// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolve the agent harness + session identity for the current process.
 *
 * This is the first concrete slice of #501 / #506: capturing *who* is driving a
 * workflow run so a future (separately-approved) monitor can correlate runs
 * with session activity. It deliberately does NOT start any background thread,
 * timer, or daemon — it only reads identity that the surrounding agent harness
 * already exposes via the environment.
 *
 * Resolution is best-effort and environment-driven:
 *   - harness:    AKM_AGENT_HARNESS, else inferred from a known harness env var.
 *   - sessionId:  AKM_SESSION_ID, else the harness-native session env var.
 *
 * Explicit values passed to `startWorkflowRun` always win over the environment.
 *
 * @module workflows/agent-identity
 */

export interface AgentIdentity {
  harness: string | null;
  sessionId: string | null;
}

function firstNonEmpty(env: NodeJS.ProcessEnv, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Best-effort resolution of the agent harness + session id from the process
 * environment. Returns `{ harness: null, sessionId: null }` when nothing is
 * detectable (e.g. a human running the CLI directly).
 */
export function resolveAgentIdentity(env: NodeJS.ProcessEnv = process.env): AgentIdentity {
  // Explicit override always wins.
  let harness = firstNonEmpty(env, ["AKM_AGENT_HARNESS"]);
  if (!harness) {
    // Infer the harness from a harness-specific *session* env var. We only
    // infer when a concrete session id is present: the bare "this process is
    // Claude Code" flag does not mean a given run is owned by an agent session,
    // so it must not silently stamp identity onto manual CLI invocations.
    if (firstNonEmpty(env, ["CLAUDE_SESSION_ID"])) {
      harness = "claude-code";
    } else if (firstNonEmpty(env, ["OPENCODE_SESSION_ID"])) {
      harness = "opencode";
    }
  }

  const sessionId = firstNonEmpty(env, ["AKM_SESSION_ID", "CLAUDE_SESSION_ID", "OPENCODE_SESSION_ID"]);

  return { harness, sessionId };
}
