// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Persist an `akm improve` result as one `improve_runs` row in state.db (since
 * 0.8.0 stdout stays empty unless `--json-to-stdout`). A run that did not
 * complete still gets a row.
 */

import crypto from "node:crypto";
import { decodeImproveResult } from "../../core/improve-result";
import { redactSensitiveValue } from "../../core/redaction";
import { withImmediateTransaction, withStateDb } from "../../core/state-db";
import { recordImproveRun } from "../../storage/repositories/improve-runs-repository";
import type { AkmImproveResult } from "./improve";

/** `<iso-8601 with dashes>-<8 hex>`, e.g. `2026-05-19T17-30-22-123Z-a1b2c3d4` (the suffix breaks same-ms ties). */
export function buildImproveRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${iso}-${rand}`;
}

/** Record a finished run (the full result, redacted; dry runs stay filterable). */
export function recordImproveRunResult(
  stashDir: string,
  runId: string,
  result: AkmImproveResult,
  startedAt?: string,
  sensitiveValues: readonly string[] = [],
): void {
  const decoded = decodeImproveResult(result);
  const persistedResult = redactSensitiveValue(result, sensitiveValues);
  withStateDb((db) => {
    const completedAt = new Date().toISOString();
    // Without a launch timestamp, the one embedded in the run id.
    const resolvedStartedAt =
      startedAt ??
      runId.slice(0, 24).replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1$2:$3:$4.$5Z");
    // BEGIN IMMEDIATE with retry: a bare write surfaced "database is locked" (#948).
    withImmediateTransaction(db, () => {
      recordImproveRun(db, {
        id: runId,
        startedAt: resolvedStartedAt,
        completedAt,
        stashDir,
        dryRun: Boolean(result.dryRun),
        strategy: redactSensitiveValue(decoded.strategy, sensitiveValues),
        scopeMode: result.scope?.mode ?? "all",
        scopeValue: persistedResult.scope?.value ?? null,
        guidance: persistedResult.guidance ?? null,
        ok: Boolean(result.ok),
        result: persistedResult,
      });
    });
  });
}

/** Why a run ended early (`metadata.terminated.reason`). */
export type TerminationReason = "SIGTERM" | "SIGINT" | "SIGHUP" | "exception" | string;

/**
 * Record a run that did not complete (a signal, e.g. a cron timeout, or an
 * exception) so it does not vanish from `akm health`: `ok: false` with the
 * reason. The in-flight actions are gone by then, so the envelope is minimal.
 */
export function recordTerminatedImproveRun(
  stashDir: string,
  runId: string,
  startedAt: string,
  reason: TerminationReason,
  ctx: {
    scopeMode?: "all" | "type" | "ref";
    scopeValue?: string | null;
    dryRun?: boolean;
    strategy: string;
    errorMessage?: string;
    sensitiveValues?: readonly string[];
  },
): void {
  const completedAt = new Date().toISOString();
  const persistedReason = redactSensitiveValue(reason, ctx.sensitiveValues ?? []);
  const persistedScopeValue = redactSensitiveValue(ctx.scopeValue, ctx.sensitiveValues ?? []);
  const persistedStrategy = redactSensitiveValue(ctx.strategy, ctx.sensitiveValues ?? []);
  const minimalResult: AkmImproveResult = redactSensitiveValue(
    {
      schemaVersion: 2,
      ok: false,
      strategy: persistedStrategy,
      scope: { mode: ctx.scopeMode ?? "all", ...(persistedScopeValue ? { value: persistedScopeValue } : {}) },
      dryRun: Boolean(ctx.dryRun),
      memorySummary: { eligible: 0, derived: 0 },
      actions: [],
      plannedRefs: [],
      terminated: {
        reason: persistedReason,
        at: completedAt,
        ...(ctx.errorMessage ? { errorMessage: ctx.errorMessage } : {}),
      },
    },
    ctx.sensitiveValues ?? [],
  );

  withStateDb((db) => {
    withImmediateTransaction(db, () => {
      recordImproveRun(db, {
        id: runId,
        startedAt,
        completedAt,
        stashDir,
        dryRun: Boolean(ctx.dryRun),
        strategy: persistedStrategy,
        scopeMode: ctx.scopeMode ?? "all",
        scopeValue: persistedScopeValue ?? null,
        guidance: null,
        ok: false,
        result: minimalResult,
        metadata: {
          terminated: {
            reason: persistedReason,
            at: completedAt,
            ...(ctx.errorMessage
              ? { errorMessage: redactSensitiveValue(ctx.errorMessage, ctx.sensitiveValues ?? []) }
              : {}),
          },
        },
      });
    });
  });
}
