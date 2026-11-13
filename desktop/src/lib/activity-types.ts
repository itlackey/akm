// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export interface ActivityCheck {
  name: string;
  status: string;
  message: string;
  evidence?: Record<string, unknown>;
}
export interface ActivityHealth {
  status: string;
  hardChecks: ActivityCheck[];
  advisories: ActivityCheck[];
}
export interface ModelCount {
  calls: number;
  failures: number;
  totalTokens: number;
  usageCalls?: number;
  totalDurationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  reasoningCalls?: number;
}
export interface ActivityTask {
  taskId: string;
  runs: number;
  failed: number;
  medianMs: number | null;
}
export interface ActivityRunUsage {
  process: string;
  engine: string | null;
  model: string | null;
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageCalls: number | null;
}
export interface ActivityRun {
  id: string;
  startedAt: string;
  completedAt?: string;
  ok: boolean | null;
  durationMs: number | null;
  strategy: string;
  scope?: { mode: string; value?: string };
  modelCalls: { total: number; failures: number; byProcess: Record<string, { calls: number; failures: number }> };
  /** The run's persisted usage report, one row per process, execution target and model. */
  usage?: ActivityRunUsage[];
  noCalls?: Array<{ process: string; engine?: string; reason: string }>;
  /** Set when the record says the run was stopped (a signal or an exception). */
  terminated?: { reason: string; at: string | null; errorMessage: string | null } | null;
  /** Failed actions' recorded error texts; `shown` is capped, `count` is all. */
  errors?: { count: number; shown: Array<{ ref: string; mode: string; error: string }> };
  preRunSync?: unknown;
  sync?: unknown;
  triage?: unknown;
}
export interface ActivityOverview {
  health: ActivityHealth | null;
  metrics: {
    window: { since: string; until: string };
    usage: {
      totals: { searches: number; shows: number; curates: number; zeroResultSearches: number };
      daily: Array<{ day: string; search: number; curate: number; show: number; feedback: number; partial?: boolean }>;
      searchMedianMs: number | null;
    };
    llm: ModelCount & {
      byProcess: Record<string, ModelCount>;
      byEngine: Record<string, ModelCount>;
      byStage: Record<string, ModelCount>;
    };
    tasks: { runs: number; failed: number; byTask: ActivityTask[] };
    index?: { runs: number; recent: Array<{ at: string; mode: string; totalMs: number }> };
    proposals: { byStatus: Record<string, number> };
    notes: string[];
    workflows?: { byModel: Record<string, number> };
  } | null;
  taskFailures: ActivityTask[] | null;
  improveRuns: ActivityRun[];
  errors?: Record<string, string>;
}
export interface RetrievalWeek {
  week: string;
  n: number;
  x: number;
  rate: number | null;
  lower: number | null;
  upper: number | null;
  signal: boolean;
}
export interface ActivityRetrieval {
  daily: Array<{ date: string; searches: number; zeroResults: number; medianMs: number | null }>;
  weekly: RetrievalWeek[];
  centre: number | null;
}
export interface OutcomeCounts {
  judge: number;
  you: number;
  unknown: number;
  rejected: number;
  reverted: number;
}
export interface ActivityImpact {
  available: boolean;
  since: string;
  weeks: string[];
  summary: {
    kept: number;
    reverted: number;
    flags: number;
    tokens: number;
    tokenCoverage: number | null;
    checked: number;
  };
  outcomes: Array<{ source: string; weeks: Array<OutcomeCounts & { week: string }> }>;
  reviewFlow: Array<{ week: string; created: number; decided: number; waiting: number }>;
  library: Array<{ week: string; entries: number | null }>;
  harm: Array<{ kind: string; ref: string; at: string; detail: string; proposalId?: string }>;
  cost: Array<{ week: string; calls: number; usageCalls: number; tokens: number; byProcess: Record<string, number> }>;
  judgeAndYou: Record<string, { accepted: number; rejected: number; reverted: number }>;
  changedAssets: Array<{
    ref: string;
    source: string;
    decidedAt: string;
    outcome: string;
    before: { hits: number; negative: number };
    after: { hits: number; negative: number };
    complete: boolean;
    afterDays: number;
  }>;
  errors?: Record<string, string>;
}
export interface ActivityPulse {
  tiles: {
    foundNothing: { n: number; x: number; rate: number | null; usual: { state: string; low?: number; high?: number } };
    negativeFeedback: { count: number; assets: number; usual: { state: string; low?: number; high?: number } };
    runs: {
      improve: { ok: number; total: number };
      tasks: { ok: number; total: number };
      failedTasks: Array<{ taskId: string; at: string }>;
    };
  };
  improveLine: {
    weeks: number;
    proposed: number;
    accepted: number;
    acceptedThenReverted: number;
    rejected: number;
    waiting: number;
    calls: number;
  };
  attention?: {
    pending: { count: number; oldest: string | null };
    misses: { queries: number };
    failedRuns: { improve: number; tasks: number };
    harm: { reverted: number };
    setup: { needs: string } | null;
  };
}
export interface ActivityTaskHistory {
  available: boolean;
  totalCount: number;
  count: number;
  runs: Array<{
    status: string;
    startedAt: string;
    durationMs: number | null;
    trigger?: "schedule" | "manual" | null;
    detail: Record<string, unknown> | null;
    /** The steps of a steps task run (Experimental); null for every other run. */
    steps?: Array<{
      name: string;
      kind: "run" | "prompt" | "task";
      status: "completed" | "failed" | "skipped" | "reused";
      durationMs: number;
      attempts: number;
      summary?: string;
      reason?: string;
    }> | null;
  }>;
}
export interface ActivityTaskRun {
  taskId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  trigger: "schedule" | "manual" | null;
}
export interface ActivityWorkflowRun {
  id: string;
  workflowRef: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  harness: string | null;
  session: string | null;
}
export interface WorkflowAttempt {
  attempt: number;
  phase: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  tokens: number | null;
  failureReason: string | null;
}
export interface WorkflowTrace {
  run: ActivityWorkflowRun & { workflowTitle: string; agentHarness?: string | null; agentSessionId?: string | null };
  steps: Array<{ id: string; title: string; status: string; sequenceIndex: number | null; completedAt: string | null }>;
  units: Array<{
    unitId: string;
    nodeId: string;
    stepId: string | null;
    phase: string | null;
    status: string;
    runtimeKind: string | null;
    engine: string | null;
    tokens: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    failureReason: string | null;
    diagnostic: string | null;
    sessionId: string | null;
    attempts: WorkflowAttempt[];
  }>;
  children: Array<{ runId: string; workflowRef: string; status: string }>;
}
