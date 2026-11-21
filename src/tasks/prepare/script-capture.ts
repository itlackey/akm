// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one shared implementation of frozen-script byte/interpreter capture.
 * Both prepare.ts's script arm (prepareTaskV3Execution) and
 * prepare-script-target.ts's typed prepareScriptTarget() call
 * captureScriptTarget() below, so the two never drift into two copies of the
 * same capture logic.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { UsageError } from "../../core/errors";
import { isBunStandaloneMain } from "../resolve-akm-bin";
import type { TaskV3ScriptInterpreter } from "./prepared-execution";

/** The interpreter a script's extension selects when its first line does not say how to run it. */
const SCRIPT_INTERPRETERS: Readonly<Record<string, TaskV3ScriptInterpreter>> = Object.freeze({
  ".sh": "sh",
  ".ts": "bun",
  ".js": "bun",
  ".mjs": "bun",
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

/** What a script's `#!` first line says to run: a program and, when the line goes on, the rest of it as one argument. */
export interface ScriptFirstLine {
  readonly program: string;
  readonly argument?: string;
}

/**
 * A script's first line when it starts with `#!`, read as the kernel reads it: the program is the first word, and
 * everything after it is ONE argument (`#!/usr/bin/env -S bash -eu` gives `env` the single argument `-S bash -eu`).
 * A carriage return that ends the line is not part of it.
 */
export function scriptFirstLine(bytes: Uint8Array | undefined): ScriptFirstLine | undefined {
  if (!bytes || bytes.length < 3 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return undefined;
  const newline = bytes.indexOf(0x0a);
  const line = Buffer.from(newline === -1 ? bytes.subarray(2) : bytes.subarray(2, newline))
    .toString("utf8")
    .replace(/\r$/, "")
    .trim();
  const [, program, argument] = /^(\S+)(?:[ \t]+(.*))?$/.exec(line) ?? [];
  if (!program) return undefined;
  return argument ? { program, argument } : { program };
}

/**
 * The words after `bun` on a first line that names it (`#!/usr/bin/env bun`, `#!/usr/local/bin/bun --smol`,
 * `#!/usr/bin/env -S bun run`), or undefined when the line names another program. Such a script runs on the Bun akm
 * itself runs on, so it needs no `bun` on `PATH`.
 */
export function bunArguments(first: ScriptFirstLine | undefined): string[] | undefined {
  if (!first) return undefined;
  const words = first.argument?.split(/\s+/).filter(Boolean) ?? [];
  if (path.basename(first.program) === "bun") return words;
  if (path.basename(first.program) !== "env") return undefined;
  const named = words[0] === "-S" ? words.slice(1) : words;
  return named[0] === "bun" ? named.slice(1) : undefined;
}

function nodeStripsTypeScript(): boolean {
  const features = (process as unknown as { features?: { typescript?: string | boolean } }).features;
  return Boolean(features?.typescript);
}

/**
 * How a script is started. Its first line decides, as it does when the file is run directly: a `#!` line that names
 * a program runs that program with that line's argument (`shebang`), so `#!/usr/bin/env bash`, `#!/bin/bash -e` and
 * `#!/usr/bin/env python3` each mean what they say. A first line that names `bun`, and a script with no such line,
 * run under the interpreter the extension selects. Windows has no `#!` lines, so there the extension always decides.
 */
export function scriptInterpreter(
  extension: string,
  ref: string,
  bytes?: Uint8Array,
  platform: NodeJS.Platform = process.platform,
): TaskV3ScriptInterpreter {
  const first = platform === "win32" ? undefined : scriptFirstLine(bytes);
  const forBun = bunArguments(first) !== undefined;
  if (first && !forBun) return "shebang";
  const interpreter = SCRIPT_INTERPRETERS[extension] ?? (forBun ? "bun" : undefined);
  if (!interpreter) {
    throw new UsageError(
      `Script ${JSON.stringify(ref)} cannot be run: it has no \`#!\` first line naming its program, and akm has no interpreter for the extension ${JSON.stringify(extension)}.`,
      "TASK_TARGET_UNSUPPORTED",
    );
  }
  if (interpreter !== "bun") return interpreter;
  if (process.versions.bun) {
    return isBunStandaloneMain() ? "bun-standalone" : "bun";
  }
  if (extension === ".js" || extension === ".mjs" || (extension === ".ts" && nodeStripsTypeScript())) {
    return "node";
  }
  throw new UsageError(
    `Script ${JSON.stringify(ref)} requires Bun for ${extension} execution, but this runtime cannot provide it.`,
    "TASK_TARGET_UNSUPPORTED",
  );
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
}

/**
 * Read a script's bytes off disk (or the caller's own read seam, following a
 * symlink to wherever it points) and freeze the interpreter/digest shape every
 * script dispatch needs. `ref` is used only for interpreter-selection error
 * messages — it is the script's own qualified ref, never a synthetic task ref.
 * `bundleRoot` is the script's working directory.
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
  return Object.freeze({
    interpreter: scriptInterpreter(extension, ref, bytes),
    extension,
    bytesBase64: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    cwd: path.resolve(bundleRoot),
  });
}
