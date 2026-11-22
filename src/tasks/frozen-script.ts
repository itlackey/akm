// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ScriptOrigin, scriptCommand, scriptOrigin } from "./prepare/script-capture";

export interface FrozenScriptSnapshot {
  readonly sourceRef: string;
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
  script: Pick<FrozenScriptSnapshot, "sourceRef" | "extension" | "bytesBase64">,
  materializedPath: string,
  args: readonly string[] = [],
): string[] {
  const bytes = Buffer.from(script.bytesBase64, "base64");
  return scriptCommand({ ref: script.sourceRef, bytes, extension: script.extension }, materializedPath, args);
}

/** The program and arguments that run the script asset `ref`, found at `file`, with `args` after it: what `akm run <ref>` runs. */
export function scriptProgram(
  ref: string,
  file: string,
  args: readonly string[],
): { argv: string[]; script: ScriptOrigin } {
  const script = { ref, bytes: fs.readFileSync(file), extension: path.extname(file).toLowerCase() };
  return { argv: scriptCommand(script, file, args), script: scriptOrigin(script) };
}

export function cleanupFrozenScript(materialized: MaterializedFrozenScript): void {
  fs.rmSync(materialized.directory, { recursive: true, force: true });
}
