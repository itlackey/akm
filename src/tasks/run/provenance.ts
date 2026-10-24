// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D5's ExecutionProvenanceContext factory + resolution helper (spec
 * docs/plans/specs/p1b-model-extraction.md §1.2 D5, §5.2).
 *
 * `createExecutionProvenanceContext` builds the SAME literal both of D5's
 * clauses build: "Construction" at the `akm task run` CLI boundary
 * (src/commands/tasks/tasks.ts's `akmTasksRun`) and "Threading" as
 * run-task.ts's own default for an absent `RunTaskOptions.provenance`.
 * `eventSource` is `"task"` UNCONDITIONALLY — spec §1.6 (D5-N1) is explicit
 * that it is NOT conditioned on `scheduled`; `scheduled` stays a separate
 * field carrying today's `RunTaskOptions.scheduled` meaning (activation
 * policy, scheduler env), never selecting the event source.
 *
 * Pure type module's runtime counterpart: `ExecutionProvenanceContext` itself
 * is declared in ../model/invocation.ts (Lane A, kept pure/IO-free per the
 * model purity ratchet); this file is where the runtime factory lives.
 */

import type { ExecutionProvenanceContext } from "../model/invocation";

/**
 * Build the default task-run provenance context: `eventSource` is always
 * `"task"` (D5-N1); `scheduled` carries the caller's own scheduled flag.
 */
export function createExecutionProvenanceContext(scheduled: boolean): ExecutionProvenanceContext {
  return Object.freeze({ eventSource: "task", scheduled });
}

/**
 * Resolve the effective provenance for one `runTask()` call: an explicit
 * `RunTaskOptions.provenance` always wins; absent, this is the default
 * context (§5.2 "Threading") — what keeps every pre-P1b caller (and any
 * future in-repo caller that never sets `provenance`) byte-equivalent to
 * today's behavior.
 */
export function resolveProvenanceContext(
  explicit: ExecutionProvenanceContext | undefined,
  scheduled: boolean,
): ExecutionProvenanceContext {
  return explicit ?? createExecutionProvenanceContext(scheduled);
}
