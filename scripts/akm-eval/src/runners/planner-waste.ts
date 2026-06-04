/**
 * Planner-waste runner — detects when the improve pipeline planner queues
 * actions that are immediately refused as no-ops by the underlying
 * command.
 *
 * Motivating bug (May 2026): for ~20 hourly runs, the planner queued 19
 * `distill` attempts per run against `lesson:*` refs. Every one of those
 * attempts returned `{ ok: true, outcome: "skipped", message: "Distill
 * refuses lesson inputs — lessons are the distilled form, not a source."
 * }` because distill structurally refuses lesson inputs. The planner had
 * no memory that those inputs were unservable, so the same 19 refs got
 * re-queued every hour, falsely inflating `distill_attempt` counters in
 * `runs-trend`. A first-class eval case flagged on day-one would have
 * caught this.
 *
 * Classification:
 *
 *   - noOpRefuse : `result.ok === true` AND `result.outcome === "skipped"`
 *                  AND `result.message` mentions "refuses" or "rejects"
 *                  (case-insensitive, word-boundary). This is the shape
 *                  of an upfront command-side input-shape rejection
 *                  ("X refuses Y inputs — Y is the ...") and is
 *                  distinct from `mode === "*-skipped"` rows which are
 *                  PRE-FILTERED by the planner and never invoked.
 *
 * Rates reported:
 *
 *   - noOpRefuseRate          : noOpRefuses / totalActions
 *                               (proportion of the planner's whole queue
 *                                that ended in a no-op refuse).
 *   - noOpRefuseRateLlmTouched: noOpRefuses / llmTouchedActions
 *                               (richer signal: of the actions the
 *                                planner actually attempted to invoke —
 *                                modes without a `-skipped` suffix — how
 *                                many were refused upfront).
 *
 * `llmTouchedActions` = actions whose `mode` does NOT end in `-skipped`.
 * The `*-skipped` mode is the planner saying "I deliberately did not
 * invoke this" (e.g. reflect cooldown pre-filtering); those are NOT
 * planner waste — the planner already learned to skip them. By contrast,
 * the noOpRefuse class is the planner failing to learn that an input is
 * unservable until after the command runs.
 *
 * Inputs:
 *   { windowRuns?: number }   default 20; clamps to the actual number of
 *                             improve runs present on disk.
 *
 * Expected (any subset):
 *   { maxNoOpRefuseRate?: number;
 *     maxNoOpRefuseRateLlmTouched?: number; }
 *
 * Requires:
 *   { minActions?: number }   threshold-skip when the sample is too
 *                             small to be a fair gate (default
 *                             behaviour: when undeclared, no skip).
 *                             Mirrors `proposal-accept-rate-floor`'s
 *                             skip-on-no-decisions pattern.
 */

import { listRecentImproveRunIds, loadImproveResult } from "../sources/improve-result";
import type { EvalCase, EvalCaseResult, EvalContext } from "../types";

/**
 * The "refuses" / "rejects" upfront-rejection shape. Word-boundary
 * matched, case-insensitive. Authored conservatively against the
 * current `Distill refuses lesson inputs — lessons are the distilled
 * form, not a source.` shape; future commands following the same
 * "X refuses Y inputs — Y is the ..." convention are picked up
 * automatically.
 */
const REFUSE_MESSAGE_PATTERN = /\b(refuses|rejects)\b/i;

/** A single classified planner action. */
export interface ClassifiedPlannerAction {
  /** The improve run directory the action came from (run id). */
  runId: string;
  ref: string;
  mode: string;
  /** When `true`, the action is in the noOpRefuse class. */
  noOpRefuse: boolean;
  /** When `true`, the action's mode does NOT end in `-skipped`. */
  llmTouched: boolean;
  /** The `result.message` (capped at 240 chars) when present; used for histogram + evidence. */
  message?: string;
}

/** Raw shape we care about on an improve-result.json action entry. */
export interface PlannerActionInput {
  mode?: string;
  ref?: string;
  result?: {
    ok?: boolean;
    outcome?: string | null;
    message?: string | null;
  };
}

/**
 * Pure classifier. Returns the classification for every action — unlike
 * the reflect runner there is no "not applicable" return because we
 * classify the entire planner queue (denominator = totalActions).
 *
 * Exported for testability so unit tests can feed fixture actions
 * directly without staging an improve-result.json on disk.
 */
export function classifyPlannerAction(
  action: PlannerActionInput,
  runId: string,
): ClassifiedPlannerAction {
  const mode = typeof action.mode === "string" ? action.mode : "";
  const ref = typeof action.ref === "string" ? action.ref : "";
  const messageRaw = action.result?.message;
  const message = typeof messageRaw === "string" && messageRaw.length > 0 ? messageRaw.slice(0, 240) : undefined;
  const ok = action.result?.ok === true;
  const outcome = action.result?.outcome;
  const noOpRefuse =
    ok && outcome === "skipped" && typeof messageRaw === "string" && REFUSE_MESSAGE_PATTERN.test(messageRaw);
  // The "-skipped" suffix is the planner's pre-filter signal; anything
  // else was at least attempted (and may have invoked the LLM).
  const llmTouched = !mode.endsWith("-skipped") && mode !== "";
  return { runId, ref, mode, noOpRefuse, llmTouched, message };
}

/**
 * Per-mode no-op refuse counts.
 */
export type ModeRefuseCounts = Record<string, number>;

/**
 * Aggregate of classifier output — the deliverable surfaced as case
 * metrics. Pure; exported so tests can lock the shape.
 */
export interface PlannerWasteAggregate {
  counts: {
    totalActions: number;
    llmTouchedActions: number;
    noOpRefuses: number;
    /** Per-mode counts of noOpRefuses, e.g. { distill: 19 }. */
    refusesByMode: ModeRefuseCounts;
  };
  /** noOpRefuses / totalActions (null when totalActions === 0). */
  noOpRefuseRate: number | null;
  /** noOpRefuses / llmTouchedActions (null when llmTouchedActions === 0). */
  noOpRefuseRateLlmTouched: number | null;
  /**
   * Top-10 refuse-reason histogram: distinct `result.message` values
   * (verbatim, truncated to 240 chars in the classifier) and their
   * occurrence counts. Sorted by count descending, then alphabetically
   * for stability.
   */
  topReasons: Array<{ message: string; count: number; modes: string[] }>;
  /**
   * For each entry in `topReasons`, up to 3 sample
   * `{runId, ref, mode}` triples — first occurrences in the window.
   */
  samplesByReason: Array<{ message: string; samples: Array<{ runId: string; ref: string; mode: string }> }>;
}

const TOP_REASON_CAP = 10;
const SAMPLE_CAP = 3;

export function aggregatePlannerActions(actions: ClassifiedPlannerAction[]): PlannerWasteAggregate {
  let totalActions = 0;
  let llmTouchedActions = 0;
  let noOpRefuses = 0;
  const refusesByMode: ModeRefuseCounts = {};

  // Reason → count + mode-set + ordered sample list.
  const reasonAccum = new Map<
    string,
    {
      count: number;
      modes: Set<string>;
      samples: Array<{ runId: string; ref: string; mode: string }>;
    }
  >();

  for (const a of actions) {
    totalActions += 1;
    if (a.llmTouched) llmTouchedActions += 1;
    if (!a.noOpRefuse) continue;
    noOpRefuses += 1;
    refusesByMode[a.mode] = (refusesByMode[a.mode] ?? 0) + 1;
    const key = a.message ?? "";
    let bucket = reasonAccum.get(key);
    if (!bucket) {
      bucket = { count: 0, modes: new Set<string>(), samples: [] };
      reasonAccum.set(key, bucket);
    }
    bucket.count += 1;
    bucket.modes.add(a.mode);
    if (bucket.samples.length < SAMPLE_CAP) {
      bucket.samples.push({ runId: a.runId, ref: a.ref, mode: a.mode });
    }
  }

  const reasonEntries = Array.from(reasonAccum.entries()).map(([message, v]) => ({
    message,
    count: v.count,
    modes: Array.from(v.modes).sort(),
    samples: v.samples,
  }));
  reasonEntries.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.message.localeCompare(b.message)));
  const topEntries = reasonEntries.slice(0, TOP_REASON_CAP);
  const topReasons = topEntries.map((e) => ({ message: e.message, count: e.count, modes: e.modes }));
  const samplesByReason = topEntries.map((e) => ({ message: e.message, samples: e.samples }));

  const noOpRefuseRate = totalActions === 0 ? null : noOpRefuses / totalActions;
  const noOpRefuseRateLlmTouched = llmTouchedActions === 0 ? null : noOpRefuses / llmTouchedActions;

  return {
    counts: { totalActions, llmTouchedActions, noOpRefuses, refusesByMode },
    noOpRefuseRate,
    noOpRefuseRateLlmTouched,
    topReasons,
    samplesByReason,
  };
}

/**
 * Read the N most-recent improve runs from `improve_runs` in state.db
 * (chronological, oldest first) and classify every action. Missing /
 * malformed envelopes are silently skipped — the toolkit is read-only
 * and best-effort.
 *
 * Returns the set of run ids actually consumed alongside the actions
 * so the runner can report the effective window.
 */
export function collectPlannerActions(
  stashRoot: string,
  windowRuns: number,
): { actions: ClassifiedPlannerAction[]; runIdsRead: string[]; runsRoot: string } {
  const runsRoot = "state.db//improve_runs";
  const ids = listRecentImproveRunIds(windowRuns);

  const actions: ClassifiedPlannerAction[] = [];
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
      actions.push(classifyPlannerAction(raw as PlannerActionInput, id));
    }
  }
  return { actions, runIdsRead, runsRoot };
}

/**
 * Resolve the window size from the case's `input.windowRuns`. Defaults
 * to 20 to keep runs bounded and to align with the operator-side
 * default `runs-trend` already used.
 */
function resolveWindowRuns(c: EvalCase): number {
  const w = c.input.windowRuns;
  if (typeof w === "number" && Number.isFinite(w) && w > 0) return Math.floor(w);
  return 20;
}

interface PlannerWasteExpected {
  maxNoOpRefuseRate?: number;
  maxNoOpRefuseRateLlmTouched?: number;
}

export async function runPlannerWasteCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  const expected = (c.expected ?? {}) as PlannerWasteExpected;
  const minActions = c.requires?.minActions;

  const windowRuns = resolveWindowRuns(c);
  let collected: ReturnType<typeof collectPlannerActions>;
  try {
    collected = collectPlannerActions(ctx.stashRoot, windowRuns);
  } catch (err) {
    return errorResult(c, err instanceof Error ? err.message : String(err), start);
  }
  const aggregate = aggregatePlannerActions(collected.actions);

  // Sample-size guard. Skip when the metric would be too noisy to be a
  // fair gate. Always evaluated against `totalActions` (not just the
  // LLM-touched subset) because the gate's denominator is the whole
  // planner queue.
  if (minActions !== undefined && aggregate.counts.totalActions < minActions) {
    return {
      caseId: c.id,
      type: "planner-waste",
      score: 1,
      passed: true,
      skipped: true,
      skipReason: `only ${aggregate.counts.totalActions} action(s) across ${collected.runIdsRead.length} run(s); minActions=${minActions}`,
      metrics: {
        ...metricsBlock(aggregate, collected, windowRuns),
        threshold: { minActions },
      },
      evidence: evidenceBlock(aggregate),
      durationMs: Date.now() - start,
    };
  }

  // If there are zero runs on disk we skip with a clearer reason than
  // the sample-size guard would give.
  if (collected.runIdsRead.length === 0) {
    return {
      caseId: c.id,
      type: "planner-waste",
      score: 1,
      passed: true,
      skipped: true,
      skipReason: `no improve runs under ${collected.runsRoot}`,
      metrics: metricsBlock(aggregate, collected, windowRuns),
      evidence: evidenceBlock(aggregate),
      durationMs: Date.now() - start,
    };
  }

  // Per-expectation checks. Skipped expectations (rate === null) do not
  // count against the score — same shape as proposal-quality.
  const checks: Array<{ name: string; ok: boolean; value: number | null }> = [];
  if (expected.maxNoOpRefuseRate !== undefined) {
    checks.push({
      name: "maxNoOpRefuseRate",
      ok: aggregate.noOpRefuseRate === null ? true : aggregate.noOpRefuseRate <= expected.maxNoOpRefuseRate,
      value: aggregate.noOpRefuseRate,
    });
  }
  if (expected.maxNoOpRefuseRateLlmTouched !== undefined) {
    checks.push({
      name: "maxNoOpRefuseRateLlmTouched",
      ok:
        aggregate.noOpRefuseRateLlmTouched === null
          ? true
          : aggregate.noOpRefuseRateLlmTouched <= expected.maxNoOpRefuseRateLlmTouched,
      value: aggregate.noOpRefuseRateLlmTouched,
    });
  }

  const passThreshold = c.scoring?.passThreshold ?? 1.0;
  const score = checks.length === 0 ? 1 : checks.filter((x) => x.ok).length / checks.length;

  return {
    caseId: c.id,
    type: "planner-waste",
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
  aggregate: PlannerWasteAggregate,
  collected: ReturnType<typeof collectPlannerActions>,
  windowRuns: number,
): Record<string, unknown> {
  return {
    windowRuns,
    runsConsidered: collected.runIdsRead.length,
    runsRoot: collected.runsRoot,
    counts: aggregate.counts,
    noOpRefuseRate: aggregate.noOpRefuseRate,
    noOpRefuseRateLlmTouched: aggregate.noOpRefuseRateLlmTouched,
    topReasons: aggregate.topReasons,
  };
}

function evidenceBlock(aggregate: PlannerWasteAggregate): Record<string, unknown> {
  return {
    samplesByReason: aggregate.samplesByReason,
  };
}

function errorResult(c: EvalCase, message: string, start: number): EvalCaseResult {
  return {
    caseId: c.id,
    type: "planner-waste",
    score: 0,
    passed: false,
    metrics: {},
    evidence: {},
    errors: [message],
    durationMs: Date.now() - start,
  };
}
