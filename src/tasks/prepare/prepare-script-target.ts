// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Typed script-target preparer (spec
 * docs/plans/specs/p1b-model-extraction.md §4.3). Replaces directScript's
 * former synthetic-task-YAML fabrication (once in the since-deleted
 * `src/workflows/ir/source-freeze-v4.ts` shim; P4 deleted the file itself):
 * given a script asset's own owned identity (ref/file/
 * bundleRoot — never a synthetic task ref), freezes the same byte/
 * interpreter shape prepareTaskV3Execution's script arm freezes for a real
 * task-v3 script target — via the one shared captureScriptTarget()
 * implementation in ./script-capture. No task document is built or parsed
 * here; this module imports nothing from ../source-v3.
 */

import type { PreparedTaskV3DirectoryIdentity, TaskV3ScriptInterpreter } from "./prepared-execution";
import { captureScriptTarget } from "./script-capture";

export interface PreparedScriptTarget {
  readonly ref: string;
  readonly interpreter: TaskV3ScriptInterpreter;
  readonly extension: string;
  /** Immutable base64 encoding of the exact source bytes. */
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly cwd: string;
  readonly cwdIdentity: PreparedTaskV3DirectoryIdentity;
}

export interface PrepareScriptTargetInput {
  /** The script's own qualified ref (owned.ref) — never a synthetic task ref. */
  readonly ref: string;
  readonly file: string;
  readonly bundleRoot: string;
  readonly readFile: (file: string, bundleRoot?: string) => Uint8Array;
}

/** Project a script asset's own identity into the frozen shape a workflow script step dispatches. */
export function prepareScriptTarget(input: PrepareScriptTargetInput): PreparedScriptTarget {
  const captured = captureScriptTarget(input.ref, input.file, input.bundleRoot, input.readFile);
  return Object.freeze({ ref: input.ref, ...captured });
}
