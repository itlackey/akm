// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// crontab backend for `akm task` (Linux default).
//
// akm's whole footprint in a crontab is one marked block, so a hand-edited
// crontab keeps its other lines untouched:
//
//     # akm:dispatch BEGIN
//     PATH=<captured when the block was written>
//     * * * * * /abs/akm task dispatch > <log> 2>&1
//     # akm:dispatch END
//
// The block sits at the end of the crontab so the PATH line, which cron applies
// to every line after it, reaches nothing but akm's own entry. Every change is
// one read, one write, with the prior crontab restored when the write fails.
//
// The per-task `# akm:task <id> BEGIN/END` blocks and the `# akm:env` block of
// akm 0.9 are found and removed here, in the same write, so nothing fires twice.
//
// BSD `crontab -l` returns exit 1 with "no crontab for <user>" on a fresh user;
// a supercronic-managed PATH shim (#910) does the same with empty stdout.
// Both mean "empty crontab". A missing `crontab` binary is an empty crontab to
// read, and an error only when something has to be written.
//
// Tests inject a fake exec so unit tests don't touch the real crontab.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { throwIfNotOk } from "./exec-utils";
import type { DispatchEntry, EntryChange, EntryInspection, LegacyRow, SchedulerBackend } from "./types";

export type CronExecResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** True when the `crontab` binary itself could not be spawned (ENOENT), not merely a nonzero exit. */
  enoent?: boolean;
  /** True when `crontab` failed in a process with no-new-privileges set (Linux `NoNewPrivs: 1`), which it inherits. */
  noNewPrivileges?: boolean;
};

export interface CronExec {
  /** Read the user's current crontab. Empty string when none is installed. */
  read(): CronExecResult;
  /** Replace the user's crontab with the given content. */
  write(content: string): CronExecResult;
}

export interface CronBackendOptions {
  exec?: CronExec;
  /** Override the absolute log directory. Defaults to {@link getTaskLogDir}. */
  logDir?: string;
  /** Create the log directory the entry redirects into (cron fails the whole line when it is missing). */
  ensureDir?: (dir: string) => void;
  /** Read an akm 0.9 wrapper script (a row too long for one cron line spilled into one). */
  readFile?: (file: string) => string;
  /** Remove such a script. */
  removeFile?: (file: string) => void;
}

const ENTRY_BEGIN = "# akm:dispatch BEGIN";
const ENTRY_END = "# akm:dispatch END";
const LEGACY_BEGIN_RE = /^# akm:task ([\w.@:_-]+) BEGIN$/;
const LEGACY_END_RE = /^# akm:task ([\w.@:_-]+) END$/;
const DISABLED_PREFIX = "# akm:disabled ";
const ENV_BEGIN = "# akm:env BEGIN";
const ENV_END = "# akm:env END";
const LEGACY_WRAPPER_PREFIX = ".akm-cron-wrapper-";
const SCHEDULE = "* * * * *";

export function CRON_BACKEND(options: CronBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? defaultCronExec();
  const logDir = options.logDir ?? getTaskLogDir();
  const ensureDir = options.ensureDir ?? ((dir: string) => void fs.mkdirSync(dir, { recursive: true }));
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const removeFile =
    options.removeFile ??
    ((file: string) => {
      fs.rmSync(file, { force: true });
    });

  const inspectText = (crontab: string): EntryInspection => {
    const entry = parseEntry(crontab);
    const legacy = parseLegacyBlocks(crontab).map((block) => legacyRow(block, readFile));
    return { ...(entry ? { entry } : {}), legacy };
  };

  return {
    name: "cron",
    inspect() {
      return inspectText(readCrontab(exec, { missingBinaryIsEmpty: true }));
    },
    apply(change: EntryChange) {
      const existing = readCrontab(exec, { missingBinaryIsEmpty: change.entry === undefined || change.entry === null });
      const blocks = parseLegacyBlocks(existing);
      const removed = new Set(change.removeLegacy);
      let next = removeLines(
        existing,
        blocks.filter((block) => removed.has(block.id)),
      );
      // The shared PATH header goes with the last legacy block it served.
      if (!parseLegacyBlocks(next).length) next = removeEnvBlock(next);
      if (change.entry !== undefined) {
        next = removeEntryBlock(next);
        if (change.entry !== null) {
          ensureDir(logDir);
          next = appendBlock(next, renderEntryBlock(change.entry, logDir));
        }
      }
      if (next !== existing) replaceCrontab(exec, existing, next);
      // Wrapper scripts of removed rows are of no use to anyone.
      for (const block of blocks) {
        const script = wrapperScript(block.line);
        if (removed.has(block.id) && script) {
          try {
            removeFile(script);
          } catch {
            // Best effort: a script that cannot be removed is left where it is.
          }
        }
      }
    },
  };
}

// ── the dispatch block ──────────────────────────────────────────────────────

/** The block `akm task sync` writes. Exported for tests. */
export function renderEntryBlock(entry: DispatchEntry, logDir: string): string {
  const command = [...entry.launcher, "task", "dispatch"].map(quoteForCron).join(" ");
  // #951: truncate (not append), so this bootstrap safety-net file holds exactly the latest run's raw output.
  const line = `${SCHEDULE} ${command} > ${quoteForCron(path.join(logDir, "dispatch.log"))} 2>&1`;
  const pathLine = entry.path ? [`PATH=${assertCronValue(dedupeSearchPath(entry.path))}`] : [];
  return [ENTRY_BEGIN, ...pathLine, line, ENTRY_END].join("\n");
}

function parseEntry(crontab: string): DispatchEntry | undefined {
  const lines = crontab.split(/\r?\n/);
  const begin = lines.indexOf(ENTRY_BEGIN);
  if (begin === -1) return undefined;
  const end = lines.indexOf(ENTRY_END, begin);
  if (end === -1) throw malformedBlockError("dispatch");
  const body = lines.slice(begin + 1, end);
  const pathValue = body.find((line) => line.startsWith("PATH="))?.slice("PATH=".length);
  const words = splitCronShellWords(body.find((line) => line.startsWith(`${SCHEDULE} `)) ?? "").slice(5);
  const redirect = words.indexOf(">");
  const command = redirect === -1 ? words : words.slice(0, redirect);
  if (command.length < 3 || command.at(-2) !== "task" || command.at(-1) !== "dispatch") return undefined;
  return { launcher: command.slice(0, -2), ...(pathValue ? { path: pathValue } : {}) };
}

function removeEntryBlock(crontab: string): string {
  const lines = crontab.split(/\r?\n/);
  const begin = lines.indexOf(ENTRY_BEGIN);
  if (begin === -1) return crontab;
  const end = lines.indexOf(ENTRY_END, begin);
  if (end === -1) throw malformedBlockError("dispatch");
  return trimTrailingBlank([...lines.slice(0, begin), ...lines.slice(end + 1)]).join("\n");
}

function appendBlock(crontab: string, block: string): string {
  const trimmed = crontab.replace(/\s+$/g, "");
  return `${trimmed}${trimmed.length === 0 ? "" : "\n"}${block}\n`;
}

// ── akm 0.9 rows ────────────────────────────────────────────────────────────

interface LegacyBlock {
  id: string;
  line: string;
  start: number;
  end: number;
}

function parseLegacyBlocks(crontab: string): LegacyBlock[] {
  const blocks: LegacyBlock[] = [];
  let current: { id: string; start: number; body: string[] } | undefined;
  for (const [index, text] of crontab.split(/\r?\n/).entries()) {
    const begin = text.match(LEGACY_BEGIN_RE);
    if (begin) {
      if (current) throw malformedBlockError(current.id);
      current = { id: begin[1] as string, start: index, body: [] };
      continue;
    }
    const end = text.match(LEGACY_END_RE);
    if (end) {
      if (!current || end[1] !== current.id) throw malformedBlockError(current?.id ?? (end[1] as string));
      blocks.push({ id: current.id, line: current.body.join("\n"), start: current.start, end: index });
      current = undefined;
      continue;
    }
    if (current) current.body.push(text);
  }
  if (current) throw malformedBlockError(current.id);
  return blocks;
}

/** A row's own `AKM_*` assignments: inline before the command, or `export`ed by its wrapper script. */
function legacyRow(block: LegacyBlock, readFile: (file: string) => string): LegacyRow {
  const body = block.line.startsWith(DISABLED_PREFIX) ? block.line.slice(DISABLED_PREFIX.length) : block.line;
  const words = splitCronShellWords(body).slice(5);
  const environment: Record<string, string> = {};
  const take = (word: string | undefined): boolean => {
    const assignment = word === undefined ? null : /^(AKM_[A-Z_]+)=(.*)$/s.exec(word);
    if (assignment) environment[assignment[1] as string] = assignment[2] as string;
    return assignment !== null;
  };
  for (const word of words) if (!take(word)) break;
  const script = wrapperScript(block.line);
  if (script) {
    try {
      for (const text of readFile(script).split("\n")) {
        const exported = splitCronShellWords(text);
        if (exported[0] === "export") take(exported[1]);
      }
    } catch {
      // A script that is gone names no installation; the row is still removable.
    }
  }
  return { id: block.id, environment };
}

function wrapperScript(line: string): string | undefined {
  const body = line.startsWith(DISABLED_PREFIX) ? line.slice(DISABLED_PREFIX.length) : line;
  const words = splitCronShellWords(body);
  const script = words[6];
  return words[5] === "sh" && script && path.basename(script).startsWith(LEGACY_WRAPPER_PREFIX) ? script : undefined;
}

function removeLines(crontab: string, blocks: readonly LegacyBlock[]): string {
  if (blocks.length === 0) return crontab;
  const lines = crontab.split(/\r?\n/);
  return trimTrailingBlank(lines.filter((_, index) => !blocks.some((b) => index >= b.start && index <= b.end))).join(
    "\n",
  );
}

function removeEnvBlock(crontab: string): string {
  const lines = crontab.split(/\r?\n/);
  const start = lines.indexOf(ENV_BEGIN);
  if (start === -1) return crontab;
  const end = lines.indexOf(ENV_END, start);
  if (end === -1) {
    throw new ConfigError(
      "Crontab contains a malformed akm environment section; refusing to modify it.",
      "INVALID_CONFIG_FILE",
    );
  }
  return trimTrailingBlank([...lines.slice(0, start), ...lines.slice(end + 1)]).join("\n");
}

function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function malformedBlockError(id: string): ConfigError {
  return new ConfigError(
    `Crontab contains a malformed akm block for "${id}"; refusing to modify it.`,
    "INVALID_CONFIG_FILE",
  );
}

// ── quoting ─────────────────────────────────────────────────────────────────

/** Reverse {@link quoteForCron}: sh word splitting, where a backslash is literal inside single quotes. */
function splitCronShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  let pending = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char === "'") {
      quoted = !quoted;
      pending = true;
      continue;
    }
    if (!quoted && char === "\\" && index + 1 < value.length) {
      current += value[index + 1];
      pending = true;
      index += 1;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (pending) words.push(current);
      current = "";
      pending = false;
      continue;
    }
    current += char;
    pending = true;
  }
  if (pending) words.push(current);
  return words;
}

function quoteForCron(part: string): string {
  assertCronValue(part);
  // crontab passes the rest of the line to /bin/sh -c, so quote anything that
  // isn't a plain shell-safe token. Single-quote and escape embedded single
  // quotes via the standard shell idiom: `'foo'\''bar'`. Cron interprets `%`
  // before the shell, even inside quotes, so close the quote around its escape.
  if (/^[A-Za-z0-9_\-./@:%=+,]+$/.test(part)) return part.replaceAll("%", "\\%");
  return `'${part.replace(/'/g, `'\\''`).replace(/%/g, `'\\%'`)}'`;
}

function assertCronValue(value: string): string {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new ConfigError("Cron values must not contain control characters.", "INVALID_CONFIG_FILE");
    }
  }
  return value;
}

function dedupeSearchPath(value: string): string {
  return [...new Set(value.split(path.delimiter).filter((entry) => entry.length > 0))].join(path.delimiter);
}

// ── crontab I/O ─────────────────────────────────────────────────────────────

function readCrontab(exec: CronExec, options: { missingBinaryIsEmpty: boolean }): string {
  const result = exec.read();
  if (result.status === 0) return result.stdout ?? "";
  // The spawn itself failed to find the binary (ENOENT): nothing is installed to read; writing needs it.
  if (result.enoent) {
    if (options.missingBinaryIsEmpty) return "";
    throw new ConfigError(
      "crontab -l failed: the `crontab` binary was not found on PATH.",
      "SCHEDULER_UNAVAILABLE",
      "Install the `crontab` binary (e.g. cron/cronie/vixie-cron) or add one to PATH.",
    );
  }
  // #910: a nonzero exit that says nothing at all, or whose stderr says
  // "no crontab" (BSD's "no crontab for <user>"; a supercronic-managed PATH
  // shim like OpenPalm's before any spool exists), is cron's own contract
  // for "empty crontab". A nonzero exit that DID say something else (a
  // permission refusal) is reported as what it said.
  const stderr = (result.stderr ?? "").trim();
  if (((result.stdout ?? "").trim() === "" && stderr === "") || /no crontab/i.test(stderr)) return "";
  // `crontab` reads the spool through its setgid `crontab` group (setuid root on some distributions). A process
  // started with no-new-privileges (an agent sandbox, a container, systemd `NoNewPrivileges=`) runs it without that
  // privilege, and the spool refuses the read. The crontab itself is fine, so say so instead of passing on a bare
  // `fopen` error. Without no-new-privileges a refusal has another cause and is reported as what it said.
  if (result.noNewPrivileges && /permission denied/i.test(stderr)) {
    throw new ConfigError(
      "crontab -l could not read the crontab spool (permission denied). `crontab` reads it through its setgid " +
        "(or setuid) bit, which this process, started with no-new-privileges (an agent sandbox, a container, " +
        "systemd NoNewPrivileges=), does not grant; run this from a normal shell to see the installed tasks.",
      "SCHEDULER_UNAVAILABLE",
      "Run the command from a normal login shell or terminal, not from a sandboxed process.",
    );
  }
  throw new ConfigError(
    `crontab -l failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
    "SCHEDULER_UNAVAILABLE",
    "The `crontab` binary ran but did not report success; check its output above.",
  );
}

function writeCrontab(exec: CronExec, content: string): void {
  const normalised = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  throwIfNotOk(exec.write(normalised), {
    message: (r) => `crontab - failed (exit ${r.status}): ${r.stderr || r.stdout || "no output"}.`,
    hint: "Ensure the `crontab` binary is on PATH and your shell can write the user crontab.",
  });
}

/** Write the next crontab; when that fails, put the prior one back before rethrowing. */
function replaceCrontab(exec: CronExec, existing: string, next: string): void {
  try {
    writeCrontab(exec, next);
  } catch (err) {
    try {
      writeCrontab(exec, existing);
    } catch (rollbackError) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AggregateError([err, rollbackError], `${message}; restoring the prior crontab also failed.`);
    }
    throw err;
  }
}

/** Whether this process has Linux's no-new-privileges flag, which every child (`crontab` included) inherits. */
function hasNoNewPrivileges(): boolean {
  try {
    return /^NoNewPrivs:\s*1$/m.test(fs.readFileSync("/proc/self/status", "utf8"));
  } catch {
    return false;
  }
}

function defaultCronExec(): CronExec {
  const run = (args: string[], input?: string): CronExecResult => {
    const r = spawnSync("crontab", args, { encoding: "utf8", ...(input !== undefined ? { input } : {}) });
    return {
      status: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      enoent: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
      noNewPrivileges: r.status !== 0 && hasNoNewPrivileges(),
    };
  };
  return {
    read: () => run(["-l"]),
    write: (content) => run(["-"], content),
  };
}
