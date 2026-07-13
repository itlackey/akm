// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// crontab backend for `akm tasks` (Linux default).
//
// Each akm-owned entry is wrapped in markers so a hand-edited crontab keeps
// its other lines untouched:
//
//     # akm:task <id> BEGIN
//     [SCHED] /abs/akm tasks run <id> >> /home/.../tasks/logs/<id>.log 2>&1
//     # akm:task <id> END
//
// The backend reads/writes the user's crontab via `crontab -l` and
// `crontab -`. Disabling a task comments the entry with `# akm:disabled `
// rather than removing it, so re-enabling preserves the original schedule.
//
// Platform notes:
//   • Operates on the *per-user* crontab — system-wide /etc/cron.d entries
//     are out of scope.
//   • Cron runs jobs with a stripped environment (`SHELL`, `PATH`, `HOME`,
//     `LOGNAME`/`USER` only). The cron line uses an absolute akm path
//     resolved at install time so it doesn't rely on the inherited PATH.
//   • BSD `crontab -l` returns exit 1 with "no crontab for <user>" on a
//     fresh user; we treat that as an empty crontab rather than an error.
//
// Tests inject a fake exec so unit tests don't touch the real crontab.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolve-akm-bin";
import { parseSchedule, translateToCron } from "../schedule";
import {
  buildScheduledTaskInvocation,
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
} from "../scheduler-invocation";
import type { TaskDocument } from "../schema";
import { nodeFs } from "./exec-utils";
import type { InstalledTaskRef, TaskBackend } from "./index";

export type CronExecResult = { status: number; stdout: string; stderr: string };

export interface CronExec {
  /** Read the user's current crontab. Empty string when none is installed. */
  read(): CronExecResult;
  /** Replace the user's crontab with the given content. */
  write(content: string): CronExecResult;
}

export interface CronFs {
  ensureDir(dir: string): void;
}

export interface CronBackendOptions {
  exec?: CronExec;
  fs?: CronFs;
  /** Override the absolute log directory. Defaults to {@link getTaskLogDir}. */
  logDir?: string;
  /** Override the akm invocation argv. Tests use this to skip resolution. */
  akmArgv?: string[];
  /** Override the PATH captured for the scheduled process. Set to false to omit it. */
  envPath?: string | false;
  /** Override the resolved non-secret AKM directory context. */
  scheduledContext?: ScheduledTaskContext;
}

const BEGIN = (id: string) => `# akm:task ${assertCronValue(id)} BEGIN`;
const END = (id: string) => `# akm:task ${assertCronValue(id)} END`;
const DISABLED_PREFIX = "# akm:disabled ";
const BLOCK_RE = /^# akm:task ([\w.@:_-]+) BEGIN$/;
const BLOCK_END_RE = /^# akm:task ([\w.@:_-]+) END$/;

export function CRON_BACKEND(options: CronBackendOptions = {}): TaskBackend {
  const exec = options.exec ?? defaultCronExec();
  const fsLike = options.fs ?? nodeFs();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;
  const envPath = options.envPath === false ? undefined : (options.envPath ?? process.env.PATH);
  const scheduledContext = options.scheduledContext ?? resolveScheduledTaskContext();

  return {
    name: "cron",
    install(task: TaskDocument) {
      // Create the log directory before writing the crontab line — cron
      // appends with `>>` and the surrounding shell will fail the entire
      // entry if the parent directory doesn't exist.
      fsLike.ensureDir(logDir);
      const cronLine = buildCronLine(task, akmArgv, logDir, envPath, scheduledContext);
      const existing = readCrontab(exec);
      const block = renderBlock(task.id, cronLine, task.enabled);
      const next = upsertBlock(existing, task.id, block);
      replaceCrontab(exec, existing, next);
    },
    uninstall(id: string) {
      const existing = readCrontab(exec);
      const next = removeBlock(existing, id);
      replaceCrontab(exec, existing, next);
    },
    setEnabled(id: string, enabled: boolean) {
      const existing = readCrontab(exec);
      const next = toggleBlock(existing, id, enabled);
      replaceCrontab(exec, existing, next);
    },
    list(): InstalledTaskRef[] {
      const existing = readCrontab(exec);
      return listBlocks(existing).map(({ id, body }) => ({ id, signature: normalizeSignature(body) }));
    },
    expectedSignature(task: TaskDocument): string {
      const cronLine = buildCronLine(task, akmArgv, logDir, envPath, scheduledContext);
      return normalizeSignature(cronBlockBody(cronLine, task.enabled));
    },
  };
}

// ── helpers (exported for tests) ────────────────────────────────────────────

export function buildCronLine(
  task: TaskDocument,
  akmArgv: string[],
  logDir: string,
  envPath: string | undefined,
  scheduledContext: ScheduledTaskContext,
): string {
  const spec = parseSchedule(task.schedule, "cron");
  const cronExpr = translateToCron(spec);
  const logPath = path.join(logDir, `${task.id}.log`);
  const invocation = buildScheduledTaskInvocation(akmArgv, task.id, scheduledContext);
  const cmd = invocation.argv.map((part) => quoteForCron(part)).join(" ");
  const contextPrefix = Object.entries(invocation.environment)
    .map(([key, value]) => `${key}=${quoteForCron(value)}`)
    .join(" ");
  const pathPrefix = envPath === undefined ? "" : `PATH=${quoteForCron(envPath)} `;
  return `${cronExpr} ${contextPrefix} ${pathPrefix}${cmd} >> ${quoteForCron(logPath)} 2>&1`;
}

/** The crontab line as it appears inside a block — commented when disabled. */
export function cronBlockBody(cronLine: string, enabled: boolean): string {
  return enabled ? cronLine : `${DISABLED_PREFIX}${cronLine}`;
}

export function renderBlock(id: string, cronLine: string, enabled: boolean): string {
  return [BEGIN(id), cronBlockBody(cronLine, enabled), END(id)].join("\n");
}

/**
 * Parse the akm-owned blocks out of a crontab, returning each task id with the
 * raw body line(s) between its BEGIN/END markers. Used by `list()` to build a
 * drift signature, and exported for tests.
 */
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
      currentId = begin[1];
      start = index;
      body = [];
      continue;
    }
    const end = line.match(BLOCK_END_RE);
    if (end) {
      if (currentId === null || end[1] !== currentId) throw malformedBlockError(currentId ?? end[1]);
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

/** Collapse incidental whitespace so signature comparison ignores it. */
function normalizeSignature(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
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
  // Collapse trailing blank lines.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function toggleBlock(existing: string, id: string, enabled: boolean): string {
  parseBlocks(existing);
  const lines = existing.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
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
      if (enabled && isComment) {
        out.push(line.slice(DISABLED_PREFIX.length));
      } else if (!enabled && !isComment) {
        out.push(`${DISABLED_PREFIX}${line}`);
      } else {
        out.push(line);
      }
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

function readCrontab(exec: CronExec): string {
  const result = exec.read();
  if (result.status === 0) return result.stdout ?? "";
  // BSD crontab returns 1 with "no crontab for <user>" on stderr — treat as empty.
  if (/no crontab for/i.test(result.stderr ?? "")) return "";
  if (/no crontab/i.test(result.stdout ?? "")) return "";
  throw new ConfigError(
    `crontab -l failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
    "INVALID_CONFIG_FILE",
    "Ensure the `crontab` binary is on PATH and your shell can read the user crontab.",
  );
}

function writeCrontab(exec: CronExec, content: string): void {
  const normalised = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  const result = exec.write(normalised);
  if (result.status !== 0) {
    throw new ConfigError(
      `crontab - failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}.`,
      "INVALID_CONFIG_FILE",
      "Ensure the `crontab` binary is on PATH and your shell can write the user crontab.",
    );
  }
}

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
  return {
    read(): CronExecResult {
      const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
      return {
        status: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
    write(content: string): CronExecResult {
      const r = spawnSync("crontab", ["-"], { encoding: "utf8", input: content });
      return {
        status: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
  };
}
