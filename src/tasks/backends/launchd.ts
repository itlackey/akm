// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * launchd backend for `akm task` (macOS default).
 *
 * akm's whole footprint is one per-user LaunchAgent,
 * `~/Library/LaunchAgents/com.akm.dispatch.plist`, that runs
 * `<launcher> task dispatch` every minute (`StartCalendarInterval` with no
 * keys fires on every clock minute) and abandons its process group, so the
 * detached task runs it starts are not killed when the dispatch exits. It is
 * registered with `launchctl bootstrap gui/<uid> <plist>`.
 *
 * The per-task `com.akm.task.<id>.plist` agents of akm 0.9 are found and
 * removed here, on upgrade.
 *
 * `gui/<uid>` is the per-user GUI domain: agents run only while the user is
 * logged in. launchd strips the environment, so the PATH of the shell that
 * wrote the entry goes into the plist's `EnvironmentVariables`.
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
import { type BackendExec, escapeXml, type NodeFs, nodeExec, nodeFs, runOrThrow } from "./exec-utils";
import type { DispatchEntry, EntryChange, EntryInspection, LegacyRow, SchedulerBackend } from "./types";

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
}

export const LAUNCHD_ENTRY_LABEL = "com.akm.dispatch";
const LEGACY_LABEL_PREFIX = "com.akm.task.";

export function LAUNCHD_BACKEND(options: LaunchdBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? defaultLaunchdExec();
  const fsLike = options.fs ?? defaultLaunchdFs();
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const logDir = options.logDir ?? getTaskLogDir();

  const plistFor = (label: string) => path.join(agentsDir, `${label}.plist`);
  const target = (label: string) => `gui/${exec.uid()}/${label}`;
  const bootout = (label: string) =>
    runOrThrow(exec, ["launchctl", "bootout", target(label)], {
      isOk: (r) => r.status === 0 || isServiceNotFoundResult(r),
      message: (r) => `launchctl bootout failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
    });
  // A `launchctl disable` override survives bootout and plist removal; clear it.
  const enable = (label: string) =>
    runOrThrow(exec, ["launchctl", "enable", target(label)], {
      message: (r) => `launchctl enable failed: ${r.stderr || r.stdout || "no output"}.`,
    });
  const removeAgent = (label: string) => {
    bootout(label);
    enable(label);
    const file = plistFor(label);
    if (fsLike.exists(file)) fsLike.removeFile(file);
  };

  const install = (entry: DispatchEntry) => {
    const xml = buildPlistXml(entry, logDir);
    const file = plistFor(LAUNCHD_ENTRY_LABEL);
    fsLike.ensureDir(agentsDir);
    // launchd refuses to start a job whose StandardOutPath directory is missing.
    fsLike.ensureDir(logDir);
    const tempFile = path.join(agentsDir, `.dispatch.${Date.now()}.tmp`);
    fsLike.writeFile(tempFile, xml);
    try {
      bootout(LAUNCHD_ENTRY_LABEL);
      fsLike.replaceFile(tempFile, file);
      enable(LAUNCHD_ENTRY_LABEL);
      runOrThrow(exec, ["launchctl", "bootstrap", `gui/${exec.uid()}`, file], {
        message: (r) => `launchctl bootstrap failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
        hint: "Ensure `launchctl` is available; on macOS it is part of the base system.",
      });
    } finally {
      if (fsLike.exists(tempFile)) fsLike.removeFile(tempFile);
    }
  };

  return {
    name: "launchd",
    inspect(): EntryInspection {
      const entryFile = plistFor(LAUNCHD_ENTRY_LABEL);
      const entry = fsLike.exists(entryFile) ? parsePlistEntry(fsLike.readFile(entryFile)) : undefined;
      const legacy: LegacyRow[] = [];
      if (fsLike.exists(agentsDir)) {
        for (const file of fsLike.list(agentsDir).sort()) {
          if (!file.startsWith(LEGACY_LABEL_PREFIX) || !file.endsWith(".plist")) continue;
          legacy.push({
            id: file.slice(LEGACY_LABEL_PREFIX.length, -".plist".length),
            environment: parsePlistEnvironment(fsLike.readFile(path.join(agentsDir, file))),
          });
        }
      }
      return { ...(entry ? { entry } : {}), legacy };
    },
    apply(change: EntryChange) {
      for (const id of change.removeLegacy) removeAgent(`${LEGACY_LABEL_PREFIX}${id}`);
      if (change.entry === null) removeAgent(LAUNCHD_ENTRY_LABEL);
      else if (change.entry !== undefined) install(change.entry);
    },
  };
}

// ── plist ───────────────────────────────────────────────────────────────────

/** The plist `akm task sync` writes. Exported for tests. */
export function buildPlistXml(entry: DispatchEntry, logDir: string): string {
  const programArgs = [...entry.launcher, "task", "dispatch"].map((a) => `    <string>${escapeXml(a)}</string>`);
  const environment = entry.path
    ? [
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        `    <key>PATH</key>`,
        `    <string>${escapeXml(entry.path)}</string>`,
        "  </dict>",
        "",
      ].join("\n")
    : "";
  const xml = launchdTemplate
    .replace("{{LABEL}}", LAUNCHD_ENTRY_LABEL)
    .replace("{{PROGRAM_ARGS}}", () => programArgs.join("\n"))
    .replaceAll("{{LOG_PATH}}", () => escapeXml(path.join(logDir, "dispatch.log")))
    .replace("{{ENV_VARS}}", () => environment);
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

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parsePlistEntry(xml: string): DispatchEntry | undefined {
  const block = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const args = [...(block?.[1] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => decodeXmlEntities(m[1]!));
  if (args.length < 3 || args.at(-2) !== "task" || args.at(-1) !== "dispatch") return undefined;
  const pathValue = parsePlistEnvironment(xml).PATH;
  return { launcher: args.slice(0, -2), ...(pathValue ? { path: pathValue } : {}) };
}

/** The `EnvironmentVariables` of a plist: `PATH` of the entry, the `AKM_*` assignments of a 0.9 row. */
function parsePlistEnvironment(xml: string): Record<string, string> {
  const dict = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  const variables: Record<string, string> = {};
  for (const entry of dict.matchAll(/<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    variables[decodeXmlEntities(entry[1]!)] = decodeXmlEntities(entry[2]!);
  }
  return variables;
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
