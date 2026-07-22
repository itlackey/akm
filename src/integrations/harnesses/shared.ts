// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared per-harness helpers (§4.6 dedup, WI-9.3).
 *
 * Home for the small helpers every per-harness module used to inline:
 * `caps()` (×10 byte-identical copies across the harness barrels) and
 * `homeDir()` (×2 across the config importers).
 *
 * This module is a dependency SINK by design: it must not import from
 * `./types`, `./index.ts`, or any per-harness barrel — those files sit
 * inside the harness/agent import cycle the cycle ratchet is dismantling,
 * and an edge back into that knot would enlist this file as a new cycle
 * participant. `HarnessCapabilities` therefore LIVES here; `./types`
 * re-exports it so existing import sites keep working unchanged.
 */

/**
 * The four capability flags that vary independently of `sessionLogs` (which
 * is split out below into a discriminant — see {@link HarnessCapabilities}).
 */
interface HarnessCapabilityFlags {
  /** Can be spawned as an agent CLI / SDK (`akm propose`, reflect, tasks). */
  readonly agentDispatch: boolean;
  /** Participates in PATH/env detection during `akm setup`. */
  readonly detection: boolean;
  /** Can import an existing harness LLM/config into akm config. */
  readonly configImport: boolean;
  /** Reports a runtime identity string for workflow run attribution. */
  readonly runtimeIdentity: boolean;
}

/**
 * Capability flags describing which of akm's six integration surfaces a
 * harness participates in. A subsystem filters `HARNESS_REGISTRY` by the
 * relevant flag instead of maintaining its own list.
 *
 * `sessionLogs` is a discriminant (WI-9.7, H1): a plain `boolean` field here
 * used to let a harness declare `sessionLogs: true` with no
 * `sessionLogProvider`, caught only by a load-time throw in
 * `session-logs/index.ts`. Splitting this into a two-member union — each
 * member pinning `sessionLogs` to a literal `true`/`false` — lets
 * `./types.ts` discriminate `AkmHarness` on this field so a `true` harness is
 * REQUIRED to carry a `sessionLogProvider` at compile time; see
 * `SessionLogCapableHarness` / `NonSessionLogHarness` there.
 */
export type HarnessCapabilities =
  | (HarnessCapabilityFlags & { readonly sessionLogs: true })
  | (HarnessCapabilityFlags & { readonly sessionLogs: false });

/**
 * Build a complete {@link HarnessCapabilities} record from the flags a
 * harness actually declares — every omitted surface defaults to `false`.
 *
 * Overloaded (rather than generic) so the two call shapes every harness
 * literal already uses — `caps({ sessionLogs: true, ... })` and
 * `caps({ ...without sessionLogs... })` — resolve to the precise union
 * member instead of the widened `HarnessCapabilities` union, which is what
 * lets `./types.ts`'s discriminated `AkmHarness` union narrow on a harness's
 * `capabilities` field without any `as const`/cast at the call site.
 */
export function caps(
  c: Partial<HarnessCapabilityFlags> & { sessionLogs: true },
): Extract<HarnessCapabilities, { sessionLogs: true }>;
export function caps(
  c: Partial<HarnessCapabilityFlags> & { sessionLogs?: false },
): Extract<HarnessCapabilities, { sessionLogs: false }>;
export function caps(c: Partial<HarnessCapabilityFlags> & { sessionLogs?: boolean }): HarnessCapabilities {
  return {
    sessionLogs: false,
    agentDispatch: false,
    detection: false,
    configImport: false,
    runtimeIdentity: false,
    ...c,
  } as HarnessCapabilities;
}

/** Home directory used for filesystem-only harness config detection. */
export function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

// ── Harness config-import contract (chunk 9 WI-9.8 KILL 8) ─────────────────
//
// `HarnessLLMConfig`/`HarnessConfigImporter` used to live in
// `setup/harness-config-import.ts`, which imports the per-harness importers
// (`claude/config-import.ts`, `opencode/config-import.ts`) BY VALUE to build
// `HARNESS_CONFIG_IMPORTERS`. Those importer modules, in turn, needed the
// `HarnessConfigImporter` TYPE to annotate their exported importer object —
// a type-only import back into `harness-config-import.ts` that still formed
// a 3-file static-graph cycle (import type does not sever a cycle; only
// moving the type does). Both types have zero external type deps, so they
// live here — this module is a dependency SINK (see the file-level doc
// comment above) — instead of a separate leaf. `harness-config-import.ts`
// re-exports both so existing import sites are unaffected.

/**
 * LLM/provider config extracted from an agent harness.
 * API key VALUES are never stored — only env var names.
 */
export interface HarnessLLMConfig {
  /** Human-readable source label, e.g. "Claude Code" */
  harnessName: string;
  /** Provider identifier, e.g. "anthropic", "openai" */
  provider?: string;
  /** Model identifier, e.g. "claude-sonnet-4-5" */
  model?: string;
  /** Base URL for the provider API */
  baseUrl?: string;
  /** Env var name (not value) that holds the API key */
  apiKeyEnvVar?: string;
  /** Additional detected models available from this harness */
  extraModels?: string[];
}

/**
 * A pluggable harness config importer.
 *
 * Importers are pure filesystem readers — no network calls, no side effects.
 */
export interface HarnessConfigImporter {
  /** Display name shown to user, e.g. "Claude Code" */
  harnessName: string;
  /**
   * Check if this harness is installed.
   * Must be fast: filesystem stat only, no network.
   */
  detect: () => boolean;
  /**
   * Read and parse harness config.
   * Returns `null` when config is absent or unreadable.
   */
  importConfig: () => HarnessLLMConfig | null;
}
