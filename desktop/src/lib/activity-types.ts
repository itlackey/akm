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
export interface ActivityRun {
  id: string;
  startedAt: string;
  completedAt?: string;
  ok: boolean | null;
  durationMs: number | null;
  strategy: string;
  scope?: { mode: string; value?: string };
  modelCalls: { total: number; failures: number; byProcess: Record<string, { calls: number; failures: number }> };
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
  runs: Array<{ status: string; startedAt: string; durationMs: number | null; detail: Record<string, unknown> | null }>;
}
