// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SessionLogHarness } from "../session-logs/types";
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
 * (e.g. `opencode/embedded/run.ts`) is imported when it runs, not here.
 */
import { AiderHarness } from "./aider";
import { AmazonqHarness } from "./amazonq";
import { ClaudeHarness } from "./claude";
import { CodexHarness } from "./codex";
import { CopilotHarness } from "./copilot";
import { GeminiHarness } from "./gemini";
import type { AkmHarness } from "./harness";
import { OpencodeHarness } from "./opencode";
import { OpenhandsHarness } from "./openhands";
import { PiHarness } from "./pi";

export type { AkmHarness } from "./harness";

/**
 * The registered harnesses, with each entry keeping its literal `id` so that
 * `VALID_HARNESS_IDS` can stay a literal tuple (`HarnessId`, `z.enum(...)` and
 * the `platform` union all need the literal types).
 */
// Order is significant: VALID_HARNESS_IDS derives from this array and feeds the
// committed JSON-schema enum order. The original [opencode, claude] prefix is
// preserved so the pre-unification portion of the generated schema enum does not
// reorder; the seven P2 harness adapters are appended after it, which extends the
// enum additively (schemas/akm-config.json is regenerated in lockstep).
const REGISTERED = [
  new OpencodeHarness(),
  new ClaudeHarness(),
  new CodexHarness(),
  new CopilotHarness(),
  new PiHarness(),
  new GeminiHarness(),
  new AiderHarness(),
  new AmazonqHarness(),
  new OpenhandsHarness(),
] as const;

/** The single registration point. */
export const HARNESS_REGISTRY: readonly AkmHarness[] = Object.freeze([...REGISTERED]);

/** Lookup by the one supported harness id. */
export const HARNESS_BY_ID: ReadonlyMap<string, AkmHarness> = new Map(HARNESS_REGISTRY.map((h) => [h.id, h]));

/**
 * Canonical, ordered list of valid harness / platform ids. The Zod
 * `AgentPlatformSchema` enum, the agent-engine platform union, and
 * setup's `DetectedHarness` union all derive from this so they cannot drift.
 */
export const VALID_HARNESS_IDS = Object.freeze(REGISTERED.map((h) => h.id)) as unknown as readonly [
  (typeof REGISTERED)[number]["id"],
  ...(typeof REGISTERED)[number]["id"][],
];

/** The platforms a `harnesses` entry may name: every harness in the registry. */
export const HARNESS_CONFIG_PLATFORMS = VALID_HARNESS_IDS;

type SessionLogCapable = AkmHarness & { readonly sessionLogProvider: () => SessionLogHarness };

/** Harnesses that expose readable native session logs. */
export const SESSION_LOG_HARNESSES: readonly SessionLogCapable[] = HARNESS_REGISTRY.filter(
  (h): h is SessionLogCapable => h.sessionLogProvider !== undefined,
);

/** Harness ids that can run a named native agent, so a harness may name a default `agent`. */
export const HARNESS_NATIVE_AGENT_IDS: ReadonlySet<string> = new Set(
  HARNESS_REGISTRY.filter((h) => h.nativeAgent).map((h) => h.id),
);

/**
 * Resolve an exact harness id to its descriptor, or `undefined` if unknown.
 */
export function getHarness(id: string): AkmHarness | undefined {
  return HARNESS_BY_ID.get(id);
}
