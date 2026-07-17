// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Dependency-free harness-id + agent-dispatch-capability table (WI-9.8 KILL 3
 * — the config↔harness-barrel import cycle, plan §10.7 D.3 edge B).
 *
 * `core/config/config-types.ts` (and, through it, `config-schema.ts`) needs
 * two small, DATA-shaped facts about the harness registry: the canonical
 * ordered id list (for the `HarnessId` union / Zod enum) and which ids
 * support agent dispatch (for the `AgentEngineSchema` platform refinement).
 * Importing `./index.ts` (`HARNESS_REGISTRY`) for that would pull in every
 * harness's agent-builder + result-extractor and, transitively, the whole
 * agent runtime (`integrations/agent/builder-shared.ts` and friends) — which
 * is how config ended up fused into the same import-cycle SCC as the agent
 * runtime. This table is the canonical, dependency-free MIRROR of that
 * subset; `./index.ts`'s `HARNESS_REGISTRY` construction asserts its entries
 * match this table (id, order, and agentDispatch) at module-load time, so the
 * two can never silently drift without a loud failure.
 *
 * Order matches `HARNESS_REGISTRY` exactly (plan §562: the original
 * [opencode, claude, opencode-sdk] prefix, then the seven P2 adapters) —
 * `VALID_HARNESS_IDS` feeds the committed JSON-schema enum order.
 */

export interface HarnessIdEntry {
  /** Canonical harness id (matches `AkmHarness.id`). */
  readonly id: string;
  /** Mirrors `AkmHarness.capabilities.agentDispatch`. */
  readonly agentDispatch: boolean;
}

export const HARNESS_ID_TABLE: readonly HarnessIdEntry[] = [
  { id: "opencode", agentDispatch: true },
  { id: "claude", agentDispatch: true },
  { id: "opencode-sdk", agentDispatch: true },
  { id: "codex", agentDispatch: true },
  { id: "copilot", agentDispatch: true },
  { id: "pi", agentDispatch: true },
  { id: "gemini", agentDispatch: true },
  { id: "aider", agentDispatch: true },
  { id: "amazonq", agentDispatch: true },
  { id: "openhands", agentDispatch: true },
] as const;

/**
 * Canonical, ordered list of valid harness / platform ids — the
 * dependency-free counterpart of `./index.ts`'s `VALID_HARNESS_IDS` (which
 * remains the barrel's own derivation for its own consumers). Both are
 * asserted equal at `HARNESS_REGISTRY` construction time.
 */
export const VALID_HARNESS_IDS = Object.freeze(HARNESS_ID_TABLE.map((h) => h.id)) as unknown as readonly [
  (typeof HARNESS_ID_TABLE)[number]["id"],
  ...(typeof HARNESS_ID_TABLE)[number]["id"][],
];

/** Harness ids whose `capabilities.agentDispatch` is `true`. */
export const HARNESS_AGENT_DISPATCH_IDS: ReadonlySet<string> = new Set(
  HARNESS_ID_TABLE.filter((h) => h.agentDispatch).map((h) => h.id),
);
