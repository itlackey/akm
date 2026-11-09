// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * metrics.db: the long-lived history of what akm measured.
 *
 * `state.db` keeps 90 days of raw `events`, `usage_events` and `improve_runs`
 * (they are functional there: ranking, improve's feedback window). Before any of
 * those rows is purged, {@link foldClosedDays} (`commands/metrics/fold.ts`)
 * folds each closed UTC day into this file: daily rollups of events, LLM use,
 * usage, queries, selects and latency, plus one slim row per improve run. This
 * file is never purged: it is what `akm metrics` and `akm health` read for any
 * window older than the raw stores reach.
 *
 * Not regenerable: nothing but the fold writes it, so it is backed up with the
 * other stores. No ATTACH: state.db and metrics.db are two handles, and a crash
 * between them just re-folds the day (the fold is idempotent per day).
 *
 * ## Tables
 *
 * `folded_day` is the purge guard: one row per UTC day folded, with the source
 * row counts folded per table. A purge deletes a day's rows only when that day
 * has a row here that covers what the purge is about to delete.
 *
 * `improve_runs` has the columns of state.db's table of the same name, so the
 * same readers query either handle. Its `result_json` is slim: the persisted
 * per-run ref list `strategyFilteredRefs` is replaced by `strategyFilteredCount`.
 *
 * Every other table is keyed by `day` (`YYYY-MM-DD`, UTC) plus its dimensions; an
 * absent dimension is stored as `''`. Duration histograms are JSON arrays of
 * bucket counts over {@link LATENCY_BUCKET_UPPER_MS} plus an overflow bucket:
 * medians do not roll up, histograms do.
 *
 * @module metrics-db
 */

import path from "node:path";
import type { Database } from "../storage/database";
import { openManagedDatabase, withManagedDb } from "../storage/managed-db";
import {
  assertMigrationRegistry,
  type Migration,
  runMigrations as runSqliteMigrations,
} from "../storage/sqlite-migrations";
import { getDataDir } from "./paths";

export type { Database };

/** Default path: `<dataDir>/metrics.db`, beside state.db and logs.db. */
export function getMetricsDbPath(): string {
  return path.join(getDataDir(), "metrics.db");
}

/**
 * Upper bounds (ms, inclusive) of the duration histogram buckets; one more
 * bucket counts everything above the last bound. Fixed forever: a histogram
 * written under other bounds could not be merged with these.
 */
export const LATENCY_BUCKET_UPPER_MS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000,
];

const MIGRATIONS: Migration[] = [
  {
    id: "001-metrics-baseline",
    up: `
      CREATE TABLE folded_day (
        day         TEXT PRIMARY KEY,
        folded_at   TEXT NOT NULL,
        src_events  INTEGER NOT NULL DEFAULT 0,
        src_usage   INTEGER NOT NULL DEFAULT 0,
        src_runs    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE improve_runs (
        id            TEXT PRIMARY KEY,
        started_at    TEXT NOT NULL,
        completed_at  TEXT,
        stash_dir     TEXT NOT NULL,
        dry_run       INTEGER NOT NULL DEFAULT 0,
        strategy      TEXT,
        scope_mode    TEXT NOT NULL,
        scope_value   TEXT,
        guidance      TEXT,
        ok            INTEGER NOT NULL,
        result_json   TEXT NOT NULL,
        metrics_json  TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_metrics_improve_runs_started ON improve_runs(started_at);

      CREATE TABLE event_daily (
        day         TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        n           INTEGER NOT NULL,
        PRIMARY KEY (day, event_type)
      );

      CREATE TABLE llm_daily (
        day                 TEXT NOT NULL,
        stage               TEXT NOT NULL,
        process             TEXT NOT NULL,
        engine              TEXT NOT NULL,
        model               TEXT NOT NULL,
        outcome             TEXT NOT NULL,
        calls               INTEGER NOT NULL,
        duration_ms         REAL NOT NULL,
        prompt_tokens       INTEGER NOT NULL,
        completion_tokens   INTEGER NOT NULL,
        total_tokens        INTEGER NOT NULL,
        reasoning_tokens    INTEGER NOT NULL,
        usage_calls         INTEGER NOT NULL,
        reasoning_calls     INTEGER NOT NULL,
        duration_hist_json  TEXT NOT NULL,
        PRIMARY KEY (day, stage, process, engine, model, outcome)
      );

      -- ref '' is a summary row (a search or curate writes one with no ref).
      -- hits / zero count summary rows whose resultCount is above / equal to 0.
      CREATE TABLE usage_daily (
        day         TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        source      TEXT NOT NULL,
        ref         TEXT NOT NULL,
        n           INTEGER NOT NULL,
        positive    INTEGER NOT NULL,
        negative    INTEGER NOT NULL,
        hits        INTEGER NOT NULL,
        zero        INTEGER NOT NULL,
        last_at     TEXT NOT NULL,
        PRIMARY KEY (day, event_type, source, ref)
      );

      -- Search summary rows with a query. results_n / results_sum cover the rows that carry a resultCount.
      CREATE TABLE query_daily (
        day          TEXT NOT NULL,
        source       TEXT NOT NULL,
        query        TEXT NOT NULL,
        n            INTEGER NOT NULL,
        results_n    INTEGER NOT NULL,
        results_sum  INTEGER NOT NULL,
        zero_n       INTEGER NOT NULL,
        last_at      TEXT NOT NULL,
        PRIMARY KEY (day, source, query)
      );

      CREATE TABLE feedback_tag_daily (
        day       TEXT NOT NULL,
        source    TEXT NOT NULL,
        tag       TEXT NOT NULL,
        positive  INTEGER NOT NULL,
        negative  INTEGER NOT NULL,
        PRIMARY KEY (day, source, tag)
      );

      -- Selects deduped by (searchId, ref) within the day; source '' when the select carried none.
      CREATE TABLE select_daily (
        day      TEXT NOT NULL,
        ref      TEXT NOT NULL,
        source   TEXT NOT NULL,
        n        INTEGER NOT NULL,
        last_at  TEXT NOT NULL,
        PRIMARY KEY (day, ref, source)
      );

      -- kind 'search' (usage summary rows' totalMs, per source) or 'index' (index_completed totalMs, source '').
      CREATE TABLE latency_daily (
        day        TEXT NOT NULL,
        kind       TEXT NOT NULL,
        source     TEXT NOT NULL,
        hist_json  TEXT NOT NULL,
        PRIMARY KEY (day, kind, source)
      );

      -- akm health counts skips from improve_skipped events: one per occurrence (summed), and, for a
      -- reason that carries a count, the latest run's snapshot. A day keeps both, so a window can be
      -- rebuilt the same way: sums add up, the latest day's snapshot wins.
      CREATE TABLE improve_skip_daily (
        day       TEXT NOT NULL,
        reason    TEXT NOT NULL,
        summed    INTEGER NOT NULL,
        snapshot  INTEGER,
        PRIMARY KEY (day, reason)
      );
    `,
  },
];

assertMigrationRegistry(MIGRATIONS);

/** Apply every pending migration; called by {@link openMetricsDatabase}. */
export function runMigrations(db: Database): void {
  runSqliteMigrations(db, MIGRATIONS);
}

/**
 * Open (and create or migrate) metrics.db. `dbPath` overrides the default path
 * (tests, or a caller that holds one). The pragmas are the standard block;
 * foreign keys stay off as in logs.db (there are none).
 */
export function openMetricsDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? getMetricsDbPath();
  return openManagedDatabase({
    path: resolvedPath,
    pragmas: { dataDir: path.dirname(resolvedPath), foreignKeys: false },
    init: runMigrations,
  });
}

/** Run `fn` against metrics.db, opening and closing it unless `borrowed` is given. */
export function withMetricsDb<T>(fn: (db: Database) => T, opts?: { path?: string; borrowed?: Database }): T {
  return withManagedDb(() => openMetricsDatabase(opts?.path), fn, opts?.borrowed ? { borrowed: opts.borrowed } : {});
}
