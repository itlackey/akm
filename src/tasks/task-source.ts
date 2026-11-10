// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The prepare seam's document vocabulary.
 *
 * `src` no longer accepts task v3 source, and nothing in 0.10 converts it:
 * the v3 grammar went with the converter at the 0.9.32 floor (akm 0.9.32's
 * `akm migrate apply` was the last to read a v3 document).
 *
 * This file holds the `PreparableTaskDocument` family
 * `src/tasks/prepare/prepare.ts` (`prepareTaskExecution`) and its
 * supporting modules take as their input shape. Only task source v4 reaches
 * it — `src/tasks/source/project-v4.ts`'s `projectTaskSourceV4()` is the only
 * producer.
 */

import type { ParsedBuiltinCommandAction } from "../commands/command/builtin-action";
import type { ExecutionJsonObject } from "../execution/json";

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
export const TASK_HOST_SHELLS = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"] as const;
export type TaskHostShell = (typeof TASK_HOST_SHELLS)[number];

export type TaskUsesTarget =
  | Readonly<{ kind: "builtin-command"; ref: "akm/command" }>
  | Readonly<{ kind: "command" | "workflow" | "script"; ref: string }>;

export type TaskEnvironment = Readonly<Record<string, string | number | boolean>>;

export interface TaskAkmOptions {
  readonly schedule?: string;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly tags?: readonly string[];
  readonly agent?: string | null;
  readonly connection?: string | null;
  readonly harness?: string | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly inference?: ExecutionJsonObject | null;
  readonly outputSchema?: ExecutionJsonObject | null;
  readonly timeout?: string | number | null;
  readonly redact?: readonly string[];
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export type TaskTarget =
  | Readonly<{
      kind: "uses";
      uses: TaskUsesTarget;
      with?: ExecutionJsonObject;
      command?: ParsedBuiltinCommandAction;
    }>
  | Readonly<{
      kind: "run";
      run: string;
      shell?: TaskHostShell;
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

export interface PreparableTaskDocument {
  readonly version: 3;
  readonly name?: string;
  readonly target: TaskTarget;
  readonly env?: TaskEnvironment;
  readonly akm?: Readonly<TaskAkmOptions>;
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
