// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
import { withStateDb } from "../../core/state-db";
import { recordImproveRun } from "../../storage/repositories/improve-runs-repository";
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
 *
 * @param strategy - The effective 0.9 strategy selected for this invocation.
 */
export function writeImproveResultFile(
  stashDir: string,
  runId: string,
  result: AkmImproveResult,
  startedAt?: string,
  strategy?: string | null,
): string {
  withStateDb((db) => {
    const completedAt = new Date().toISOString();
    // startedAt is the ISO timestamp captured at process launch (passed from the
    // CLI entry point). If omitted, fall back to the run-id's embedded timestamp
    // so started_at != completed_at even on older call sites.
    const resolvedStartedAt =
      startedAt ??
      runId.slice(0, 24).replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1$2:$3:$4.$5Z");
    recordImproveRun(db, {
      id: runId,
      startedAt: resolvedStartedAt,
      completedAt,
      stashDir,
      dryRun: Boolean(result.dryRun),
      strategy: strategy ?? result.strategy ?? null,
      scopeMode: result.scope?.mode ?? "all",
      scopeValue: result.scope?.value ?? null,
      guidance: result.guidance ?? null,
      ok: Boolean(result.ok),
      result,
    });
  });
  return relativeImproveResultPath(runId);
}

/**
 * Reason this run terminated before completing. Used by
 * {@link recordTerminatedImproveRun} to populate `metadata.terminated.reason`
 * so post-mortem queries can distinguish a `SIGTERM` from the cron timeout,
 * a `SIGINT` from operator Ctrl-C, and an in-process exception.
 */
export type TerminationReason = "SIGTERM" | "SIGINT" | "SIGHUP" | "exception" | string;

/**
 * Persist an improve_runs row for a run that did NOT complete normally.
 * 2026-05-26 incident: the cron's `timeout_ms: 1800000` SIGTERM'd an
 * akm-improve invocation at 30:00 with 54 actionable refs in-flight. No
 * `improve_runs` row was written because the writer only fired at successful
 * end-of-run, so the run vanished from `akm health --detail per-run` even
 * though it had consumed 30 min of LLM time and produced 29 ref-level
 * proposals. This helper closes that gap: signal handlers and the CLI
 * try/catch wrapper call it on the abnormal-exit paths so the row exists
 * with `ok: false` and `metadata.terminated.reason` set.
 *
 * The persisted result envelope is minimal — we don't try to reconstruct
 * the in-flight `actions[]` because that state lives inside `akmImprove`
 * and is gone by the time the signal handler runs. The row captures
 * enough to know: a run started, was scoped to X, did NOT complete, and
 * why.
 */
export function recordTerminatedImproveRun(
  stashDir: string,
  runId: string,
  startedAt: string,
  reason: TerminationReason,
  ctx?: {
    scopeMode?: "all" | "type" | "ref";
    scopeValue?: string | null;
    dryRun?: boolean;
    strategy?: string | null;
    errorMessage?: string;
  },
): void {
  const completedAt = new Date().toISOString();
  const minimalResult: AkmImproveResult = {
    schemaVersion: 1,
    ok: false,
    scope: { mode: ctx?.scopeMode ?? "all", ...(ctx?.scopeValue ? { value: ctx.scopeValue } : {}) },
    dryRun: Boolean(ctx?.dryRun),
    actions: [],
    plannedRefs: [],
    terminated: {
      reason,
      at: completedAt,
      ...(ctx?.errorMessage ? { errorMessage: ctx.errorMessage } : {}),
    },
  } as unknown as AkmImproveResult;

  withStateDb((db) => {
    recordImproveRun(db, {
      id: runId,
      startedAt,
      completedAt,
      stashDir,
      dryRun: Boolean(ctx?.dryRun),
      strategy: ctx?.strategy ?? null,
      scopeMode: ctx?.scopeMode ?? "all",
      scopeValue: ctx?.scopeValue ?? null,
      guidance: null,
      ok: false,
      result: minimalResult,
      metadata: {
        terminated: {
          reason,
          at: completedAt,
          ...(ctx?.errorMessage ? { errorMessage: ctx.errorMessage } : {}),
        },
      },
    });
  });
}
