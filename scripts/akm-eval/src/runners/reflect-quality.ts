/**
 * Reflect-quality runner — classifies reflect / reflect-failed actions
 * across recent improve runs and surfaces the metrics PR 3 gate
 * decisions hinge on.
 *
 * The historical hand-rolled jq pattern was:
 *
 *   jq '[.actions[] | select(.mode=="reflect" or .mode=="reflect-failed")
 *        | {mode, ref, reason: .result.reason,
 *           errSnip: (.result.error // "" | tostring | .[0:120])}]'
 *
 * Classification (per the operator notes in
 * docs/improve-stats.md / the PR 3 gate discussion):
 *
 *   - succeeded         : mode === "reflect"               (no failure)
 *   - schema-shape      : reflect-failed AND error matches
 *                         "missing required string field" |
 *                         "JSON Parse error" |
 *                         "Unterminated string"
 *   - content-policy    : reflect-failed AND error starts with
 *                         "Reflect rejected: EXCESSIVE_"
 *                         (EXCESSIVE_EXPANSION / EXCESSIVE_SHRINKAGE)
 *   - gate-refused      : reflect-failed AND error starts with
 *                         "Reflect refused:"
 *                         (e.g. asset type not supported)
 *   - other             : reflect-failed but matched none of the above
 *                         (recorded for triage; counted as LLM-touched
 *                          since the LLM was called)
 *
 * LLM-touched denominator = succeeded + schema-shape + content-policy + other
 *   (gate-refused are pre-validation rejections — the LLM was never
 *    called for them, so excluding them from the denominator is the
 *    correct shape for measuring schema compliance.)
 *
 * schemaShapeRate = schema-shape / LLM-touched   (null when LLM-touched = 0)
 *
 * Inputs:
 *   { windowRuns?: number }   default 20; clamps to the actual number of
 *                             improve runs present on disk.
 *
 * Expected (any subset):
 *   { maxSchemaShapeRate?: number;
 *     maxContentPolicyRate?: number;
 *     minSuccessRate?: number; }
 *
 * Requires:
 *   { minLlmTouchedReflects?: number }  threshold-skip when the LLM-touched
 *                                       sample is below this. Mirrors
 *                                       proposal-accept-rate-floor's
 *                                       skip-on-no-decisions pattern.
 */

import fs from "node:fs";
import path from "node:path";
import { loadImproveResult } from "../sources/improve-result";
import { resolveImproveRunsRoot } from "../sources/paths";
import type { EvalCase, EvalCaseResult, EvalContext } from "../types";

/** A single classified reflect action. */
export interface ClassifiedReflectAction {
  /** The improve run directory the action came from (run id). */
  runId: string;
  ref: string;
  mode: "reflect" | "reflect-failed";
  classification: "succeeded" | "schemaShape" | "contentPolicy" | "gateRefused" | "other";
  /** First 200 chars of the error string, when present — for triage evidence. */
  errSnippet?: string;
}

/** Raw shape we care about on an improve-result.json action entry. */
export interface ReflectActionInput {
  mode?: string;
  ref?: string;
  result?: {
    reason?: string | null;
    error?: string | null;
  };
}

/**
 * Pure classifier. Returns `null` when the action is not a reflect /
 * reflect-failed (callers filter this out).
 *
 * Exported for testability so unit tests can feed fixture actions
 * directly without staging an improve-result.json on disk.
 */
export function classifyReflectAction(
  action: ReflectActionInput,
  runId: string,
): ClassifiedReflectAction | null {
  const mode = action.mode;
  if (mode !== "reflect" && mode !== "reflect-failed") return null;
  const ref = action.ref ?? "";
  const errRaw = action.result?.error ?? "";
  const err = typeof errRaw === "string" ? errRaw : String(errRaw);
  const errSnippet = err ? err.slice(0, 200) : undefined;

  if (mode === "reflect") {
    return { runId, ref, mode, classification: "succeeded", errSnippet };
  }
  // mode === "reflect-failed"
  if (err.startsWith("Reflect refused:")) {
    return { runId, ref, mode, classification: "gateRefused", errSnippet };
  }
  if (err.startsWith("Reflect rejected: EXCESSIVE_")) {
    return { runId, ref, mode, classification: "contentPolicy", errSnippet };
  }
  if (
    err.includes("missing required string field") ||
    err.includes("JSON Parse error") ||
    err.includes("Unterminated string")
  ) {
    return { runId, ref, mode, classification: "schemaShape", errSnippet };
  }
  return { runId, ref, mode, classification: "other", errSnippet };
}

/**
 * Aggregate per-class counts + the derived rates we report on. Pure;
 * exported so the runner and the test fixtures share one source of
 * truth.
 */
export interface ReflectAggregate {
  counts: {
    succeeded: number;
    schemaShape: number;
    contentPolicy: number;
    gateRefused: number;
    other: number;
    /** All reflect/reflect-failed actions across the window. */
    totalReflectActions: number;
    /** succeeded + schemaShape + contentPolicy + other (gateRefused excluded). */
    llmTouched: number;
  };
  /** schemaShape / llmTouched (null when llmTouched === 0). */
  schemaShapeRate: number | null;
  /** contentPolicy / llmTouched (null when llmTouched === 0). */
  contentPolicyRate: number | null;
  /** succeeded / llmTouched (null when llmTouched === 0). */
  successRate: number | null;
  /** Sample of at most 3 actions per non-succeeded class, for triage. */
  samples: {
    schemaShape: ClassifiedReflectAction[];
    contentPolicy: ClassifiedReflectAction[];
    gateRefused: ClassifiedReflectAction[];
    other: ClassifiedReflectAction[];
  };
}

export function aggregateReflectActions(actions: ClassifiedReflectAction[]): ReflectAggregate {
  const counts = {
    succeeded: 0,
    schemaShape: 0,
    contentPolicy: 0,
    gateRefused: 0,
    other: 0,
    totalReflectActions: actions.length,
    llmTouched: 0,
  };
  const samples: ReflectAggregate["samples"] = {
    schemaShape: [],
    contentPolicy: [],
    gateRefused: [],
    other: [],
  };
  for (const a of actions) {
    switch (a.classification) {
      case "succeeded":
        counts.succeeded += 1;
        break;
      case "schemaShape":
        counts.schemaShape += 1;
        if (samples.schemaShape.length < 3) samples.schemaShape.push(a);
        break;
      case "contentPolicy":
        counts.contentPolicy += 1;
        if (samples.contentPolicy.length < 3) samples.contentPolicy.push(a);
        break;
      case "gateRefused":
        counts.gateRefused += 1;
        if (samples.gateRefused.length < 3) samples.gateRefused.push(a);
        break;
      case "other":
        counts.other += 1;
        if (samples.other.length < 3) samples.other.push(a);
        break;
    }
  }
  counts.llmTouched =
    counts.succeeded + counts.schemaShape + counts.contentPolicy + counts.other;
  const schemaShapeRate = counts.llmTouched === 0 ? null : counts.schemaShape / counts.llmTouched;
  const contentPolicyRate = counts.llmTouched === 0 ? null : counts.contentPolicy / counts.llmTouched;
  const successRate = counts.llmTouched === 0 ? null : counts.succeeded / counts.llmTouched;
  return { counts, schemaShapeRate, contentPolicyRate, successRate, samples };
}

/**
 * Walk `<stash>/.akm/runs/*` (most recent first), read each
 * improve-result.json, and yield the classified reflect actions for the
 * most recent `windowRuns` runs. Missing / malformed envelopes are
 * silently skipped — the toolkit is read-only and best-effort.
 *
 * Returns the set of run ids actually consumed alongside the actions
 * so the runner can report the effective window.
 */
export function collectReflectActions(
  stashRoot: string,
  windowRuns: number,
): { actions: ClassifiedReflectAction[]; runIdsRead: string[]; runsRoot: string } {
  const runsRoot = resolveImproveRunsRoot(stashRoot);
  if (!fs.existsSync(runsRoot)) {
    return { actions: [], runIdsRead: [], runsRoot };
  }
  const allIds = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  // Newest last (lexicographic sort of ISO-prefixed names is
  // chronological), so the last `windowRuns` are the most recent.
  const ids = windowRuns > 0 && allIds.length > windowRuns ? allIds.slice(allIds.length - windowRuns) : allIds;

  const actions: ClassifiedReflectAction[] = [];
  const runIdsRead: string[] = [];
  for (const id of ids) {
    let envelope: Awaited<ReturnType<typeof loadImproveResult>>["envelope"];
    try {
      envelope = loadImproveResult(stashRoot, id).envelope;
    } catch {
      continue;
    }
    runIdsRead.push(id);
    const rawActions = Array.isArray(envelope.actions) ? envelope.actions : [];
    for (const raw of rawActions) {
      const classified = classifyReflectAction(raw as ReflectActionInput, id);
      if (classified) actions.push(classified);
    }
  }
  return { actions, runIdsRead, runsRoot };
}

/**
 * Resolve the window size from the case's `input.windowRuns`. Defaults
 * to 20 to keep runs bounded; mirrors the operator-side default the
 * hand-rolled `runs-trend` script also defaulted to.
 */
function resolveWindowRuns(c: EvalCase): number {
  const w = c.input.windowRuns;
  if (typeof w === "number" && Number.isFinite(w) && w > 0) return Math.floor(w);
  return 20;
}

interface ReflectExpected {
  maxSchemaShapeRate?: number;
  maxContentPolicyRate?: number;
  minSuccessRate?: number;
}

export async function runReflectQualityCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  const expected = (c.expected ?? {}) as ReflectExpected;
  // Sample-size guard lives on `c.requires` (alongside features /
  // minAkmVersion) because it's a precondition for the threshold check,
  // not a runner input. Mirrors the spirit of `proposal-accept-rate-floor`
  // skipping on zero decisions.
  const minLlm = c.requires?.minLlmTouchedReflects;

  const windowRuns = resolveWindowRuns(c);
  let collected: ReturnType<typeof collectReflectActions>;
  try {
    collected = collectReflectActions(ctx.stashRoot, windowRuns);
  } catch (err) {
    return errorResult(c, err instanceof Error ? err.message : String(err), start);
  }
  const aggregate = aggregateReflectActions(collected.actions);

  // Sample-size guard. Skip when the metric is too noisy to be a fair
  // gate. Always evaluated against the LLM-touched denominator
  // (gateRefused excluded).
  if (minLlm !== undefined && aggregate.counts.llmTouched < minLlm) {
    return {
      caseId: c.id,
      type: "reflect-quality",
      score: 1,
      passed: true,
      skipped: true,
      skipReason: `only ${aggregate.counts.llmTouched} LLM-touched reflect(s) across ${collected.runIdsRead.length} run(s); minLlmTouchedReflects=${minLlm}`,
      metrics: {
        ...metricsBlock(aggregate, collected, windowRuns),
        threshold: { minLlmTouchedReflects: minLlm },
      },
      evidence: evidenceBlock(aggregate),
      durationMs: Date.now() - start,
    };
  }

  // Per-expectation checks. Skipped expectations (rate === null) do not
  // count against the score — same pattern as proposal-quality.
  const checks: Array<{ name: string; ok: boolean; value: number | null }> = [];
  if (expected.maxSchemaShapeRate !== undefined) {
    checks.push({
      name: "maxSchemaShapeRate",
      ok: aggregate.schemaShapeRate === null ? true : aggregate.schemaShapeRate <= expected.maxSchemaShapeRate,
      value: aggregate.schemaShapeRate,
    });
  }
  if (expected.maxContentPolicyRate !== undefined) {
    checks.push({
      name: "maxContentPolicyRate",
      ok: aggregate.contentPolicyRate === null ? true : aggregate.contentPolicyRate <= expected.maxContentPolicyRate,
      value: aggregate.contentPolicyRate,
    });
  }
  if (expected.minSuccessRate !== undefined) {
    checks.push({
      name: "minSuccessRate",
      ok: aggregate.successRate === null ? true : aggregate.successRate >= expected.minSuccessRate,
      value: aggregate.successRate,
    });
  }

  const passThreshold = c.scoring?.passThreshold ?? 1.0;
  const score = checks.length === 0 ? 1 : checks.filter((x) => x.ok).length / checks.length;

  return {
    caseId: c.id,
    type: "reflect-quality",
    score,
    passed: score >= passThreshold,
    metrics: {
      ...metricsBlock(aggregate, collected, windowRuns),
      checks,
    },
    evidence: evidenceBlock(aggregate),
    durationMs: Date.now() - start,
  };
}

function metricsBlock(
  aggregate: ReflectAggregate,
  collected: ReturnType<typeof collectReflectActions>,
  windowRuns: number,
): Record<string, unknown> {
  return {
    windowRuns,
    runsConsidered: collected.runIdsRead.length,
    runsRoot: collected.runsRoot,
    counts: aggregate.counts,
    schemaShapeRate: aggregate.schemaShapeRate,
    contentPolicyRate: aggregate.contentPolicyRate,
    successRate: aggregate.successRate,
  };
}

function evidenceBlock(aggregate: ReflectAggregate): Record<string, unknown> {
  return {
    sampleByClass: {
      schemaShape: aggregate.samples.schemaShape.map(toSample),
      contentPolicy: aggregate.samples.contentPolicy.map(toSample),
      gateRefused: aggregate.samples.gateRefused.map(toSample),
      other: aggregate.samples.other.map(toSample),
    },
  };
}

function toSample(a: ClassifiedReflectAction): Record<string, unknown> {
  return {
    runId: a.runId,
    ref: a.ref,
    errSnippet: a.errSnippet,
  };
}

function errorResult(c: EvalCase, message: string, start: number): EvalCaseResult {
  return {
    caseId: c.id,
    type: "reflect-quality",
    score: 0,
    passed: false,
    metrics: {},
    evidence: {},
    errors: [message],
    durationMs: Date.now() - start,
  };
}
