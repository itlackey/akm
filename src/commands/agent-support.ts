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

import { loadConfig } from "../core/config";
import {
  type AgentConfig,
  type AgentFailureReason,
  type AgentProfile,
  type AgentRunResult,
  requireAgentProfile,
} from "../integrations/agent";

// ── Config helpers ───────────────────────────────────────────────────────────

/**
 * Load the loaded AkmConfig from disk.
 *
 * After 0.8.0, the legacy `agent` top-level block was removed — the agent
 * profile data now lives on the unified `AkmConfig` (via `profiles.agent` and
 * `defaults.agent`). This helper remains for source-compat with callers that
 * still expect an "AgentConfig"; it now returns the loaded `AkmConfig`.
 */
export function loadAgentConfigFromDisk(): AgentConfig | undefined {
  return loadConfig();
}

/**
 * Resolve the agent profile for a command's options.
 * Prefers an injected `agentProfile` (test seam) over the on-disk config.
 */
export function resolveAgentProfile(options: {
  agentProfile?: AgentProfile;
  agentConfig?: AgentConfig;
  profile?: string;
}): AgentProfile {
  if (options.agentProfile) return options.agentProfile;
  const agent = options.agentConfig ?? loadAgentConfigFromDisk();
  return requireAgentProfile(agent, options.profile);
}

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
