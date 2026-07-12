// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared helpers for agent-based commands (reflect, propose, etc.).
 *
 * Consolidates utility functions that were duplicated byte-for-byte across
 * `reflect.ts` and `propose.ts`. Any command that shells out to an agent
 * profile can import from here rather than copy-pasting.
 */

import type { AgentFailureReason, AgentRunResult } from "../../integrations/agent";

// ── Failure helpers ──────────────────────────────────────────────────────────

/**
 * Base failure envelope shared by all agent command failures.
 * Each command returns its own typed failure shape — this helper builds the
 * common fields so per-command wrappers only need to add their own fields.
 */
export function baseFailureFields(
  result: AgentRunResult,
  fallbackReason: AgentFailureReason = "non_zero_exit",
): {
  schemaVersion: 1;
  ok: false;
  reason: AgentFailureReason;
  error: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
} {
  const reason = result.reason ?? fallbackReason;
  return {
    schemaVersion: 1,
    ok: false,
    reason,
    error: result.error ?? `agent failure (${reason})`,
    exitCode: result.exitCode,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
}

// ── ENOENT hint ──────────────────────────────────────────────────────────────

/**
 * Return `true` when a failed agent result looks like the binary was not found
 * on PATH. Used to surface a better error message pointing the user at
 * `akm setup`.
 */
export function isEnoentFailure(result: AgentRunResult): boolean {
  return (
    result.reason === "spawn_failed" &&
    (!!result.error?.includes("ENOENT") || !!result.error?.toLowerCase().includes("not found"))
  );
}

/**
 * Build an actionable error message for a spawn-ENOENT failure.
 */
export function enoentHintMessage(binName: string): string {
  return `The agent binary '${binName}' was not found on PATH. Run \`akm setup\` to configure an agent CLI, or install ${binName} and retry.`;
}
