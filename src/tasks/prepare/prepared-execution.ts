// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The PreparedTaskV3* type family. Pure types only; prepare.ts
 * (prepareTaskV3Execution) and prepare-script-target.ts build values of
 * these shapes.
 */

import type {
  PrepareCommandInvocationOptions,
  PreparedCommandInvocation,
  prepareCommandInvocation,
} from "../../commands/command/command-execution";
import type { AkmConfig } from "../../core/config/config-types";
import type { SCHEDULED_TASK_CONTEXT_KEYS } from "../scheduler-invocation";
import type { TaskV3HostShell, TaskV3SourceDocument } from "../source-v3";

/**
 * The prepare seam's input, named independently of the source grammar
 * version: `prepareTaskV3Execution` (`./prepare.ts`) consumes exactly
 * `TaskV3SourceDocument`'s shape, and a task source v4
 * document projects into that SAME shape via `src/tasks/source/project-v4.ts`'s
 * `projectTaskSourceV4()` (its `version` field is the literal discriminant
 * `3`). Type alias only.
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
