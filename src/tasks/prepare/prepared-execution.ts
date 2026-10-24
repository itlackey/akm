// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The PreparedTaskV3* type family — moved body-intact from
 * src/tasks/runtime-v3.ts (docs/plans/specs/p1b-model-extraction.md §4.1,
 * Lane B / D4 module map). Pure types only; prepare.ts (the moved
 * prepareTaskV3Execution) and prepare-script-target.ts build values of
 * these shapes.
 */

import type {
  PrepareCommandInvocationOptions,
  PreparedCommandInvocation,
  prepareCommandInvocation,
} from "../../commands/command/command-execution";
import type { AkmConfig } from "../../core/config/config-types";
import type { FrozenDirectoryIdentity } from "../../execution/directory-identity";
import type { SCHEDULED_TASK_CONTEXT_KEYS } from "../scheduler-invocation";
import type { TaskV3HostShell, TaskV3SourceDocument } from "../source-v3";

/**
 * The prepare seam's input, named independently of the source grammar
 * version (P2a, spec docs/plans/specs/p2a-task-source-v4.md §3.1/§3.5):
 * `prepareTaskV3Execution` (`./prepare.ts`) is unmodified in P2a and still
 * consumes exactly `TaskV3SourceDocument`'s shape, but a task source v4
 * document projects into that SAME shape via `src/tasks/source/project-v4.ts`'s
 * `projectTaskSourceV4()` (its `version` field is the literal discriminant
 * `3`, a recorded wart — P4 retires this alias when it renames the
 * underlying type). Type alias only; no behavior change.
 */
export type PreparableTaskDocument = TaskV3SourceDocument;

export type TaskV3ScriptInterpreter =
  | "sh"
  | "bun"
  | "bun-standalone"
  | "node"
  | "powershell"
  | "cmd"
  | "python"
  | "ruby"
  | "go"
  | "perl"
  | "php"
  | "lua"
  | "rscript"
  | "swift"
  | "kotlin";

export interface TaskV3PreparedBase {
  readonly taskId: string;
  readonly taskRef: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number | null;
  readonly redact: readonly string[];
}

/** Physical directory identity frozen before durable task history begins. */
export type PreparedTaskV3DirectoryIdentity = FrozenDirectoryIdentity;

export interface PreparedTaskV3Command extends TaskV3PreparedBase {
  readonly kind: "command";
  readonly invocation: PreparedCommandInvocation;
}

export interface PreparedTaskV3Workflow extends TaskV3PreparedBase {
  readonly kind: "workflow";
  readonly ref: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export interface PreparedTaskV3Shell extends TaskV3PreparedBase {
  readonly kind: "shell";
  readonly command: string;
  readonly shell: TaskV3HostShell;
  readonly cwd: string;
  readonly cwdIdentity: PreparedTaskV3DirectoryIdentity;
}

export interface PreparedTaskV3Script extends TaskV3PreparedBase {
  readonly kind: "script";
  readonly sourceRef: string;
  readonly interpreter: TaskV3ScriptInterpreter;
  readonly extension: string;
  /** Immutable base64 encoding of the exact source bytes. */
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly cwd: string;
  readonly cwdIdentity: PreparedTaskV3DirectoryIdentity;
}

export type PreparedTaskV3Execution =
  | PreparedTaskV3Command
  | PreparedTaskV3Workflow
  | PreparedTaskV3Shell
  | PreparedTaskV3Script;

export interface PrepareTaskV3ExecutionContext {
  readonly taskId: string;
  readonly taskRef: string;
  readonly bundleName: string;
  readonly bundleRoot: string;
  readonly config: AkmConfig;
  /**
   * The scheduled process's AKM directory values (the row sets them) to freeze into nested agent dispatch.
   * Only the closed AKM directory-key set is accepted; arbitrary operational
   * environment overrides remain outside the immutable command request.
   */
  readonly schedulerContext?: Readonly<Partial<Record<(typeof SCHEDULED_TASK_CONTEXT_KEYS)[number], string>>>;
  readonly prepareCommand?: typeof prepareCommandInvocation;
  readonly commandSourceLoader?: PrepareCommandInvocationOptions["sourceLoader"];
  readonly resolveAsset?: (input: {
    readonly bundle: string;
    readonly type: "workflow" | "script";
    readonly name: string;
    readonly ref: string;
  }) => Promise<string | Readonly<{ file: string; bundleRoot: string }>>;
  readonly readFile?: (file: string, bundleRoot?: string) => Uint8Array;
  /** Platform policy injection used by cross-platform projection tests. */
  readonly platform?: NodeJS.Platform;
}
