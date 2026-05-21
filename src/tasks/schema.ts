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

export const TASK_SCHEMA_VERSION = 1;

export interface TaskWorkflowTarget {
  kind: "workflow";
  /** A workflow ref, e.g. `workflow:daily-backup`. */
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
  /** Agent profile name; defaults to `config.agent.default` when undefined. */
  profile?: string;
}

export interface TaskCommandTarget {
  kind: "command";
  /** Pre-split argv — first element is the executable. */
  cmd: string[];
}

export type TaskTarget = TaskWorkflowTarget | TaskPromptTarget | TaskCommandTarget;

export interface TaskDocument {
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
   * - Positive number: overrides `config.agent.timeoutMs` for this task only.
   * - `null` or `0`: disables the timeout entirely (no process kill). Use for
   *   long-running local-model tasks where wall-clock time is unpredictable.
   * - Omitted (`undefined`): inherits the global `config.agent.timeoutMs`.
   */
  timeoutMs?: number | null;
}
