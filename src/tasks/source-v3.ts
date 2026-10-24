// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The prepare seam's document vocabulary (spec
 * docs/plans/specs/p4-deletions-closeout.md §3.2.3).
 *
 * `src` no longer accepts task v3 source — the v3 grammar (`parseTaskV3Yaml`,
 * `parseTaskV3Document`, `classifyTaskV3Uses`, and the GitHub Action locator
 * grammar deleted from classification ahead of this file's own shrink)
 * survives only vendored, frozen, in
 * `src/tasks/source/task-source-v3-frozen.ts` — the ONE place
 * left that reads a v3 document, reachable only through `akm migrate apply`
 * / `akm-migrate`.
 *
 * This file's surviving purpose is the `TaskV3*` type family
 * `src/tasks/prepare/prepare.ts` (`prepareTaskV3Execution`) and its
 * supporting modules still take as their input shape —
 * `PreparableTaskDocument` (`src/tasks/prepare/prepared-execution.ts`) is a
 * name for `TaskV3SourceDocument` that is not version-bound. The type
 * family's NAME stays (spec §0, R-R1: the rename to something version-
 * neutral is deferred to a follow-up commit after the sweep, so the
 * deletion diff this phase exists to prove is not buried under an
 * unrelated rename storm). Only task source v4 ever reaches this shape now
 * — `src/tasks/source/project-v4.ts`'s `projectTaskSourceV4()` is the only
 * producer.
 *
 * The workflow-side trigger classifier that used to live here
 * (`classifyTaskV3Triggers`) is re-homed to `src/workflows/github-yaml.ts`
 * (`parseTriggers`, P4-N3) — its subject was always a WORKFLOW's `on:`
 * trigger fragment, not a task document, and after the move
 * `src/workflows/**` imports nothing at all from `src/tasks/**` source
 * modules.
 */

import type { ParsedBuiltinCommandAction } from "../commands/command/builtin-action";
import type { ExecutionJsonObject } from "../execution/json";
import { TASK_V3_MAX_SCHEDULES } from "./source/bounded-document";

// D2-N4 (spec docs/plans/specs/p2a-task-source-v4.md §3.1, §9): re-exported
// at its EXISTING name so no importer changes. The one name a surviving
// `src` consumer still imports (task-source-v4.ts) — every other
// bounded-document re-export this file used to carry was dropped in P4
// §3.2.3.
export { TASK_V3_MAX_SCHEDULES };

export const TASK_EXTENSION = ".yml";
export const TASK_NEAR_MISS_EXTENSION = ".yaml";

/** Explain why the near-miss `.yaml` spelling is not a task source. */
export function taskExtensionDetail(relPath: string): string {
  const base = relPath.replace(/\.yaml$/i, "");
  return (
    `task file uses the ${TASK_NEAR_MISS_EXTENSION} extension; akm recognizes tasks only as ` +
    `${TASK_EXTENSION}, so this file is never indexed or scheduled — rename it to ${base}${TASK_EXTENSION}.`
  );
}

/** Closed authoring vocabulary. Arbitrary GitHub `{0}` shell templates are not accepted. */
export const TASK_V3_HOST_SHELLS = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"] as const;
export type TaskV3HostShell = (typeof TASK_V3_HOST_SHELLS)[number];

export type TaskV3UsesTarget =
  | Readonly<{ kind: "builtin-command"; ref: "akm/command" }>
  | Readonly<{ kind: "command" | "workflow" | "script"; ref: string }>;

export type TaskV3Environment = Readonly<Record<string, string | number | boolean>>;

export interface TaskV3AkmOptions {
  readonly schedule?: string;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly agent?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  readonly tools?: string | readonly string[] | ExecutionJsonObject | null;
  readonly timeout?: string | number | null;
  readonly redact?: readonly string[];
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export type TaskV3Target =
  | Readonly<{
      kind: "uses";
      uses: TaskV3UsesTarget;
      with?: ExecutionJsonObject;
      command?: ParsedBuiltinCommandAction;
    }>
  | Readonly<{
      kind: "run";
      run: string;
      shell?: TaskV3HostShell;
      workingDirectory?: string;
    }>;

/**
 * The trigger shape a task document projects to — a local, independent
 * declaration rather than an import so `src/tasks/**` and `src/workflows/**`
 * stay decoupled in both directions (P4-N3). `src/tasks/source/project-v4.ts`'s
 * `projectTaskSourceV4()` is the only producer of a value in this shape now.
 */
interface PreparableTaskTriggerPlan {
  readonly manual: boolean;
  readonly schedules: readonly Readonly<{ cron: string; source: string; ordinal: number }>[];
}

export interface TaskV3SourceDocument {
  readonly version: 3;
  readonly name?: string;
  readonly target: TaskV3Target;
  readonly env?: TaskV3Environment;
  readonly akm?: Readonly<TaskV3AkmOptions>;
  readonly triggers: PreparableTaskTriggerPlan;
  readonly source: Readonly<{ path: string }>;
}

/** Preserve actionable classified hints when a parser failure becomes a diagnostic. */
export function taskSourceErrorDetail(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const hint =
    "hint" in cause && typeof (cause as { hint?: unknown }).hint === "function"
      ? (cause as { hint: () => string | undefined }).hint()
      : undefined;
  return hint ? `${cause.message} ${hint}` : cause.message;
}
