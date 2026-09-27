// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// crontab backend for `akm task` (Linux default).
//
// Each akm-owned entry is wrapped in markers so a hand-edited crontab keeps
// its other lines untouched:
//
//     # akm:task <id> BEGIN
//     [SCHED] /abs/akm --scheduler-context <descriptor> task run <id> ... > <log> 2>&1
//     # akm:task <id> END
//
// The backend reads/writes the user's crontab via `crontab -l` and
// `crontab -`. Every mutation is one read → modify the akm blocks (and the
// `# akm:env` PATH header) → one write, with the prior crontab restored when
// the write fails. Disabling a task comments the entry with `# akm:disabled `
// rather than removing it, so re-enabling preserves the original schedule.
//
// Platform notes:
//   • Operates on the *per-user* crontab — system-wide /etc/cron.d entries
//     are out of scope.
//   • Cron runs jobs with a stripped environment (`SHELL`, `PATH`, `HOME`,
//     `LOGNAME`/`USER` only). The cron line uses an absolute akm path
//     resolved at install time so it doesn't rely on the inherited PATH.
//   • BSD `crontab -l` returns exit 1 with "no crontab for <user>" on a
//     fresh user; a supercronic-managed PATH shim (#910, e.g. OpenPalm's
//     `/tmp/openpalm-bin/crontab` before any spool exists) does the same
//     with empty stdout instead. Both mean "empty crontab", not "broken
//     install" — only a genuinely missing binary (ENOENT from the spawn
//     itself) gets the "install crontab" remedy.
//
// Tests inject a fake exec so unit tests don't touch the real crontab.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { parseSchedule, translateToCron } from "../schedule";
import { type SchedulerBinding, schedulerBindingNativeId, schedulerLogicalBindingId } from "../scheduler-binding";
import {
  buildScheduledBindingInvocation,
  type ParsedScheduledBindingInvocation,
  parsePublicSchedulerInvocation,
  parseScheduledBindingArgv,
  resolveScheduledTaskContext,
  SCHEDULER_CONTEXT_ARG,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../scheduler-invocation";
import { type NodeFs, nodeFs, throwIfNotOk } from "./exec-utils";
import type { InstalledSchedulerBinding, SchedulerBackend, SchedulerInstallOptions } from "./types";

export type CronExecResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** True when the `crontab` binary itself could not be spawned (ENOENT), not merely a nonzero exit. */
  enoent?: boolean;
};

export interface CronExec {
  /** Read the user's current crontab. Empty string when none is installed. */
  read(): CronExecResult;
  /** Replace the user's crontab with the given content. */
  write(content: string): CronExecResult;
}

export type CronFs = Pick<NodeFs, "ensureDir"> & Partial<Pick<NodeFs, "writeFile">>;

export interface CronBackendOptions {
  exec?: CronExec;
  fs?: CronFs;
  /** Override the absolute log directory. Defaults to {@link getTaskLogDir}. */
  logDir?: string;
  /** Override the akm invocation argv. Tests use this to skip resolution. */
  akmArgv?: string[];
  /** Override the PATH written to the crontab's akm section. Set to false to omit it. */
  envPath?: string | false;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
}

const BEGIN = (id: string) => `# akm:task ${assertCronValue(id)} BEGIN`;
const END = (id: string) => `# akm:task ${assertCronValue(id)} END`;
const DISABLED_PREFIX = "# akm:disabled ";
const BLOCK_RE = /^# akm:task ([\w.@:_-]+) BEGIN$/;
const BLOCK_END_RE = /^# akm:task ([\w.@:_-]+) END$/;
const ENV_BEGIN = "# akm:env BEGIN";
const ENV_END = "# akm:env END";
export const PORTABLE_CRON_LINE_LIMIT = 1000;
const CRON_WRAPPER_PREFIX = ".akm-cron-wrapper-";

export function CRON_BACKEND(options: CronBackendOptions = {}): SchedulerBackend {
  const exec = options.exec ?? defaultCronExec();
  const fsLike = options.fs ?? nodeFs();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const envPath = options.envPath === false ? undefined : (options.envPath ?? process.env.PATH);
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();
  const defaultContextPath = schedulerContextPath(schedulerContextDescriptor(scheduledContext));
  const lineFor = (task: SchedulerBinding, opts?: SchedulerInstallOptions) =>
    buildCronLineParts(task, [...(opts?.binding ?? akmArgv)], logDir, opts?.contextPath ?? defaultContextPath);

  return {
    name: "cron",
    install(task, opts) {
      const parts = lineFor(task, opts);
      assertPortableCronLine(parts.line);
      // The redirect target's parent directory must exist or the surrounding
      // shell fails the entire entry.
      fsLike.ensureDir(logDir);
      if (parts.wrapper) {
        if (!fsLike.writeFile) {
          throw new ConfigError(
            "Cron backend needs to write a wrapper script for this task's long invocation, but the configured filesystem cannot write files.",
            "INVALID_CONFIG_FILE",
          );
        }
        fsLike.writeFile(parts.wrapper.path, parts.wrapper.content);
      }
      const existing = readCrontab(exec);
      const nativeId = schedulerBindingNativeId(task);
      const block = renderBlock(nativeId, parts.line, task.enabled);
      replaceCrontab(exec, existing, upsertEnvBlock(upsertBlock(existing, nativeId, block), envPath));
    },
    uninstall(nativeId) {
      const existing = readCrontab(exec);
      if (!listBlocks(existing).some((block) => block.id === nativeId)) return;
      replaceCrontab(exec, existing, upsertEnvBlock(removeBlock(existing, nativeId), envPath));
    },
    setEnabled(nativeId, enabled) {
      const existing = readCrontab(exec);
      const next = toggleBlock(existing, nativeId, enabled);
      if (next !== existing) replaceCrontab(exec, existing, next);
    },
    list() {
      const rows: InstalledSchedulerBinding[] = [];
      for (const { id, body } of listBlocks(readCrontab(exec))) {
        const parsed = extractCronInvocation(body);
        if (!parsed) continue;
        rows.push({
          id: schedulerLogicalBindingId(id, parsed.invocation),
          nativeId: id,
          enabled: !cronIsDisabled(body),
          signature: normalizeSignature(body),
          ...(parsed.target !== undefined ? { target: parsed.target } : {}),
          binding: parsed.binding,
          // A pre-0.9.2 row has no descriptor of its own (#881); it reads as
          // the current one so ownership resolves and sync rewrites it.
          contextPath: parsed.contextPath || defaultContextPath,
          invocation: parsed.invocation,
        });
      }
      return rows;
    },
    expectedSignature(task, opts) {
      const line = lineFor(task, opts).line;
      assertPortableCronLine(line);
      return normalizeSignature(cronBlockBody(line, task.enabled));
    },
  };
}

// ── helpers (exported for tests) ────────────────────────────────────────────

export interface CronWrapperScript {
  readonly path: string;
  readonly content: string;
}

export interface CronLineResult {
  readonly line: string;
  readonly wrapper?: CronWrapperScript;
}

function buildCronLineParts(
  task: SchedulerBinding,
  akmArgv: string[],
  logDir: string,
  contextPath: string,
): CronLineResult {
  const cronExpr = translateToCron(parseSchedule(task.cron, "cron"));
  const nativeId = schedulerBindingNativeId(task);
  const logPath = path.join(logDir, `${nativeId}.log`);
  const invocation = buildScheduledBindingInvocation(akmArgv, contextPath, task.invocation);
  const cmd = invocation.argv.map((part) => quoteForCron(part)).join(" ");
  // #951: truncate (not append) so this bootstrap safety-net file always
  // holds exactly the latest run's raw output. akm's own per-run log
  // (src/tasks/run/task-log.ts) keeps history.
  const directLine = `${cronExpr} ${cmd} > ${quoteForCron(logPath)} 2>&1`;
  if (Buffer.byteLength(directLine, "utf8") <= PORTABLE_CRON_LINE_LIMIT) return { line: directLine };
  // A command over vixie-cron's MAX_COMMAND is spilled into a short wrapper
  // script under logDir instead of being truncated or refused.
  const content = `#!/bin/sh\nexec ${invocation.argv.map(quoteForShellScript).join(" ")}\n`;
  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const wrapperPath = path.join(logDir, `${CRON_WRAPPER_PREFIX}${nativeId}-${contentHash}.sh`);
  const line = `${cronExpr} sh ${quoteForCron(wrapperPath)} > ${quoteForCron(logPath)} 2>&1`;
  return { line, wrapper: { path: wrapperPath, content } };
}

function quoteForShellScript(part: string): string {
  if (/^[A-Za-z0-9_\-./@:=+,]+$/.test(part)) return part;
  return `'${part.replace(/'/g, `'\\''`)}'`;
}

export function buildCronLine(task: SchedulerBinding, akmArgv: string[], logDir: string, contextPath: string): string {
  return buildCronLineParts(task, akmArgv, logDir, contextPath).line;
}

/** The crontab line as it appears inside a block — commented when disabled. */
export function cronBlockBody(cronLine: string, enabled: boolean): string {
  return enabled ? cronLine : `${DISABLED_PREFIX}${cronLine}`;
}

export function renderBlock(id: string, cronLine: string, enabled: boolean): string {
  return [BEGIN(id), cronBlockBody(cronLine, enabled), END(id)].join("\n");
}

/** The akm-owned blocks of a crontab: each id with the raw body between its BEGIN/END markers. */
export function listBlocks(existing: string): Array<{ id: string; body: string }> {
  return parseBlocks(existing).map(({ id, body }) => ({ id, body }));
}

interface ParsedCronBlock {
  id: string;
  body: string;
  start: number;
  end: number;
}

function parseBlocks(existing: string): ParsedCronBlock[] {
  const out: ParsedCronBlock[] = [];
  const lines = existing.split(/\r?\n/);
  let currentId: string | null = null;
  let start = -1;
  let body: string[] = [];
  for (const [index, line] of lines.entries()) {
    const begin = line.match(BLOCK_RE);
    if (begin) {
      if (currentId !== null) throw malformedBlockError(currentId);
      currentId = begin[1]!;
      start = index;
      body = [];
      continue;
    }
    const end = line.match(BLOCK_END_RE);
    if (end) {
      if (currentId === null || end[1] !== currentId) throw malformedBlockError(currentId ?? end[1]!);
      out.push({ id: currentId, body: body.join("\n"), start, end: index });
      currentId = null;
      start = -1;
      body = [];
      continue;
    }
    if (currentId !== null) body.push(line);
  }
  if (currentId !== null) throw malformedBlockError(currentId);
  return out;
}

function malformedBlockError(id: string): ConfigError {
  return new ConfigError(
    `Crontab contains a malformed akm task block for "${id}"; refusing to modify it.`,
    "INVALID_CONFIG_FILE",
  );
}

/** The `--bundle <bundle>` token of an installed cron body; undefined for the primary/default form. */
export function extractInstalledTarget(body: string): string | undefined {
  return extractCronInvocation(body)?.target;
}

export function extractCronInvocation(body: string): ParsedScheduledBindingInvocation | undefined {
  const line = body.startsWith(DISABLED_PREFIX) ? body.slice(DISABLED_PREFIX.length) : body;
  const fields = splitCronShellWords(line);
  if (fields.length < 6) return undefined;
  let commandStart = 5;
  while (commandStart < fields.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(fields[commandStart]!)) commandStart += 1;
  // #951: new rows redirect with `>`; rows written before that use `>>`.
  const redirectIndex = fields.findIndex((field, index) => index >= commandStart && (field === ">" || field === ">>"));
  if (redirectIndex === -1) return undefined;
  const tail = fields.slice(commandStart, redirectIndex);
  const parsed = parseScheduledBindingArgv(tail);
  if (parsed) return parsed;
  // Rows written by akm < 0.9.2 have no `--scheduler-context` argument at
  // all — the akm argv is followed directly by the public `task run …` /
  // `workflow run …` tail (#881). This only ever runs on a body already
  // isolated between akm's own BEGIN/END markers, so recognizing the older
  // shape extends no trust to unmarked crontab lines. A row that DOES carry
  // the marker but fails to parse is never reinterpreted as legacy.
  if (tail.includes(SCHEDULER_CONTEXT_ARG)) return undefined;
  for (let index = 0; index < tail.length - 1; index += 1) {
    if ((tail[index] === "task" || tail[index] === "workflow") && tail[index + 1] === "run") {
      const publicInvocation = parsePublicSchedulerInvocation(tail.slice(index));
      if (!publicInvocation) return undefined;
      return {
        binding: tail.slice(0, index),
        contextPath: "",
        invocation: publicInvocation.invocation,
        ...(publicInvocation.target !== undefined ? { target: publicInvocation.target } : {}),
      };
    }
  }
  return undefined;
}

/** Reverse {@link quoteForCron} for a single whitespace-free token. */
function splitCronShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "'") {
      quoted = !quoted;
      continue;
    }
    if (char === "\\" && index + 1 < value.length) {
      current += value[index + 1];
      index += 1;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

/** Collapse incidental whitespace so signature comparison ignores it. */
function normalizeSignature(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function cronIsDisabled(body: string): boolean {
  return body.trimStart().startsWith(DISABLED_PREFIX);
}

export function upsertBlock(existing: string, id: string, block: string): string {
  const trimmed = existing.replace(/\s+$/g, "");
  const removed = removeBlock(trimmed, id);
  const sep = removed.length === 0 ? "" : "\n";
  return `${removed}${sep}${block}\n`;
}

export function removeBlock(existing: string, id: string): string {
  const lines = existing.split(/\r?\n/);
  const blocks = parseBlocks(existing).filter((block) => block.id === id);
  if (blocks.length === 0) return existing;
  const out = lines.filter((_, index) => !blocks.some((block) => index >= block.start && index <= block.end));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * akm's managed environment section: one `PATH=` line directly above the
 * first akm task block. Cron applies an environment assignment to every
 * command line after it, which is why the line sits immediately above akm's
 * own rows rather than at the top of the crontab; it is plain text a person
 * can edit with `crontab -e`, rewritten on every akm crontab write and
 * removed together with the last akm task block.
 */
export function renderEnvBlock(envPath: string): string {
  return [ENV_BEGIN, `PATH=${assertCronValue(dedupeSearchPath(envPath))}`, ENV_END].join("\n");
}

export function upsertEnvBlock(existing: string, envPath: string | undefined): string {
  const lines = removeEnvBlock(existing).split(/\r?\n/);
  const firstBlock = lines.findIndex((line) => BLOCK_RE.test(line));
  if (!envPath || firstBlock === -1) return lines.join("\n");
  return [...lines.slice(0, firstBlock), renderEnvBlock(envPath), ...lines.slice(firstBlock)].join("\n");
}

export function removeEnvBlock(existing: string): string {
  const lines = existing.split(/\r?\n/);
  const start = lines.indexOf(ENV_BEGIN);
  if (start === -1) return existing;
  const end = lines.indexOf(ENV_END, start);
  if (end === -1) {
    throw new ConfigError(
      "Crontab contains a malformed akm environment section; refusing to modify it.",
      "INVALID_CONFIG_FILE",
    );
  }
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
}

function dedupeSearchPath(value: string): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of value.split(path.delimiter)) {
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join(path.delimiter);
}

export function toggleBlock(existing: string, id: string, enabled: boolean): string {
  parseBlocks(existing);
  const out: string[] = [];
  let inBlock = false;
  for (const line of existing.split(/\r?\n/)) {
    if (!inBlock && line === BEGIN(id)) {
      inBlock = true;
      out.push(line);
      continue;
    }
    if (inBlock && line === END(id)) {
      inBlock = false;
      out.push(line);
      continue;
    }
    if (inBlock) {
      const isComment = line.startsWith(DISABLED_PREFIX);
      if (enabled && isComment) out.push(line.slice(DISABLED_PREFIX.length));
      else if (!enabled && !isComment) out.push(`${DISABLED_PREFIX}${line}`);
      else out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
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

function assertPortableCronLine(line: string): void {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > PORTABLE_CRON_LINE_LIMIT) {
    throw new ConfigError(
      `Generated cron definition is ${bytes} bytes; portable cron command lines are limited to ${PORTABLE_CRON_LINE_LIMIT} bytes.`,
      "INVALID_CONFIG_FILE",
    );
  }
}

function readCrontab(exec: CronExec): string {
  const result = exec.read();
  if (result.status === 0) return result.stdout ?? "";
  // The spawn itself failed to find the binary (ENOENT) — the only case
  // where "install/PATH the crontab binary" is the correct remedy.
  if (result.enoent) {
    throw new ConfigError(
      "crontab -l failed: the `crontab` binary was not found on PATH.",
      "INVALID_CONFIG_FILE",
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
  throw new ConfigError(
    `crontab -l failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
    "INVALID_CONFIG_FILE",
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

function defaultCronExec(): CronExec {
  const run = (args: string[], input?: string): CronExecResult => {
    const r = spawnSync("crontab", args, { encoding: "utf8", ...(input !== undefined ? { input } : {}) });
    return {
      status: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      enoent: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
    };
  };
  return {
    read: () => run(["-l"]),
    write: (content) => run(["-"], content),
  };
}
