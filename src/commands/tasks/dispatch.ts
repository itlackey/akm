// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task dispatch`: what the OS scheduler runs every minute on a host in
 * dispatch mode (`akm doctor scheduler sync --dispatch`).
 *
 * It reads `scheduler.enabled`, reads those task files as sync does, matches
 * each schedule entry against the minutes since the last dispatch, starts each
 * due entry detached with the invocation and log file its per-task row would
 * have had, and exits. A task file edit applies on the next minute. A run that
 * overlaps an earlier run of its task meets the task's own run lock, as a
 * per-task row's does.
 *
 * The last dispatched minute is kept in a file under the state dir, so a late
 * start does not drop a minute; catch-up is capped at
 * {@link DISPATCH_WINDOW_MINUTES}, and an entry due in several of those minutes
 * starts once.
 */

import fs from "node:fs";
import path from "node:path";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { spawnChild } from "../../core/children";
import { loadConfig } from "../../core/config/config";
import type { AkmConfig } from "../../core/config/config-types";
import { getStateDir, getTaskLogDir, withoutLauncherVars } from "../../core/paths";
import { backendNameForPlatform } from "../../core/platform";
import { isWriteCapableSourceKind } from "../../core/write-source";
import { schedulerEnabledRefs } from "../../tasks/activation-config";
import { resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { activeTaskSources } from "../../tasks/run/load-task";
import { parseSchedule, type ScheduleField, type ScheduleFields } from "../../tasks/schedule";
import { type SchedulerBinding, schedulerBindingNativeId } from "../../tasks/scheduler-binding";
import { compileSchedulerSources, type SchedulerSourceFailure } from "../../tasks/scheduler-sync";
import { resolveTaskReadBundle } from "./tasks";

/** The most minutes one dispatch looks back over: a late start, not a catch-up of downtime. */
export const DISPATCH_WINDOW_MINUTES = 5;

const MINUTE_MS = 60_000;

export interface TaskDispatchResult {
  /** The minute dispatched, local time without seconds. */
  minute: string;
  /** How many minutes were evaluated: 1 normally, up to {@link DISPATCH_WINDOW_MINUTES} after a late start, 0 when this minute was already dispatched. */
  window: number;
  /** The refs started, one per due schedule entry. */
  started: string[];
  /** Enabled tasks or bundles that could not be read, and starts that failed. */
  failures: SchedulerSourceFailure[];
}

export interface DispatchDeps {
  now?: () => Date;
  config?: AkmConfig;
  /** Replaces the detached spawn (tests). */
  start?: (argv: readonly string[], logPath: string) => Promise<void>;
  launcher?: readonly string[];
  statePath?: string;
  logDir?: string;
}

/**
 * Whether `fields` fire at the local minute `at`. `parseSchedule` refuses day-of-month with day-of-week, so one of
 * them is always `*` and both must match.
 */
export function scheduleMatchesMinute(fields: ScheduleFields, at: Date): boolean {
  return (
    fieldMatches(fields.minute, at.getMinutes(), 0) &&
    fieldMatches(fields.hour, at.getHours(), 0) &&
    fieldMatches(fields.dom, at.getDate(), 1) &&
    fieldMatches(fields.month, at.getMonth() + 1, 1) &&
    fieldMatches(fields.dow, at.getDay(), 0)
  );
}

/** One field at `value`; `min` is the field's lowest value, where a `*\/N` step starts. */
function fieldMatches(field: ScheduleField, value: number, min: number): boolean {
  switch (field.kind) {
    case "star":
      return true;
    case "value":
      return field.value === value;
    case "step":
      return (value - min) % field.step === 0;
    case "rangeStep":
      return value >= field.start && value <= field.end && (value - field.start) % field.step === 0;
    case "list":
      return field.values.includes(value);
  }
}

/** The epoch minutes to evaluate: those since the last dispatched one, at most the window, never one already done. */
export function minutesToEvaluate(current: number, last: number | undefined): number[] {
  // This minute, or one a little ahead of the clock, was already dispatched.
  if (last !== undefined && last >= current && last - current <= DISPATCH_WINDOW_MINUTES) return [];
  // No last minute, or one so far ahead that the clock was set back: this minute only.
  const behind = last === undefined || last > current ? 1 : current - last;
  const count = Math.min(behind, DISPATCH_WINDOW_MINUTES);
  return Array.from({ length: count }, (_, index) => current - count + 1 + index);
}

function readLastMinute(file: string): number | undefined {
  try {
    // asset-io: state the last dispatched minute
    const value = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeLastMinute(file: string, minute: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  // asset-io: state the last dispatched minute
  fs.writeFileSync(temp, `${minute}\n`);
  // asset-io: state the last dispatched minute
  fs.renameSync(temp, file);
}

function localMinuteLabel(minute: number): string {
  const at = new Date(minute * MINUTE_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Start `argv` detached with its output in `logPath` (truncated: the latest run's raw output), then let go of it. */
async function startDetached(argv: readonly string[], logPath: string): Promise<void> {
  const [command, ...args] = argv;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // asset-io: state the run's log, as its row writes it
  const fd = fs.openSync(logPath, "w");
  try {
    const child = spawnChild(command as string, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      // A started `akm` gets its `AKM_LAUNCHER_*` variables from its own launcher.
      env: withoutLauncherVars(process.env),
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

/** The schedule entries of the enabled tasks, read as sync reads them, without checking their targets. */
async function enabledBindings(
  config: AkmConfig,
  refs: readonly string[],
  failures: SchedulerSourceFailure[],
): Promise<SchedulerBinding[]> {
  // Sync schedules filesystem and git bundles only, and so does dispatch.
  const schedulable = new Set(
    activeTaskSources(config).flatMap(({ bundleId, type }) =>
      type !== undefined && isWriteCapableSourceKind(type) ? [bundleId] : [],
    ),
  );
  const bundles = [...new Set(refs.map((ref) => parseBundleRef(ref).bundle))].filter(
    (bundle): bundle is string => bundle !== undefined && schedulable.has(bundle),
  );
  const backend = backendNameForPlatform();
  const enabledRefs = new Set(refs);
  const bindings: SchedulerBinding[] = [];
  for (const name of bundles) {
    try {
      const { source } = resolveTaskReadBundle(undefined, name);
      const compiled = await compileSchedulerSources({
        sourceRoot: source.path,
        ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
        bundleName: source.name,
        backend,
        enabledRefs,
        checkTargets: false,
      });
      bindings.push(...compiled.desired);
      failures.push(...compiled.failures);
    } catch (cause) {
      failures.push({ path: name, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return bindings;
}

export async function akmTaskDispatch(deps: DispatchDeps = {}): Promise<TaskDispatchResult> {
  const now = (deps.now ?? (() => new Date()))();
  const current = Math.floor(now.getTime() / MINUTE_MS);
  const config = deps.config ?? loadConfig();
  const statePath = deps.statePath ?? path.join(getStateDir(), "scheduler", "dispatch-minute");
  const result: TaskDispatchResult = { minute: localMinuteLabel(current), window: 0, started: [], failures: [] };

  const refs = schedulerEnabledRefs(config) ?? [];
  if (refs.length === 0) return result;
  const minutes = minutesToEvaluate(current, readLastMinute(statePath));
  result.window = minutes.length;
  if (minutes.length === 0) return result;
  // Recorded before anything starts: a dispatch that overlaps this one finds the minute done.
  writeLastMinute(statePath, current);

  const backend = backendNameForPlatform();
  const due = (await enabledBindings(config, refs, result.failures)).filter((binding) => {
    // `@reboot` runs once at startup, which dispatch has no minute for; sync reports it.
    if (binding.cron.trim().toLowerCase() === "@reboot") return false;
    const { fields } = parseSchedule(binding.cron, backend);
    return minutes.some((minute) => scheduleMatchesMinute(fields, new Date(minute * MINUTE_MS)));
  });
  if (due.length === 0) return result;

  const launcher = deps.launcher ?? resolveAkmInvocation().argv;
  const logDir = deps.logDir ?? getTaskLogDir();
  const start = deps.start ?? startDetached;
  for (const binding of due) {
    try {
      await start([...launcher, ...binding.invocation], path.join(logDir, `${schedulerBindingNativeId(binding)}.log`));
      result.started.push(binding.logicalSource.ref);
    } catch (cause) {
      result.failures.push({
        path: binding.source,
        ref: binding.logicalSource.ref,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return result;
}
