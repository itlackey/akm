// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolve the invoking harness/session identity for a run from the
 * environment (best-effort, no background work): the harness from
 * `AKM_AGENT_HARNESS`, else a harness session-id env var, else a presence
 * flag; the session id from `AKM_SESSION_ID`, else the harness-native session
 * var (presence flags never supply one). The markers derive from
 * `HARNESS_REGISTRY`. Explicit `startWorkflowRun` values always win.
 */
import { HARNESS_REGISTRY } from "../../integrations/harnesses";

export interface AgentIdentity {
  harness: string | null;
  sessionId: string | null;
}

interface IdentityMarker {
  harnessId: string;
  envKeys: readonly string[];
}

/** A marker table from one registry env-var field, ordered by canonical id (the detection precedence). */
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
    // A harness session id outranks any presence flag (opencode inside a codex sandbox is opencode).
    for (const marker of SESSION_MARKERS) {
      if (firstNonEmpty(env, marker.envKeys)) {
        harness = marker.harnessId;
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
        harness = marker.harnessId;
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
