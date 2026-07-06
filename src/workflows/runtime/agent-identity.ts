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
 *   - harness:    AKM_AGENT_HARNESS, else inferred from a harness session-id
 *                 env var (`identityEnv`), else from a harness presence flag
 *                 (`presenceEnv`).
 *   - sessionId:  AKM_SESSION_ID, else the harness-native session env var.
 *                 Presence flags NEVER contribute a session id — their values
 *                 (`CODEX_SANDBOX=seatbelt`, `GEMINI_CLI=1`) are modes/flags,
 *                 not sessions, and must not be persisted as agent_session_id.
 *
 * Explicit values passed to `startWorkflowRun` always win over the environment.
 *
 * The harness-native markers are DERIVED from `HARNESS_REGISTRY` (plan §"Kill
 * registry drift", P2): each harness declares its session-id env vars via
 * `identityEnv` and its presence-only flags via `presenceEnv`, so adding a
 * harness never touches this module. Only the `AKM_*` explicit-override vars
 * are non-registry (they are akm's own, not any harness's) and stay hardcoded
 * here.
 *
 * @module workflows/agent-identity
 */
import { denormalizeRuntimeIdentity, HARNESS_REGISTRY } from "../../integrations/harnesses";

export interface AgentIdentity {
  harness: string | null;
  sessionId: string | null;
}

interface IdentityMarker {
  harnessId: string;
  envKeys: readonly string[];
}

/**
 * Derive a marker table from one registry env-var field, ordered by canonical
 * id. The sort keeps the pre-derivation precedence byte-identical ('claude'
 * before 'opencode' — the old if/else chain's order) and independent of
 * `HARNESS_REGISTRY` declaration order, which is pinned for JSON-schema enum
 * stability, not detection precedence.
 */
function deriveMarkers(
  pick: (h: (typeof HARNESS_REGISTRY)[number]) => readonly string[] | undefined,
): IdentityMarker[] {
  return HARNESS_REGISTRY.filter((h) => (pick(h)?.length ?? 0) > 0)
    .map((h) => ({ harnessId: h.id, envKeys: pick(h) ?? [] }))
    .sort((a, b) => a.harnessId.localeCompare(b.harnessId));
}

/** Session-id-bearing markers — usable for BOTH harness inference and sessionId. */
const SESSION_MARKERS: readonly IdentityMarker[] = deriveMarkers((h) => h.identityEnv);

/** Presence-only flags — harness inference ONLY; their values are never a session id. */
const PRESENCE_MARKERS: readonly IdentityMarker[] = deriveMarkers((h) => h.presenceEnv);

function firstNonEmpty(env: NodeJS.ProcessEnv, keys: readonly string[]): string | null {
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
    // Infer the harness from a harness-specific *session* env var first
    // (registry `identityEnv` markers). A concrete session id is the
    // strongest evidence of the immediate driver, so it outranks any
    // presence flag — e.g. opencode launched inside a codex sandbox
    // (OPENCODE_SESSION_ID + CODEX_SANDBOX) attributes to opencode.
    for (const marker of SESSION_MARKERS) {
      if (firstNonEmpty(env, marker.envKeys)) {
        // Report the harness's RUNTIME identity (e.g. canonical 'claude' →
        // 'claude-code') via the registry's #562 bridge so the persisted
        // runtime string can't drift.
        harness = denormalizeRuntimeIdentity(marker.harnessId);
        break;
      }
    }
  }
  if (!harness) {
    // Fall back to presence-only flags (registry `presenceEnv`). These are
    // stamped by the harness on its OWN child processes (CODEX_SANDBOX,
    // GEMINI_CLI=1), so they cannot mis-attribute manual CLI invocations —
    // but they carry no session id, so sessionId stays null below.
    for (const marker of PRESENCE_MARKERS) {
      if (firstNonEmpty(env, marker.envKeys)) {
        harness = denormalizeRuntimeIdentity(marker.harnessId);
        break;
      }
    }
  }

  // Session id: the explicit AKM override first, then the session-id-bearing
  // registry markers in the same precedence order as harness inference (so
  // harness and session id agree when multiple harness env vars are present).
  // Presence flags are deliberately excluded — their values are not sessions.
  const sessionId = firstNonEmpty(env, ["AKM_SESSION_ID", ...SESSION_MARKERS.flatMap((m) => [...m.envKeys])]);

  return { harness, sessionId };
}
