// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNever } from "../core/assert";
import type { TaskV3ScriptInterpreter } from "./prepare/prepared-execution";
import { bunArguments, scriptFirstLine, scriptInterpreter } from "./prepare/script-capture";
import { STANDALONE_FROZEN_SCRIPT_ARG } from "./standalone-script-entry";

export interface FrozenScriptSnapshot {
  readonly sourceRef: string;
  readonly interpreter: TaskV3ScriptInterpreter;
  readonly extension: string;
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface MaterializedFrozenScript {
  readonly directory: string;
  readonly file: string;
}

export function materializeFrozenScript(script: FrozenScriptSnapshot): MaterializedFrozenScript {
  const bytes = Buffer.from(script.bytesBase64, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== script.byteLength || digest !== script.sha256) {
    throw new Error(`Frozen script snapshot ${script.sourceRef} failed its byte/hash integrity check.`);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-script-"));
  const file = path.join(directory, `snapshot${script.extension}`);
  fs.writeFileSync(file, bytes, { mode: 0o700 });
  return Object.freeze({ directory, file });
}

/** The program and arguments that run the frozen script at `materializedPath`, with `args` after it. */
export function frozenScriptCommand(
  script: Pick<FrozenScriptSnapshot, "interpreter" | "extension" | "bytesBase64">,
  materializedPath: string,
  args: readonly string[] = [],
): string[] {
  return scriptCommand(script, Buffer.from(script.bytesBase64, "base64"), materializedPath, args);
}

/** The program and arguments that run the script asset `ref`, found at `file`, with `args` after it: what `akm run <ref>` runs. */
export function scriptProgram(ref: string, file: string, args: readonly string[]): string[] {
  const extension = path.extname(file).toLowerCase();
  const bytes = fs.readFileSync(file);
  return scriptCommand({ interpreter: scriptInterpreter(extension, ref, bytes), extension }, bytes, file, args);
}

/**
 * The one place a script becomes a command line. A `shebang` script is started the way the kernel starts it: the
 * program its first line names, that line's argument, then the file. A script for Bun runs on this process's own
 * runtime, with the words its first line put after `bun`.
 */
function scriptCommand(
  script: Pick<FrozenScriptSnapshot, "interpreter" | "extension">,
  bytes: Uint8Array,
  file: string,
  args: readonly string[],
): string[] {
  const first = scriptFirstLine(bytes);
  switch (script.interpreter) {
    case "shebang": {
      if (!first) throw new Error(`Script ${file} was to run by its first line, and has none.`);
      return [first.program, ...(first.argument ? [first.argument] : []), file, ...args];
    }
    case "bun":
      return [process.execPath, ...(bunArguments(first) ?? []), file, ...args];
    case "bun-standalone":
      return [process.execPath, STANDALONE_FROZEN_SCRIPT_ARG, file, ...args];
    case "node":
      return ["node", file, ...args];
    case "powershell":
      return ["powershell", "-NoProfile", "-NonInteractive", "-File", file, ...args];
    case "cmd":
      return ["cmd", "/d", "/s", "/c", file, ...args];
    case "go":
      return ["go", "run", file, ...args];
    case "kotlin":
      return [...(script.extension === ".kts" ? ["kotlinc", "-script"] : ["kotlin"]), file, ...args];
    case "python":
      // PEP 394: `python3` is the name a POSIX system has; Windows installs `python`.
      return [process.platform === "win32" ? "python" : "python3", file, ...args];
    case "sh":
    case "ruby":
    case "perl":
    case "php":
    case "lua":
    case "rscript":
    case "swift":
      return [script.interpreter, file, ...args];
    default:
      return assertNever(script.interpreter, "scriptCommand");
  }
}

export function cleanupFrozenScript(materialized: MaterializedFrozenScript): void {
  fs.rmSync(materialized.directory, { recursive: true, force: true });
}
