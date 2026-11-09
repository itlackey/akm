// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The PreparedTask* type family. Pure types only; prepare.ts
 * (prepareTaskExecution) and prepare-script-target.ts build values of
 * these shapes.
 */

import type {
  PrepareCommandInvocationOptions,
  PreparedCommandInvocation,
  prepareCommandInvocation,
} from "../../commands/command/command-execution";
import type { AkmConfig } from "../../core/config/config-types";
import type { PreparableTaskDocument, TaskHostShell } from "../task-source";

export type TaskScriptInterpreter =
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

export interface PreparedTaskBase {
  readonly taskId: string;
  readonly taskRef: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number | null;
  readonly redact: readonly string[];
}

export interface PreparedTaskCommand extends PreparedTaskBase {
  readonly kind: "command";
  readonly invocation: PreparedCommandInvocation;
}

export interface PreparedTaskWorkflow extends PreparedTaskBase {
  readonly kind: "workflow";
  readonly ref: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export interface PreparedTaskShell extends PreparedTaskBase {
  readonly kind: "shell";
  readonly command: string;
  readonly shell: TaskHostShell;
  readonly cwd: string;
}

export interface PreparedTaskScript extends PreparedTaskBase {
  readonly kind: "script";
  readonly sourceRef: string;
  readonly interpreter: TaskScriptInterpreter;
  readonly extension: string;
  /** Immutable base64 encoding of the exact source bytes. */
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly cwd: string;
}

export type PreparedTaskExecution = PreparedTaskCommand | PreparedTaskWorkflow | PreparedTaskShell | PreparedTaskScript;

export interface PrepareTaskExecutionContext {
  readonly taskId: string;
  readonly taskRef: string;
  readonly bundleName: string;
  readonly bundleRoot: string;
  readonly config: AkmConfig;
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
