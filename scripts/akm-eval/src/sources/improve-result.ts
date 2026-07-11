/**
 * Loader for improve run envelopes.
 *
 * Source of truth: the `improve_runs` table in `state.db` (added in 0.8.0).
 * Each row holds the full result envelope as `result_json`. The legacy
 * filesystem layout (`<stash>/.akm/runs/<id>/improve-result.json`) was
 * archived during the 0.8.0 migration and is no longer read.
 *
 * Phase 6 record/replay: `loadImproveResult` honors an optional `recorder`
 * (captures the resolved row for later replay) or `player` (returns
 * previously-captured content without touching the database).
 */

import { Database } from "bun:sqlite";
import { decodeImproveResult, type ImproveResultEnvelope } from "../../../../src/core/improve-result";
import { pathExists, resolveStateDbPath } from "./paths";
import { type ReplayPlayer, type ReplayRecorder } from "./replay-log";

export type { ImproveResultEnvelope } from "../../../../src/core/improve-result";

interface ImproveRunRow {
  id: string;
  legacy_profile: string | null;
  strategy: string | null;
  result_json: string;
}

/**
 * List the N most-recent improve run ids in chronological order (oldest
 * first, matching the legacy "lexicographic readdirSync over .akm/runs/*"
 * behaviour the runners depend on). Excludes dry-run rows. When `n <= 0`,
 * returns every non-dry-run row.
 */
export function listRecentImproveRunIds(n: number): string[] {
  // A fresh checkout (or any stash that has never run `improve`) has no
  // state.db. Treat "no database" as "no runs" so read-only history audits
  // skip cleanly instead of throwing on a readonly open of a missing file.
  // This also keeps record/replay deterministic: both passes see [] rather
  // than diverging on whether a later case happened to create state.db.
  const dbPath = resolveStateDbPath();
  if (!pathExists(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = (
      n > 0
        ? db
            .prepare("SELECT id FROM improve_runs WHERE dry_run = 0 ORDER BY started_at DESC LIMIT ?")
            .all(n)
        : db.prepare("SELECT id FROM improve_runs WHERE dry_run = 0 ORDER BY started_at DESC").all()
    ) as Array<{ id: string }>;
    return rows.map((r) => r.id).reverse(); // oldest first
  } finally {
    db.close();
  }
}

/**
 * Resolve a run identifier ("latest" / "last" or an exact id) to a row id.
 * Excludes dry-run rows so productivity audits aren't polluted (closes the
 * dry-run artifact-trap recorded in feedback_akm_dryrun_artifact_trap).
 */
export function resolveImproveRunId(_stashRoot: string, ref: string): string {
  // No state.db ⇒ no runs; surface the same "no rows" error the empty-table
  // path gives rather than a raw sqlite "unable to open database file".
  const dbPath = resolveStateDbPath();
  if (!pathExists(dbPath)) {
    throw new Error(`improve_runs row not found: ${ref} (no state.db at ${dbPath})`);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    if (ref === "latest" || ref === "last") {
      const row = db
        .prepare("SELECT id FROM improve_runs WHERE dry_run = 0 ORDER BY started_at DESC LIMIT 1")
        .get() as { id: string } | undefined;
      if (!row) throw new Error("no improve_runs rows in state.db (dry_run = 0)");
      return row.id;
    }
    const row = db.prepare("SELECT id FROM improve_runs WHERE id = ?").get(ref) as { id: string } | undefined;
    if (!row) throw new Error(`improve_runs row not found: ${ref}`);
    return row.id;
  } finally {
    db.close();
  }
}

export interface LoadImproveResultOptions {
  /** When set, the resolved row is recorded for later replay. */
  recorder?: ReplayRecorder;
  /**
   * When set, the row content is dequeued from the player instead of read
   * from state.db. The id is still resolved (so "latest" semantics match)
   * but the DB read for `result_json` is skipped.
   */
  player?: ReplayPlayer;
}

/**
 * Load the full improve-run envelope for a given run id (or "latest").
 *
 * Returns:
 *   - runId: the resolved row id
 *   - source: a symbolic locator `state.db//improve_runs/<id>` — preserved
 *     in the legacy `dir` field name expected by callers (collect.ts uses
 *     it for log/report lines only; nothing reads it as a filesystem path).
 *   - envelope: the parsed AkmImproveResult JSON
 */
export function loadImproveResult(
  stashRoot: string,
  ref: string,
  opts: LoadImproveResultOptions = {},
): {
  runId: string;
  dir: string;
  envelope: ImproveResultEnvelope;
  strategy: string | null;
  legacyProfile: string | null;
} {
  if (opts.recorder && opts.player) {
    throw new Error("loadImproveResult: cannot record and play back simultaneously");
  }
  const runId = resolveImproveRunId(stashRoot, ref);
  const locator = `state.db//improve_runs/${runId}`;
  let raw: string;
  let storedStrategy: string | null | undefined;
  let storedLegacyProfile: string | null | undefined;
  if (opts.player) {
    raw = opts.player.nextImproveResult(locator);
  } else {
    const db = new Database(resolveStateDbPath(), { readonly: true });
    try {
      const row = db
        .prepare("SELECT profile AS legacy_profile, strategy, result_json FROM improve_runs WHERE id = ?")
        .get(runId) as ImproveRunRow | undefined;
      if (!row) throw new Error(`improve_runs result_json missing for ${runId}`);
      raw = row.result_json;
      storedStrategy = row.strategy;
      storedLegacyProfile = row.legacy_profile;
    } finally {
      db.close();
    }
    opts.recorder?.recordImproveResult(locator, raw);
  }
  const decoded = decodeImproveResult(raw);
  return {
    runId,
    dir: locator,
    envelope: decoded.envelope,
    strategy: storedStrategy === undefined ? decoded.strategy : storedStrategy,
    legacyProfile: storedLegacyProfile === undefined ? decoded.legacyProfile : storedLegacyProfile,
  };
}
