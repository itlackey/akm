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
  "reflect-quality": 0.05,
  "memory-safety": 0.2,
  "workflow-compliance": 0.1,
  "judge-calibration": 0.10,
  regression: 0.05,
};

export function aggregateScores(results: EvalCaseResult[]): {
  overall: number;
  /**
   * Weighted mean restricted to cases where `result.deterministic !== false`.
   * Cases that opt out (e.g. judge-calibration cases that depend on LLM
   * outcomes) are excluded so CI gates remain deterministic. When no
   * deterministic cases ran, `deterministic` falls back to `overall`.
   */
  deterministic: number;
  /**
   * Phase 7: mean of all `case.llmJudgement.score` values that came back
   * from the judge (errors excluded). `undefined` when no case carried a
   * judge result. This is recorded separately and is NEVER folded into
   * `deterministic` or `overall` — the MT-Bench variance argument
   * (arXiv:2306.05685) is why judge scores remain an audit signal only.
   */
  llmJudged?: number;
  byType: Record<EvalCaseType, { run: number; passed: number; skipped: number; score: number }>;
} {
  type Bucket = { run: number; passed: number; skipped: number; scores: number[]; deterministicScores: number[] };
  const blankBucket = (): Bucket => ({ run: 0, passed: 0, skipped: 0, scores: [], deterministicScores: [] });
  const byType: Record<EvalCaseType, Bucket> = {
    retrieval: blankBucket(),
    "lesson-application": blankBucket(),
    "proposal-quality": blankBucket(),
    "reflect-quality": blankBucket(),
    "memory-safety": blankBucket(),
    "workflow-compliance": blankBucket(),
    "judge-calibration": blankBucket(),
    regression: blankBucket(),
  };

  for (const r of results) {
    const bucket = byType[r.type];
    if (r.skipped) {
      bucket.skipped += 1;
      continue;
    }
    bucket.run += 1;
    bucket.scores.push(r.score);
    if (r.deterministic !== false) bucket.deterministicScores.push(r.score);
    if (r.passed) bucket.passed += 1;
  }

  const reduced: Record<EvalCaseType, { run: number; passed: number; skipped: number; score: number }> = {
    retrieval: { run: 0, passed: 0, skipped: 0, score: 0 },
    "lesson-application": { run: 0, passed: 0, skipped: 0, score: 0 },
    "proposal-quality": { run: 0, passed: 0, skipped: 0, score: 0 },
    "reflect-quality": { run: 0, passed: 0, skipped: 0, score: 0 },
    "memory-safety": { run: 0, passed: 0, skipped: 0, score: 0 },
    "workflow-compliance": { run: 0, passed: 0, skipped: 0, score: 0 },
    "judge-calibration": { run: 0, passed: 0, skipped: 0, score: 0 },
    regression: { run: 0, passed: 0, skipped: 0, score: 0 },
  };

  let overallSum = 0;
  let overallW = 0;
  let detSum = 0;
  let detW = 0;
  for (const key of Object.keys(byType) as EvalCaseType[]) {
    const b = byType[key];
    const avgAll = b.scores.length === 0 ? 0 : b.scores.reduce((a, x) => a + x, 0) / b.scores.length;
    const avgDet = b.deterministicScores.length === 0 ? 0 : b.deterministicScores.reduce((a, x) => a + x, 0) / b.deterministicScores.length;
    reduced[key] = { run: b.run, passed: b.passed, skipped: b.skipped, score: avgAll };
    const w = DEFAULT_TYPE_WEIGHTS[key];
    if (b.scores.length > 0) {
      overallSum += avgAll * w;
      overallW += w;
    }
    if (b.deterministicScores.length > 0) {
      detSum += avgDet * w;
      detW += w;
    }
  }

  const overall = overallW === 0 ? 0 : overallSum / overallW;
  const deterministic = detW === 0 ? overall : detSum / detW;

  // Phase 7: LLM-judged mean — strictly separate from deterministic.
  // Only judge calls that came back without `error` contribute to the
  // mean; failed calls count as "skipped" for judging purposes.
  const judgeScores: number[] = [];
  for (const r of results) {
    const j = r.llmJudgement;
    if (!j) continue;
    if (j.error) continue;
    if (Number.isFinite(j.score)) judgeScores.push(j.score);
  }
  const llmJudged =
    judgeScores.length === 0
      ? undefined
      : judgeScores.reduce((a, x) => a + x, 0) / judgeScores.length;

  return { overall, deterministic, llmJudged, byType: reduced };
}

export function buildCountsByType(results: EvalCaseResult[]): EvalRunResult["countsByType"] {
  const init: EvalRunResult["countsByType"] = {
    retrieval: { run: 0, passed: 0, skipped: 0 },
    "lesson-application": { run: 0, passed: 0, skipped: 0 },
    "proposal-quality": { run: 0, passed: 0, skipped: 0 },
    "reflect-quality": { run: 0, passed: 0, skipped: 0 },
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
