// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Single registration point for every akm agent harness (#562, #1095).
 *
 * `HARNESS_REGISTRY` is the ONE source of truth. Each harness is a
 * self-contained folder (`./<id>/index.ts`) exporting its descriptor; the
 * config schema's platform enum, the built-in agent profiles, command
 * builders, setup choices and the docs table all derive from the array below.
 *
 * Adding a harness: create `./<id>/index.ts`, add its class here. Removing:
 * delete both. This module must stay free of runtime `core/config` imports
 * (config derives `VALID_HARNESS_IDS` from here), so a harness's heavy runner
 * (e.g. `opencode-sdk/sdk-runner.ts`) is imported by its caller, not here.
 */
import { AiderHarness } from "./aider";
import { AmazonqHarness } from "./amazonq";
import { ClaudeHarness } from "./claude";
import { CodexHarness } from "./codex";
import { CopilotHarness } from "./copilot";
import { GeminiHarness } from "./gemini";
import { OpencodeHarness } from "./opencode";
import { OpencodeSdkHarness } from "./opencode-sdk";
import { OpenhandsHarness } from "./openhands";
import { PiHarness } from "./pi";
import type { AkmHarness } from "./types";
import { isSessionLogHarness } from "./types";

export type { AkmHarness, HarnessCapabilities, NonSessionLogHarness, SessionLogCapableHarness } from "./types";
export { isSessionLogHarness } from "./types";

/**
 * The single registration point.
 *
 * Typed `as const` (not `AkmHarness[]`) so each entry keeps its literal `id`,
 * which lets `VALID_HARNESS_IDS` stay a literal tuple — `HarnessId`,
 * `z.enum(...)`, and the `platform` union all need the literal types.
 */
// Order is significant: VALID_HARNESS_IDS derives from this array and feeds the
// committed JSON-schema enum order. The original [opencode, claude,
// opencode-sdk] prefix is preserved so the pre-unification portion of the
// generated schema enum does not reorder; the seven P2 harness adapters are
// appended after it, which extends the enum additively (schemas/akm-config.json
// is regenerated in lockstep).
export const HARNESS_REGISTRY = Object.freeze([
  new OpencodeHarness(),
  new ClaudeHarness(),
  new OpencodeSdkHarness(),
  new CodexHarness(),
  new CopilotHarness(),
  new PiHarness(),
  new GeminiHarness(),
  new AiderHarness(),
  new AmazonqHarness(),
  new OpenhandsHarness(),
] as const) satisfies readonly AkmHarness[];

/** Lookup by the one supported harness id. */
export const HARNESS_BY_ID: ReadonlyMap<string, AkmHarness> = new Map(HARNESS_REGISTRY.map((h) => [h.id, h]));

/**
 * Canonical, ordered list of valid harness / platform ids. The Zod
 * `AgentPlatformSchema` enum, the agent-engine platform union, and
 * setup's `DetectedHarness` union all derive from this so they cannot drift.
 */
export const VALID_HARNESS_IDS = Object.freeze(HARNESS_REGISTRY.map((h) => h.id)) as unknown as readonly [
  (typeof HARNESS_REGISTRY)[number]["id"],
  ...(typeof HARNESS_REGISTRY)[number]["id"][],
];

/**
 * Harnesses that expose readable native session logs. Narrowed via the
 * {@link isSessionLogHarness} type-predicate (rather than a plain boolean
 * callback) so `sessionLogProvider` is known-present on every element — see
 * that function's doc comment for why a plain predicate doesn't narrow here.
 */
export const SESSION_LOG_HARNESSES = HARNESS_REGISTRY.filter(isSessionLogHarness);
/** Harnesses that can be dispatched as an agent CLI / SDK. */
export const AGENT_DISPATCH_HARNESSES = HARNESS_REGISTRY.filter((h) => h.capabilities.agentDispatch);

const idsWith = (flag: (h: AkmHarness) => boolean): ReadonlySet<string> =>
  new Set(HARNESS_REGISTRY.filter(flag).map((h) => h.id));

/** Harness ids whose `capabilities.agentDispatch` is `true`. */
export const HARNESS_AGENT_DISPATCH_IDS = idsWith((h) => h.capabilities.agentDispatch);
/** Harness ids that confine the model-work tool policy, so unattended model work may run on them. */
export const HARNESS_MODEL_WORK_IDS = idsWith((h) => h.capabilities.modelWork);
/** Harness ids that can run a named native agent, so an engine may name a default `agent`. */
export const HARNESS_NATIVE_AGENT_IDS = idsWith((h) => h.capabilities.nativeAgent);

/**
 * Resolve an exact harness id to its descriptor, or `undefined` if unknown.
 */
export function getHarness(id: string): AkmHarness | undefined {
  return HARNESS_BY_ID.get(id);
}

/**
 * Default agent-profile name for a detected harness id (#566).
 *
 * Used by `akm setup`'s headless/recommended-config path so a newly added
 * dispatch-capable harness gets a usable default profile name (its canonical
 * id) instead of falling through a hardcoded if-chain with no default. Returns
 * `undefined` for `"none"` or any id that is unknown / not agent-dispatch
 * capable.
 */
export function defaultProfileName(detected: string): string | undefined {
  const h = HARNESS_BY_ID.get(detected);
  if (!h?.capabilities.agentDispatch) return undefined;
  return h.id;
}
