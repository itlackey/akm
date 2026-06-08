// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unified harness descriptor (#562).
 *
 * Before this module, adding a new agent harness to akm required edits to ~16
 * locations across 10+ files, kept in sync by hand across three disconnected
 * registries:
 *
 *   - session-logs index   (`src/integrations/session-logs/index.ts`)
 *   - agent profiles        (`src/integrations/agent/profiles.ts`)
 *   - config/setup platform strings (`config-schema.ts`, `config-types.ts`, ...)
 *
 * `AkmHarness` collapses those into ONE descriptor per harness. The
 * `HARNESS_REGISTRY` array in `./index.ts` is the single registration point;
 * every subsystem derives its membership from the capability flags here.
 *
 * This issue (#562) is ADDITIVE scaffolding: the registry is the source of
 * truth for *ids and capability membership*, and existing call sites are wired
 * to derive from / validate against it. The concrete session-log / agent
 * implementations are migrated under each harness in #563/#564.
 */

/**
 * Capability flags describing which of akm's six integration surfaces a
 * harness participates in. A subsystem filters `HARNESS_REGISTRY` by the
 * relevant flag instead of maintaining its own list.
 */
export interface HarnessCapabilities {
  /** Has readable native session logs (`akm extract`, session-logs index). */
  readonly sessionLogs: boolean;
  /** Can be spawned as an agent CLI / SDK (`akm propose`, reflect, tasks). */
  readonly agentDispatch: boolean;
  /** Participates in PATH/env detection during `akm setup`. */
  readonly detection: boolean;
  /** Can import an existing harness LLM/config into akm config. */
  readonly configImport: boolean;
  /** Reports a runtime identity string for workflow run attribution. */
  readonly runtimeIdentity: boolean;
  /** Has a v1→v2 config-migration mapping for legacy profile names. */
  readonly v1Migration: boolean;
}

/**
 * A single harness's identity + capability membership.
 *
 * `id` is the canonical, persisted identifier (what new config writes use).
 * `aliases` are alternate identifiers that MUST keep round-tripping for
 * already-persisted configs and session logs — see the Claude Code split
 * below.
 *
 * ## id normalization bridge ('claude' vs 'claude-code')
 *
 * Claude Code has historically been persisted under two different id strings:
 *   - `'claude'`      — agent runner, agent profiles, Zod config schema
 *   - `'claude-code'` — session-logs provider name, runtime identity string
 *
 * The canonical id is `'claude'`; `'claude-code'` is registered as an alias so
 * that BOTH directions resolve to the same harness. `normalizeHarnessId()` and
 * `denormalizeRuntimeIdentity()` in `./index.ts` implement the bridge. Existing
 * user config and session-log discovery keep working unchanged.
 */
export interface AkmHarness {
  /** Canonical, persisted id (the value new config writes). */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /**
   * Alternate ids that must continue to resolve to this harness for
   * already-persisted configs / session logs. Never written for new config.
   */
  readonly aliases: readonly string[];
  /**
   * Identity string reported at runtime / in session logs, when it differs
   * from the canonical `id`. Used by workflow run attribution and the
   * session-logs provider name. Absent ⇒ same as `id`.
   */
  readonly runtimeId?: string;
  /**
   * Home-relative config directory that `akm setup` scans to offer this
   * harness as a stash source (#567). e.g. `.claude`, `.config/opencode`.
   *
   * Only harnesses that ALSO have `capabilities.sessionLogs === true` are
   * offered as setup stash-source candidates — selecting a harness with no
   * session-log provider would be a silent no-op (the old `AGENT_PLATFORMS`
   * trap that listed Continue/Codeium/Cursor/Codex CLI). `detectAgentPlatforms`
   * derives its candidate list from `SESSION_LOG_HARNESSES` that declare this
   * field, so the registry is the single source of which harnesses are real
   * stash sources. Absent ⇒ not offered during setup.
   */
  readonly setupDetectionDir?: string;
  /** Capability membership — which subsystems include this harness. */
  readonly capabilities: HarnessCapabilities;

  /**
   * Does a legacy v1 agent-profile name belong to this harness? (#566)
   *
   * v1 agent profiles never carried an explicit `platform`; the platform was
   * inferred from the profile name. This method is the per-harness owner of
   * that inference, consulted by `v1ProfilePlatform()` in `./index.ts` during
   * v1→v2 config migration AND by `akm setup`'s legacy-agent apply.
   *
   * The default implementation in {@link BaseHarness} matches the canonical id
   * and every alias case-insensitively, plus any `v1ProfilePrefixes` for
   * decorated names (e.g. `"opencode-sdk-fast"`). A harness only participates
   * when `capabilities.v1Migration` is true.
   */
  matchesV1ProfileName(name: string): boolean;
}

/**
 * Shared base for harness descriptors (#566).
 *
 * Provides the default v1-profile-name matcher so the inference logic lives in
 * ONE place instead of being duplicated across the old `guessAgentPlatform()`
 * (config-migration) and the `name.includes("claude")` heuristic (setup). A
 * concrete harness sets `id`/`aliases`/`capabilities` and, when its v1 profile
 * names could be decorated (e.g. `"opencode-sdk-fast"`), `v1ProfilePrefixes`.
 */
export abstract class BaseHarness implements AkmHarness {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly aliases: readonly string[];
  abstract readonly capabilities: HarnessCapabilities;
  readonly runtimeId?: string;
  readonly setupDetectionDir?: string;

  /**
   * Lowercase prefixes that a decorated v1 profile name may start with and
   * still belong to this harness (e.g. `["opencode-sdk"]`). The canonical id
   * and aliases are always matched in addition to these; an empty list means
   * only exact id/alias matches.
   */
  protected readonly v1ProfilePrefixes: readonly string[] = [];

  matchesV1ProfileName(name: string): boolean {
    // Only harnesses with a v1→v2 mapping participate; others never claim a
    // legacy profile name (so unknown names are dropped, not misclassified).
    if (!this.capabilities.v1Migration) return false;
    const lower = name.trim().toLowerCase();
    if (!lower) return false;
    if (lower === this.id.toLowerCase()) return true;
    for (const alias of this.aliases) {
      if (lower === alias.toLowerCase()) return true;
    }
    for (const prefix of this.v1ProfilePrefixes) {
      if (lower.startsWith(prefix.toLowerCase())) return true;
    }
    return false;
  }
}
