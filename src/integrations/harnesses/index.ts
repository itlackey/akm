// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Single registration point for every akm agent harness (#562).
 *
 * `HARNESS_REGISTRY` is the ONE source of truth that replaces the three
 * previously-disconnected registries (session-logs index, agent profiles,
 * config/setup platform strings). All derived exports below are computed from
 * it, so adding a harness is a single entry here instead of ~16 scattered edits.
 *
 * This module is a dependency-graph LEAF: it imports nothing from
 * `core/config`. `core/config/config-types.ts` derives `VALID_HARNESS_IDS`
 * from here, which keeps the import direction acyclic (config ← harnesses).
 *
 * Implementations (session-log readers, agent profiles) are migrated under each
 * harness in #563/#564; this step only owns ids + capability membership and
 * wires the existing call sites to consult it (behaviour-preserving).
 */
import { ClaudeHarness } from "./claude";
import { OpencodeHarness } from "./opencode";
import { OpencodeSdkHarness } from "./opencode-sdk";
import type { AkmHarness } from "./types";

export type { AkmHarness, HarnessCapabilities } from "./types";

// Each harness descriptor (ClaudeHarness, OpencodeHarness, OpencodeSdkHarness)
// lives in its own per-harness directory alongside that harness's session-log
// reader, agent builder, config importer, and/or SDK runner (#563/#564). They
// are imported above and registered in HARNESS_REGISTRY below.

/**
 * The single registration point. Add a harness here (and nothing else) to make
 * every derived registry pick it up.
 *
 * Typed `as const` (not `AkmHarness[]`) so each entry keeps its literal `id`,
 * which lets `VALID_HARNESS_IDS` stay a literal tuple — `HarnessId`,
 * `z.enum(...)`, and the `platform` union all need the literal types.
 */
// Order is significant: VALID_HARNESS_IDS derives from this array and feeds the
// committed JSON-schema enum order. Kept as [opencode, claude, opencode-sdk] to
// match the pre-unification VALID_HARNESS_IDS so the generated schema does not
// drift (behaviour-preserving, #562).
export const HARNESS_REGISTRY = Object.freeze([
  new OpencodeHarness(),
  new ClaudeHarness(),
  new OpencodeSdkHarness(),
] as const) satisfies readonly AkmHarness[];

/** Lookup by canonical id. */
export const HARNESS_BY_ID: ReadonlyMap<string, AkmHarness> = new Map(HARNESS_REGISTRY.map((h) => [h.id, h]));

/**
 * Lookup by canonical id OR any alias OR runtime id — the normalization bridge
 * resolver. Both 'claude' and 'claude-code' map to the Claude harness.
 */
const HARNESS_BY_ANY_ID: ReadonlyMap<string, AkmHarness> = (() => {
  const m = new Map<string, AkmHarness>();
  for (const h of HARNESS_REGISTRY as readonly AkmHarness[]) {
    m.set(h.id, h);
    if (h.runtimeId) m.set(h.runtimeId, h);
    for (const a of h.aliases) m.set(a, h);
  }
  return m;
})();

/**
 * Canonical, ordered list of valid harness / platform ids. The Zod
 * `AgentPlatformSchema` enum, the `AgentProfileConfigV2` platform union,
 * `parseAgentProfilesMapV2`'s membership check, and setup's `DetectedHarness`
 * union all derive from this so they cannot drift.
 */
export const VALID_HARNESS_IDS = Object.freeze(HARNESS_REGISTRY.map((h) => h.id)) as unknown as readonly [
  (typeof HARNESS_REGISTRY)[number]["id"],
  ...(typeof HARNESS_REGISTRY)[number]["id"][],
];

/** Harnesses that expose readable native session logs. */
export const SESSION_LOG_HARNESSES = HARNESS_REGISTRY.filter((h) => h.capabilities.sessionLogs);
/** Harnesses that can be dispatched as an agent CLI / SDK. */
export const AGENT_DISPATCH_HARNESSES = HARNESS_REGISTRY.filter((h) => h.capabilities.agentDispatch);
/** Harnesses that can import an existing harness config into akm. */
export const CONFIG_IMPORTER_HARNESSES = HARNESS_REGISTRY.filter((h) => h.capabilities.configImport);
/** Harnesses that participate in `akm setup` detection. */
export const DETECTION_HARNESSES = HARNESS_REGISTRY.filter((h) => h.capabilities.detection);

/**
 * Resolve any id form (canonical id, alias, or runtime id) to the harness
 * descriptor, or `undefined` if unknown.
 */
export function getHarness(id: string): AkmHarness | undefined {
  return HARNESS_BY_ANY_ID.get(id);
}

/**
 * id normalization bridge — alias → canonical.
 *
 * Maps any known alias/runtime id to its canonical persisted id (e.g.
 * 'claude-code' → 'claude'). Unknown ids pass through unchanged so callers can
 * still validate them. This is what keeps existing persisted configs that say
 * 'claude-code' working against the canonical 'claude' registry.
 */
export function normalizeHarnessId(id: string): string {
  return HARNESS_BY_ANY_ID.get(id)?.id ?? id;
}

/**
 * Resolve a legacy v1 agent-profile name to its v2 platform id (#566).
 *
 * v1 agent profiles never carried an explicit `platform`; it had to be inferred
 * from the profile name. This is the SINGLE registry-backed resolver that
 * replaces both the old standalone `guessAgentPlatform()` in config-migration
 * and the `name.includes("claude") ? "claude" : "opencode"` heuristic in setup.
 * Each harness owns its own `matchesV1ProfileName()`; an unknown name matches no
 * harness and returns `undefined`, so the caller drops it instead of silently
 * defaulting to `'opencode'`.
 *
 * Harnesses are consulted most-specific-id-first (longest id wins) so a
 * decorated name like `"opencode-sdk-fast"` resolves to `'opencode-sdk'` rather
 * than being over-matched by OpenCode's `"opencode"` prefix.
 */
const V1_RESOLUTION_ORDER: readonly AkmHarness[] = [...HARNESS_REGISTRY].sort((a, b) => b.id.length - a.id.length);

export function v1ProfilePlatform(name: string): string | undefined {
  for (const h of V1_RESOLUTION_ORDER) {
    if (h.matchesV1ProfileName(name)) return h.id;
  }
  return undefined;
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
  const h = HARNESS_BY_ANY_ID.get(detected);
  if (!h || !h.capabilities.agentDispatch) return undefined;
  return h.id;
}

/**
 * id normalization bridge — canonical → runtime identity.
 *
 * Maps a canonical id to the string a harness reports at runtime / in its
 * session logs (e.g. 'claude' → 'claude-code'). Used by workflow run
 * attribution and the session-logs provider name so the persisted runtime
 * identity stays stable. Falls back to the canonical id when the harness has no
 * distinct runtime identity.
 */
export function denormalizeRuntimeIdentity(id: string): string {
  const h = HARNESS_BY_ANY_ID.get(id);
  return h?.runtimeId ?? h?.id ?? id;
}
