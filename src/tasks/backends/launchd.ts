// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * launchd backend for `akm task` (macOS default).
 *
 * Each task is written as a per-user LaunchAgent plist at
 * `~/Library/LaunchAgents/com.akm.task.<id>.plist` and registered via
 * `launchctl bootstrap gui/<uid> <plist>`. Disabling uses
 * `launchctl disable gui/<uid>/<label>` and re-enabling uses `enable`.
 *
 * Platform notes:
 *   • The `bootstrap` / `bootout` / `enable` / `disable` subcommands require
 *     macOS 10.10 (Yosemite) or newer. We only target modern macOS.
 *   • `gui/<uid>` is the per-user GUI launchd domain — agents in this
 *     domain only run while the user is logged in. Tasks that need to run
 *     when the user is logged out should be installed as system Daemons,
 *     which is out of scope.
 *   • launchd strips the environment; the syncing shell's PATH goes into the
 *     plist's `EnvironmentVariables` so task bodies find the same binaries.
 *
 * Tests inject a fake exec + filesystem so the backend can be unit-tested
 * without touching the host launchctl.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import launchdTemplate from "../../assets/backends/launchd-template.xml" with { type: "text" };
import { hasErrnoCode } from "../../core/common";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { warn } from "../../core/warn";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { type LaunchdTrigger, parseSchedule, translateToLaunchd } from "../schedule";
import { type SchedulerBinding, schedulerBindingNativeId, schedulerLogicalBindingId } from "../scheduler-binding";
import {
  buildScheduledBindingInvocation,
  type ParsedScheduledBindingInvocation,
  parseScheduledBindingArgv,
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../scheduler-invocation";
import { type BackendExec, escapeXml, type NodeFs, nodeExec, nodeFs, runOrThrow } from "./exec-utils";
import type { InstalledSchedulerBinding, SchedulerBackend } from "./types";

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
  /** Override the PATH written to the plist's `EnvironmentVariables`; `false` omits it. */
  envPath?: string | false;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
}

export const LAUNCHD_LABEL_PREFIX = "com.akm.task.";
const LAUNCHD_AKM_LABEL_RE = /^com\.akm\.task\.[A-Za-z0-9._-]{1,1024}$/u;

export function LAUNCHD_BACKEND(options: LaunchdBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? defaultLaunchdExec();
  const fsLike = options.fs ?? defaultLaunchdFs();
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();
  const envPath =
    options.envPath === false ? undefined : typeof options.envPath === "string" ? options.envPath : process.env.PATH;
  const defaultContextPath = schedulerContextPath(schedulerContextDescriptor(scheduledContext));

  const plistPath = (nativeId: string) => path.join(agentsDir, `${LAUNCHD_LABEL_PREFIX}${nativeId}.plist`);
  const label = (nativeId: string) => `${LAUNCHD_LABEL_PREFIX}${nativeId}`;
  const target = (nativeId: string) => `gui/${exec.uid()}/${label(nativeId)}`;
  const setEnableState = (nativeId: string, enabled: boolean) => {
    const verb = enabled ? "enable" : "disable";
    runOrThrow(exec, ["launchctl", verb, target(nativeId)], {
      message: (result) => `launchctl ${verb} failed: ${result.stderr || result.stdout || "no output"}.`,
    });
  };
  const bootout = (nativeId: string) =>
    runOrThrow(exec, ["launchctl", "bootout", target(nativeId)], {
      isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
      message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
    });
  const xmlFor = (task: SchedulerBinding, opts?: { binding?: readonly string[]; contextPath?: string }) =>
    buildPlistXml(task, [...(opts?.binding ?? akmArgv)], logDir, opts?.contextPath ?? defaultContextPath, envPath);

  return {
    name: "launchd",
    install(task, opts) {
      const xml = xmlFor(task, opts);
      const nativeId = schedulerBindingNativeId(task);
      const file = plistPath(nativeId);
      fsLike.ensureDir(agentsDir);
      // launchd refuses to start a job whose StandardOutPath directory is
      // missing; create it before touching launchd state.
      fsLike.ensureDir(logDir);
      const tempFile = path.join(agentsDir, `.${nativeId}.${Date.now()}.tmp`);
      fsLike.writeFile(tempFile, xml);
      try {
        bootout(nativeId);
        fsLike.replaceFile(tempFile, file);
        // A disable override survives bootout and plist replacement. Clear it
        // before bootstrap, then apply the desired state after registration.
        setEnableState(nativeId, true);
        runOrThrow(exec, ["launchctl", "bootstrap", `gui/${exec.uid()}`, file], {
          message: (r) => `launchctl bootstrap failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
          hint: "Ensure `launchctl` is available; on macOS it is part of the base system.",
        });
        if (!task.enabled) setEnableState(nativeId, false);
      } finally {
        if (fsLike.exists(tempFile)) fsLike.removeFile(tempFile);
      }
    },
    uninstall(nativeId) {
      bootout(nativeId);
      // launchctl disable overrides persist after the plist is removed.
      setEnableState(nativeId, true);
      const file = plistPath(nativeId);
      if (fsLike.exists(file)) fsLike.removeFile(file);
    },
    setEnabled(nativeId, enabled) {
      setEnableState(nativeId, enabled);
    },
    list() {
      const domain = exec.run(["launchctl", "print", `gui/${exec.uid()}`]);
      if (domain.status !== 0) {
        throw new ConfigError(
          `launchctl failed to enumerate the loaded user domain: ${domain.stderr || domain.stdout || "no output"}.`,
          "INVALID_CONFIG_FILE",
        );
      }
      const loadedLabels = parseLaunchdLoadedLabels(domain.stdout);
      const disabledLabels = readDisabledLabels(exec);
      const rows: InstalledSchedulerBinding[] = [];
      if (!fsLike.exists(agentsDir)) return rows;
      for (const file of fsLike.list(agentsDir).sort()) {
        if (!file.startsWith(LAUNCHD_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
        const nativeId = file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length);
        const raw = fsLike.readFile(plistPath(nativeId));
        const parsed = extractPlistInvocation(raw);
        if (!parsed) continue;
        const enabled = !disabledLabels.has(label(nativeId));
        const loaded = loadedLabels.has(label(nativeId));
        rows.push({
          id: schedulerLogicalBindingId(nativeId, parsed.invocation),
          nativeId,
          enabled: enabled && loaded,
          // An unloaded service or a disable override is drift: the signature
          // carries both, so sync bootstraps/enables it again.
          signature: launchdFingerprint(raw, enabled, loaded),
          ...(parsed.target !== undefined ? { target: parsed.target } : {}),
          binding: parsed.binding,
          contextPath: parsed.contextPath,
          invocation: parsed.invocation,
        });
      }
      return rows;
    },
    expectedSignature(task, opts) {
      return launchdFingerprint(xmlFor(task, opts), task.enabled, true);
    },
  };
}

function launchdFingerprint(raw: string, enabled: boolean, loaded: boolean): string {
  const signed = raw.replace(/<!-- akm-enabled:(?:true|false) -->/, `<!-- akm-enabled:${enabled} -->`);
  return `${signed.replace(/\r\n/g, "\n").trim()}:loaded=${loaded}`;
}

export function extractPlistInvocation(xml: string): ParsedScheduledBindingInvocation | undefined {
  const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return undefined;
  const args = [...block[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => decodeXmlEntities(m[1]!));
  return parseScheduledBindingArgv(args);
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

function renderPlistEnvironment(envPath: string | undefined): string {
  if (!envPath) return "";
  return [
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    <string>${escapeXml(envPath)}</string>`,
    "  </dict>",
    "",
  ].join("\n");
}

export function buildPlistXml(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  contextPath: string,
  envPath?: string,
): string {
  const trigger = translateToLaunchd(parseSchedule(task.cron, "launchd"));
  const invocation = buildScheduledBindingInvocation(akmArgv, contextPath, task.invocation);
  const programArgs = invocation.argv.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  const nativeId = schedulerBindingNativeId(task);
  const logPath = path.join(logDir, `${nativeId}.log`);
  const xml = launchdTemplate
    .replace("<dict>\n", `<dict>\n  <!-- akm-enabled:${task.enabled} -->\n`)
    .replace("{{LABEL}}", LAUNCHD_LABEL_PREFIX + escapeXml(nativeId))
    .replace("{{PROGRAM_ARGS}}", programArgs)
    .replaceAll("{{LOG_PATH}}", escapeXml(logPath))
    .replace("{{ENV_VARS}}", renderPlistEnvironment(envPath))
    .replace("{{TRIGGER_XML}}", renderLaunchdTrigger(trigger));
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
    for (const calendar of trigger.calendars) lines.push(...renderCalendar(calendar, "    "));
    lines.push("  </array>");
    return lines.join("\n");
  }
  return ["  <key>StartCalendarInterval</key>", ...renderCalendar(trigger.calendar ?? {}, "  ")].join("\n");
}

function renderCalendar(calendar: NonNullable<LaunchdTrigger["calendar"]>, indent: string): string[] {
  const valueIndent = `${indent}  `;
  const lines = [`${indent}<dict>`];
  if (calendar.Minute !== undefined) lines.push(`${valueIndent}<key>Minute</key><integer>${calendar.Minute}</integer>`);
  if (calendar.Hour !== undefined) lines.push(`${valueIndent}<key>Hour</key><integer>${calendar.Hour}</integer>`);
  if (calendar.Day !== undefined) lines.push(`${valueIndent}<key>Day</key><integer>${calendar.Day}</integer>`);
  if (calendar.Month !== undefined) lines.push(`${valueIndent}<key>Month</key><integer>${calendar.Month}</integer>`);
  if (calendar.Weekday !== undefined) {
    lines.push(`${valueIndent}<key>Weekday</key><integer>${calendar.Weekday}</integer>`);
  }
  lines.push(`${indent}</dict>`);
  return lines;
}

/**
 * Collect the akm-owned service labels present in `launchctl` output.
 *
 * This reads the CURRENT USER'S OWN scheduler inventory, so it is parsed
 * permissively: scan for labels in our own `com.akm.task.` namespace and
 * ignore everything else.
 */
export function parseLaunchdLoadedLabels(output: string): Set<string> {
  const labels = new Set<string>();
  // `[^\s"{}=,()]` stops the token at whatever punctuation the surrounding
  // launchctl syntax uses, so a label works whether it appears as a bare
  // table cell, a quoted string, or a dictionary key.
  for (const match of output.matchAll(/com\.akm\.task\.[^\s"{}=,()]+/gu)) {
    if (LAUNCHD_AKM_LABEL_RE.test(match[0])) labels.add(match[0]);
  }
  return labels;
}

/** `print-disabled` failing or looking unfamiliar degrades to "nothing is disabled". */
function readDisabledLabels(exec: LaunchdExec): Set<string> {
  try {
    const result = exec.run(["launchctl", "print-disabled", `gui/${exec.uid()}`]);
    if (result.status !== 0) {
      warn("[akm] launchctl print-disabled exited %d; assuming no akm task is disabled.", result.status);
      return new Set();
    }
    const disabled = new Set<string>();
    const entryPattern = /"(com\.akm\.task\.[^"\r\n]+)"\s*=>\s*(true|false|enabled|disabled)/gu;
    for (const match of result.stdout.matchAll(entryPattern)) {
      const label = match[1]!;
      if (LAUNCHD_AKM_LABEL_RE.test(label) && (match[2] === "true" || match[2] === "disabled")) disabled.add(label);
    }
    return disabled;
  } catch (error) {
    warn(
      "[akm] launchctl print-disabled could not be run; assuming no akm task is disabled: %s",
      error instanceof Error ? error.message : String(error),
    );
    return new Set();
  }
}

function isServiceNotFoundResult(result: { stdout: string; stderr: string }): boolean {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /could not find service\b|service\b.*\bnot found\b|\bno such process\b/i.test(output);
}

function defaultAgentsDir(): string {
  const home = os.homedir();
  if (!home) {
    throw new ConfigError(
      "Cannot determine user home directory; launchd backend requires HOME to locate ~/Library/LaunchAgents.",
      "INVALID_CONFIG_FILE",
      "Set $HOME (POSIX) or the equivalent before running `akm task` on macOS.",
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
      } catch (error) {
        // Genuinely absent is an empty listing; anything else (e.g. EACCES)
        // is not "no plists".
        if (hasErrnoCode(error, "ENOENT")) return [];
        throw new ConfigError(`Unable to read LaunchAgents directory at "${dir}".`, "INVALID_CONFIG_FILE");
      }
    },
    exists(file) {
      return fs.existsSync(file);
    },
  };
}
