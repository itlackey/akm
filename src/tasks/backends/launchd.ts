// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * launchd backend for `akm tasks` (macOS default).
 *
 * Each task is written as a per-user LaunchAgent plist at
 * `~/Library/LaunchAgents/com.akm.task.<id>.plist` and registered via
 * `launchctl bootstrap gui/<uid> <plist>`. Disabling uses
 * `launchctl disable gui/<uid>/<label>` and re-enabling uses `enable`.
 *
 * Platform notes:
 *   • The `bootstrap` / `bootout` / `enable` / `disable` subcommands require
 *     macOS 10.10 (Yosemite) or newer. On older systems the equivalents
 *     are `launchctl load -w` / `unload -w`. We only target modern macOS.
 *   • `gui/<uid>` is the per-user GUI launchd domain — agents in this
 *     domain only run while the user is logged in (no background runs at
 *     the loginwindow). Tasks that need to run when the user is logged
 *     out should be installed as system Daemons, which is out of scope.
 *
 * Tests inject a fake exec + filesystem so the backend can be unit-tested
 * without touching the host launchctl.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import launchdTemplate from "../../assets/backends/launchd-template.xml" with { type: "text" };
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { type LaunchdTrigger, parseSchedule, translateToLaunchd } from "../schedule";
import {
  buildScheduledTaskInvocation,
  parseScheduledTaskArgv,
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../scheduler-invocation";
import type { TaskDocument } from "../schema";
import { type BackendExec, escapeXml, type NodeFs, nodeExec, nodeFs, runOrThrow } from "./exec-utils";
import type { InstalledTaskRef, TaskBackend, TaskInstallOptions } from "./types";

export type LaunchdExec = BackendExec<{ uid(): number }>;

export type LaunchdFs = NodeFs & {
  readFile(file: string): string;
  removeFile(file: string): void;
  replaceFile(source: string, destination: string): void;
  list(dir: string): string[];
  exists(file: string): boolean;
};

export interface LaunchdBackendOptions {
  exec?: LaunchdExec;
  fs?: LaunchdFs;
  /** Override the LaunchAgents directory. Defaults to `~/Library/LaunchAgents`. */
  agentsDir?: string;
  /** Override the absolute log directory. */
  logDir?: string;
  /** Override the akm invocation argv. */
  akmArgv?: string[];
  /**
   * Override the PATH captured for `EnvironmentVariables` in the plist.
   * Set to `false` to disable PATH capture entirely.
   * When omitted, `process.env.PATH` at install time is used.
   */
  envPath?: string | false;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
}

export const LAUNCHD_LABEL_PREFIX = "com.akm.task.";

export function LAUNCHD_BACKEND(options: LaunchdBackendOptions = {}): TaskBackend {
  const exec = options.exec ?? defaultLaunchdExec();
  const fsLike = options.fs ?? defaultLaunchdFs();
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();

  const plistPath = (id: string) => path.join(agentsDir, `${LAUNCHD_LABEL_PREFIX}${id}.plist`);
  const label = (id: string) => `${LAUNCHD_LABEL_PREFIX}${id}`;
  const target = (id: string) => `gui/${exec.uid()}/${label(id)}`;
  const pathEnv = () => {
    if (options.envPath === false) return undefined;
    if (typeof options.envPath === "string") return options.envPath;
    return process.env.PATH ?? "";
  };
  const defaultContextPath = schedulerContextPath(schedulerContextDescriptor(scheduledContext, pathEnv() ?? ""));

  const setEnableState = (id: string, enabled: boolean) => {
    const verb = enabled ? "enable" : "disable";
    runOrThrow(exec, ["launchctl", verb, target(id)], {
      message: (r) => `launchctl ${verb} failed: ${r.stderr || r.stdout || "no output"}.`,
    });
  };

  return {
    name: "launchd",
    install(task: TaskDocument, opts?: TaskInstallOptions) {
      // Capture PATH at install time so launchd (which strips the environment
      // aggressively) can find the same binaries the user sees interactively.
      const xml = buildPlistXml(
        task,
        [...(opts?.binding ?? akmArgv)],
        logDir,
        opts?.contextPath === null ? undefined : (opts?.contextPath ?? defaultContextPath),
        opts?.target,
      );
      const file = plistPath(task.id);
      const previousPlist = fsLike.exists(file) ? fsLike.readFile(file) : undefined;
      let previousEnabled = true;
      if (previousPlist !== undefined) {
        const disabledLabels = readDisabledLabels(exec);
        if (disabledLabels === undefined) {
          throw new ConfigError(
            `launchctl print-disabled failed; cannot safely replace existing task "${task.id}".`,
            "INVALID_CONFIG_FILE",
          );
        }
        previousEnabled = !disabledLabels.has(label(task.id));
      }
      fsLike.ensureDir(agentsDir);
      // launchd refuses to start a job when StandardOutPath/StandardErrorPath
      // points at a non-existent directory; create it before bootstrap.
      fsLike.ensureDir(logDir);
      const tempFile = path.join(agentsDir, `.${task.id}.${Date.now()}.tmp`);
      fsLike.writeFile(tempFile, xml);
      let bootoutCompleted = false;
      let previousWasLoaded = false;
      let fileReplaced = false;
      let enableStateTouched = false;
      try {
        const bootout = runOrThrow(exec, ["launchctl", "bootout", target(task.id)], {
          isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
          message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
        });
        bootoutCompleted = true;
        previousWasLoaded = previousPlist !== undefined && bootout.status === 0;
        fsLike.replaceFile(tempFile, file);
        fileReplaced = true;
        // A disable override survives bootout and plist replacement. Clear it
        // before bootstrap, then apply the desired state after registration.
        enableStateTouched = true;
        setEnableState(task.id, true);
        runOrThrow(exec, ["launchctl", "bootstrap", `gui/${exec.uid()}`, file], {
          message: (r) => `launchctl bootstrap failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
          hint: "Ensure `launchctl` is available; on macOS it is part of the base system.",
        });
        if (!task.enabled) {
          setEnableState(task.id, false);
        }
      } catch (err) {
        if (!bootoutCompleted) throw err;
        const rollbackErrors: unknown[] = [];
        let priorFileRestored = !fileReplaced;
        if (fileReplaced) {
          let replacementUnloaded = false;
          try {
            const rollbackBootout = exec.run(["launchctl", "bootout", target(task.id)]);
            replacementUnloaded = rollbackBootout.status === 0 || isServiceNotFoundResult(rollbackBootout);
            if (!replacementUnloaded) {
              rollbackErrors.push(
                new ConfigError(
                  `launchctl bootout during rollback failed: ${rollbackBootout.stderr || rollbackBootout.stdout || "no output"}.`,
                  "INVALID_CONFIG_FILE",
                ),
              );
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }

          if (replacementUnloaded) {
            try {
              if (previousPlist === undefined) {
                if (fsLike.exists(file)) fsLike.removeFile(file);
              } else {
                fsLike.writeFile(tempFile, previousPlist);
                fsLike.replaceFile(tempFile, file);
              }
              priorFileRestored = true;
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
        }

        if (previousPlist !== undefined && previousWasLoaded && priorFileRestored) {
          try {
            setEnableState(task.id, true);
            const restore = exec.run(["launchctl", "bootstrap", `gui/${exec.uid()}`, file]);
            if (restore.status !== 0) {
              rollbackErrors.push(
                new ConfigError(
                  `launchctl bootstrap during rollback failed: ${restore.stderr || restore.stdout || "no output"}.`,
                  "INVALID_CONFIG_FILE",
                ),
              );
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          if (!previousEnabled) {
            try {
              setEnableState(task.id, false);
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
        } else if (enableStateTouched) {
          try {
            setEnableState(task.id, previousPlist === undefined || previousEnabled);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          const message = err instanceof Error ? err.message : String(err);
          throw new AggregateError(
            [err, ...rollbackErrors],
            `${message}; rollback for launchd task "${task.id}" was incomplete.`,
          );
        }
        throw err;
      } finally {
        if (fsLike.exists(tempFile)) fsLike.removeFile(tempFile);
      }
    },
    uninstall(id: string) {
      runOrThrow(exec, ["launchctl", "bootout", target(id)], {
        isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
        message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
      });
      // launchctl disable overrides persist after the plist is removed.
      setEnableState(id, true);
      const file = plistPath(id);
      if (fsLike.exists(file)) fsLike.removeFile(file);
    },
    setEnabled(id: string, enabled: boolean) {
      setEnableState(id, enabled);
    },
    list(): InstalledTaskRef[] {
      if (!fsLike.exists(agentsDir)) return [];
      const ids: string[] = [];
      for (const file of fsLike.list(agentsDir)) {
        if (file.startsWith(LAUNCHD_LABEL_PREFIX) && file.endsWith(".plist")) {
          ids.push(file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length));
        }
      }
      if (ids.length === 0) return [];
      const disabledLabels = readDisabledLabels(exec);
      return ids.map((id) => {
        try {
          return inspectInstalledLaunchdTask(id, fsLike.readFile(plistPath(id)), disabledLabels, exec);
        } catch {
          return { id };
        }
      });
    },
    expectedSignature(task: TaskDocument, opts?: TaskInstallOptions): string {
      return normalizeSignature(
        buildPlistXml(
          task,
          [...(opts?.binding ?? akmArgv)],
          logDir,
          opts?.contextPath === null ? undefined : (opts?.contextPath ?? defaultContextPath),
          opts?.target,
        ),
      );
    },
  };
}

function inspectInstalledLaunchdTask(
  id: string,
  raw: string,
  disabledLabels: Set<string> | undefined,
  exec: LaunchdExec,
): InstalledTaskRef {
  const installed = extractPlistInvocation(raw);
  const metadata = {
    ...(installed?.target !== undefined ? { target: installed.target } : {}),
    ...(installed?.binding !== undefined ? { binding: installed.binding } : {}),
    ...(installed?.contextPath !== undefined ? { contextPath: installed.contextPath } : {}),
  };
  if (!disabledLabels) return { id, ...metadata };

  const jobLabel = `${LAUNCHD_LABEL_PREFIX}${id}`;
  try {
    const loaded = exec.run(["launchctl", "print", `gui/${exec.uid()}/${jobLabel}`]);
    if (loaded.status !== 0) return { id, ...metadata };
  } catch {
    return { id, ...metadata };
  }

  try {
    const xml = raw.replace(
      /<!-- akm-enabled:(?:true|false) -->/,
      `<!-- akm-enabled:${!disabledLabels.has(jobLabel)} -->`,
    );
    return {
      id,
      signature: normalizeSignature(xml),
      ...metadata,
    };
  } catch {
    return { id, ...metadata };
  }
}

/**
 * Recover the bundle name embedded as a `--target <bundle>` pair in a plist's
 * `<ProgramArguments>`. Returns undefined for the primary/default form.
 */
export function extractPlistTarget(xml: string): string | undefined {
  return extractPlistInvocation(xml)?.target;
}

export function extractPlistInvocation(xml: string): ReturnType<typeof parseScheduledTaskArgv> {
  const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return undefined;
  const args = [...block[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => decodeXmlEntities(m[1]!));
  return parseScheduledTaskArgv(args);
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

// ── XML builder (exported for tests) ────────────────────────────────────────

export function buildPlistXml(
  task: TaskDocument,
  akmArgv: string[],
  logDir: string,
  contextPath: string | undefined,
  target?: string,
): string {
  const spec = parseSchedule(task.schedule, "launchd");
  const trigger = translateToLaunchd(spec);
  const invocation = buildScheduledTaskInvocation(akmArgv, task.id, contextPath, target);
  const argv = invocation.argv;
  const programArgs = argv.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  const logPath = path.join(logDir, `${task.id}.log`);
  const triggerXml = renderLaunchdTrigger(trigger);

  const xml = launchdTemplate
    .replace("<dict>\n", `<dict>\n  <!-- akm-enabled:${task.enabled} -->\n`)
    .replace("{{LABEL}}", LAUNCHD_LABEL_PREFIX + escapeXml(task.id))
    .replace("{{PROGRAM_ARGS}}", programArgs)
    .replaceAll("{{LOG_PATH}}", escapeXml(logPath))
    .replace("{{ENV_VARS}}", "")
    .replace("{{TRIGGER_XML}}", triggerXml);
  for (const char of xml) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)) {
      throw new ConfigError(
        "Launchd plist values must not contain XML-forbidden control characters.",
        "INVALID_CONFIG_FILE",
      );
    }
  }
  return xml;
}

function renderLaunchdTrigger(trigger: LaunchdTrigger): string {
  if (trigger.calendars !== undefined) {
    const lines = ["  <key>StartCalendarInterval</key>", "  <array>"];
    for (const calendar of trigger.calendars) {
      lines.push(...renderCalendar(calendar, "    "));
    }
    lines.push("  </array>");
    return lines.join("\n");
  }
  const cal = trigger.calendar ?? {};
  const lines = ["  <key>StartCalendarInterval</key>", ...renderCalendar(cal, "  ")];
  return lines.join("\n");
}

function renderCalendar(calendar: NonNullable<LaunchdTrigger["calendar"]>, indent: string): string[] {
  const valueIndent = `${indent}  `;
  const lines = [`${indent}<dict>`];
  if (calendar.Minute !== undefined) {
    lines.push(`${valueIndent}<key>Minute</key><integer>${calendar.Minute}</integer>`);
  }
  if (calendar.Hour !== undefined) lines.push(`${valueIndent}<key>Hour</key><integer>${calendar.Hour}</integer>`);
  if (calendar.Day !== undefined) lines.push(`${valueIndent}<key>Day</key><integer>${calendar.Day}</integer>`);
  if (calendar.Month !== undefined) lines.push(`${valueIndent}<key>Month</key><integer>${calendar.Month}</integer>`);
  if (calendar.Weekday !== undefined) {
    lines.push(`${valueIndent}<key>Weekday</key><integer>${calendar.Weekday}</integer>`);
  }
  lines.push(`${indent}</dict>`);
  return lines;
}

function normalizeSignature(xml: string): string {
  return xml.replace(/\r\n/g, "\n").trim();
}

function readDisabledLabels(exec: LaunchdExec): Set<string> | undefined {
  try {
    const result = exec.run(["launchctl", "print-disabled", `gui/${exec.uid()}`]);
    if (result.status !== 0) return undefined;
    return parseDisabledLabels(result.stdout);
  } catch {
    return undefined;
  }
}

function parseDisabledLabels(output: string): Set<string> | undefined {
  const envelope = /^\s*disabled services\s*=\s*\{([\s\S]*)\}\s*$/.exec(output);
  if (!envelope) return undefined;

  const disabled = new Set<string>();
  let body = envelope[1]!;
  while (body.trim()) {
    const entry = /^\s*"([^"\r\n]+)"\s*=>\s*(true|false|enabled|disabled)\s*/.exec(body);
    if (!entry) return undefined;
    if (entry[2] === "true" || entry[2] === "disabled") disabled.add(entry[1]!);
    body = body.slice(entry[0].length);
  }
  return disabled;
}

function isServiceNotFoundResult(result: { stdout: string; stderr: string }): boolean {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /could not find service\b|service\b.*\bnot found\b|\bno such process\b/i.test(output);
}

function defaultAgentsDir(): string {
  // launchd's per-user LaunchAgents live under the user's home directory.
  // If we can't determine HOME, refuse rather than silently producing a
  // relative path that would write somewhere unexpected.
  const home = os.homedir();
  if (!home) {
    throw new ConfigError(
      "Cannot determine user home directory; launchd backend requires HOME to locate ~/Library/LaunchAgents.",
      "INVALID_CONFIG_FILE",
      "Set $HOME (POSIX) or the equivalent before running `akm tasks` on macOS.",
    );
  }
  return path.join(home, "Library", "LaunchAgents");
}

function defaultLaunchdExec(): LaunchdExec {
  return {
    ...nodeExec(),
    uid() {
      const fn = (process as { getuid?: () => number }).getuid;
      return typeof fn === "function" ? fn.call(process) : 0;
    },
  };
}

function defaultLaunchdFs(): LaunchdFs {
  return {
    ...nodeFs(),
    readFile(file) {
      return fs.readFileSync(file, "utf8");
    },
    removeFile(file) {
      fs.rmSync(file, { force: true });
    },
    replaceFile(source, destination) {
      fs.renameSync(source, destination);
    },
    list(dir) {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    exists(file) {
      return fs.existsSync(file);
    },
  };
}
