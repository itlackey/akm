// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Shared by the per-harness plugin upgraders: running an external command with a timeout, and the entry shapes they return. */

import * as childProcess from "node:child_process";
import type { PluginUpgradeEntry } from "../../sources/types";
import { ChannelWriteError } from "./plugin-channels";

export const READ_TIMEOUT_MS = 30_000;
export const REFRESH_TIMEOUT_MS = 120_000;
export const PREFETCH_TIMEOUT_MS = 180_000;

// ── Running external commands ───────────────────────────────────────────────

export type CommandFailure = { ok: false; missing: boolean; error: string };
type CommandResult = { ok: true; stdout: string } | CommandFailure;

export function runCommand(command: string, args: string[], timeoutMs: number, opts?: { cwd?: string }): CommandResult {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    cwd: opts?.cwd,
  });
  const label = `${command} ${args.join(" ")}`;
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT")
      return { ok: false, missing: false, error: `\`${label}\` timed out after ${timeoutMs / 1000}s` };
    return { ok: false, missing: code === "ENOENT", error: `\`${label}\` could not run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit code ${result.status}`;
    return { ok: false, missing: false, error: `\`${label}\` failed: ${detail}` };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

export function skipped(harness: PluginUpgradeEntry["harness"], message: string): PluginUpgradeEntry {
  return { harness, outcome: "skipped", message };
}

export function failed(harness: PluginUpgradeEntry["harness"], message: string): PluginUpgradeEntry {
  return { harness, outcome: "failed", message };
}

export function channelWriteFailure(
  harness: PluginUpgradeEntry["harness"],
  error: unknown,
  before: NonNullable<PluginUpgradeEntry["channel"]>,
): PluginUpgradeEntry {
  return {
    ...failed(harness, String(error)),
    channel: error instanceof ChannelWriteError && error.writtenFiles.length ? "unknown" : before,
    ...(error instanceof ChannelWriteError ? { backups: error.backups } : {}),
  };
}

/** An entry for a refresh that ran: `updated` when the installed version moved, else `current`. */
export function refreshed(harness: PluginUpgradeEntry["harness"], from: string | undefined, to: string | undefined) {
  const moved = from !== undefined && to !== undefined && from !== to;
  return { harness, outcome: moved ? "updated" : "current", from, to } as PluginUpgradeEntry;
}
