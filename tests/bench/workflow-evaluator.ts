/**
 * akm-bench workflow compliance evaluator (issue #256).
 *
 * Consumes a normalized `WorkflowTraceResult` (from `./workflow-trace`, issue
 * #254) plus a declarative `WorkflowSpec` (from `./workflow-spec`, issue #255)
 * and produces one `WorkflowCheckResult` per (run, spec) describing how well
 * the run satisfied the spec.
 *
 * Design rules:
 *   - Pure: never mutates the input trace, spec, run, or task metadata, and
 *     never throws on malformed input. Bad input yields a `harness_error`
 *     status with a structured violation.
 *   - Bounded: caps total emitted violations per (run, spec) at
 *     `MAX_VIOLATIONS_PER_CHECK` (32) so a pathological run cannot OOM
 *     downstream reporters.
 *   - Stable contract: `schemaVersion: 1` on the result envelope. Only
 *     additive changes to violation codes / new optional fields are allowed
 *     without a major bump.
 *
 * Spec semantics (from #255 fixtures):
 *   - `required_sequence[i].event` — event must appear at least once.
 *   - `required_sequence[i].before = X` — first occurrence of `event` must
 *     precede first occurrence of `X`.
 *   - `required_sequence[i].after  = X` — first occurrence of `event` must
 *     follow first occurrence of `X` (if `X` is absent, the constraint is
 *     vacuous; the `after`-event's required-event check captures missing-X).
 *   - `required_sequence[i].min_count = N` — event count must be ≥ N.
 *   - `required_sequence[i].polarity` — at least one matching feedback event
 *     must carry that polarity (resolved from `metadata.polarity` on the
 *     trace event when present, else inferred from feedback args).
 *   - `required_sequence[i].ref_must_equal = "gold_ref"` — the matching
 *     event's `assetRef` must equal `taskMetadata.gold_ref`.
 *   - `required_sequence[i].required_if = <flag>` — step is only required
 *     when `taskMetadata.flags[<flag>]` is true. Unknown flags default to
 *     `false`, i.e. the step is treated as optional.
 *   - `forbidden[i].event` — event must NOT appear.
 *   - `forbidden[i].before = X` — event must NOT appear before X.
 *   - `forbidden[i].after  = X` — event must NOT appear after X.
 *   - `forbidden[i].polarity` — feedback event with that polarity must NOT
 *     appear.
 *
 * Verifier-aware checks (acceptance criteria):
 *   - `feedback polarity` — when `verifierFailed = true`, any recorded
 *     `akm_feedback` must include a negative-polarity event; emitting only
 *     positive feedback raises `wrong_feedback_polarity`.
 *   - `gold_ref` — when `taskMetadata.goldRef` is set, the trace must contain
 *     an `akm_show` whose `assetRef` matches `goldRef`. Loading other refs
 *     instead raises `irrelevant_asset_loaded`.
 */

import type { WorkflowForbiddenStep, WorkflowSequenceStep, WorkflowSpec } from "./workflow-spec";
import { specApplies } from "./workflow-spec";
import type { WorkflowTraceEvent, WorkflowTraceEventType, WorkflowTraceResult } from "./workflow-trace";

/* ─── Public API ──────────────────────────────────────────────────────────── */

export type WorkflowCheckStatus = "pass" | "partial" | "fail" | "not_applicable" | "harness_error";

export type WorkflowViolationCode =
  | "missing_required_event"
  | "wrong_order"
  | "forbidden_event"
  | "missing_evidence"
  | "late_feedback"
  | "wrong_feedback_polarity"
  | "irrelevant_asset_loaded"
  | "reflection_without_failure"
  | "proposal_accepted_without_validation";

export interface WorkflowViolation {
  code: WorkflowViolationCode;
  message: string;
  expected?: string;
  observed?: string;
}

export interface WorkflowEvidenceSummary {
  /** Total events the trace contributed to the spec's vocabulary. */
  matchedEvents: number;
  /** Whether any feedback event was observed at all. */
  feedbackRecorded: boolean;
  /** Whether the gold asset (when declared) was loaded by the agent. */
  goldAssetLoaded: boolean;
  /** Whether trace was truncated upstream (mirrors WorkflowTraceResult.truncated). */
  traceTruncated: boolean;
}

export interface WorkflowCheckResult {
  schemaVersion: 1;
  workflowId: string;
  taskId: string;
  arm: string;
  seed: number;
  status: WorkflowCheckStatus;
  /** [0, 1], higher = better. 0 for harness_error / fully-failed. */
  score: number;
  requiredPassed: number;
  requiredTotal: number;
  violations: WorkflowViolation[];
  evidence: WorkflowEvidenceSummary;
}

/**
 * Run-level context used by `specApplies` and the verifier-aware checks.
 *
 * `outcome` mirrors the `RunResult.outcome` field (e.g. "pass" | "fail").
 * `verifierFailed` controls feedback-polarity expectations; when omitted it
 * is inferred from `outcome === "fail"`.
 */
export interface WorkflowEvalRunContext {
  arm: string;
  taskId: string;
  seed: number;
  outcome?: string;
  verifierFailed?: boolean;
  repeatedFailures?: number;
}

/**
 * Task-side metadata. All fields optional. Unknown `required_if` flags
 * default to `false` so a missing flag does NOT cause a false-positive
 * `missing_required_event`.
 */
export interface WorkflowEvalTaskMetadata {
  /** Asset ref the agent should have loaded, e.g. `skill:deploy`. */
  goldRef?: string;
  /** Boolean flags consulted by `required_if`. */
  flags?: Record<string, boolean>;
}

/* ─── Caps (documented contract) ──────────────────────────────────────────── */

/** Hard cap on emitted violations per (run, spec). Prevents runaway reports. */
export const MAX_VIOLATIONS_PER_CHECK = 32;

/* ─── Top-level entry points ──────────────────────────────────────────────── */

/**
 * Evaluate one run-trace against one spec. Pure; never throws; never mutates
 * inputs.
 *
 * Callers who want applicability filtering should use
 * `evaluateRunAgainstAllSpecs` — this entry point evaluates unconditionally
 * and assumes the caller already decided the spec applies. (It still returns
 * `harness_error` if inputs are obviously malformed.)
 */
export function evaluateRunAgainstSpec(
  trace: WorkflowTraceResult | undefined | null,
  spec: WorkflowSpec | undefined | null,
  run: WorkflowEvalRunContext,
  task: WorkflowEvalTaskMetadata = {},
): WorkflowCheckResult {
  // Harness validation: malformed inputs short-circuit with a structured violation.
  const harnessError = validateInputs(trace, spec, run);
  if (harnessError) return harnessError;

  // Past validateInputs we know trace & spec are well-formed.
  const t = trace as WorkflowTraceResult;
  const s = spec as WorkflowSpec;

  const events = Array.isArray(t.events) ? t.events.filter(isUsableEvent) : [];
  const violations: WorkflowViolation[] = [];
  const flags = task.flags ?? {};

  // ── Required-sequence checks ──────────────────────────────────────────────
  let requiredTotal = 0;
  let requiredPassed = 0;

  for (const step of s.required_sequence) {
    if (step.required_if && !flags[step.required_if]) {
      // Conditional step skipped.
      continue;
    }
    requiredTotal += 1;
    const ok = checkRequiredStep(step, events, task, violations);
    if (ok) requiredPassed += 1;
  }

  // ── Forbidden checks ──────────────────────────────────────────────────────
  let forbiddenTotal = 0;
  let forbiddenPassed = 0;

  for (const step of s.forbidden ?? []) {
    forbiddenTotal += 1;
    const ok = checkForbiddenStep(step, events, violations);
    if (ok) forbiddenPassed += 1;
  }

  // ── Verifier-aware feedback polarity check ────────────────────────────────
  const verifierFailed = run.verifierFailed ?? run.outcome === "fail";
  const feedbackEvents = events.filter((e) => e.type === "akm_feedback");
  const polarityCheckOk = checkVerifierPolarity(verifierFailed, feedbackEvents, violations);

  // ── Gold-ref check (when task has goldRef and spec expects gold loading) ──
  const goldAssetLoaded = checkGoldRef(task.goldRef, events, s, violations);

  // ── Score & status ────────────────────────────────────────────────────────
  const w = s.scoring;
  const requiredFraction = requiredTotal === 0 ? 1 : requiredPassed / requiredTotal;
  const forbiddenFraction = forbiddenTotal === 0 ? 1 : forbiddenPassed / forbiddenTotal;
  // Evidence quality: feedback-polarity match + gold-ref match + verifier_run present.
  const evidenceSignals: number[] = [polarityCheckOk ? 1 : 0];
  if (task.goldRef !== undefined) evidenceSignals.push(goldAssetLoaded ? 1 : 0);
  if (events.some((e) => e.type === "verifier_run")) evidenceSignals.push(1);
  else evidenceSignals.push(0);
  const evidenceFraction = evidenceSignals.length === 0 ? 1 : average(evidenceSignals);

  let score =
    w.required_steps_weight * requiredFraction +
    w.forbidden_steps_weight * forbiddenFraction +
    w.evidence_quality_weight * evidenceFraction;
  score = clampUnit(score);

  // Cap violations after computing score so the score reflects ALL findings.
  const cappedViolations = capViolations(violations);

  let status: WorkflowCheckStatus;
  if (requiredTotal === 0) {
    // No required steps applied (e.g. all required_if guards were false).
    // Treat as pass when no violations were found, partial otherwise.
    status = cappedViolations.length === 0 ? "pass" : "partial";
  } else if (requiredPassed === requiredTotal && cappedViolations.length === 0) {
    status = "pass";
  } else if (requiredPassed === 0) {
    status = "fail";
  } else {
    status = "partial";
  }

  const evidence: WorkflowEvidenceSummary = {
    matchedEvents: countMatchingEvents(events, s),
    feedbackRecorded: feedbackEvents.length > 0,
    goldAssetLoaded,
    traceTruncated: t.truncated === true,
  };

  return {
    schemaVersion: 1,
    workflowId: s.id,
    taskId: run.taskId,
    arm: run.arm,
    seed: run.seed,
    status,
    score,
    requiredPassed,
    requiredTotal,
    violations: cappedViolations,
    evidence,
  };
}

/**
 * Evaluate one trace against many specs, applying `applies_to` filters. Specs
 * whose filter excludes the run produce a `not_applicable` result with empty
 * violations and `score = 0`; this preserves a stable 1-result-per-spec shape
 * for downstream reporters.
 */
export function evaluateRunAgainstAllSpecs(
  trace: WorkflowTraceResult | undefined | null,
  specs: readonly WorkflowSpec[] | undefined | null,
  run: WorkflowEvalRunContext,
  task: WorkflowEvalTaskMetadata = {},
): WorkflowCheckResult[] {
  if (!Array.isArray(specs)) return [];
  const out: WorkflowCheckResult[] = [];
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") continue;
    const applicable = specApplies(spec, {
      arm: run.arm,
      taskId: run.taskId,
      outcome: run.outcome,
      hasGoldRef: task.goldRef !== undefined,
      repeatedFailures: run.repeatedFailures,
    });
    if (!applicable) {
      out.push(makeNotApplicable(spec, run));
      continue;
    }
    out.push(evaluateRunAgainstSpec(trace, spec, run, task));
  }
  return out;
}

/* ─── Required-step check ─────────────────────────────────────────────────── */

function checkRequiredStep(
  step: WorkflowSequenceStep,
  events: WorkflowTraceEvent[],
  task: WorkflowEvalTaskMetadata,
  violations: WorkflowViolation[],
): boolean {
  const matchingForStep = events.filter((e) => e.type === step.event);

  // 1) Polarity-aware filter: a polarity-tagged step only counts feedback
  //    events with the right polarity.
  const matching =
    step.polarity !== undefined ? matchingForStep.filter((e) => eventPolarity(e) === step.polarity) : matchingForStep;

  // 2) Presence + min_count.
  const minCount = step.min_count ?? 1;
  if (matching.length < minCount) {
    pushViolation(violations, {
      code: "missing_required_event",
      message:
        step.polarity !== undefined
          ? `expected ≥${minCount} ${step.event} event(s) with polarity=${step.polarity}, observed ${matching.length}`
          : `expected ≥${minCount} ${step.event} event(s), observed ${matching.length}`,
      expected: step.polarity ? `${step.event}(${step.polarity}) x${minCount}` : `${step.event} x${minCount}`,
      observed: `${matching.length}`,
    });
    return false;
  }

  // 3) ref_must_equal — match a matching event to the task field.
  if (step.ref_must_equal !== undefined) {
    const wantedRef = resolveRefField(step.ref_must_equal, task);
    if (wantedRef === undefined) {
      pushViolation(violations, {
        code: "missing_evidence",
        message: `step expects ref_must_equal=${step.ref_must_equal} but task does not declare it`,
        expected: step.ref_must_equal,
      });
      return false;
    }
    const refMatch = matching.find((e) => e.assetRef === wantedRef);
    if (!refMatch) {
      const observedRef = matching.find((e) => typeof e.assetRef === "string")?.assetRef;
      pushViolation(violations, {
        code: "irrelevant_asset_loaded",
        message: `${step.event} did not load ${step.ref_must_equal}=${wantedRef}`,
        expected: wantedRef,
        observed: observedRef,
      });
      return false;
    }
  }

  // 4) before/after order checks. We compare FIRST occurrence (by event id).
  const firstThis = firstId(matching);
  if (step.before !== undefined && firstThis !== undefined) {
    const firstOther = firstId(events.filter((e) => e.type === step.before));
    if (firstOther !== undefined && firstThis >= firstOther) {
      pushViolation(violations, {
        code: "wrong_order",
        message: `expected ${step.event} before ${step.before}, but ${step.before} occurred first`,
        expected: `${step.event} < ${step.before}`,
        observed: `${step.before} < ${step.event}`,
      });
      return false;
    }
  }
  if (step.after !== undefined && firstThis !== undefined) {
    const firstOther = firstId(events.filter((e) => e.type === step.after));
    if (firstOther !== undefined && firstThis <= firstOther) {
      pushViolation(violations, {
        code: "wrong_order",
        message: `expected ${step.event} after ${step.after}, but ${step.event} occurred first`,
        expected: `${step.after} < ${step.event}`,
        observed: `${step.event} < ${step.after}`,
      });
      return false;
    }
  }

  return true;
}

/* ─── Forbidden-step check ────────────────────────────────────────────────── */

function checkForbiddenStep(
  step: WorkflowForbiddenStep,
  events: WorkflowTraceEvent[],
  violations: WorkflowViolation[],
): boolean {
  const matchingForType = events.filter((e) => e.type === step.event);
  const matching =
    step.polarity !== undefined ? matchingForType.filter((e) => eventPolarity(e) === step.polarity) : matchingForType;

  if (matching.length === 0) return true;

  // Pure forbidden (no before/after): event must be absent.
  if (step.before === undefined && step.after === undefined) {
    pushViolation(violations, {
      code: "forbidden_event",
      message:
        step.polarity !== undefined
          ? `forbidden event ${step.event}(polarity=${step.polarity}) appeared`
          : `forbidden event ${step.event} appeared`,
      expected: "absent",
      observed: step.polarity ? `${step.event}(${step.polarity})` : step.event,
    });
    return false;
  }

  // Conditional forbidden: forbidden when ordered relative to a guard.
  if (step.before !== undefined) {
    const firstGuard = firstId(events.filter((e) => e.type === step.before));
    const firstThis = firstId(matching);
    if (firstGuard === undefined) {
      // Guard absent — `before X` cannot be violated.
      return true;
    }
    if (firstThis !== undefined && firstThis < firstGuard) {
      pushViolation(violations, {
        code: classifyForbiddenCode(step),
        message: `${step.event} occurred before ${step.before}`,
        expected: `${step.event} after ${step.before}`,
        observed: `${step.event} before ${step.before}`,
      });
      return false;
    }
    return true;
  }

  if (step.after !== undefined) {
    const firstGuard = firstId(events.filter((e) => e.type === step.after));
    const firstThis = firstId(matching);
    if (firstGuard === undefined) return true;
    if (firstThis !== undefined && firstThis > firstGuard) {
      pushViolation(violations, {
        code: classifyForbiddenCode(step),
        message: `${step.event} occurred after ${step.after}`,
        expected: `${step.event} before ${step.after}`,
        observed: `${step.event} after ${step.after}`,
      });
      return false;
    }
    return true;
  }

  return true;
}

/** Pick a more specific violation code for ordering-flavoured forbidden rules. */
function classifyForbiddenCode(step: WorkflowForbiddenStep): WorkflowViolationCode {
  // Domain-specific specialisations for diagnostic clarity.
  if (step.event === "akm_reflect" && step.before === "akm_feedback") {
    return "reflection_without_failure";
  }
  if (step.event === "akm_proposal_accept") {
    // Accepting a proposal before propose/verifier/test = unvalidated acceptance.
    return "proposal_accepted_without_validation";
  }
  if (step.event === "akm_feedback" && step.before === "verifier_run") {
    return "late_feedback";
  }
  return "forbidden_event";
}

/* ─── Verifier-aware feedback polarity ────────────────────────────────────── */

/**
 * When the verifier failed, any recorded `akm_feedback` must include at least
 * one negative-polarity event. Mirror: when the verifier passed, recorded
 * feedback should include a positive-polarity event. Returns true when the
 * polarity matches (or there is no feedback at all — that's the
 * `feedback-after-use` spec's job to flag).
 */
function checkVerifierPolarity(
  verifierFailed: boolean,
  feedbackEvents: WorkflowTraceEvent[],
  violations: WorkflowViolation[],
): boolean {
  if (feedbackEvents.length === 0) return true; // separate spec covers missing feedback.

  if (verifierFailed) {
    const hasNegative = feedbackEvents.some((e) => eventPolarity(e) === "negative");
    if (!hasNegative) {
      pushViolation(violations, {
        code: "wrong_feedback_polarity",
        message: "verifier failed but agent recorded no negative feedback",
        expected: "negative",
        observed: feedbackEvents.map((e) => eventPolarity(e) ?? "unknown").join(","),
      });
      return false;
    }
    return true;
  }

  // Verifier passed. Positive feedback expected when feedback was recorded.
  const hasPositive = feedbackEvents.some((e) => eventPolarity(e) === "positive");
  if (!hasPositive) {
    pushViolation(violations, {
      code: "wrong_feedback_polarity",
      message: "verifier passed but agent recorded no positive feedback",
      expected: "positive",
      observed: feedbackEvents.map((e) => eventPolarity(e) ?? "unknown").join(","),
    });
    return false;
  }
  return true;
}

/* ─── Gold-ref check ──────────────────────────────────────────────────────── */

function checkGoldRef(
  goldRef: string | undefined,
  events: WorkflowTraceEvent[],
  spec: WorkflowSpec,
  violations: WorkflowViolation[],
): boolean {
  if (goldRef === undefined) return false; // not loaded, but also not required.

  const showEvents = events.filter((e) => e.type === "akm_show");
  const matched = showEvents.some((e) => e.assetRef === goldRef);
  if (matched) return true;

  // Don't double-count if the spec already had a `ref_must_equal: gold_ref`
  // step that flagged this — check by scanning existing violations.
  const alreadyFlagged = violations.some((v) => v.code === "irrelevant_asset_loaded" && v.expected === goldRef);
  if (alreadyFlagged) return false;

  // Only emit a top-level gold-ref violation when the spec at least mentions
  // gold loading — e.g. has a step with `ref_must_equal` OR declares its own
  // `gold_ref`. Otherwise this would noisy-fire on every unrelated spec.
  const specCaresAboutGold =
    spec.gold_ref !== undefined || spec.required_sequence.some((step) => step.ref_must_equal !== undefined);
  if (!specCaresAboutGold) return false;

  const observed = showEvents.find((e) => typeof e.assetRef === "string")?.assetRef;
  pushViolation(violations, {
    code: "irrelevant_asset_loaded",
    message: `gold asset ${goldRef} was never loaded via akm_show`,
    expected: goldRef,
    observed,
  });
  return false;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function isUsableEvent(e: unknown): e is WorkflowTraceEvent {
  if (!e || typeof e !== "object") return false;
  const ev = e as Partial<WorkflowTraceEvent>;
  return typeof ev.type === "string" && typeof ev.id === "number";
}

function firstId(events: WorkflowTraceEvent[]): number | undefined {
  if (events.length === 0) return undefined;
  let min = events[0].id;
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].id < min) min = events[i].id;
  }
  return min;
}

/**
 * Recover an event's feedback polarity. The trace contract does NOT carry a
 * top-level `polarity` field, so we probe known shapes:
 *   - args contain a token like `+1` / `-1` / `positive` / `negative`.
 *   - command-style: `akm feedback +1 skill:foo`.
 * Returns `undefined` when polarity cannot be determined.
 */
function eventPolarity(ev: WorkflowTraceEvent): "positive" | "negative" | undefined {
  // args-based detection.
  if (Array.isArray(ev.args)) {
    for (const a of ev.args) {
      if (a === "+1" || a === "positive" || a === "+") return "positive";
      if (a === "-1" || a === "negative" || a === "-") return "negative";
    }
  }
  // command-string fallback (rare, but cheap).
  if (typeof ev.command === "string") {
    if (/(?:^|\s)(?:\+1|positive)(?:\s|$)/.test(ev.command)) return "positive";
    if (/(?:^|\s)(?:-1|negative)(?:\s|$)/.test(ev.command)) return "negative";
  }
  return undefined;
}

function resolveRefField(field: string, task: WorkflowEvalTaskMetadata): string | undefined {
  if (field === "gold_ref") return task.goldRef;
  return undefined;
}

function pushViolation(out: WorkflowViolation[], v: WorkflowViolation): void {
  if (out.length >= MAX_VIOLATIONS_PER_CHECK) return;
  out.push(v);
}

function capViolations(violations: WorkflowViolation[]): WorkflowViolation[] {
  if (violations.length <= MAX_VIOLATIONS_PER_CHECK) return violations;
  return violations.slice(0, MAX_VIOLATIONS_PER_CHECK);
}

function countMatchingEvents(events: WorkflowTraceEvent[], spec: WorkflowSpec): number {
  const vocab = new Set<WorkflowTraceEventType>();
  for (const step of spec.required_sequence) {
    vocab.add(step.event as WorkflowTraceEventType);
    if (step.before) vocab.add(step.before as WorkflowTraceEventType);
    if (step.after) vocab.add(step.after as WorkflowTraceEventType);
  }
  for (const step of spec.forbidden ?? []) {
    vocab.add(step.event as WorkflowTraceEventType);
  }
  let n = 0;
  for (const ev of events) if (vocab.has(ev.type)) n += 1;
  return n;
}

function average(xs: number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function makeNotApplicable(spec: WorkflowSpec, run: WorkflowEvalRunContext): WorkflowCheckResult {
  return {
    schemaVersion: 1,
    workflowId: spec.id,
    taskId: run.taskId,
    arm: run.arm,
    seed: run.seed,
    status: "not_applicable",
    score: 0,
    requiredPassed: 0,
    requiredTotal: 0,
    violations: [],
    evidence: {
      matchedEvents: 0,
      feedbackRecorded: false,
      goldAssetLoaded: false,
      traceTruncated: false,
    },
  };
}

function validateInputs(
  trace: WorkflowTraceResult | undefined | null,
  spec: WorkflowSpec | undefined | null,
  run: WorkflowEvalRunContext,
): WorkflowCheckResult | undefined {
  if (!run || typeof run !== "object" || typeof run.taskId !== "string" || typeof run.arm !== "string") {
    return harnessError(spec, run, "run context missing arm/taskId");
  }
  if (!trace || typeof trace !== "object") {
    return harnessError(spec, run, "trace is missing or not an object");
  }
  if (!Array.isArray((trace as WorkflowTraceResult).events)) {
    return harnessError(spec, run, "trace.events is not an array");
  }
  if (!spec || typeof spec !== "object") {
    return harnessError(spec, run, "spec is missing or not an object");
  }
  const s = spec as Partial<WorkflowSpec>;
  if (typeof s.id !== "string" || !Array.isArray(s.required_sequence) || !s.scoring) {
    return harnessError(spec, run, "spec is malformed (missing id/required_sequence/scoring)");
  }
  return undefined;
}

function harnessError(
  spec: WorkflowSpec | undefined | null,
  run: WorkflowEvalRunContext | undefined | null,
  reason: string,
): WorkflowCheckResult {
  const safeRun: WorkflowEvalRunContext =
    run && typeof run === "object"
      ? {
          arm: typeof run.arm === "string" ? run.arm : "unknown",
          taskId: typeof run.taskId === "string" ? run.taskId : "unknown",
          seed: typeof run.seed === "number" ? run.seed : -1,
        }
      : { arm: "unknown", taskId: "unknown", seed: -1 };
  return {
    schemaVersion: 1,
    workflowId:
      spec && typeof spec === "object" && typeof (spec as WorkflowSpec).id === "string"
        ? (spec as WorkflowSpec).id
        : "unknown",
    taskId: safeRun.taskId,
    arm: safeRun.arm,
    seed: safeRun.seed,
    status: "harness_error",
    score: 0,
    requiredPassed: 0,
    requiredTotal: 0,
    violations: [
      {
        code: "missing_evidence",
        message: `harness error: ${reason}`,
        observed: reason,
      },
    ],
    evidence: {
      matchedEvents: 0,
      feedbackRecorded: false,
      goldAssetLoaded: false,
      traceTruncated: false,
    },
  };
}
