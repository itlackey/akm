// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TaskInvocation and ExecutionProvenanceContext — pure invocation-boundary
 * types for the task model (spec docs/plans/specs/p1b-model-extraction.md
 * §1.1 D4, §1.2 D5, §3.1).
 *
 * Pure type module: no runtime export, no fs/db/subprocess imports (spec
 * §3.2 purity ratchet). `TaskInvocation`'s exact `caller`/`overrides` field
 * shapes are intentionally light — the spec's own module-map row leaves them
 * as "..." (unspecified); the two variants below carry only what a caller
 * already has in hand without resolving anything (no IO), leaving richer
 * shapes to whichever later phase first threads a real `TaskInvocation`
 * value (this phase does not construct one).
 *
 * `inputs` (spec docs/plans/specs/p2a-task-source-v4.md §4.4): the
 * `akm task run` input-flag literals `src/tasks/run/load-task.ts` materializes
 * (Stage 2) are attached here, widening the model. `TaskInputBinding` is a
 * type-only import from `src/execution/input-contract` — not on the purity
 * ratchet's forbidden list (`tests/tasks/parse-v3-adapter.test.ts:368-388`),
 * and erased at compile time either way, so the ratchet stays green with no
 * baseline change. P2a validates only — nothing reads `inputs` back yet
 * (spec §0); `src/tasks/model/definition.ts` is unchanged.
 */

import type { TaskInputBinding } from "../../execution/input-contract";

/** How a task run was invoked, and any per-invocation overrides. */
export type TaskInvocationCaller =
  | Readonly<{ readonly kind: "cli" }>
  | Readonly<{ readonly kind: "schedule"; readonly cron: string }>
  | Readonly<{ readonly kind: "workflow"; readonly workflowRef: string; readonly stepId: string }>;

/** Execution-default overrides a caller may supply on top of a TaskDefinition. */
export interface TaskInvocationOverrides {
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
 * D5 (verbatim, spec §1.2): a value threaded through `RunTaskOptions` and
 * dispatch, constructed ONCE at the invocation boundary
 * (`src/commands/tasks/tasks.ts`), replacing the removed GLOBAL
 * `process.env.AKM_EVENT_SOURCE` mutation. `eventSource` is NOT conditioned
 * on `scheduled` — see spec §1.6 (D5-N1) for the binding disambiguation.
 * The runtime factory and resolution helpers live in `run/provenance.ts`
 * (Lane C, spec §5.1/§5.2); this module only fixes the bare type.
 */
export type ExecutionProvenanceContext = Readonly<{
  eventSource: "user" | "task";
  scheduled: boolean;
}>;
