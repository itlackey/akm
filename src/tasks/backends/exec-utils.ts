// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";

/** Shared result type for synchronous command execution. */
export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command synchronously, normalizing null results to safe defaults.
 * args[0] is the binary; args[1..] are its arguments.
 */
export function spawnCommand(args: string[]): ExecResult {
  const [bin, ...rest] = args;
  const r = spawnSync(bin, rest, { encoding: "utf8" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
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
