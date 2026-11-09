// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `metrics-db` for `akm health`: whether metrics.db, the one copy of akm's history older than
 * state.db's raw rows, is intact, how big it is and up to which day it holds a fold, and whether the
 * fold is keeping up with state.db. A day the fold has not covered is never purged, so a lag costs
 * state.db space, not history; but it is the sign that `akm index` and `akm improve` are not
 * running (or that folding fails), which is why it is reported.
 */

import fs from "node:fs";
import type { Database } from "../../storage/database";
import { openDatabase } from "../../storage/database";
import { metricsDbPathBeside } from "../../storage/repositories/metrics-rollup-repository";
import { applyReadonlyPragmas } from "../../storage/sqlite-pragmas";
import { runStateDbIntegrityCheck } from "../../storage/state-db-integrity";
import { readFoldedDays, unfoldedClosedDays, utcDay } from "../metrics/fold";
import type { HealthCheckResult } from "./types";

const DAY_MS = 86_400_000;

/** Warn when state.db holds a closed day older than this that metrics.db does not cover. */
export const FOLD_LAG_WARN_DAYS = 7;

/** What the check reads, once per `akm health`. */
export interface MetricsDbState {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  integrity?: { ok: boolean; lines: string[]; error?: string };
  foldedDays?: number;
  firstFoldedDay?: string;
  lastFoldedDay?: string;
  /** Closed UTC days state.db holds rows of that metrics.db does not cover, oldest first (at most 3 named). */
  unfoldedDays?: { count: number; oldest: string; oldestAgeDays: number };
  /** Why metrics.db or the comparison could not be read. */
  error?: string;
}

/** Read metrics.db beside `stateDbPath`, read-only and without creating it. Never throws. */
export function readMetricsDbState(stateDb: Database, stateDbPath: string, nowMs: number): MetricsDbState {
  const file = metricsDbPathBeside(stateDbPath);
  const state: MetricsDbState = { path: file, exists: fs.existsSync(file) };
  try {
    if (!state.exists) {
      state.unfoldedDays = unfolded(stateDb, new Map(), nowMs);
      return state;
    }
    state.sizeBytes = fs.statSync(file).size;
    state.integrity = runStateDbIntegrityCheck(file);
    if (!state.integrity.ok) return state;
    const metrics = openDatabase(file, { readonly: true, create: false });
    try {
      applyReadonlyPragmas(metrics);
      const folded = readFoldedDays(metrics);
      const days = [...folded.keys()].sort();
      state.foldedDays = days.length;
      state.firstFoldedDay = days[0];
      state.lastFoldedDay = days.at(-1);
      state.unfoldedDays = unfolded(stateDb, folded, nowMs);
    } finally {
      metrics.close();
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
  return state;
}

function unfolded(stateDb: Database, folded: ReturnType<typeof readFoldedDays>, nowMs: number) {
  const days = unfoldedClosedDays(stateDb, folded, nowMs);
  const oldest = days[0];
  if (oldest === undefined) return undefined;
  return {
    count: days.length,
    oldest,
    oldestAgeDays: Math.floor(
      (Date.parse(`${utcDay(nowMs)}T00:00:00.000Z`) - Date.parse(`${oldest}T00:00:00.000Z`)) / DAY_MS,
    ),
  };
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function metricsDbCheck(state: MetricsDbState): HealthCheckResult {
  const result = (
    status: HealthCheckResult["status"],
    message: string,
    evidence?: Record<string, unknown>,
  ): HealthCheckResult => ({
    name: "metrics-db",
    kind: "deterministic",
    status,
    confidence: "high",
    message,
    evidence: { path: state.path, ...evidence },
  });
  if (state.integrity && !state.integrity.ok) {
    return result(
      "fail",
      `metrics.db failed PRAGMA integrity_check: ${state.integrity.error ?? state.integrity.lines.join("; ")}. It holds history that nothing else can regenerate: restore it from your backup of the data directory, or move it aside and the next fold starts a new one (state.db keeps only the last 90 days).`,
      { lines: state.integrity.lines },
    );
  }
  if (state.error)
    return result("fail", `metrics.db could not be read: ${state.error}.`, { sizeBytes: state.sizeBytes });
  const lag = state.unfoldedDays;
  const evidence = {
    sizeBytes: state.sizeBytes,
    foldedDays: state.foldedDays,
    firstFoldedDay: state.firstFoldedDay,
    lastFoldedDay: state.lastFoldedDay,
    unfoldedDays: lag?.count,
    oldestUnfoldedDay: lag?.oldest,
  };
  if (lag && lag.oldestAgeDays > FOLD_LAG_WARN_DAYS) {
    return result(
      "warn",
      `${lag.count} closed day(s) of state.db are not folded into metrics.db, the oldest ${lag.oldest} (${lag.oldestAgeDays} days ago). The fold runs in \`akm index\` and \`akm improve\`; until it does, state.db keeps those rows past 90 days instead of purging them.`,
      evidence,
    );
  }
  if (!state.exists) {
    return result(
      "pass",
      "metrics.db is not created yet: the first `akm index` or `akm improve` folds into it.",
      evidence,
    );
  }
  return result(
    "pass",
    state.lastFoldedDay
      ? `metrics.db ${mb(state.sizeBytes ?? 0)}, ${state.foldedDays} day(s) folded, ${state.firstFoldedDay} to ${state.lastFoldedDay}.`
      : `metrics.db ${mb(state.sizeBytes ?? 0)}, no day folded yet.`,
    evidence,
  );
}
