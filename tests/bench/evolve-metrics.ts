/**
 * Track B lesson quality + reuse metrics (issue #264, spec §6.3 follow-up).
 *
 * `computeLessonMetrics` walks the evolve runner's proposal log and the
 * Phase 3 pre/post arm `RunResult[]`s and emits one `LessonRecord` per
 * lesson-kind proposal. The record captures:
 *
 *   - `source_failures` — eval/train tasks whose negative feedback events
 *     targeted this asset ref (joined via the supplied `feedbackLog`).
 *   - `lint_pass` / `accepted` — verbatim from the proposal log entry.
 *   - `first_reused_on` / `reuse_count` / `reuse_pass_rate` — how often the
 *     accepted lesson's ref appeared in post-arm runs' `assetsLoaded`, and
 *     the pass-rate among those reuses.
 *   - `negative_transfer_count` — count of (taskId, seed) pairs where the
 *     same task PASSED in pre but FAILED in post AND the post run loaded
 *     this lesson's ref. Spec §6.4 negative-transfer attribution.
 *   - `leakage_risk` — `"high"` when any verbatim 4-token-or-longer phrase
 *     in the supplied verifier source(s) appears verbatim in the lesson
 *     body; `"medium"` for 3-token leakage; `"low"` otherwise. Mirrors the
 *     Wave 3 `leakage.test.ts` philosophy: structural fragments are red
 *     flags, lone tokens are not.
 *
 * The function is pure: no disk I/O, no subprocess. Callers (the evolve
 * runner) thread lesson bodies + verifier sources through optional maps so
 * the leakage check is fully deterministic and testable with mock inputs.
 */

import type { RunResult } from "./driver";
import type { FeedbackLogEntry } from "./evolve";
import type { ProposalLogEntry } from "./metrics";

/** Per-lesson record exposed in the Track B `lessons[]` report block. */
export interface LessonRecord {
  /** Asset ref the lesson targets (mirrors proposal.assetRef). */
  ref: string;
  /**
   * Train/Phase-1 task ids whose negative feedback against this ref
   * contributed to the proposal being generated. Sorted, deduplicated.
   * Empty when no feedback log was supplied or no negative event matches.
   */
  source_failures: string[];
  /** Whether `akm proposal show --json` reported `lint_pass: true`. */
  lint_pass: boolean;
  /** Whether the runner ran `proposal accept` on this proposal. */
  accepted: boolean;
  /**
   * First eval-arm task that loaded this lesson after acceptance (i.e. the
   * lesson's ref appeared in `assetsLoaded`). `null` if never reused. The
   * "first" is determined by `(taskId, seed)` lexicographic order over the
   * supplied `postRuns` — `postRuns` is intentionally NOT re-sorted by the
   * function so callers that already pre-sort by wallclock get that order.
   */
  first_reused_on: string | null;
  /**
   * Number of post-arm (taskId, seed) runs that loaded this lesson's ref.
   * A single task across multiple seeds counts as multiple reuses.
   */
  reuse_count: number;
  /**
   * Fraction of reuse runs whose outcome was `pass`. `0` when
   * `reuse_count === 0` (NaN-safe sentinel).
   */
  reuse_pass_rate: number;
  /**
   * Count of (taskId, seed) pairs where the same task passed in `preRuns`
   * but failed in `postRuns` AND the post run loaded this lesson's ref.
   * The same task counted at most once across seeds (matches §6.4 spirit:
   * the lesson made the task worse, regardless of how many seeds saw it).
   */
  negative_transfer_count: number;
  /**
   * `"high"` when verbatim 4+-token phrases from any supplied
   * `verifierSources[ref]` entry appear in `lessonBodies[ref]`; `"medium"`
   * for 3-token overlap; `"low"` otherwise (including when the lesson body
   * or verifier source is missing).
   */
  leakage_risk: "low" | "medium" | "high";
}

/** Aggregate envelope returned by `computeLessonMetrics`. */
export interface LessonMetrics {
  /** One row per lesson-kind proposal, sorted by ref. */
  lessons: LessonRecord[];
  /** Total lesson-kind proposals (accepted + rejected). */
  lessons_created_count: number;
  /** Lesson-kind proposals whose `decision === "accept"`. */
  lessons_accepted_count: number;
  /** `lint_pass / total`. `0` when there are no lessons. */
  proposal_lint_pass_rate: number;
  /** `accepted / total`. `0` when there are no lessons. */
  proposal_acceptance_rate: number;
  /**
   * Fraction of accepted lessons that were reused at least once. `0` when
   * there are no accepted lessons.
   */
  lesson_reuse_rate: number;
  /**
   * Mean `reuse_pass_rate` across reused lessons. `0` when no reuse.
   */
  lesson_reuse_success_rate: number;
  /** Sum of `negative_transfer_count` across all lessons. */
  lesson_negative_transfer_count: number;
}

/**
 * Inputs to `computeLessonMetrics`. All non-`proposalLog` fields are
 * optional so callers can compute partial metrics from mocked inputs in
 * tests; missing inputs collapse to safe defaults (no source failures, no
 * reuse, low leakage).
 */
export interface ComputeLessonMetricsInput {
  proposalLog: ProposalLogEntry[];
  /**
   * Phase 1 feedback events. Used to populate `source_failures` per lesson
   * (joined on `goldRef === lesson.ref` with `signal === "negative"`).
   */
  feedbackLog?: FeedbackLogEntry[];
  /** Eval-slice pre-arm runs (no Phase 2 mutations applied). */
  preRuns?: RunResult[];
  /** Eval-slice post-arm runs (with accepted lessons in scope). */
  postRuns?: RunResult[];
  /**
   * Map from lesson ref → lesson body content. Supplied by the runner from
   * the on-disk lesson file after acceptance; tests pass mocks. When a
   * ref is absent the leakage check defaults to `"low"`.
   */
  lessonBodies?: Record<string, string>;
  /**
   * Map from lesson ref → verifier source text(s) to leakage-check
   * against. The runner concatenates the verifier files for tasks whose
   * gold ref matches the lesson; tests pass mocks. When absent the
   * leakage check defaults to `"low"`.
   */
  verifierSources?: Record<string, string[]>;
}

/**
 * Compute lesson-quality + reuse metrics from the evolve runner's outputs.
 * Pure function — does not touch disk and does not invoke any subprocess.
 *
 * Only `proposalLog` entries with `kind === "lesson"` are surfaced as
 * `LessonRecord`s. Revision-kind proposals are tracked elsewhere (the
 * §6.3 `proposals` block already covers them) and would skew the lesson
 * reuse rate if mixed in.
 */
export function computeLessonMetrics(input: ComputeLessonMetricsInput): LessonMetrics {
  const lessons = input.proposalLog.filter((p) => p.kind === "lesson");
  const feedbackLog = input.feedbackLog ?? [];
  const preRuns = input.preRuns ?? [];
  const postRuns = input.postRuns ?? [];
  const lessonBodies = input.lessonBodies ?? {};
  const verifierSources = input.verifierSources ?? {};

  // Pre-index pre-arm task → seed → outcome so negative-transfer attribution
  // is a constant-time lookup per post run.
  const preOutcomes = new Map<string, Map<number, RunResult["outcome"]>>();
  for (const r of preRuns) {
    let inner = preOutcomes.get(r.taskId);
    if (!inner) {
      inner = new Map();
      preOutcomes.set(r.taskId, inner);
    }
    inner.set(r.seed, r.outcome);
  }

  // Pre-index negative feedback by ref so source_failures is O(events).
  const negativeFeedbackByRef = new Map<string, Set<string>>();
  for (const ev of feedbackLog) {
    if (ev.signal !== "negative") continue;
    let set = negativeFeedbackByRef.get(ev.goldRef);
    if (!set) {
      set = new Set();
      negativeFeedbackByRef.set(ev.goldRef, set);
    }
    set.add(ev.taskId);
  }

  const records: LessonRecord[] = lessons.map((p) => {
    const ref = p.assetRef;
    const sourceFailures = [...(negativeFeedbackByRef.get(ref) ?? [])].sort();

    // Reuse: post-arm runs that loaded this ref.
    let firstReusedOn: string | null = null;
    let reuseCount = 0;
    let reusePassCount = 0;
    // Negative transfer: post-FAIL where pre-PASS for the same (task, seed)
    // AND this lesson was loaded in the post run. Dedupe by taskId so a
    // task that regresses across multiple seeds counts once.
    const negativeTransferTasks = new Set<string>();
    if (p.decision === "accept") {
      for (const r of postRuns) {
        if (!r.assetsLoaded?.includes(ref)) continue;
        if (firstReusedOn === null) firstReusedOn = r.taskId;
        reuseCount += 1;
        if (r.outcome === "pass") reusePassCount += 1;
        if (r.outcome === "fail" || r.outcome === "budget_exceeded") {
          const prePerSeed = preOutcomes.get(r.taskId);
          if (prePerSeed && prePerSeed.get(r.seed) === "pass") {
            negativeTransferTasks.add(r.taskId);
          }
        }
      }
    }
    const reusePassRate = reuseCount === 0 ? 0 : reusePassCount / reuseCount;

    const leakageRisk = classifyLeakageRisk(lessonBodies[ref], verifierSources[ref]);

    return {
      ref,
      source_failures: sourceFailures,
      lint_pass: p.lintPass,
      accepted: p.decision === "accept",
      first_reused_on: firstReusedOn,
      reuse_count: reuseCount,
      reuse_pass_rate: reusePassRate,
      negative_transfer_count: negativeTransferTasks.size,
      leakage_risk: leakageRisk,
    };
  });

  records.sort((a, b) => a.ref.localeCompare(b.ref));

  const total = records.length;
  const accepted = records.filter((r) => r.accepted);
  const lintPassed = records.filter((r) => r.lint_pass).length;
  const reusedAccepted = accepted.filter((r) => r.reuse_count > 0);
  const reusePassRateSum = reusedAccepted.reduce((sum, r) => sum + r.reuse_pass_rate, 0);
  const negativeTransferTotal = records.reduce((sum, r) => sum + r.negative_transfer_count, 0);

  return {
    lessons: records,
    lessons_created_count: total,
    lessons_accepted_count: accepted.length,
    proposal_lint_pass_rate: total === 0 ? 0 : lintPassed / total,
    proposal_acceptance_rate: total === 0 ? 0 : accepted.length / total,
    lesson_reuse_rate: accepted.length === 0 ? 0 : reusedAccepted.length / accepted.length,
    lesson_reuse_success_rate: reusedAccepted.length === 0 ? 0 : reusePassRateSum / reusedAccepted.length,
    lesson_negative_transfer_count: negativeTransferTotal,
  };
}

/**
 * Classify lesson-body leakage against verifier source text. Returns
 * `"high"` when a 4+-word verbatim phrase from any verifier-source entry
 * appears in the body; `"medium"` for 3-word overlap; `"low"` otherwise.
 *
 * The check is intentionally simple — Wave 3's `leakage.test.ts` uses
 * structural assertion extraction (regex literals, dotted paths, jq/grep
 * patterns); here we just slide an N-gram window over the verifier text
 * and ask "does the body contain this exact run of words?". Tokens are
 * normalised to lowercase and split on non-word boundaries so trivial
 * whitespace differences don't hide leakage.
 */
export function classifyLeakageRisk(
  body: string | undefined,
  verifierSources: string[] | undefined,
): "low" | "medium" | "high" {
  if (!body || !verifierSources || verifierSources.length === 0) return "low";
  const bodyTokens = tokenize(body);
  if (bodyTokens.length === 0) return "low";
  const bodyJoined = ` ${bodyTokens.join(" ")} `;

  let mediumHit = false;
  for (const source of verifierSources) {
    const sourceTokens = tokenize(source);
    if (sourceTokens.length < 3) continue;
    if (containsNGram(bodyJoined, sourceTokens, 4)) return "high";
    if (!mediumHit && containsNGram(bodyJoined, sourceTokens, 3)) mediumHit = true;
  }
  return mediumHit ? "medium" : "low";
}

/**
 * Slide an N-gram window of size `n` across `tokens` and return true if any
 * window appears as a contiguous substring inside `bodyJoined` (which is
 * pre-padded with spaces so word boundaries match cleanly). Skips windows
 * shorter than `n`; returns false on empty input.
 */
function containsNGram(bodyJoined: string, tokens: string[], n: number): boolean {
  if (tokens.length < n) return false;
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const phrase = ` ${tokens.slice(i, i + n).join(" ")} `;
    if (bodyJoined.includes(phrase)) return true;
  }
  return false;
}

/** Lowercase tokens split on non-word characters. Empty strings dropped. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}
