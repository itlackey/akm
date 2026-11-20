// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNever } from "../core/assert";
import type { TaskV3ScriptInterpreter } from "./prepare/prepared-execution";
import { scriptInterpreter } from "./prepare/script-capture";
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

/** The program and arguments that run the script at `materializedPath`, with `args` after it. */
export function frozenScriptCommand(
  script: Pick<FrozenScriptSnapshot, "interpreter" | "extension">,
  materializedPath: string,
  args: readonly string[] = [],
): string[] {
  return [...interpreterCommand(script, materializedPath), ...args];
}

/** The program and arguments that run the script asset `ref`, found at `file`, with `args` after it: what `akm run <ref>` runs. */
export function scriptProgram(ref: string, file: string, args: readonly string[]): string[] {
  const extension = path.extname(file);
  const interpreter = scriptInterpreter(extension, ref, extension === "" ? fs.readFileSync(file) : undefined);
  return frozenScriptCommand({ interpreter, extension }, file, args);
}

function interpreterCommand(
  script: Pick<FrozenScriptSnapshot, "interpreter" | "extension">,
  materializedPath: string,
): string[] {
  switch (script.interpreter) {
    case "bun":
      return [process.execPath, materializedPath];
    case "bun-standalone":
      return [process.execPath, STANDALONE_FROZEN_SCRIPT_ARG, materializedPath];
    case "node":
      return ["node", materializedPath];
    case "powershell":
      return ["powershell", "-NoProfile", "-NonInteractive", "-File", materializedPath];
    case "cmd":
      return ["cmd", "/d", "/s", "/c", materializedPath];
    case "go":
      return ["go", "run", materializedPath];
    case "kotlin":
      return script.extension === ".kts" ? ["kotlinc", "-script", materializedPath] : ["kotlin", materializedPath];
    case "sh":
    case "python":
    case "ruby":
    case "perl":
    case "php":
    case "lua":
    case "rscript":
    case "swift":
      return [script.interpreter, materializedPath];
    default:
      return assertNever(script.interpreter, "frozenScriptCommand");
  }
}

export function cleanupFrozenScript(materialized: MaterializedFrozenScript): void {
  fs.rmSync(materialized.directory, { recursive: true, force: true });
}
