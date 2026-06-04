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
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolveAkmBin";
import { type LaunchdTrigger, parseSchedule, translateToLaunchd } from "../schedule";
import type { TaskDocument } from "../schema";
import { escapeXml, spawnCommand } from "./exec-utils";
import type { InstalledTaskRef, TaskBackend } from "./index";
import launchdTemplate from "./launchd-template.xml" with { type: "text" };

export interface LaunchdExec {
  run(args: string[]): { status: number; stdout: string; stderr: string };
  uid(): number;
}

export interface LaunchdFs {
  writeFile(file: string, content: string): void;
  removeFile(file: string): void;
  ensureDir(dir: string): void;
  list(dir: string): string[];
  exists(file: string): boolean;
}

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
}

export const LAUNCHD_LABEL_PREFIX = "com.akm.task.";

export function LAUNCHD_BACKEND(options: LaunchdBackendOptions = {}): TaskBackend {
  const exec = options.exec ?? defaultLaunchdExec();
  const fsLike = options.fs ?? defaultLaunchdFs();
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;

  const plistPath = (id: string) => path.join(agentsDir, `${LAUNCHD_LABEL_PREFIX}${id}.plist`);
  const label = (id: string) => `${LAUNCHD_LABEL_PREFIX}${id}`;
  const target = (id: string) => `gui/${exec.uid()}/${label(id)}`;

  return {
    name: "launchd",
    install(task: TaskDocument) {
      // Capture PATH at install time so launchd (which strips the environment
      // aggressively) can find the same binaries the user sees interactively.
      let pathEnv: string | undefined;
      if (options.envPath === false) {
        pathEnv = undefined;
      } else if (typeof options.envPath === "string") {
        pathEnv = options.envPath;
      } else {
        pathEnv = process.env.PATH ?? "";
      }
      const xml = buildPlistXml(task, akmArgv, logDir, pathEnv);
      fsLike.ensureDir(agentsDir);
      // launchd refuses to start a job when StandardOutPath/StandardErrorPath
      // points at a non-existent directory; create it before bootstrap.
      fsLike.ensureDir(logDir);
      fsLike.writeFile(plistPath(task.id), xml);
      const bootout = exec.run(["launchctl", "bootout", target(task.id)]);
      // bootout returning non-zero is fine — agent might not be loaded.
      void bootout;
      const bootstrap = exec.run(["launchctl", "bootstrap", `gui/${exec.uid()}`, plistPath(task.id)]);
      if (bootstrap.status !== 0) {
        throw new ConfigError(
          `launchctl bootstrap failed (exit ${bootstrap.status}): ${bootstrap.stderr || bootstrap.stdout || "no output"}.`,
          "INVALID_CONFIG_FILE",
          "Ensure `launchctl` is available; on macOS it is part of the base system.",
        );
      }
      if (!task.enabled) {
        const disable = exec.run(["launchctl", "disable", target(task.id)]);
        if (disable.status !== 0) {
          throw new ConfigError(
            `launchctl disable failed: ${disable.stderr || disable.stdout || "no output"}.`,
            "INVALID_CONFIG_FILE",
          );
        }
      }
    },
    uninstall(id: string) {
      // Bootout first (may fail if agent never loaded — that's fine).
      exec.run(["launchctl", "bootout", target(id)]);
      const file = plistPath(id);
      if (fsLike.exists(file)) fsLike.removeFile(file);
    },
    setEnabled(id: string, enabled: boolean) {
      const verb = enabled ? "enable" : "disable";
      const r = exec.run(["launchctl", verb, target(id)]);
      if (r.status !== 0) {
        throw new ConfigError(
          `launchctl ${verb} failed: ${r.stderr || r.stdout || "no output"}.`,
          "INVALID_CONFIG_FILE",
        );
      }
    },
    list(): InstalledTaskRef[] {
      if (!fsLike.exists(agentsDir)) return [];
      const ids: string[] = [];
      for (const file of fsLike.list(agentsDir)) {
        if (file.startsWith(LAUNCHD_LABEL_PREFIX) && file.endsWith(".plist")) {
          ids.push(file.slice(LAUNCHD_LABEL_PREFIX.length, -".plist".length));
        }
      }
      return ids.map((id) => ({ id }));
    },
  };
}

// ── XML builder (exported for tests) ────────────────────────────────────────

export function buildPlistXml(task: TaskDocument, akmArgv: string[], logDir: string, pathEnv?: string): string {
  const spec = parseSchedule(task.schedule, "launchd");
  const trigger = translateToLaunchd(spec);
  const argv = [...akmArgv, "tasks", "run", task.id];
  const programArgs = argv.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  const logPath = path.join(logDir, `${task.id}.log`);
  const triggerXml = renderLaunchdTrigger(trigger);

  const envVarsXml =
    pathEnv !== undefined
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${escapeXml(pathEnv)}</string>\n  </dict>\n`
      : "";

  return launchdTemplate
    .replace("{{LABEL}}", LAUNCHD_LABEL_PREFIX + escapeXml(task.id))
    .replace("{{PROGRAM_ARGS}}", programArgs)
    .replaceAll("{{LOG_PATH}}", escapeXml(logPath))
    .replace("{{ENV_VARS}}", envVarsXml)
    .replace("{{TRIGGER_XML}}", triggerXml);
}

function renderLaunchdTrigger(trigger: LaunchdTrigger): string {
  if (trigger.intervalSeconds !== undefined) {
    return `  <key>StartInterval</key>
  <integer>${trigger.intervalSeconds}</integer>`;
  }
  const cal = trigger.calendar ?? {};
  const lines = ["  <key>StartCalendarInterval</key>", "  <dict>"];
  if (cal.Minute !== undefined) lines.push(`    <key>Minute</key><integer>${cal.Minute}</integer>`);
  if (cal.Hour !== undefined) lines.push(`    <key>Hour</key><integer>${cal.Hour}</integer>`);
  if (cal.Day !== undefined) lines.push(`    <key>Day</key><integer>${cal.Day}</integer>`);
  if (cal.Month !== undefined) lines.push(`    <key>Month</key><integer>${cal.Month}</integer>`);
  if (cal.Weekday !== undefined) lines.push(`    <key>Weekday</key><integer>${cal.Weekday}</integer>`);
  lines.push("  </dict>");
  return lines.join("\n");
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
    run(args: string[]) {
      return spawnCommand(args);
    },
    uid() {
      const fn = (process as { getuid?: () => number }).getuid;
      return typeof fn === "function" ? fn.call(process) : 0;
    },
  };
}

function defaultLaunchdFs(): LaunchdFs {
  return {
    writeFile(file, content) {
      fs.writeFileSync(file, content, { encoding: "utf8" });
    },
    removeFile(file) {
      fs.rmSync(file, { force: true });
    },
    ensureDir(dir) {
      fs.mkdirSync(dir, { recursive: true });
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
