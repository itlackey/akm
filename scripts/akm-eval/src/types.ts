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
}
