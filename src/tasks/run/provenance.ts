// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * ExecutionProvenanceContext factory + resolution helper.
 *
 * `createExecutionProvenanceContext` builds the literal used at the
 * `akm task run` CLI boundary (src/commands/tasks/tasks.ts's `akmTasksRun`)
 * and as run-task.ts's default for an absent `RunTaskOptions.provenance`.
 * `eventSource` is `"task"` UNCONDITIONALLY — it is NOT conditioned on
 * `scheduled`; `scheduled` stays a separate field carrying
 * `RunTaskOptions.scheduled`'s meaning (activation policy, scheduler env),
 * never selecting the event source.
 *
 * `ExecutionProvenanceContext` itself is declared in ../model/invocation.ts
 * (kept pure/IO-free per the model purity ratchet); this file is where the
 * runtime factory lives.
 */

import type { ExecutionProvenanceContext } from "../model/invocation";

/**
 * Build the default task-run provenance context: `eventSource` is always
 * `"task"`; `scheduled` carries the caller's own scheduled flag.
 */
export function createExecutionProvenanceContext(scheduled: boolean): ExecutionProvenanceContext {
  return Object.freeze({ eventSource: "task", scheduled });
}

/**
 * Resolve the effective provenance for one `runTask()` call: an explicit
 * `RunTaskOptions.provenance` always wins; absent, this is the default
 * context — what keeps any caller that never sets `provenance` on the
 * default behavior.
 */
export function resolveProvenanceContext(
  explicit: ExecutionProvenanceContext | undefined,
  scheduled: boolean,
): ExecutionProvenanceContext {
  return explicit ?? createExecutionProvenanceContext(scheduled);
}
