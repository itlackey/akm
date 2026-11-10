// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task dispatch`: the one thing the OS scheduler runs, once a minute.
 *
 * It reads `scheduler.enabled`, parses only those task files, matches each
 * `schedule:` against the minutes since the last dispatch, skips a task that
 * already has a run in flight, starts every due task as a detached
 * `akm task run <id> --bundle <b> --scheduled`, and exits. No database is
 * opened unless something is due. Nothing about the schedule is copied into
 * the OS: a task file edit takes effect on the next minute.
 *
 * The last dispatched minute is kept in a small file under the state dir, so a
 * late or skipped start does not drop a minute; catch-up is capped at
 * {@link DISPATCH_WINDOW_MINUTES}, and a task due in several of those minutes
 * runs once.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../core/adapter/detect-adapter";
import { parseBundleRef } from "../core/asset/asset-ref";
import { isProcessAlive } from "../core/common";
import { loadConfig } from "../core/config/config";
import type { AkmConfig } from "../core/config/config-types";
import { getStateDir, getTaskLogDir } from "../core/paths";
import { withStateDb } from "../core/state-db";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import { listActiveTaskRuns } from "../storage/repositories/task-history-repository";
import { schedulerEnabledRefs } from "./activation-config";
import { resolveAkmInvocation } from "./resolve-akm-bin";
import { activeTaskSources } from "./run/load-task";
import { DEFAULT_SCHEDULED_TASK_TIMEOUT_MS } from "./run/run-workflow-task";
import { parseSchedule, scheduleMatchesMinute } from "./schedule";
import { parseTaskSource } from "./source/parse-task-source";

/** The most minutes one dispatch looks back over: a skew or short sleep, not a catch-up of downtime. */
export const DISPATCH_WINDOW_MINUTES = 5;

const MINUTE_MS = 60_000;

export interface DispatchedTask {
  ref: string;
  id: string;
  bundle: string;
  /** `schedule[i].inputs` of the entry that matched, as `task run` flags. */
  inputFlags: string[];
}

export interface TaskDispatchResult {
  /** The minute dispatched, local ISO without seconds. */
  minute: string;
  /** How many minutes were evaluated (1 normally, up to {@link DISPATCH_WINDOW_MINUTES} after a late start). */
  window: number;
  started: string[];
  /** Due tasks that were not started, each with the reason (a run still in flight). */
  skipped: { ref: string; reason: string }[];
  /** Enabled tasks that could not be read or started. */
  failures: { ref: string; reason: string }[];
}

export interface DispatchDeps {
  now?: () => Date;
  config?: AkmConfig;
  /** The launcher argv `task run` is started through; resolved from this process when absent. */
  launcher?: readonly string[];
  /** Replaces the detached `spawn` (tests). */
  start?: (argv: readonly string[], logPath: string) => Promise<void>;
  statePath?: string;
  logDir?: string;
}

function lastMinutePath(): string {
  return path.join(getStateDir(), "scheduler", "dispatch-minute");
}

function readLastMinute(file: string): number | undefined {
  try {
    const value = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeLastMinute(file: string, minute: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${minute}\n`);
  fs.renameSync(temp, file);
}

/** The epoch minutes to evaluate: those since the last dispatched one, at most the window, never one already done. */
export function minutesToEvaluate(current: number, last: number | undefined): number[] {
  // Same minute (or the clock a little behind the last one): already dispatched.
  if (last !== undefined && last >= current && last - current <= DISPATCH_WINDOW_MINUTES) return [];
  // No last minute, or one so far ahead that the clock was set back: only this minute.
  const behind = last === undefined || last > current ? 1 : current - last;
  const count = Math.min(behind, DISPATCH_WINDOW_MINUTES);
  return Array.from({ length: count }, (_, index) => current - count + 1 + index);
}

function localMinuteLabel(minute: number): string {
  const at = new Date(minute * MINUTE_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** `--<name> <value>` flags for one schedule entry's inputs; a value starting with `-` uses `--name=value`. */
function inputFlagTail(inputs: Readonly<Record<string, unknown>> | undefined): string[] {
  const tail: string[] = [];
  for (const name of Object.keys(inputs ?? {}).sort()) {
    const value = (inputs as Record<string, unknown>)[name];
    const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (text.startsWith("-")) tail.push(`--${name}=${text}`);
    else tail.push(`--${name}`, text);
  }
  return tail;
}

/** One enabled ref read as dispatch reads it: where it lives, and the schedule entries it carries. */
function readEnabledTask(ref: string, sources: ReturnType<typeof activeTaskSources>) {
  const parsedRef = parseBundleRef(ref);
  const bundle = parsedRef.bundle as string;
  const source = resolveSourcesForOrigin(bundle, sources)[0];
  if (!source) throw new Error(`bundle ${JSON.stringify(bundle)} is not active on this host`);
  const adapterId = source.adapterId ?? detectAdapterId(source.path);
  const file = path.join(source.path, `${parsedRef.conceptId}.yml`);
  const parsed = parseTaskSource({ yaml: fs.readFileSync(file, "utf8"), filePath: file });
  const id = adapterId === "akm" ? parsedRef.conceptId.replace(/^tasks\//, "") : parsedRef.conceptId;
  return { id, bundle, schedule: parsed.v4.schedule.map((entry) => ({ ...entry, spec: parseSchedule(entry.cron) })) };
}

/**
 * The enabled tasks dispatch cannot run (a missing or unreadable file, an inactive bundle, a schedule the grammar
 * rejects), each with the reason. Dispatch reports the same failures, but only in a log that is rewritten every
 * minute; `task doctor` and `akm health` read them here.
 */
export function unrunnableTasks(config: AkmConfig = loadConfig()): { ref: string; reason: string }[] {
  const failures: { ref: string; reason: string }[] = [];
  for (const ref of schedulerEnabledRefs(config) ?? []) {
    try {
      readEnabledTask(ref, activeTaskSources(config));
    } catch (cause) {
      failures.push({ ref, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return failures;
}

/** The enabled tasks due in any of `minutes`, one entry per task: the first schedule entry that matched. */
function dueTasks(
  config: AkmConfig,
  refs: readonly string[],
  minutes: readonly number[],
  failures: TaskDispatchResult["failures"],
): DispatchedTask[] {
  const sources = activeTaskSources(config);
  const due: DispatchedTask[] = [];
  for (const ref of refs) {
    try {
      const task = readEnabledTask(ref, sources);
      const entry = task.schedule.find((candidate) =>
        minutes.some((minute) => scheduleMatchesMinute(candidate.spec.fields, new Date(minute * MINUTE_MS))),
      );
      if (!entry) continue;
      due.push({ ref, id: task.id, bundle: task.bundle, inputFlags: inputFlagTail(entry.inputs) });
    } catch (cause) {
      failures.push({ ref, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return due;
}

/**
 * A task run is in flight when it is younger than the default scheduled timeout and its recorded process is alive
 * (one without a pid, from an older akm, counts by age alone). A crashed run whose pid was reused by another process
 * therefore blocks its task for that timeout, not forever.
 */
function runningTaskIds(ids: readonly string[], now: number): Set<string> {
  const running = new Set<string>();
  withStateDb((db) => {
    for (const run of listActiveTaskRuns(db, ids)) {
      const young = now - new Date(run.started_at).getTime() < DEFAULT_SCHEDULED_TASK_TIMEOUT_MS;
      if (young && (run.pid === undefined || isProcessAlive(run.pid))) running.add(run.task_id);
    }
  });
  return running;
}

/** Start `argv` detached with its output in `logPath` (truncated: the latest run's raw output), then let go of it. */
async function startDetached(argv: readonly string[], logPath: string): Promise<void> {
  const [command, ...args] = argv;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "w");
  // The launcher's watchdog (AKM_LAUNCHER_PID) would stop a child whose launcher exits; each child has its own.
  const env = { ...process.env };
  delete env.AKM_LAUNCHER_PID;
  try {
    const child = spawn(command as string, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => resolve());
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

export async function dispatchDueTasks(deps: DispatchDeps = {}): Promise<TaskDispatchResult> {
  const now = (deps.now ?? (() => new Date()))();
  const current = Math.floor(now.getTime() / MINUTE_MS);
  const config = deps.config ?? loadConfig();
  const statePath = deps.statePath ?? lastMinutePath();
  const result: TaskDispatchResult = {
    minute: localMinuteLabel(current),
    window: 0,
    started: [],
    skipped: [],
    failures: [],
  };

  const refs = schedulerEnabledRefs(config) ?? [];
  if (refs.length === 0) return result;
  const minutes = minutesToEvaluate(current, readLastMinute(statePath));
  result.window = minutes.length;
  if (minutes.length === 0) return result;
  // Recorded before anything starts: a dispatch that overlaps this one sees the minute as done.
  writeLastMinute(statePath, current);

  const due = dueTasks(config, refs, minutes, result.failures);
  if (due.length === 0) return result;

  const running = runningTaskIds(
    due.map((task) => task.id),
    now.getTime(),
  );
  const launcher = deps.launcher ?? resolveAkmInvocation().argv;
  const logDir = deps.logDir ?? getTaskLogDir();
  const start = deps.start ?? startDetached;
  for (const task of due) {
    if (running.has(task.id)) {
      result.skipped.push({ ref: task.ref, reason: "a run of this task is still in flight" });
      continue;
    }
    const argv = [...launcher, "task", "run", task.id, "--bundle", task.bundle, "--scheduled", ...task.inputFlags];
    try {
      const logName = `${task.bundle}__${task.id}`.replace(/[\\/]/g, "__");
      await start(argv, path.join(logDir, `${logName}.log`));
      result.started.push(task.ref);
    } catch (cause) {
      result.failures.push({ ref: task.ref, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return result;
}
