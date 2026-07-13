// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Shared result type for synchronous command execution. */
export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Common structural shape of the synchronous exec seam shared by the task
 * backends. Backends declare their own *Exec interfaces (some add fields such
 * as `uid()`); this is the subset they all share and that {@link nodeExec}
 * provides by default.
 */
export interface NodeExec {
  run(args: string[]): ExecResult;
}

/**
 * Default exec strategy: run commands synchronously via {@link spawnCommand}.
 *
 * This is the shared default for every task backend's `exec` seam. Backends
 * that need extra fields (e.g. launchd's `uid()`) spread this and add them.
 */
export function nodeExec(): NodeExec {
  return {
    run(args: string[]) {
      return spawnCommand(args);
    },
  };
}

/**
 * Common structural shape of the synchronous filesystem seam shared by the
 * task backends. Backends declare their own *Fs interfaces with additional
 * members (launchd adds `list`/`exists`; schtasks adds `tmpdir`); this is the
 * subset whose default implementation is byte-identical across them and that
 * {@link nodeFs} provides.
 */
export interface NodeFs {
  writeFile(file: string, content: string): void;
  ensureDir(dir: string): void;
}

/**
 * Default filesystem strategy for the shared subset of the backend `fs` seam
 * (`writeFile` + `ensureDir`), backed by `node:fs`.
 *
 * Backends spread this and add their own members. Note `removeFile` is NOT
 * shared here: the launchd and schtasks defaults differ observably (schtasks
 * swallows errors; launchd does not), so each keeps its own.
 */
export function nodeFs(): NodeFs {
  return {
    writeFile(file: string, content: string) {
      fs.writeFileSync(file, content, { encoding: "utf8" });
    },
    ensureDir(dir: string) {
      fs.mkdirSync(dir, { recursive: true });
    },
  };
}

/**
 * Run a command synchronously, normalizing null results to safe defaults.
 * args[0] is the binary; args[1..] are its arguments.
 */
export function spawnCommand(args: string[]): ExecResult {
  const [bin, ...rest] = args;
  const r = spawnSync(bin, rest);
  return {
    status: r.status ?? 1,
    stdout: decodeCommandOutput(r.stdout),
    stderr: decodeCommandOutput(r.stderr),
  };
}

/** Decode native command output, including the UTF-16 XML emitted by schtasks. */
export function decodeCommandOutput(output: string | Buffer | null | undefined): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output.replace(/^\uFEFF/, "");
  if (output.length === 0) return "";

  if (output[0] === 0xef && output[1] === 0xbb && output[2] === 0xbf) {
    return output.toString("utf8", 3);
  }
  if (output[0] === 0xff && output[1] === 0xfe) {
    return output.subarray(2).toString("utf16le");
  }
  if (output[0] === 0xfe && output[1] === 0xff) {
    return decodeUtf16Be(output.subarray(2));
  }

  const pairs = Math.floor(output.length / 2);
  if (pairs > 1) {
    let evenNuls = 0;
    let oddNuls = 0;
    for (let i = 0; i < pairs * 2; i += 2) {
      if (output[i] === 0) evenNuls += 1;
      if (output[i + 1] === 0) oddNuls += 1;
    }
    if (oddNuls / pairs > 0.6) return output.toString("utf16le");
    if (evenNuls / pairs > 0.6) return decodeUtf16Be(output);
  }

  return output.toString("utf8");
}

/** Return XML with the declaration required by Task Scheduler's UTF-16 input. */
export function normalizeXmlForUtf16File(xml: string): string {
  const source = xml.replace(/^\uFEFF/, "");
  const declaration = '<?xml version="1.0" encoding="UTF-16"?>';
  if (/^<\?xml\b[^?]*\?>/i.test(source)) {
    return source.replace(/^<\?xml\b[^?]*\?>/i, declaration);
  }
  return `${declaration}\n${source}`;
}

function decodeUtf16Be(output: Buffer): string {
  const evenLength = output.length - (output.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    swapped[i] = output[i + 1];
    swapped[i + 1] = output[i];
  }
  return swapped.toString("utf16le");
}

/**
 * Escape a string for safe embedding in an XML attribute or text node.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
