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
// `crontab -`. Tests inject a fake exec so unit tests don't touch the real
// crontab.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { getTaskLogDir } from "../../core/paths";
import { resolveAkmInvocation } from "../resolveAkmBin";
import { parseSchedule, translateToCron } from "../schedule";
import type { TaskDocument } from "../schema";
import type { InstalledTaskRef, TaskBackend } from "./index";

export type CronExecResult = { status: number; stdout: string; stderr: string };

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
  /** Override the akm invocation argv. Tests use this to skip resolution. */
  akmArgv?: string[];
}

const BEGIN = (id: string) => `# akm:task ${id} BEGIN`;
const END = (id: string) => `# akm:task ${id} END`;
const DISABLED_PREFIX = "# akm:disabled ";
const BLOCK_RE = /^# akm:task ([\w.@:_-]+) BEGIN$/;

export function CRON_BACKEND(options: CronBackendOptions = {}): TaskBackend {
  const exec = options.exec ?? defaultCronExec();
  const logDir = options.logDir ?? getTaskLogDir();
  const akmArgv = options.akmArgv ?? resolveAkmInvocation().argv;

  return {
    name: "cron",
    install(task: TaskDocument) {
      // Create the log directory before writing the crontab line — cron
      // appends with `>>` and the surrounding shell will fail the entire
      // entry if the parent directory doesn't exist.
      ensureDir(logDir);
      const cronLine = buildCronLine(task, akmArgv, logDir);
      const existing = readCrontab(exec);
      const block = renderBlock(task.id, cronLine, task.enabled);
      const next = upsertBlock(existing, task.id, block);
      writeCrontab(exec, next);
    },
    uninstall(id: string) {
      const existing = readCrontab(exec);
      const next = removeBlock(existing, id);
      writeCrontab(exec, next);
    },
    setEnabled(id: string, enabled: boolean) {
      const existing = readCrontab(exec);
      const next = toggleBlock(existing, id, enabled);
      writeCrontab(exec, next);
    },
    list(): InstalledTaskRef[] {
      const existing = readCrontab(exec);
      const ids: string[] = [];
      for (const line of existing.split(/\r?\n/)) {
        const m = line.match(BLOCK_RE);
        if (m) ids.push(m[1]);
      }
      return ids.map((id) => ({ id }));
    },
  };
}

// ── helpers (exported for tests) ────────────────────────────────────────────

export function buildCronLine(task: TaskDocument, akmArgv: string[], logDir: string): string {
  const spec = parseSchedule(task.schedule, "cron");
  const cronExpr = translateToCron(spec);
  const logPath = path.join(logDir, `${task.id}.log`);
  const cmd = [...akmArgv, "tasks", "run", task.id].map((part) => quoteForCron(part)).join(" ");
  return `${cronExpr} ${cmd} >> ${quoteForCron(logPath)} 2>&1`;
}

export function renderBlock(id: string, cronLine: string, enabled: boolean): string {
  const body = enabled ? cronLine : `${DISABLED_PREFIX}${cronLine}`;
  return [BEGIN(id), body, END(id)].join("\n");
}

export function upsertBlock(existing: string, id: string, block: string): string {
  const trimmed = existing.replace(/\s+$/g, "");
  const removed = removeBlock(trimmed, id);
  const sep = removed.length === 0 ? "" : "\n";
  return `${removed}${sep}${block}\n`;
}

export function removeBlock(existing: string, id: string): string {
  const lines = existing.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock && line === BEGIN(id)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === END(id)) {
      inBlock = false;
      continue;
    }
    if (inBlock) continue;
    out.push(line);
  }
  // Collapse trailing blank lines.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function toggleBlock(existing: string, id: string, enabled: boolean): string {
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
  // crontab passes the rest of the line to /bin/sh -c, so quote anything that
  // isn't a plain shell-safe token. Single-quote and escape embedded single
  // quotes via the standard shell idiom: `'foo'\''bar'`.
  if (/^[A-Za-z0-9_\-./@:%=+,]+$/.test(part)) return part;
  return `'${part.replace(/'/g, `'\\''`)}'`;
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

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort: the install will surface a clearer error if the cron
    // line later fails at runtime due to a missing redirection target.
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
