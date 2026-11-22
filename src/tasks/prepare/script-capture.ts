// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one shared implementation of frozen-script byte capture, and of how a script is started.
 * Both prepare.ts's script arm (prepareTaskV3Execution) and
 * prepare-script-target.ts's typed prepareScriptTarget() call
 * captureScriptTarget() below, so the two never drift into two copies of the
 * same capture logic.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { UsageError } from "../../core/errors";
import { isBunStandaloneMain } from "../resolve-akm-bin";
import { STANDALONE_FROZEN_SCRIPT_ARG } from "../standalone-script-entry";

/** The program and leading arguments a script with no `#!` first line is started with, by extension. */
const EXTENSION_PROGRAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ".sh": ["sh"],
  ".cmd": ["cmd", "/d", "/s", "/c"],
  ".bat": ["cmd", "/d", "/s", "/c"],
  ".rb": ["ruby"],
  ".go": ["go", "run"],
  ".pl": ["perl"],
  ".php": ["php"],
  ".lua": ["lua"],
  ".r": ["Rscript"],
  ".swift": ["swift"],
  ".kt": ["kotlin"],
  ".kts": ["kotlinc", "-script"],
});

/** Extensions that run on Bun (or, without it, on Node) when the script has no `#!` first line. */
const BUN_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".js", ".mjs"]);

/** What a script's `#!` first line says to run: a program and, when the line goes on, the rest of it as one argument. */
export interface ScriptFirstLine {
  readonly program: string;
  readonly argument?: string;
}

/**
 * A script's first line when it starts with `#!`: the program is the first word, and everything after it is ONE
 * argument (`#!/usr/bin/env -S bash -eu` gives `env` the single argument `-S bash -eu`). Unlike the kernel, akm drops
 * a carriage return that ends the line, so a script saved with CRLF line endings runs as its author meant.
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

/** Which script a command line runs: its ref and `#!` first line as written (undefined when the extension chose the program). */
export interface ScriptOrigin {
  readonly ref: string;
  readonly firstLine: string | undefined;
}

/** The `#!` first line of a script as it is written, when akm reads it (never on Windows, which has no `#!` lines). */
function scriptFirstLineText(bytes: Uint8Array, platform: NodeJS.Platform): string | undefined {
  const first = platform === "win32" ? undefined : scriptFirstLine(bytes);
  return first ? `#!${first.program}${first.argument ? ` ${first.argument}` : ""}` : undefined;
}

/** Where a script's command line comes from, for an error about a program that cannot be started. */
export function scriptOrigin(
  script: { readonly ref: string; readonly bytes: Uint8Array },
  platform: NodeJS.Platform = process.platform,
): ScriptOrigin {
  return { ref: script.ref, firstLine: scriptFirstLineText(script.bytes, platform) };
}

/**
 * The one place a script becomes a command line: the program and arguments that run `file`, a copy of the script
 * `script` (named `ref` in messages), with `args` after it. This is akm's rule for how a script runs, which `akm run`, a task's script step, a
 * frozen task and the task check all use:
 *
 * - A `#!` first line names the program and its one argument, and that program is run with the file. akm differs from
 *   the kernel in three ways, each making a script run that its author meant to run: a trailing carriage return is
 *   ignored, a bare program name is searched on `PATH`, and the words after `bun` are split.
 * - A first line that names `bun` runs on the Bun akm itself runs on, with those words, so it needs no `bun` on
 *   `PATH`. A standalone akm binary has no Bun flags to pass them to and ignores the words. On a Node build there is
 *   no Bun to run on, so the line is run as written.
 * - With no first line, the extension selects the program.
 * - Windows has no `#!` lines, so there the extension always decides.
 *
 * Throws `TASK_TARGET_UNSUPPORTED` when the script has no first line and its extension names no program.
 */
export function scriptCommand(
  script: { readonly ref: string; readonly bytes: Uint8Array; readonly extension: string },
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const { extension, ref } = script;
  const first = platform === "win32" ? undefined : scriptFirstLine(script.bytes);
  if (first) {
    const bun = bunArguments(first);
    if (bun !== undefined && process.versions.bun) {
      return isBunStandaloneMain()
        ? [process.execPath, STANDALONE_FROZEN_SCRIPT_ARG, file, ...args]
        : [process.execPath, ...bun, file, ...args];
    }
    return [first.program, ...(first.argument ? [first.argument] : []), file, ...args];
  }
  if (BUN_EXTENSIONS.has(extension)) {
    if (process.versions.bun) {
      return isBunStandaloneMain()
        ? [process.execPath, STANDALONE_FROZEN_SCRIPT_ARG, file, ...args]
        : [process.execPath, file, ...args];
    }
    if (extension !== ".ts" || nodeStripsTypeScript()) return ["node", file, ...args];
    throw new UsageError(
      `Script ${JSON.stringify(ref)} requires Bun for ${extension} execution, but this runtime cannot provide it.`,
      "TASK_TARGET_UNSUPPORTED",
      "Add a `#!` first line naming the program that runs it, or run akm on Bun.",
    );
  }
  if (extension === ".py") return [platform === "win32" ? "python" : "python3", file, ...args];
  // PowerShell 7 installs only `pwsh` on Linux and macOS.
  if (extension === ".ps1")
    return [platform === "win32" ? "powershell" : "pwsh", "-NoProfile", "-NonInteractive", "-File", file, ...args];
  const program = EXTENSION_PROGRAMS[extension];
  if (!program) {
    throw new UsageError(
      `Script ${JSON.stringify(ref)} cannot be run: it has no \`#!\` first line naming its program, and akm has no program for the extension ${JSON.stringify(extension)}.`,
      "TASK_TARGET_UNSUPPORTED",
      "Add a `#!` first line naming the program that runs the script.",
    );
  }
  return [...program, file, ...args];
}

/** The fields both script-projection call sites (prepare.ts, prepare-script-target.ts) freeze identically. */
export interface CapturedScriptTarget {
  readonly extension: string;
  /** Immutable base64 encoding of the exact source bytes. */
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly cwd: string;
}

/**
 * Read a script's bytes off disk (or the caller's own read seam, following a
 * symlink to wherever it points) and freeze the digest shape every script
 * dispatch needs, refusing a script `scriptCommand` cannot start. `ref` is used
 * only in that refusal — it is the script's own qualified ref, never a synthetic
 * task ref. `bundleRoot` is the script's working directory.
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
  scriptCommand({ ref, bytes, extension }, file, []);
  return Object.freeze({
    extension,
    bytesBase64: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    cwd: path.resolve(bundleRoot),
  });
}
