/**
 * Weighted scoring + aggregation.
 *
 * Keeps deterministic and LLM-judged scores separate (LLM judging is
 * Phase 7; this file is forward-compatible).
 */

import type { EvalCaseResult, EvalCaseType, EvalRunResult } from "./types";

/**
 * Default per-type weights. Sum to 1.0.
 *
 * Phase 4 introduced `judge-calibration` (0.10) by reducing `retrieval` from
 * 0.25 → 0.15 (-0.10). All other weights kept verbatim. Suites that only
 * exercise retrieval/proposal-quality cases still see a sensible weighted
 * average because aggregation only counts types that actually contributed
 * scores (zero-result types are excluded from `weightTotal`).
 */
const DEFAULT_TYPE_WEIGHTS: Record<EvalCaseType, number> = {
  retrieval: 0.15,
  "lesson-application": 0.2,
  "proposal-quality": 0.2,
  "memory-safety": 0.2,
  "workflow-compliance": 0.1,
  "judge-calibration": 0.10,
  regression: 0.05,
};

export function aggregateScores(results: EvalCaseResult[]): {
  overall: number;
  deterministic: number;
  byType: Record<EvalCaseType, { run: number; passed: number; skipped: number; score: number }>;
} {
  const byType: Record<EvalCaseType, { run: number; passed: number; skipped: number; scores: number[] }> = {
    retrieval: { run: 0, passed: 0, skipped: 0, scores: [] },
    "lesson-application": { run: 0, passed: 0, skipped: 0, scores: [] },
    "proposal-quality": { run: 0, passed: 0, skipped: 0, scores: [] },
    "memory-safety": { run: 0, passed: 0, skipped: 0, scores: [] },
    "workflow-compliance": { run: 0, passed: 0, skipped: 0, scores: [] },
    "judge-calibration": { run: 0, passed: 0, skipped: 0, scores: [] },
    regression: { run: 0, passed: 0, skipped: 0, scores: [] },
  };

  for (const r of results) {
    const bucket = byType[r.type];
    if (r.skipped) {
      bucket.skipped += 1;
      continue;
    }
    bucket.run += 1;
    bucket.scores.push(r.score);
    if (r.passed) bucket.passed += 1;
  }

  const reduced: Record<EvalCaseType, { run: number; passed: number; skipped: number; score: number }> = {
    retrieval: { run: 0, passed: 0, skipped: 0, score: 0 },
    "lesson-application": { run: 0, passed: 0, skipped: 0, score: 0 },
    "proposal-quality": { run: 0, passed: 0, skipped: 0, score: 0 },
    "memory-safety": { run: 0, passed: 0, skipped: 0, score: 0 },
    "workflow-compliance": { run: 0, passed: 0, skipped: 0, score: 0 },
    "judge-calibration": { run: 0, passed: 0, skipped: 0, score: 0 },
    regression: { run: 0, passed: 0, skipped: 0, score: 0 },
  };

  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(byType) as EvalCaseType[]) {
    const b = byType[key];
    const avg = b.scores.length === 0 ? 0 : b.scores.reduce((a, x) => a + x, 0) / b.scores.length;
    reduced[key] = { run: b.run, passed: b.passed, skipped: b.skipped, score: avg };
    if (b.scores.length > 0) {
      const w = DEFAULT_TYPE_WEIGHTS[key];
      weightedSum += avg * w;
      weightTotal += w;
    }
  }

  const overall = weightTotal === 0 ? 0 : weightedSum / weightTotal;
  return { overall, deterministic: overall, byType: reduced };
}

export function buildCountsByType(results: EvalCaseResult[]): EvalRunResult["countsByType"] {
  const init: EvalRunResult["countsByType"] = {
    retrieval: { run: 0, passed: 0, skipped: 0 },
    "lesson-application": { run: 0, passed: 0, skipped: 0 },
    "proposal-quality": { run: 0, passed: 0, skipped: 0 },
    "memory-safety": { run: 0, passed: 0, skipped: 0 },
    "workflow-compliance": { run: 0, passed: 0, skipped: 0 },
    "judge-calibration": { run: 0, passed: 0, skipped: 0 },
    regression: { run: 0, passed: 0, skipped: 0 },
  };
  for (const r of results) {
    const bucket = init[r.type];
    if (r.skipped) bucket.skipped += 1;
    else {
      bucket.run += 1;
      if (r.passed) bucket.passed += 1;
    }
  }
  return init;
}
