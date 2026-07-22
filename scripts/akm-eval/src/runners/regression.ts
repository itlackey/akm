/**
 * Regression runner — diffs the current case-results.jsonl against a
 * previously stored eval-run-id.
 *
 * Surfaces:
 *   - newly-failing cases (passed before, fail now)
 *   - newly-passing cases (failed before, pass now)
 *   - score drops above a configurable delta (default 0.1)
 *   - missing cases (present before, absent now)
 *
 * Designed to be invoked two ways:
 *   1. as an EvalCase of type "regression" embedded in a suite (the
 *      orchestrator dispatches to this file via `runCase`),
 *   2. as a standalone diff via the `regression` helpers below, which
 *      `src/run.ts` uses to populate `EvalRunResult.regressions` after
 *      paired mode and which `src/compare.ts` reuses for compare output.
 */

import fs from "node:fs";
import path from "node:path";
import {
  assertMatchingSuiteFingerprints,
  loadCaseResults,
  loadEvalRunResult,
  resolveRunDir,
  type RunLocation,
} from "../sources/eval-runs";
import type { EvalCase, EvalCaseResult, EvalContext } from "../types";

export interface RegressionEntry {
  caseId: string;
  type: EvalCaseResult["type"];
  previousScore: number;
  currentScore: number;
  previousPassed: boolean;
  currentPassed: boolean;
  delta: number;
  reason: "newly-failing" | "score-drop" | "missing";
}

export interface RegressionDiff {
  /** Cases that regressed (newly-failing, score drop above threshold, or disappeared). */
  regressions: RegressionEntry[];
  /** Cases that were failing or absent and are now passing. */
  newlyPassing: Array<{ caseId: string; type: EvalCaseResult["type"]; previousScore: number | null; currentScore: number }>;
  /** Cases that fail in both runs (carry-over failures — not new regressions, surfaced for context). */
  carryoverFailing: Array<{ caseId: string; type: EvalCaseResult["type"]; previousScore: number; currentScore: number }>;
  /** Cases present in current but absent in previous. */
  added: Array<{ caseId: string; type: EvalCaseResult["type"]; currentScore: number; currentPassed: boolean }>;
  threshold: number;
}

export interface RegressionOptions {
  /** Minimum score drop counted as a regression even if both runs still pass. */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 0.1;

export function diffCaseResults(
  previous: EvalCaseResult[],
  current: EvalCaseResult[],
  opts: RegressionOptions = {},
): RegressionDiff {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const prevById = new Map(previous.map((r) => [r.caseId, r]));
  const currById = new Map(current.map((r) => [r.caseId, r]));

  const regressions: RegressionEntry[] = [];
  const newlyPassing: RegressionDiff["newlyPassing"] = [];
  const carryoverFailing: RegressionDiff["carryoverFailing"] = [];
  const added: RegressionDiff["added"] = [];

  for (const cur of current) {
    if (cur.skipped) continue;
    const prev = prevById.get(cur.caseId);
    if (!prev) {
      added.push({ caseId: cur.caseId, type: cur.type, currentScore: cur.score, currentPassed: cur.passed });
      if (cur.passed) {
        newlyPassing.push({ caseId: cur.caseId, type: cur.type, previousScore: null, currentScore: cur.score });
      }
      continue;
    }
    if (prev.skipped) continue;
    const delta = cur.score - prev.score;
    if (prev.passed && !cur.passed) {
      regressions.push({
        caseId: cur.caseId,
        type: cur.type,
        previousScore: prev.score,
        currentScore: cur.score,
        previousPassed: prev.passed,
        currentPassed: cur.passed,
        delta,
        reason: "newly-failing",
      });
    } else if (!prev.passed && cur.passed) {
      newlyPassing.push({ caseId: cur.caseId, type: cur.type, previousScore: prev.score, currentScore: cur.score });
    } else if (!prev.passed && !cur.passed) {
      carryoverFailing.push({ caseId: cur.caseId, type: cur.type, previousScore: prev.score, currentScore: cur.score });
    }
    if (delta < -threshold && (prev.passed === cur.passed) && prev.passed) {
      // Score dropped sharply but both still pass — surface as a soft regression.
      regressions.push({
        caseId: cur.caseId,
        type: cur.type,
        previousScore: prev.score,
        currentScore: cur.score,
        previousPassed: prev.passed,
        currentPassed: cur.passed,
        delta,
        reason: "score-drop",
      });
    }
  }

  for (const prev of previous) {
    if (prev.skipped) continue;
    if (!currById.has(prev.caseId)) {
      regressions.push({
        caseId: prev.caseId,
        type: prev.type,
        previousScore: prev.score,
        currentScore: 0,
        previousPassed: prev.passed,
        currentPassed: false,
        delta: -prev.score,
        reason: "missing",
      });
    }
  }

  return { regressions, newlyPassing, carryoverFailing, added, threshold };
}

/**
 * Embedded-case mode: an EvalCase with `type: "regression"` declares a
 * previous run id (or "latest") in `input.previousRunId` and an optional
 * threshold. The runner loads that run's case-results.jsonl and diffs it
 * against `ctx.currentResults` (populated by the orchestrator just before
 * dispatching this case).
 */
export async function runRegressionCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  const previousRunId = String(c.input.previousRunId ?? "latest");
  const threshold = Number(c.input.threshold ?? DEFAULT_THRESHOLD);
  const evalsRunsRoot = path.join(ctx.outRoot, "runs");
  const current = ctx.currentResults ?? [];

  let location: RunLocation;
  try {
    location = resolveRunDir(evalsRunsRoot, previousRunId);
  } catch (err) {
    return {
      caseId: c.id,
      type: "regression",
      score: 0,
      passed: false,
      metrics: {},
      evidence: { previousRunId },
      errors: [err instanceof Error ? err.message : String(err)],
      durationMs: Date.now() - start,
    };
  }

  // Skip self-diff (e.g. when "latest" resolves to the run currently being written).
  if (location.runId === ctx.currentRunId) {
    return {
      caseId: c.id,
      type: "regression",
      score: 1,
      passed: true,
      skipped: true,
      skipReason: "previous run resolved to the current run (no prior run available)",
      metrics: {},
      evidence: { previousRunId: location.runId },
      durationMs: Date.now() - start,
    };
  }

  let previous: EvalCaseResult[];
  try {
    const previousEnvelope = loadEvalRunResult(location.dir);
    assertMatchingSuiteFingerprints(previousEnvelope.inputs.suiteFingerprint, ctx.suiteFingerprint);
    previous = loadCaseResults(location.dir);
  } catch (err) {
    return {
      caseId: c.id,
      type: "regression",
      score: 0,
      passed: false,
      metrics: {},
      evidence: { previousRunId: location.runId, runDir: location.dir },
      errors: [err instanceof Error ? err.message : String(err)],
      durationMs: Date.now() - start,
    };
  }

  const diff = diffCaseResults(previous, current, { threshold });
  const passed = diff.regressions.length === 0;
  return {
    caseId: c.id,
    type: "regression",
    score: passed ? 1 : 0,
    passed,
    metrics: {
      regressionCount: diff.regressions.length,
      newlyPassingCount: diff.newlyPassing.length,
      addedCount: diff.added.length,
      carryoverFailingCount: diff.carryoverFailing.length,
      threshold,
    },
    evidence: {
      previousRunId: location.runId,
      previousRunDir: location.dir,
      regressions: diff.regressions,
      newlyPassing: diff.newlyPassing,
      added: diff.added,
    },
    durationMs: Date.now() - start,
  };
}

/** Read a case-results.jsonl file directly without going through the run resolver. */
export function loadCaseResultsFromFile(file: string): EvalCaseResult[] {
  const raw = fs.readFileSync(file, "utf8");
  const out: EvalCaseResult[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as EvalCaseResult);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
