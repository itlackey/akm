// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `TaskRunResult` — the shape every dispatch arm returns — plus
 * `exitCodeForStatus` (the OS-scheduler exit-code mapping).
 * `RunTaskOptions` — the public options bag `runTask()`, `load-task.ts`, and
 * every dispatch arm read from — lives here too, alongside the other
 * public-surface types the compat shim (src/tasks/runner.ts) re-exports.
 *
 * Moved from src/tasks/runner.ts (spec docs/plans/specs/p1b-model-extraction.md
 * §5.1, §9, runner.ts:87-103,105-143,256-292,1164-1177).
 *
 * The D8 result-vocabulary re-code's write side lives in each dispatch arm's
 * own result construction (run-native-task.ts, run-command-task.ts,
 * run-workflow-task.ts) — see
 * docs/architecture/decisions/0005-task-result-vocabulary-and-legacy-read-mapping.md
 * for why; task-history.ts carries the read-side legacy mapping.
 *
 * F-3 (§5.4): `RunTaskOptions.stashDir` is renamed to `bundleDir` here —
 * VALUE-preserving, only the option key changed.
 *
 * Import direction: this module is a DAG leaf with respect to the rest of
 * src/tasks/run/** — it imports nothing from ./task-history (appendHistory)
 * or ./attempt-lifecycle (finishAttempt), and, for `RunTaskOptions`'s
 * override-seam types, only the workflow orchestrator's own exported symbol
 * (safe: src/workflows/exec/run-workflow.ts and everything it transitively
 * imports never reaches back into src/tasks/run/**).
 * ./task-history.ts imports TaskRunResult's TYPE from here, and
 * tests/architecture/import-cycle-ratchet.test.ts counts type-only imports as
 * real cycle edges (shrink-only, empty baseline — see
 * scripts/lint-import-cycles.ts's header), so a value import back from here
 * would close a cycle.
 *
 * P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, row B-22, P4-N6):
 * `finishDisabledTask` — the disabled-task short-circuit this file used to
 * build — and the `"disabled"` `TaskRunStatus` member it was the sole
 * producer of are DELETED. Its only caller, run-task.ts's
 * `shouldSkipUnactivatedTask`, was deleted in the same family: task source
 * v4 has no document-level `enabled` to skip at fire time (see
 * src/core/activation-policy.ts's header for where that enforcement moved).
 * `exitCodeForStatus`'s `"disabled"` case,
 * src/commands/tasks/tasks.ts's `result.status === "disabled"` disjunct, and
 * `preparedResultTarget` (the `PreparedTaskV3Execution` -> `TaskRunResult["target"]`
 * projection `finishDisabledTask` was its only caller) — all unreachable
 * once the sole producer was gone — were deleted with it.
 */

import type { SpawnFn } from "../../core/subprocess";
import type { InputFlag } from "../../execution/input-contract";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { RunAgentOptions } from "../../integrations/agent";
import type { RunExecutionOptions } from "../../integrations/agent/runner-dispatch";
import type { chatCompletion } from "../../llm/client";
import type { runWorkflowSteps } from "../../workflows/exec/run-workflow";
import type { ExecutionProvenanceContext, TaskInvocation } from "../model/invocation";
import type { PreparedTaskV3Script, PreparedTaskV3Shell } from "../prepare/prepared-execution";

export type TaskRunStatus = "completed" | "blocked" | "failed" | "active";

export type TaskAttemptFailureReason =
  | "invalid_task_id"
  | "task_load_failed"
  | "task_parse_failed"
  | "task_dispatch_failed";

export interface TaskRunResult {
  id: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  log: string;
  target:
    | { kind: "workflow"; ref: string }
    | { kind: "command"; engine: string | null }
    | { kind: "shell"; cmd?: string[] }
    | { kind: "script"; cmd?: string[] }
    | { kind: "unknown" };
  /** Workflow run id (for workflow targets) or agent reason/error (for command targets). */
  detail?: { runId?: string; reason?: string; error?: string; exitCode?: number | null };
  /** Secret-free optimistic-lowering diagnostics for command (agent/LLM) targets. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface RunTaskOptions {
  /**
   * The bundle directory the task asset resolves against. Resolved once at
   * the `akm task run` command boundary (WI-9.10 CLI-wide sweep) and threaded
   * in — this runner no longer reads the ambient stash-dir resolver.
   *
   * F-3 (spec §5.4): renamed from `stashDir` — VALUE-preserving, the option
   * key is a replacement, not an addition (a `stashDir`-only options object
   * does not resolve the task).
   */
  bundleDir: string;
  /** Durable bundle identity for fully-qualified refs. */
  bundleName?: string;
  /** Configured adapter for the selected component root. */
  adapterId?: string;
  /** Override the common command dispatch's agent runner (tests). */
  runAgentImpl?: RunExecutionOptions["runAgent"];
  /**
   * Override the workflow orchestrator (tests). Defaults to
   * {@link runWorkflowSteps}.
   */
  runWorkflowStepsImpl?: typeof runWorkflowSteps;
  /** Override clock (tests). */
  now?: () => Date;
  /** Override log dir (tests). */
  logDir?: string;
  /** Extra args/env to pass through the common command dispatcher (tests). */
  agentOptions?: Partial<RunAgentOptions>;
  /** Override plain LLM prompt dispatch (tests). */
  chatCompletionImpl?: typeof chatCompletion;
  /** Override the command-target spawn (tests). Defaults to the runtime spawn. */
  spawnFn?: SpawnFn;
  /**
   * Override the timeout timers (tests). Default to the globals. Used by both
   * the command-target kill ladder and the workflow-target whole-run timeout.
   */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** True only for an invocation generated by a scheduler backend. */
  scheduled?: boolean;
  /**
   * D5 (spec §1.2/§5.2): execution provenance threaded from the invocation
   * boundary. Optional — absent, `runTask` defaults it to
   * `{ eventSource: "task", scheduled: options.scheduled === true }`
   * (run/provenance.ts's `createExecutionProvenanceContext`), which is what
   * keeps every existing caller — and this option's own absence — byte-
   * equivalent to pre-P1b behavior.
   */
  provenance?: ExecutionProvenanceContext;
  /** Runs after immutable preparation/history reservation and before native dispatch (tests). */
  beforeNativeDispatch?: (task: PreparedTaskV3Shell | PreparedTaskV3Script) => void;
  /**
   * P2a Lane C (spec docs/plans/specs/p2a-task-source-v4.md §5.1): raw,
   * exact-name `akm task run` input flags captured by `tasks-cli.ts`'s Stage
   * 1 (`parseTaskInputFlags`). `load-task.ts`'s Stage 2 materializes these
   * against the task's contract (task source v4: its `inputs:` declarations;
   * v3: the empty contract, so ANY flag on a v3 task is `UNKNOWN_FLAG`) and attaches
   * the result to the constructed `TaskInvocation.inputs`. Optional — every
   * existing caller and test call site keeps today's behavior untouched (the
   * same pattern P1b used for `provenance`). P2a validates only: nothing
   * downstream of `loadPreparedTask` reads this back (spec §0).
   */
  inputFlags?: readonly InputFlag[];
  /**
   * TEST-ONLY. Runs once, with the `TaskInvocation` Stage 2 constructs,
   * before dispatch — never read by production code. `TaskInvocation`
   * (`src/tasks/model/invocation.ts`) is otherwise unobservable from outside
   * `load-task.ts` in P2a (the model-purity ratchet,
   * tests/tasks/parse-v3-adapter.test.ts, keeps it a pure, IO-free type that
   * nothing production reads back either), so this is the seam
   * tests/integration/commands/tasks-input-flags.test.ts uses to assert
   * against the real constructed value rather than a bespoke side channel.
   */
  captureTaskInvocation?: (invocation: TaskInvocation) => void;
}

/**
 * The exit code surfaced to the OS scheduler. Mapped from {@link TaskRunStatus}
 * so cron / launchd / schtasks see a useful return value.
 */
export function exitCodeForStatus(status: TaskRunStatus): number {
  switch (status) {
    case "completed":
      return 0;
    case "active":
      return 0;
    case "blocked":
      return 1;
    case "failed":
      return 1;
  }
}
