// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TaskInvocation and ExecutionProvenanceContext — pure invocation-boundary
 * types for the task model.
 *
 * Pure type module: no runtime export, no fs/db/subprocess imports.
 * `TaskInvocation`'s exact `caller`/`overrides` field shapes are intentionally
 * light — the two variants below carry only what a caller already has in hand
 * without resolving anything (no IO).
 *
 * `inputs`: the `akm task run` input-flag literals
 * `src/tasks/run/load-task.ts` materializes (Stage 2) are attached here.
 * `TaskInputBinding` is a type-only import from
 * `src/execution/input-contract`, erased at compile time. Nothing reads
 * `inputs` back yet.
 */

import type { TaskInputBinding } from "../../execution/input-contract";

/** How a task run was invoked, and any per-invocation overrides. */
export type TaskInvocationCaller =
  | Readonly<{ readonly kind: "cli" }>
  | Readonly<{ readonly kind: "schedule"; readonly cron: string }>
  | Readonly<{ readonly kind: "workflow"; readonly workflowRef: string; readonly stepId: string }>;

/** Execution-default overrides a caller may supply on top of a TaskDefinition. */
export interface TaskInvocationOverrides {
  readonly connection?: string | null;
  readonly harness?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly timeout?: string | number | null;
  readonly env?: Readonly<Record<string, string | number | boolean>>;
}

export interface TaskInvocation {
  readonly taskRef: string;
  readonly caller: TaskInvocationCaller;
  readonly overrides?: TaskInvocationOverrides;
  /** Literal input bindings materialized from `akm task run` input flags (P2a §4.4). Validated only — not yet delivered (§0). */
  readonly inputs?: readonly TaskInputBinding[];
}

/**
 * A value threaded through `RunTaskOptions` and dispatch, constructed ONCE at
 * the invocation boundary (`src/commands/tasks/tasks.ts`), instead of a GLOBAL
 * `process.env.AKM_EVENT_SOURCE` mutation. `eventSource` is NOT conditioned
 * on `scheduled`. The runtime factory and resolution helpers live in
 * `run/provenance.ts`; this module only fixes the bare type.
 */
export type ExecutionProvenanceContext = Readonly<{
  eventSource: "user" | "task";
  scheduled: boolean;
}>;
