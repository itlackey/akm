// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one shared implementation of frozen-script byte/interpreter capture
 * (spec docs/plans/specs/p1b-model-extraction.md §4.3). Both prepare.ts's
 * script arm (the moved prepareTaskV3Execution) and
 * prepare-script-target.ts's typed prepareScriptTarget() call
 * captureScriptTarget() below, so the two never drift into two copies of the
 * same capture logic. scriptInterpreter() and captureDirectoryIdentity() are
 * moved body-intact out of the pre-P1b src/tasks/runtime-v3.ts.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { UsageError } from "../../core/errors";
import { captureFrozenDirectoryIdentity } from "../../execution/directory-identity";
import { isBunStandaloneMain } from "../resolve-akm-bin";
import type { PreparedTaskV3DirectoryIdentity, TaskV3ScriptInterpreter } from "./prepared-execution";

const SCRIPT_INTERPRETERS: Readonly<Record<string, TaskV3ScriptInterpreter>> = Object.freeze({
  ".sh": "sh",
  ".ts": "bun",
  ".js": "bun",
  ".ps1": "powershell",
  ".cmd": "cmd",
  ".bat": "cmd",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".pl": "perl",
  ".php": "php",
  ".lua": "lua",
  ".r": "rscript",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
});

const SHEBANG_INTERPRETERS: ReadonlyArray<readonly [RegExp, TaskV3ScriptInterpreter]> = [
  [/^(bash|sh|zsh|dash|ksh)$/, "sh"],
  [/^python[0-9.]*$/, "python"],
  [/^ruby$/, "ruby"],
  [/^perl$/, "perl"],
  [/^php$/, "php"],
  [/^lua$/, "lua"],
  [/^node$/, "node"],
];

function interpreterFromShebang(bytes: Uint8Array | undefined): TaskV3ScriptInterpreter | undefined {
  if (!bytes || bytes.length < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return undefined;
  const newline = bytes.indexOf(0x0a);
  const lineBytes = newline === -1 ? bytes.subarray(2) : bytes.subarray(2, newline);
  const tokens = Buffer.from(lineBytes).toString("utf8").trim().split(/\s+/).filter(Boolean);
  const [first, second] = tokens;
  const named = first?.split("/").pop() === "env" ? second : first?.split("/").pop();
  if (!named) return undefined;
  for (const [pattern, interpreter] of SHEBANG_INTERPRETERS) {
    if (pattern.test(named)) return interpreter;
  }
  return undefined;
}

function nodeStripsTypeScript(): boolean {
  const features = (process as unknown as { features?: { typescript?: string | boolean } }).features;
  return Boolean(features?.typescript);
}

export function scriptInterpreter(extension: string, ref: string, bytes?: Uint8Array): TaskV3ScriptInterpreter {
  const interpreter = SCRIPT_INTERPRETERS[extension] ?? (extension === "" ? interpreterFromShebang(bytes) : undefined);
  if (!interpreter) {
    throw new UsageError(
      `Task v3 script target ${JSON.stringify(ref)} has no closed runtime interpreter for extension ${JSON.stringify(extension)}.`,
      "TASK_TARGET_UNSUPPORTED",
    );
  }
  if (interpreter !== "bun") return interpreter;
  if (process.versions.bun) {
    return isBunStandaloneMain() ? "bun-standalone" : "bun";
  }
  if (extension === ".js" || (extension === ".ts" && nodeStripsTypeScript())) {
    return "node";
  }
  throw new UsageError(
    `Task v3 script target ${JSON.stringify(ref)} requires Bun for ${extension} execution, but this runtime cannot provide it.`,
    "TASK_TARGET_UNSUPPORTED",
  );
}

export function captureDirectoryIdentity(
  bundleRoot: string,
  workingDirectory?: string,
): PreparedTaskV3DirectoryIdentity {
  try {
    return captureFrozenDirectoryIdentity(bundleRoot, workingDirectory);
  } catch (cause) {
    if (cause instanceof UsageError) throw cause;
    throw new UsageError(
      `Task working directory ${JSON.stringify(workingDirectory ?? ".")} cannot be physically verified: ${cause instanceof Error ? cause.message : String(cause)}`,
      "TASK_SOURCE_INVALID",
    );
  }
}

/** The fields both script-projection call sites (prepare.ts, prepare-script-target.ts) freeze identically. */
export interface CapturedScriptTarget {
  readonly interpreter: TaskV3ScriptInterpreter;
  readonly extension: string;
  /** Immutable base64 encoding of the exact source bytes. */
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly cwd: string;
  readonly cwdIdentity: PreparedTaskV3DirectoryIdentity;
}

/**
 * Read a script's bytes off disk (or the caller's own read seam) and freeze
 * the interpreter/digest/directory-identity shape every script dispatch
 * needs. `ref` is used only for interpreter-selection error messages — it is
 * the script's own qualified ref, never a synthetic task ref. `bundleRoot` is
 * where directory identity is captured from (one level above the script file
 * itself, matching prepareTaskV3Execution's historical behavior).
 */
export function captureScriptTarget(
  ref: string,
  file: string,
  bundleRoot: string,
  readFile: (file: string, bundleRoot?: string) => Uint8Array,
): CapturedScriptTarget {
  const extension = path.extname(file).toLowerCase();
  const raw = readFile(file, bundleRoot);
  const bytes = Uint8Array.from(raw);
  const cwdIdentity = captureDirectoryIdentity(bundleRoot);
  return Object.freeze({
    interpreter: scriptInterpreter(extension, ref, bytes),
    extension,
    bytesBase64: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    cwd: cwdIdentity.realCwd,
    cwdIdentity,
  });
}
