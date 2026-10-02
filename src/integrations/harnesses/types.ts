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

import type { AgentCommandBuilder, AgentRequestLowerer, AgentResultExtractor } from "../agent/builder-shared";
import type { SessionLogHarness } from "../session-logs/types";
import type { HarnessCapabilities } from "./shared";

// `HarnessCapabilities` lives in `./shared` (a cycle-free dependency sink —
// see that module's doc comment) and is re-exported here so this file stays
// the interface home for existing import sites.
export type { HarnessCapabilities } from "./shared";

/**
 * Fields every harness descriptor carries regardless of its `sessionLogs`
 * capability. Split out of `AkmHarness` so the capability-discriminated
 * `sessionLogProvider` field (see {@link AkmHarness}) can be added per-branch
 * without repeating the rest of the descriptor twice.
 */
interface AkmHarnessCommon {
  /** The only config, dispatch, runtime-attribution, and session-log id. */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName: string;
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
   * stash sources. Absent ⇒ not offered during setup. NOTE: this field is
   * NOT tied to `capabilities.sessionLogs` by the type system — a harness
   * declaring both is a registry-level convention, pinned by
   * `tests/harnesses-registry.test.ts`, not a compile-time invariant.
   */
  readonly setupDetectionDir?: string;

  /**
   * The harness-owned agent command builder, when dispatch goes through the
   * CLI spawn path. `BUILTIN_BUILDERS` in `agent/builders.ts` is DERIVED from
   * this field so the
   * builder registry cannot drift from the harness registry. Absent for
   * harnesses that dispatch without argv construction (opencode-sdk) — and
   * for dispatch-capable CLIs that do not have a dedicated builder yet, in
   * which case dispatch fails loudly rather than falling back to a
   * wrong-flag-shape default (see `getCommandBuilder`).
   */
  readonly agentBuilder?: AgentCommandBuilder;

  /** Resolved-request lowering for non-argv transports such as OpenCode SDK. */
  readonly executionLowerer?: AgentRequestLowerer;

  /**
   * Env vars that carry this harness's *session id* when a process runs under
   * it (e.g. `CLAUDE_SESSION_ID`). The workflow runtime's agent-identity
   * detection (`src/workflows/runtime/agent-identity.ts`) is DERIVED from
   * these markers, so a new harness only registers here — never in a parallel
   * if/else chain. Only session-id-bearing vars belong here: the VALUE of the
   * first matching var is persisted as `workflow_runs.agent_session_id`, so a
   * bare "this-harness-is-present" flag would journal a fake session id (and
   * stamp identity onto manual runs). Presence-only flags belong in
   * {@link presenceEnv}.
   */
  readonly identityEnv?: readonly string[];

  /**
   * Env vars whose mere PRESENCE indicates "this process runs under this
   * harness" without carrying a session id (e.g. `CODEX_SANDBOX=seatbelt`,
   * `GEMINI_CLI=1`). Used ONLY to infer the harness for run attribution —
   * their values are never recorded as a session id, and a concrete
   * `identityEnv` session id (from any harness) outranks presence inference.
   * Only vars the harness stamps on its OWN child processes belong here;
   * user-profile config vars (e.g. `CODEX_HOME`, commonly exported in shell
   * profiles) would stamp identity onto manual runs and must not be
   * registered.
   */
  readonly presenceEnv?: readonly string[];

  /**
   * Harness-owned result extractor: normalizes a raw `AgentRunResult` into
   * `{ text, sessionId? }` before schema validation (plan §"The adapter
   * contract" step 3). Absent ⇒ the engine uses the raw stdout as text.
   */
  readonly resultExtractor?: AgentResultExtractor;
}

/**
 * A harness that declares `capabilities.sessionLogs: true`. Its
 * `sessionLogProvider` factory is REQUIRED — a harness cannot claim the
 * capability without supplying the provider that backs it. This is the
 * compile-time replacement for the load-time throw formerly in
 * `src/integrations/session-logs/index.ts` (WI-9.7, H1): omitting
 * `sessionLogProvider` while `sessionLogs: true` is now a type error at the
 * `HARNESS_REGISTRY` declaration, not a thrown error at import time.
 */
export interface SessionLogCapableHarness extends AkmHarnessCommon {
  readonly capabilities: Extract<HarnessCapabilities, { sessionLogs: true }>;
  /**
   * Factory for this harness's session-log provider. The session-logs index
   * (`src/integrations/session-logs/index.ts`) DERIVES its provider array
   * from this field, so the provider list cannot drift from the registry.
   */
  readonly sessionLogProvider: () => SessionLogHarness;
}

/**
 * A harness that declares `capabilities.sessionLogs: false`. It carries no
 * `sessionLogProvider` — the field is typed `undefined`-only so a harness
 * cannot silently carry a provider nobody derives from (the mirror of
 * {@link SessionLogCapableHarness}'s requirement).
 */
export interface NonSessionLogHarness extends AkmHarnessCommon {
  readonly capabilities: Extract<HarnessCapabilities, { sessionLogs: false }>;
  readonly sessionLogProvider?: undefined;
}

/**
 * A single harness's identity + capability membership.
 *
 * Discriminated on `capabilities.sessionLogs` (WI-9.7, H1): the union forces
 * `sessionLogProvider` to be present exactly when `sessionLogs` is `true`, so
 * the pairing is a compile error to get wrong rather than a load-time throw.
 * See {@link SessionLogCapableHarness} / {@link NonSessionLogHarness}.
 */
export type AkmHarness = SessionLogCapableHarness | NonSessionLogHarness;

/**
 * Type-guard narrowing a harness to {@link SessionLogCapableHarness}.
 *
 * `Array.prototype.filter`'s type-predicate overload requires the predicate's
 * inferred type to extend the array's element type — a plain
 * `(h: AkmHarness) => h is SessionLogCapableHarness` predicate fails that
 * constraint against `HARNESS_REGISTRY`'s element type (the union of the ten
 * concrete harness classes, each with literal `id`s narrower than
 * `SessionLogCapableHarness`'s `id: string`), so `.filter` would silently fall
 * back to its non-narrowing overload. Generic over the input `H` and
 * intersecting it into the predicate (`H & SessionLogCapableHarness`) keeps
 * the result always a subtype of `H`, so the constraint holds regardless of
 * what concrete harness type(s) `H` resolves to — this is what lets
 * `HARNESS_REGISTRY.filter(isSessionLogHarness)` (in `./index.ts`) actually
 * narrow to a type where `sessionLogProvider` is known-present, retiring the
 * load-time throw that used to guard this in `session-logs/index.ts`.
 */
export function isSessionLogHarness<H extends AkmHarness>(h: H): h is H & SessionLogCapableHarness {
  return h.capabilities.sessionLogs;
}

/**
 * Shared base for harness descriptors (#566).
 *
 * Provides shared optional descriptor fields for concrete harnesses.
 *
 * Deliberately implements {@link AkmHarnessCommon}, NOT the discriminated
 * `AkmHarness` union (WI-9.7, H1): `AkmHarnessCommon` excludes `capabilities`
 * and `sessionLogProvider`, the two fields whose pairing the union enforces.
 * A base class shared by both branches cannot itself satisfy either specific
 * union member — `capabilities` stays declared `abstract` at the (widened)
 * `HarnessCapabilities` union type here, and each subclass narrows it to a
 * literal `sessionLogs: true`/`false` variant via `caps({...})`.
 * `sessionLogProvider` is intentionally NOT declared here at all (not even
 * optional): the 8 non-session-log subclasses simply never declare it, which
 * satisfies `NonSessionLogHarness`'s `sessionLogProvider?: undefined` (an
 * absent optional property satisfies an `undefined`-typed optional); had this
 * class declared it as `sessionLogProvider?: () => SessionLogHarness`
 * instead, every non-session-log subclass would inherit that (function |
 * undefined) type and fail to satisfy `NonSessionLogHarness` at the
 * `HARNESS_REGISTRY` `satisfies` check. The two session-log subclasses
 * (Claude, OpenCode) declare their own required `sessionLogProvider`.
 */
export abstract class BaseHarness implements AkmHarnessCommon {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: HarnessCapabilities;
  readonly setupDetectionDir?: string;
  readonly agentBuilder?: AgentCommandBuilder;
  readonly executionLowerer?: AgentRequestLowerer;
  readonly identityEnv?: readonly string[];
  readonly presenceEnv?: readonly string[];
  readonly resultExtractor?: AgentResultExtractor;
}
