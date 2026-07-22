/**
 * Shared types for the akm-eval toolkit (Phase 1).
 *
 * Stable enough for case files on disk to lock against `schemaVersion`.
 */

export type EvalCaseType =
  | "retrieval"
  | "proposal-quality"
  | "reflect-quality"
  | "planner-waste"
  | "lesson-application"
  | "memory-safety"
  | "workflow-compliance"
  | "judge-calibration"
  | "regression";

/**
 * Phase 7: optional LLM-judge configuration on a case. When set AND the
 * orchestrator was invoked with `--llm-judge`, the runner's deterministic
 * result is computed as usual and then an additional judge call grades
 * the artifact at `evidence[artifactField]` (or `metrics[artifactField]`).
 * The judge result lands on `EvalCaseResult.llmJudgement` and is never
 * folded into the deterministic score.
 */
export interface EvalCaseLlmJudgeSpec {
  /** Field name on `EvalCaseResult.evidence` / `.metrics` whose stringified value is judged. */
  artifactField: string;
  /** Grading rubric/instructions passed to the judge. Capped at 4 KB. */
  rubric: string;
  /** Optional override for the per-case artifact byte cap (default 16 KB). */
  maxArtifactBytes?: number;
}

export interface EvalCase {
  schemaVersion: 1;
  id: string;
  suite: string;
  type: EvalCaseType;
  description: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  scoring?: {
    deterministic?: boolean;
    weights?: Record<string, number>;
    passThreshold?: number;
    /** Phase 7: opt-in LLM judging. Only honoured when `--llm-judge` is on. */
    llmJudge?: EvalCaseLlmJudgeSpec;
  };
  requires?: {
    features?: string[];
    minAkmVersion?: string;
    /**
     * When true, this test requires access to state.db. If the database
     * doesn't exist (e.g., in CI against a fresh example stash), the case
     * is skipped with skipReason = "state.db not available".
     */
    requiresStateDb?: boolean;
    /**
     * Reflect-quality: minimum LLM-touched reflect sample size before any
     * threshold check is evaluated. When fewer LLM-touched reflects are
     * available across the configured window, the case is skipped (mirrors
     * how `proposal-accept-rate-floor` no-ops on zero decisions).
     */
    minLlmTouchedReflects?: number;
    /**
     * Planner-waste: minimum total-action sample size across the
     * window before any threshold check is evaluated. When fewer
     * actions are present the runner returns `skipped` so the gate
     * doesn't fire on tiny samples (e.g. a stash with only one improve
     * run).
     */
    minActions?: number;
  };
  tags?: string[];
}

/**
 * Phase 7: an LLM-judge response attached to a case result. Recorded
 * for replay/audit but never combined with the deterministic score.
 */
export interface LlmJudgementResult {
  /** 0..1 score from the judge. */
  score: number;
  /** Judge's confidence band. */
  band: "low" | "medium" | "high";
  /** Judge's rationale text. */
  rationale: string;
  /** Provenance for replay / audit. */
  provenance: {
    model: string;
    provider: string;
    temperature: number;
    promptHash: string;
    artifactHash: string;
    durationMs: number;
    ts: string;
  };
  /** Optional non-fatal error message (set when the call failed entirely). */
  error?: string;
}

export interface EvalCaseResult {
  caseId: string;
  type: EvalCaseType;
  score: number;
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
  metrics: Record<string, unknown>;
  evidence: Record<string, unknown>;
  errors?: string[];
  durationMs: number;
  /**
   * Echo of `EvalCase.scoring.deterministic`. When `false`, the case
   * does NOT contribute to the run envelope's `scores.deterministic` —
   * but its score still feeds into `scores.overall`. Defaults to `true`
   * when the case file omits the field.
   */
  deterministic?: boolean;
  /**
   * Phase 7: LLM-judge result for this case. Present only when
   * `--llm-judge` was on AND the case declared `scoring.llmJudge`. The
   * score is recorded for audit but is NEVER folded into deterministic
   * aggregation (see `scoring.aggregateScores`).
   */
  llmJudgement?: LlmJudgementResult;
}

export type EvalMode = "baseline" | "akm" | "paired";

export interface EvalRunResult {
  /** v1 envelopes remain readable; v2 makes suiteFingerprint mandatory on disk. */
  schemaVersion: 1 | 2;
  evalRunId: string;
  suite: string;
  mode: EvalMode;
  label?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  akm: {
    version?: string;
    stashRoot?: string;
    dataDir?: string;
  };
  inputs: {
    caseCount: number;
    caseDir: string;
    /** SHA-256 of the canonical case and transitive fixture/probe manifest. */
    suiteFingerprint?: string;
    improveRunId?: string;
  };
  scores: {
    overall: number;
    deterministic: number;
    llmJudged?: number;
    baseline?: number;
    delta?: number;
  };
  countsByType: Record<EvalCaseType, { run: number; passed: number; skipped: number }>;
  // Note: countsByType always lists every EvalCaseType — see buildCountsByType
  // in src/scoring.ts for the canonical init.
  metrics: Record<string, unknown>;
  regressions?: Array<{
    caseId: string;
    previousScore: number;
    currentScore: number;
    reason: string;
  }>;
  errors: Array<{ caseId: string; message: string }>;
  artifacts: Record<string, string>;
}

/**
 * Phase 7: LLM-judge orchestration context. When `enabled === true` the
 * orchestrator will call the judge for any case declaring
 * `scoring.llmJudge`. Resolved once at startup; never mutated per-case.
 *
 * The deterministic eval path must complete even if the judge endpoint
 * is unreachable, so all judge errors are non-fatal at runner level
 * (recorded as `LlmJudgementResult.error`, never thrown).
 */
export interface LlmJudgeContext {
  enabled: boolean;
  model: string;
  provider: string;
  temperature: number;
  /** Optional endpoint override; otherwise the provider's default is used. */
  endpoint?: string;
  /** Bearer token / API key (resolved from env). NEVER log this value. */
  apiKey?: string;
}

export interface EvalContext {
  stashRoot: string;
  dataDir: string;
  akmBin: string;
  casesRoot: string;
  outRoot: string;
  keepSandbox: boolean;
  env: Record<string, string>;
  /**
   * Phase 2: the case-results collected so far in the current eval run.
   * Used by the regression runner to diff against a previous run from
   * inside the same orchestrator pass.
   */
  currentResults?: EvalCaseResult[];
  /** Phase 2: the in-flight eval run id; lets the regression runner skip self-diffs. */
  currentRunId?: string;
  /** Frozen suite identity used to reject comparisons against changed cases. */
  suiteFingerprint?: string;
  /** Phase 7: optional LLM-judge context (only present when `--llm-judge` is on). */
  judge?: LlmJudgeContext;
  /**
   * Phase 6: when `true`, runners route their AkmCli / StateDb /
   * improve-result reads through the process-level recorder/player held by
   * `src/sources/replay-log.ts` (`getCurrentRecorder()` / `getCurrentPlayer()`).
   */
  recording?: boolean;
  /**
   * Phase 6: the wall-clock instant the run started, frozen at orchestrator
   * entry. Runners that resolve a "since" / windowed view of state-db rows
   * MUST anchor against this value rather than calling `new Date()` directly,
   * so deterministic replay can re-derive the same SQL parameters from the
   * recorded envelope's `startedAt` (see `src/replay.ts`). Optional purely so
   * existing test fixtures that build a context by hand don't break — runners
   * fall back to `new Date()` when unset.
   */
  runStartedAt?: Date;
}
