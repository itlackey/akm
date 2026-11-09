// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * schtasks.exe backend for `akm task` (Windows default).
 *
 * akm's whole footprint is one task, `\akm\dispatch`, that runs
 * `<launcher> task dispatch` every minute (a daily trigger repeating every
 * minute; `IgnoreNew` keeps a slow dispatch from stacking). The definition is
 * sent through `schtasks /Create /TN \akm\dispatch /XML <path> /F`.
 *
 * The per-task `\akm\<id>` tasks of akm 0.9 are found and deleted here, on
 * upgrade. The backend never touches tasks outside the `\akm\` folder.
 *
 * Platform notes:
 *   • `LogonType=InteractiveToken`: runs as the registering user while they
 *     are logged in; no stored password.
 *   • The action runs the launcher directly, with no shell in between.
 *     InteractiveToken runs it in the user's desktop session, and a console
 *     program (a Bun standalone, node.exe) may show a console window every
 *     minute there: Microsoft's docs do not say, and the CI gate cannot see
 *     windows. `<Hidden>` only hides the task from the Task Scheduler UI.
 *     Task Scheduler runs with the account's own environment, so PATH is not
 *     carried anywhere.
 *   • The launcher argv is stored as JSON in `<Source>`, which is how
 *     `inspect()` reads it back.
 *
 * Tests inject a fake exec + filesystem.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import schtasksTemplate from "../../assets/backends/schtasks-template.xml" with { type: "text" };
import { ConfigError } from "../../core/errors";
import {
  type BackendExec,
  escapeXml,
  type NodeFs,
  nodeExec,
  nodeFs,
  normalizeXmlForUtf16File,
  runOrThrow,
} from "./exec-utils";
import type { DispatchEntry, EntryChange, EntryInspection, LegacyRow, SchedulerBackend } from "./types";

export type SchtasksExec = BackendExec;

export type SchtasksFs = NodeFs & {
  removeFile(file: string): void;
  tmpdir(): string;
};

export interface SchtasksBackendOptions {
  exec?: SchtasksExec;
  fs?: SchtasksFs;
  /** Folder prefix for task names. Default `\akm\`. */
  folderPrefix?: string;
  /** Override the current Windows user SID (tests). */
  userSid?: string;
  /** Override the clock used for the first StartBoundary (tests). */
  now?: () => Date;
}

export const DEFAULT_FOLDER_PREFIX = "\\akm\\";
const ENTRY_NAME = "dispatch";
const SIGNATURE_PREFIX = "akm:v2:";

export function SCHTASKS_BACKEND(options: SchtasksBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? nodeExec();
  const fsLike = options.fs ?? defaultSchtasksFs();
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const taskName = (id: string) => `${folder}${id}`;
  const queryXml = (id: string) =>
    runOrThrow(exec, ["schtasks", "/Query", "/TN", taskName(id), "/XML"], {
      message: (result) =>
        `schtasks /Query /XML for "${taskName(id)}" failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
    }).stdout;
  const remove = (id: string) =>
    runOrThrow(exec, ["schtasks", "/Delete", "/TN", taskName(id), "/F"], {
      isOk: (r) => r.status === 0 || isMissingTaskResult(r),
      message: (r) => `schtasks /Delete failed: ${r.stderr || r.stdout || "no output"}.`,
    });

  const install = (entry: DispatchEntry) => {
    const userSid = options.userSid ?? resolveCurrentUserSid(exec);
    const xml = normalizeXmlForUtf16File(buildSchtasksXml(entry, { folderPrefix: folder, userSid, now: options.now }));
    const tmpFile = path.join(fsLike.tmpdir(), `akm-dispatch-${Date.now()}.xml`);
    fsLike.writeFile(tmpFile, xml);
    try {
      // /F forces overwrite if a task with the same name exists.
      runOrThrow(exec, ["schtasks", "/Create", "/TN", taskName(ENTRY_NAME), "/XML", tmpFile, "/F"], {
        message: (r) => `schtasks /Create failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
      });
    } finally {
      fsLike.removeFile(tmpFile);
    }
  };

  return {
    name: "schtasks",
    inspect(): EntryInspection {
      const listing = runOrThrow(exec, ["schtasks", "/Query", "/FO", "CSV", "/NH"], {
        message: (result) =>
          `schtasks /Query failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
      });
      let entry: DispatchEntry | undefined;
      const legacy: LegacyRow[] = [];
      const seen = new Set<string>();
      for (const line of (listing.stdout ?? "").split(/\r?\n/)) {
        const name = line.match(/^"([^"]+)",/)?.[1];
        if (!name?.startsWith(folder)) continue;
        const id = name.slice(folder.length);
        if (seen.has(id)) continue;
        seen.add(id);
        const xml = queryXml(id);
        if (id === ENTRY_NAME) entry = parseSchtasksEntry(xml);
        else legacy.push({ id, environment: parseLegacyEnvironment(xml) });
      }
      return { ...(entry ? { entry } : {}), legacy };
    },
    apply(change: EntryChange) {
      for (const id of change.removeLegacy) remove(id);
      if (change.entry === null) remove(ENTRY_NAME);
      else if (change.entry !== undefined) install(change.entry);
    },
  };
}

// ── XML ─────────────────────────────────────────────────────────────────────

/** The task definition `akm task sync` writes. Exported for tests. */
export function buildSchtasksXml(
  entry: DispatchEntry,
  options: { folderPrefix?: string; userSid: string; now?: () => Date },
): string {
  const folder = options.folderPrefix ?? DEFAULT_FOLDER_PREFIX;
  const [command, ...rest] = entry.launcher;
  if (!command) throw new ConfigError("The dispatch entry has no launcher.", "INVALID_CONFIG_FILE");
  const args = [...rest, "task", "dispatch"].map(quoteArg).join(" ");
  // A daily trigger repeating every minute; its boundary is local midnight today, which Task Scheduler reads in the
  // registering user's time zone.
  const now = (options.now ?? (() => new Date()))();
  const pad = (value: number) => String(value).padStart(2, "0");
  const startBoundary = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00:00:00`;
  return schtasksTemplate
    .replaceAll("{{FOLDER}}", escapeXml(folder))
    .replace("{{SIGNATURE}}", () => escapeXml(`${SIGNATURE_PREFIX}${JSON.stringify(entry.launcher)}`))
    .replace("{{START_BOUNDARY}}", startBoundary)
    .replace('<Principal id="Author">', `<Principal id="Author">\n      <UserId>${escapeXml(options.userSid)}</UserId>`)
    .replace("{{COMMAND}}", () => escapeXml(command))
    .replace("{{ARGS}}", () => escapeXml(args));
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_\-./@:%=+,\\]+$/.test(s)) return s;
  // CommandLineToArgvW requires backslashes before quotes (including the
  // closing quote) to be doubled so they survive as literal backslashes.
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function parseSchtasksEntry(xml: string): DispatchEntry | undefined {
  const source = xml.match(/<(?:[\w.-]+:)?Source>([^<]*)<\//i)?.[1]?.trim();
  const json = source === undefined ? undefined : decodeXml(source);
  if (!json?.startsWith(SIGNATURE_PREFIX)) return undefined;
  try {
    const launcher = JSON.parse(json.slice(SIGNATURE_PREFIX.length)) as unknown;
    return Array.isArray(launcher) && launcher.every((part) => typeof part === "string")
      ? { launcher: launcher as string[] }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The `$env:AKM_*='value';` assignments an akm 0.9 task's PowerShell command set. */
function parseLegacyEnvironment(xml: string): Record<string, string> {
  const args = xml.match(/<(?:[\w.-]+:)?Arguments>([\s\S]*?)<\/(?:[\w.-]+:)?Arguments>/i)?.[1];
  const variables: Record<string, string> = {};
  if (args === undefined) return variables;
  for (const assignment of decodeXml(args).matchAll(/\$env:(AKM_[A-Z_]+)='((?:[^']|'')*)'\s*;/g)) {
    variables[assignment[1]!] = assignment[2]!.replaceAll("''", "'");
  }
  return variables;
}

function isMissingTaskResult(result: { stdout: string; stderr: string }): boolean {
  return /cannot find|not found/i.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

function decodeXml(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hex) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    switch (entity.toLowerCase()) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        return entity;
    }
  });
}

function resolveCurrentUserSid(exec: SchtasksExec): string {
  const result = runOrThrow(exec, ["whoami", "/user", "/fo", "csv", "/nh"], {
    message: (r) => `whoami /user failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
  });
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\bS-\d+(?:-\d+){2,}\b/i);
  if (!match) throw new ConfigError("whoami /user returned no Windows user SID.", "INVALID_CONFIG_FILE");
  return `S${match[0].slice(1)}`;
}

function defaultSchtasksFs(): SchtasksFs {
  return {
    ...nodeFs(),
    writeFile(file, content) {
      fs.writeFileSync(file, `﻿${content}`, { encoding: "utf16le" });
    },
    removeFile(file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    },
    tmpdir() {
      return os.tmpdir();
    },
  };
}
