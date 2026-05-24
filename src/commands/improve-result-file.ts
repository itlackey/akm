/**
 * Helpers for persisting the `akm improve` result envelope.
 *
 * v0.8.0 behavioural default change:
 *   - Default: the full result is recorded as a single row in the
 *     `improve_runs` table of `state.db` (migration 003). Stdout is empty.
 *     The existing `[improve] ...` progress log lines on stderr remain the
 *     canonical console UX.
 *   - `--json-to-stdout` restores the prior behaviour: full JSON to stdout,
 *     nothing written to state.db.
 *
 * v0.8.0 storage change (this module): the previous on-disk artifact at
 * `<stash>/.akm/runs/<runId>/improve-result.json` is no longer written. The
 * canonical record now lives in `improve_runs` (see
 * `src/core/state-db.ts`). Pre-existing files from older runs are not
 * deleted by this change — they become historical artifacts. Zero current
 * code paths read them, so no consumers needed to update.
 *
 * Run-id format: ISO-8601 timestamp (colons/dots replaced by `-`) plus an
 * 8-char hex random suffix. There is no existing canonical run-id helper for
 * persistent per-command artefacts on disk — the `workflow_runs` table uses
 * `randomUUID()` but is database-scoped, and `consolidate-journal.json` is a
 * single-slot artefact. We mint a fresh timestamped id for each improve run.
 */

import crypto from "node:crypto";
import path from "node:path";
import { openStateDatabase, recordImproveRun } from "../core/state-db";
import type { AkmImproveResult } from "./improve";

/**
 * Build a stable run-id for a single improve invocation.
 *
 * Shape: `<iso-8601-utc-with-dashes>-<8 hex chars>`, e.g.
 *   `2026-05-19T17-30-22-123Z-a1b2c3d4`.
 *
 * The hex suffix protects against same-millisecond collisions when multiple
 * runs happen back-to-back in tests or scripts.
 */
export function buildImproveRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${iso}-${rand}`;
}

/**
 * Return a stable, human-recognisable reference for a given improve run.
 *
 * Historical compatibility shim: callers used to receive a stash-relative
 * file path like `.akm/runs/<runId>/improve-result.json`. With the state.db
 * migration, no such file exists, but several callers still log "wrote to
 * <path>" style messages. Returning a `state.db//improve_runs/<runId>`
 * locator preserves the "the result is at <thing>" signature so existing
 * log lines and error messages continue to make sense without rewriting
 * every call site.
 */
export function relativeImproveResultPath(runId: string): string {
  return path.join("state.db", "improve_runs", runId);
}

/**
 * Persist the full improve result into the `improve_runs` table of state.db.
 *
 * Backwards-compatible signature: the function name, argument list, and
 * return type all match the pre-0.8.0 file-writing helper. The returned
 * string is the `state.db//improve_runs/<runId>` locator (see
 * {@link relativeImproveResultPath}), which is intended for log messages
 * only — no caller should treat it as a filesystem path. Zero current
 * readers existed for the previous file path, so this is a pure storage
 * swap.
 *
 * The state.db row carries the scope and dry-run flag from `result.scope`
 * and `result.dryRun`, plus the full result JSON for full fidelity. The
 * dry-run column is indexed so productivity audits can filter cleanly
 * (closes the dry-run/real-run artifact-trap recorded in MEMORY.md
 * `feedback_akm_dryrun_artifact_trap`).
 */
export function writeImproveResultFile(stashDir: string, runId: string, result: AkmImproveResult): string {
  const db = openStateDatabase();
  try {
    const startedAt = new Date().toISOString();
    recordImproveRun(db, {
      id: runId,
      startedAt,
      completedAt: startedAt,
      stashDir,
      dryRun: Boolean(result.dryRun),
      profile: null,
      scopeMode: result.scope?.mode ?? "all",
      scopeValue: result.scope?.value ?? null,
      guidance: result.guidance ?? null,
      ok: Boolean(result.ok),
      result,
    });
  } finally {
    try {
      db.close();
    } catch {
      // best-effort
    }
  }
  return relativeImproveResultPath(runId);
}
