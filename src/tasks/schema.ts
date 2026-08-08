// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Task asset schema. A task pairs a cron-style schedule with exactly one of:
 *
 *   • a workflow target  — executed via `runWorkflowSteps()`
 *   • a prompt target    — invoked via `runAgent()` against the configured
 *                          agent harness (e.g. `opencode run`)
 *   • a command target   — invoked directly via `Bun.spawn()`, no AI agent
 *
 * Tasks are stored as pure YAML files at `<stash>/tasks/<id>.yml`. Multi-line
 * inline prompts use a YAML block scalar (`prompt: |`).
 */

export const TASK_SCHEMA_VERSION = 2;

/**
 * Largest expressible `timeoutMs` — `setTimeout`'s 32-bit signed ceiling
 * (2^31-1, ~24.8 days). A larger delay overflows and fires almost immediately,
 * which would silently abort a run seconds after it started instead of hours
 * later. Mirrored as `maximum` on `timeoutMs` in `schemas/akm-task.json`.
 */
export const TASK_MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Lint-level shape problems for a parsed task YAML mapping: the field rules
 * `src/tasks/parser.ts` enforces at load time, phrased as diagnostics. The ONE
 * definition shared by both task linters (`core/adapter/adapters/akm-lint.ts`
 * and `akm-task-adapter.ts`) so lint and runtime cannot disagree — they
 * previously did, in both directions: lint demanded `enabled` (which the
 * parser defaults to `true`, so a runnable task was flagged) and never checked
 * `version` (which the parser hard-requires as `2`, so a lint-clean task died
 * at runtime with TASK_SCHEMA_VERSION_UNSUPPORTED). `schemas/akm-task.json`
 * agrees with the parser: `required: [version, schedule]`, `version:
 * {const: 2}`, `enabled` optional but boolean. Target-arity rules stay with
 * each caller (they legitimately differ: at-least-one vs exactly-one).
 */
export function taskFieldProblems(data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (data.version !== TASK_SCHEMA_VERSION) problems.push(`version (must be ${TASK_SCHEMA_VERSION})`);
  if (typeof data.schedule !== "string" || data.schedule.trim() === "") problems.push("schedule");
  if ("enabled" in data && typeof data.enabled !== "boolean") problems.push("enabled (must be a boolean when present)");
  return problems;
}

export interface TaskWorkflowTarget {
  kind: "workflow";
  /** A workflow ref, e.g. `workflows/daily-backup`. */
  ref: string;
  params: Record<string, unknown>;
  /**
   * Whole-run timeout (ms) for the orchestration this task drives — the same
   * bound `akm workflow run --timeout` applies, expressed in the task file.
   *
   *   • `undefined` → `DEFAULT_WORKFLOW_TASK_TIMEOUT_MS` (see `runner.ts`).
   *     An unattended run is never left unbounded by accident.
   *   • `null`      → explicit opt-out: run until the workflow itself stops.
   *   • integer     → that many milliseconds; an explicit value always wins.
   *
   * On expiry the runner aborts the run's signal, which the engine treats as a
   * graceful break at a step boundary — the run stays resumable.
   */
  timeoutMs?: number | null;
  /** Stop after this many spine steps (`akm workflow run --max-steps`). */
  maxSteps?: number;
  /** Retry a failed step this many additional times (`--max-retries`). */
  maxRetries?: number;
}

export type TaskPromptSource =
  | { kind: "inline"; text: string }
  /** A stash asset ref like `agents/my-agent` or `commands/foo`. */
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
  /** Runtime and on-disk schema version. */
  version: typeof TASK_SCHEMA_VERSION;
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  /** Filesystem-derived id (basename without `.yml`). */
  id: string;
  /** Cron-style expression, possibly an `@`-alias. */
  schedule: string;
  enabled: boolean;
  target: TaskTarget;
  /** Human-readable display name shown in `akm show` and search results. */
  name?: string;
  description?: string;
  /** Guidance on when this task should be used or triggered manually. */
  when_to_use?: string;
  tags?: string[];
  source: { path: string };
  /**
   * Per-task agent timeout override (ms).
   *
   * Command-task timeout. Prompt task timeout is stored on its engine use, and
   * a workflow task's whole-run timeout on {@link TaskWorkflowTarget.timeoutMs}
   * — every target kind reads the same `timeoutMs` YAML key, it just lands
   * where that kind's dispatch consumes it.
   */
  timeoutMs?: number | null;
}
