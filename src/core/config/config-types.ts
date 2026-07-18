// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Public config type surface for `AkmConfig` and its sub-shapes.
 *
 * The Zod schema in `./config-schema.ts` is the SINGLE SOURCE OF TRUTH: every
 * type here is DERIVED from a schema via `z.infer` / `z.output`, so the type
 * and the runtime validator cannot drift. (This finished a migration that had
 * only converted the improve/agent process shapes; the hand-written
 * connection/source/index/top-level interfaces that mirrored the schema — and
 * silently dropped new nested keys when someone forgot to update both — are
 * gone.)
 *
 * The schema values are referenced via inline `typeof import("./config-schema")`
 * type queries rather than an `import type {...}`: this is unambiguously
 * type-only under any tsconfig/toolchain and creates no runtime import cycle
 * (config-schema imports VALID_HARNESS_IDS from here at runtime).
 *
 * The only hand-written shapes below are `SourceSpec` / `ConfiguredSource`,
 * which are RUNTIME-derived at config load and never appear on disk, so they
 * have no schema counterpart.
 */
import type { z } from "zod";
// VALID_HARNESS_IDS / HARNESS_AGENT_DISPATCH_IDS derive from the dependency-free
// harnesses/ids.ts leaf (WI-9.8 KILL 3), NOT the full HARNESS_REGISTRY barrel
// (`../../integrations/harnesses`) — that barrel transitively pulls in every
// harness's agent-builder and the agent runtime, which is what fused config
// into the same import-cycle SCC as `integrations/agent/*`. `harnesses/index.ts`
// asserts at construction time that its registry matches this leaf, so the two
// cannot silently drift (see `tests/harnesses-registry.test.ts` for the
// value-level pin). config ← harnesses/ids is the only import direction (the
// leaf imports nothing), so there is no cycle.
import { HARNESS_AGENT_DISPATCH_IDS, VALID_HARNESS_IDS } from "../../integrations/harnesses/ids";

/**
 * Canonical list of valid agent harness / platform ids. Derived from the
 * dependency-free harness-id leaf (#562/WI-9.8) so the Zod `AgentPlatformSchema`
 * enum, the agent-engine platform union, and setup's `DetectedHarness` union
 * all derive from one place and cannot drift. Add a harness in
 * `src/integrations/harnesses/index.ts` (and its `ids.ts` mirror entry).
 */
export { HARNESS_AGENT_DISPATCH_IDS, VALID_HARNESS_IDS };

/** Union of valid harness ids, derived from {@link VALID_HARNESS_IDS}. */
export type HarnessId = (typeof VALID_HARNESS_IDS)[number];

/** OpenAI-compatible embedding connection config. */
export type EmbeddingConnectionConfig = z.infer<typeof import("./config-schema").EmbeddingConnectionConfigSchema>;

/** OpenAI-compatible LLM connection materialized from a named engine. */
export type LlmConnectionConfig = z.infer<typeof import("./config-schema").LlmConnectionConfigSchema>;

/** Internal LLM call shape including structured-output capability metadata. */
export type LlmProfileConfig = z.infer<typeof import("./config-schema").LlmProfileConfigSchema>;

/** A named 0.9 engine (LLM connection or agent platform). */
export type EngineConfig = z.infer<typeof import("./config-schema").EngineConfigSchema>;

/**
 * Per-process config (`improve.strategies.<strategy>.processes.<process>`). Most
 * fields are process-specific — see the field comments in config-schema.ts for
 * which process each knob applies to and its default (e.g. `minPoolSize` =
 * consolidate; `minNewSessions`/`indexSessions`/`triage` = extract;
 * `fullScan`/`topN` = graphExtraction).
 */
export type ImproveProcessConfig = z.infer<typeof import("./config-schema").ImproveProcessConfigSchema>;

/**
 * A named improve strategy (`improve.strategies.<name>`). Holds the per-process
 * `processes` map plus profile-level knobs (`limit`, `symmetricValence`,
 * `sync`). See config-schema.ts for per-field docs.
 */
export type ImproveProfileConfig = z.infer<typeof import("./config-schema").ImproveProfileConfigSchema>;

/** A configured registry for stash discovery (`registries[]`). */
export type RegistryConfigEntry = z.infer<typeof import("./config-schema").RegistryConfigEntrySchema>;

/**
 * SourceSpec — discriminated union describing *where* a stash comes from.
 * The on-disk config keeps the flat `{ type, path, url, ... }` shape; a
 * SourceSpec value is derived at load time and attached to ConfiguredSource.
 */
export type SourceSpec =
  | { type: "filesystem"; path: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "npm"; package: string; version?: string }
  | { type: "github"; owner: string; repo: string; ref?: string }
  | { type: "website"; url: string; maxPages?: number }
  | { type: "local"; path: string };

/**
 * ConfiguredSource — runtime representation of a configured stash. Persisted
 * on disk via SourceConfigEntry; the `source` field is derived at load time.
 *
 * Iteration order (see `resolveConfiguredSources()`):
 *   1. The entry marked `primary: true` (or a synthetic entry built from `stashDir`).
 *   2. Remaining `sources[]` entries in declared order.
 *   3. Legacy `installed[]` entries last.
 */
export interface ConfiguredSource {
  /** Stable identifier. Generated from `type+hash` when absent in legacy configs. */
  name: string;
  /** Provider type discriminator (mirrors `source.type`). */
  type: string;
  /** Internal derived field — not persisted to disk. */
  source: SourceSpec;
  /** Default true. When false, the entry is loaded but skipped at runtime. */
  enabled?: boolean;
  /** Whether the underlying repo accepts writes (e.g. git push). */
  writable?: boolean;
  /** Marks one entry in `sources[]` as the primary working stash. */
  primary?: boolean;
  /** Pass-through provider-specific options. */
  options?: Record<string, unknown>;
}

/**
 * SourceConfigEntry — the on-disk JSON shape of a `sources[]` entry. The loader
 * derives {@link SourceSpec} from the persisted fields to build a
 * {@link ConfiguredSource}.
 */
export type SourceConfigEntry = z.infer<typeof import("./config-schema").SourceConfigEntrySchema>;

/** Output defaults for CLI rendering (`output`). */
export type OutputConfig = z.infer<typeof import("./config-schema").OutputConfigSchema>;

/**
 * Per-pass index configuration. Each named pass can select an engine and apply
 * bounded invocation overrides; `enabled: false` opts a pass out.
 */
export type IndexPassConfig = z.infer<typeof import("./config-schema").IndexPassConfigSchema>;

/**
 * Index-time configuration. Combines well-known feature sections
 * (`metadataEnhance`; `stalenessDetection` is retired but tolerated) and the
 * `indexBodyOpening` boolean feature flag (stash-conventions SPEC-8, default
 * false) with per-pass overrides keyed by pass name.
 */
export type IndexConfig = z.infer<typeof import("./config-schema").IndexConfigSchema>;

/** `akm improve` pipeline tuning (`improve`). See config-schema.ts for docs. */
export type ImproveConfig = z.infer<typeof import("./config-schema").ImproveConfigSchema>;

/** Workflow-engine settings (`workflow`). See config-schema.ts for docs. */
export type WorkflowConfig = z.infer<typeof import("./config-schema").WorkflowConfigSchema>;

/**
 * The full on-disk config shape. This IS the Zod schema's output type — there
 * is no parallel hand-written interface to keep in sync.
 */
export type AkmConfig = Partial<import("./config-schema").AkmConfigParsed> &
  Pick<import("./config-schema").AkmConfigParsed, "semanticSearchMode">;
