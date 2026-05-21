/**
 * Shared types for the akm-eval toolkit (Phase 1).
 *
 * Stable enough for case files on disk to lock against `schemaVersion`.
 */

export type EvalCaseType =
  | "retrieval"
  | "proposal-quality"
  | "lesson-application"
  | "memory-safety"
  | "workflow-compliance"
  | "regression";

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
  };
  requires?: {
    features?: string[];
    minAkmVersion?: string;
  };
  tags?: string[];
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
}

export type EvalMode = "baseline" | "akm" | "paired";

export interface EvalRunResult {
  schemaVersion: 1;
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
  /**
   * Phase 6: when `true`, runners route their AkmCli / StateDb /
   * improve-result reads through the process-level recorder/player held by
   * `src/sources/replay-log.ts` (`getCurrentRecorder()` / `getCurrentPlayer()`).
   *
   * Kept as a single boolean so this file stays small and additive for the
   * Phase 4 + Phase 7 worktrees that are editing it in parallel. The
   * orchestrator owns the recorder/player; runners only know "am I in a
   * recording/replay session?" via this flag.
   */
  recording?: boolean;
}
