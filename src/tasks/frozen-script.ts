// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Asset } from "../core/assets/read";
import { UsageError } from "../core/errors";
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
  // asset-io: scratch materialized script
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

/**
 * The program and arguments that run the script `asset`, which `ref` names, with `args` after it: what `akm run <ref>`
 * runs. The program reads the script from its file, so the asset must be kept in one; its bytes are the asset's own.
 */
export function scriptProgram(
  ref: string,
  asset: Asset,
  args: readonly string[],
): { argv: string[]; script: ScriptOrigin } {
  // asset-io: exec the file is handed to the interpreter
  const file = asset.entry.file;
  if (file === undefined) throw new UsageError(`Asset ${asset.ref} is not kept in a file.`);
  const script = { ref, bytes: asset.entry.bytes(), extension: path.extname(file).toLowerCase() };
  return { argv: scriptCommand(script, file, args), script: scriptOrigin(script) };
}

export function cleanupFrozenScript(materialized: MaterializedFrozenScript): void {
  // asset-io: scratch materialized script
  fs.rmSync(materialized.directory, { recursive: true, force: true });
}
