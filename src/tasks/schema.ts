// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task asset schema. A task pairs a cron-style schedule with exactly one of:
 *
 *   • a workflow target  — invoked via `startWorkflowRun()`
 *   • a prompt target    — invoked via `runAgent()` against the configured
 *                          agent harness (e.g. `opencode run`)
 *   • a command target   — invoked directly via `Bun.spawn()`, no AI agent
 *
 * Tasks are stored as pure YAML files at `<stash>/tasks/<id>.yml`. Multi-line
 * inline prompts use a YAML block scalar (`prompt: |`).
 */

export const TASK_SCHEMA_VERSION = 2;

export interface TaskWorkflowTarget {
  kind: "workflow";
  /** A workflow ref, e.g. `workflows/daily-backup`. */
  ref: string;
  params: Record<string, unknown>;
}

export type TaskPromptSource =
  | { kind: "inline"; text: string }
  /** A stash asset ref like `agent:my-agent` or `command:foo`. */
  | { kind: "asset"; ref: string }
  /** A path resolved relative to the task file's directory. */
  | { kind: "file"; path: string };

export interface TaskPromptTarget {
  kind: "prompt";
  source: TaskPromptSource;
  /** Named engine; defaults to `defaults.engine` when undefined. */
  engine?: string;
  model?: string;
  timeoutMs?: number | null;
  llm?: {
    temperature?: number;
    maxTokens?: number;
    supportsJsonSchema?: boolean;
    extraParams?: Record<string, unknown>;
    contextLength?: number;
    enableThinking?: boolean;
  };
}

export interface TaskCommandTarget {
  kind: "command";
  /** Pre-split argv — first element is the executable. */
  cmd: string[];
}

export type TaskTarget = TaskWorkflowTarget | TaskPromptTarget | TaskCommandTarget;

export interface TaskDocument {
  /** Runtime schema version. Valid 0.8 task YAML is normalized to this shape while reading. */
  version: typeof TASK_SCHEMA_VERSION;
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  /** Filesystem-derived id (basename without `.yml`). */
  id: string;
  /** Cron-style expression, possibly an `@`-alias. */
  schedule: string;
  enabled: boolean;
  target: TaskTarget;
  /** Human-readable display name shown in `akm tasks list`. */
  name?: string;
  description?: string;
  /** Guidance on when this task should be used or triggered manually. */
  when_to_use?: string;
  tags?: string[];
  source: { path: string };
  /**
   * Per-task agent timeout override (ms).
   *
   * Command-task timeout. Prompt task timeout is stored on its engine use;
   * workflow tasks cannot set a timeout.
   */
  timeoutMs?: number | null;
}
