// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The improve/agent process shapes are DERIVED from the Zod schema via
// `z.infer` so the type and the validator cannot drift — config-schema.ts is the
// single source of truth (see its field comments for per-knob docs). The schema
// values are referenced via inline `typeof import("./config-schema").<Schema>`
// type queries rather than an `import type {...}`: this is unambiguously
// type-only under any tsconfig/toolchain and creates no runtime import cycle
// (config-schema imports VALID_HARNESS_IDS from here at runtime).
import type { z } from "zod";
// VALID_HARNESS_IDS now derives from the unified HARNESS_REGISTRY (#562), which
// is the single source of truth replacing the previously-disconnected
// registries. config ← harnesses is the only import direction (harnesses/ is a
// dependency-graph leaf), so there is no cycle.
import { VALID_HARNESS_IDS } from "../../integrations/harnesses";
/**
 * Type definitions for the `AkmConfig` shape and its sub-shapes.
 *
 * The Zod schema in `./config-schema.ts` is the single source of truth for
 * runtime validation. The high-churn improve/agent process shapes
 * (`ImproveProcessConfig`, `ImproveProfileConfig`, `AgentProfileConfig`) are
 * DERIVED from that schema via `z.infer`, so they cannot drift. The remaining
 * hand-written interfaces (connection/source/index/top-level `AkmConfig`) mirror
 * the schema for consumers that don't want to import Zod; keep those in sync —
 * `bunx tsc` surfaces drift through call-site errors.
 */
import type { InstalledStashEntry } from "../../registry/types";

/**
 * Canonical list of valid agent harness / platform ids. Re-exported from the
 * unified harness registry (#562) so the Zod `AgentPlatformSchema` enum, the
 * `AgentProfileConfig` platform union, and setup's `DetectedHarness` union all
 * derive from one place and cannot drift. Add a harness in
 * `src/integrations/harnesses/index.ts`.
 */
export { VALID_HARNESS_IDS };

/** Union of valid harness ids, derived from {@link VALID_HARNESS_IDS}. */
export type HarnessId = (typeof VALID_HARNESS_IDS)[number];

/**
 * Fields shared by every OpenAI-compatible connection config (embedding +
 * LLM). Specialized configs extend this base. Pure type DRY — the on-disk
 * JSON schema is unchanged.
 */
export interface BaseConnectionConfig {
  /** Provider name for display (e.g. "openai", "anthropic", "ollama"). */
  provider?: string;
  /** OpenAI-compatible HTTP endpoint. */
  endpoint: string;
  /** Model name to use. */
  model: string;
  /** Optional API key for authenticated endpoints. */
  apiKey?: string;
}

/**
 * Embedding connection config. Discriminated by `endpoint` presence:
 *   - Remote: both `endpoint` (http/https URL) and `model` set.
 *   - Local-only: `endpoint`/`model` absent; `localModel` selects the local
 *     transformer (or falls back to {@link DEFAULT_LOCAL_MODEL}).
 *
 * Consumers route via `hasRemoteEndpoint()`, which checks for an http(s)
 * `endpoint` value — undefined falls through to the local path naturally.
 */
export interface EmbeddingConnectionConfig {
  /** Provider name for display (e.g. "openai", "anthropic", "ollama"). */
  provider?: string;
  /** OpenAI-compatible HTTP endpoint. Optional — absent means local-only. */
  endpoint?: string;
  /** Model name to use. Optional — absent means local-only. */
  model?: string;
  /** Optional API key for authenticated endpoints. */
  apiKey?: string;
  /** Optional output dimension for providers that support it. */
  dimension?: number;
  /** Optional local transformer model name. Overrides the default when using local embeddings. */
  localModel?: string;
  /** Max tokens per document chunk before splitting. */
  maxTokens?: number;
  /** Documents per embedding API batch (default 100). */
  batchSize?: number;
  /** Max characters per text chunk before splitting. */
  chunkSize?: number;
  /**
   * Context window size passed as `num_ctx` to Ollama's native `/api/embed` endpoint.
   * Has no effect on non-Ollama providers.
   */
  contextLength?: number;
  /**
   * Arbitrary options forwarded verbatim as the `options` field in the Ollama
   * native `/api/embed` request body. Takes precedence over `contextLength`.
   */
  ollamaOptions?: { num_ctx?: number };
}

export interface LlmCapabilities {
  /** Model emits strict JSON reliably (probed during setup). */
  structuredOutput?: boolean;
}

export interface LlmConnectionConfig extends BaseConnectionConfig {
  /** Optional sampling temperature */
  temperature?: number;
  /** Optional response token limit */
  maxTokens?: number;
  /** Optional request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Max parallel LLM requests issued by index passes. Defaults to 1.
   * Cloud users can set this to 4 or higher; local model servers should
   * leave it at the default.
   */
  concurrency?: number;
  /** Capability flags learned at setup time (e.g. structured-output support). */
  capabilities?: LlmCapabilities;
  /** Arbitrary key-value pairs forwarded verbatim into every chat completions request body. */
  extraParams?: Record<string, unknown>;
  /** Model context window size in tokens. Set this to the value your model was loaded with. */
  contextLength?: number;
  /** Optional model name override for the LLM-as-judge quality gate (P2-B). */
  judgeModel?: string;
  /** Disable thinking mode for models that support it (e.g. qwen3.x). */
  enableThinking?: boolean;
}

export interface LlmProfileConfig extends LlmConnectionConfig {
  supportsJsonSchema?: boolean;
}

/**
 * Per-agent-profile config (`profiles.agent.<name>`). Derived from
 * {@link AgentProfileConfigSchema}; fields: `platform`, `bin`, `args`,
 * `workspace`, `model`, `timeoutMs` (null = no timeout).
 */
export type AgentProfileConfig = z.infer<typeof import("./config-schema").AgentProfileConfigSchema>;

/**
 * Per-process config (`profiles.improve.<profile>.processes.<process>`).
 * Derived from {@link ImproveProcessConfigSchema} so the type and the runtime
 * validator cannot drift. Most fields are process-specific — see the field
 * comments in config-schema.ts for which process each knob applies to and its
 * default (e.g. `dedup`/`judgedCache`/`minPoolSize` = consolidate;
 * `minNewSessions`/`indexSessions`/`triage` = extract; `fullScan`/`topN` =
 * graphExtraction; `minClusterSize`/`relatednessSource` = recombine;
 * `minRecurrence`/`emitAs` = procedural).
 */
export type ImproveProcessConfig = z.infer<typeof import("./config-schema").ImproveProcessConfigSchema>;

/**
 * A named improve profile (`profiles.improve.<name>`). Derived from
 * {@link ImproveProfileConfigSchema}. Holds the per-process `processes` map plus
 * profile-level knobs (`autoAccept`, `limit`, `maxCycles`, `symmetricValence`,
 * `sync`). See config-schema.ts for per-field docs.
 */
export type ImproveProfileConfig = z.infer<typeof import("./config-schema").ImproveProfileConfigSchema>;

export interface RegistryConfigEntry {
  /** URL of the registry index */
  url: string;
  /** Human-friendly label for this registry */
  name?: string;
  /** Whether this registry is active. Default: true */
  enabled?: boolean;
  /** Provider type. Default: "static-index" (current behavior). */
  provider?: string;
  /** Arbitrary provider-specific options passed through to the provider. */
  options?: Record<string, unknown>;
}

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
  /** If set, .md files in this stash are indexed as wiki pages under this name. */
  wikiName?: string;
}

/** Provider-specific options for a configured source entry. */
export interface SourceConfigEntryOptions {
  /**
   * @deprecated 0.9.0 (issue #507). The per-asset commit/push path is retired:
   * akm now commits writes in a single batch at the operation boundary and
   * pushes when the target is writable with a remote (same gate as `sync.push`).
   * The field still parses so old configs load; its push intent is mapped onto
   * the batch push gate, and an encountered value emits a one-time deprecation
   * warning. Prefer `writable: true` + sync push instead.
   */
  pushOnCommit?: boolean;
  /** Pass-through catch-all for provider-specific options. */
  [key: string]: unknown;
}

/**
 * @deprecated Use {@link ConfiguredSource} (runtime) — the loader derives
 * {@link SourceSpec} from the persisted fields. SourceConfigEntry is the
 * on-disk JSON shape.
 */
export interface SourceConfigEntry {
  type: string;
  path?: string;
  url?: string;
  name?: string;
  enabled?: boolean;
  writable?: boolean;
  primary?: boolean;
  options?: SourceConfigEntryOptions;
  wikiName?: string;
}

export interface OutputConfig {
  format?: "json" | "yaml" | "text";
  detail?: "brief" | "normal" | "full";
}

/**
 * Per-pass index configuration. Each named pass that uses an LLM defaults to
 * the default LLM profile; setting `llm: false` opts a single pass out.
 *
 * Per-pass alternative provider configuration is intentionally not supported
 * (#208) — non-boolean `llm`, or any unknown key, fails at config load.
 */
export interface IndexPassConfig {
  /** When `false`, the pass skips its LLM call. */
  llm?: boolean;
  /**
   * Number of asset bodies to batch into a single graph-extraction LLM call.
   * Default: {@link DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE} (4). Practical range: 1–10.
   * Effective value is clamped by {@link resolveBatchSize} when llm.contextLength is set.
   */
  graphExtractionBatchSize?: number;
  /**
   * Asset types eligible for graph extraction.
   * Default: ["memory", "knowledge"]. Unknown values are rejected at load.
   */
  graphExtractionIncludeTypes?: string[];
  /** Memory bodies to batch into a single memory-inference LLM call. Default: 1. Practical range: 1–10. */
  memoryInferenceBatchSize?: number;
  /**
   * Opt-in (#624-P3). When true, `akm show` extracts graph data inline
   * (timeout-bounded) and `akm curate` enqueues it for an ungraphed asset.
   * Default: false — behavior byte-identical to today.
   */
  lazyGraphExtraction?: boolean;
}

/** Reserved well-known keys on IndexConfig that are NOT per-pass entries. */
export interface IndexConfigReservedKeys {
  /** Gates the `akm index` metadata-enhancement pass. Default: enabled. */
  metadataEnhance?: { enabled?: boolean };
  /** Gates the `akm index` staleness-detection pass. Default: disabled. */
  stalenessDetection?: { enabled?: boolean; thresholdDays?: number };
}

/**
 * Index-time configuration. Combines well-known feature sections
 * ({@link IndexConfigReservedKeys}) with per-pass overrides keyed by pass name.
 * Use `getIndexPassConfig()` to read pass-named entries safely.
 */
export type IndexConfig = IndexConfigReservedKeys & {
  [passName: string]: IndexPassConfig | IndexConfigReservedKeys[keyof IndexConfigReservedKeys] | undefined;
};

export interface ImproveConfig {
  /**
   * Phase 2A / Rec 5 — configurable forgetting curve.
   * Tunes utility-score recency decay applied during search ranking.
   * Absence — and no positive feedback — collapses to the original
   * `exp(-days / 30)` curve so pre-2A behaviour is preserved.
   */
  utilityDecay?: {
    /** Recency half-life in days (default 30). Minimum 0.1. */
    halfLifeDays?: number;
    /**
     * Multiplicative half-life extension per positive feedback event.
     * Default 1.5; minimum 1.0. Effective half-life capped at halfLifeDays × 4.
     */
    feedbackStabilityBoost?: number;
  };
  /**
   * Retention window (days) for rows in state.db's `events` table.
   * Default: 90. Set to 0 to disable purging entirely.
   */
  eventRetentionDays?: number;
  /**
   * #612 / WS-4 — auto-accept gate calibration + bounded, opt-in per-phase
   * threshold auto-tune.
   *
   * Calibration (the reliability summary on `akm health`) is always computed
   * from gate decisions; this block controls only the OPT-IN threshold
   * auto-tune. DEFAULT OFF: absent — or `autoTune: false` — means the gate
   * threshold is never adjusted and behaviour is byte-identical to today.
   *
   * WS-4 change: thresholds are now persisted PER PHASE in state.db (keyed by
   * phase label). `makeGateConfig` reads the stored value and falls back to
   * `globalThreshold` when none exists yet. The auto-tune ceiling is bounded at
   * `maxThreshold` (default 85) to prevent the gate converging to pure
   * exploitation.
   */
  calibration?: {
    /** Master switch for the bounded threshold auto-tune. Default false (parity). */
    autoTune?: boolean;
    /** Lower bound (0-100) the tuned threshold may never drop below. */
    minThreshold?: number;
    /**
     * Upper bound (0-100) the tuned threshold may never rise above.
     * WS-4 default: 85 (prevents gate converging to pure exploitation and
     * shutting down novelty / exploration throughput).
     */
    maxThreshold?: number;
    /** Maximum adjustment magnitude (points) applied in one tune step. */
    maxStep?: number;
    /** Minimum acted-on sample count required before any adjustment. */
    minSamples?: number;
    /** Target realized accept rate in [0, 1]. Default 0.9. */
    targetAcceptRate?: number;
  };
  /**
   * WS-4 — Exploration budget: a fixed fraction of proposals per run are
   * accepted regardless of confidence to prevent the gate converging to pure
   * exploitation (which would shut down Gap-3/Gap-4 novelty and recreate the
   * throughput collapse this work exists to fix).
   *
   * DEFAULT OFF: absent means no exploration budget is applied.
   * Exploration-promoted proposals are logged with
   * `eligibilitySource = "exploration"` and are NOT subject to auto-tune.
   */
  exploration?: {
    /**
     * Fraction of proposals per run to accept as exploration regardless of
     * confidence. Default 0.05 (5%). Range [0, 1].
     */
    budgetFraction?: number;
    /**
     * When true, exploration budget is active. Default false (parity).
     * Set to true to enable the exploration lane.
     */
    enabled?: boolean;
  };
  /**
   * WS-2 (#613) — salience-weight configuration.
   *
   * Controls whether the WS-2 outcome-weight term (`w_o = 0.15`) is active in
   * the salience projection.
   *
   * **DEFAULT ON** (`outcomeWeightEnabled` absent or `true`): the projection
   * uses WS-2 weights (`w_e=0.25, w_o=0.15, w_r=0.60`) so the prediction-error
   * outcome signal shapes ranking (R1 loop closure; safe since `outcome_score`
   * saturates at `OUTCOME_SCORE_MAX`). Set to `false` to restore the WS-1
   * parity weights (`w_e=0.30, w_r=0.70`, `w_o=0`).
   */
  salience?: {
    /**
     * Enable the WS-2 outcome-weight term in the salience projection.
     * Default `true` (weights `w_e=0.25, w_o=0.15, w_r=0.60`). Explicit
     * `false` restores parity — WS-1 weights `w_e=0.30, w_r=0.70`, `w_o=0`.
     */
    outcomeWeightEnabled?: boolean;
    /**
     * Minimum encoding salience score for the high-salience improve lane (#608).
     * Zero-feedback assets with `encoding_salience >= salienceThreshold` are
     * admitted up to 10% of `maxPerRun`. Default 0.75. Set to 1.0 to disable.
     */
    salienceThreshold?: number;
    /**
     * Per-run additive replay budget (#610). Up to this many top-salience refs are
     * revisited even with no feedback/retrieval and regardless of cooldown.
     * Additive on top of --limit (never steals fresh work). Refs that converged to
     * no_change (consecutive_no_ops >= dampener threshold) are skipped.
     * Default 0 = current behavior (no replay).
     */
    replayBudget?: number;
  };
  /**
   * R5 — longitudinal collapse/churn detector
   * (docs/design/improve-collapse-churn-detector-design.md). Observe-only in
   * v1: on every improve cycle where consolidate/recombine did work, snapshots
   * canary retrieval + store-shape metrics to `improve_cycle_metrics` and
   * evaluates collapse/churn alert rules over the trend window. Deterministic
   * (FTS-only, no LLM/model), fail-open, < 250 ms per qualifying cycle.
   *
   * **DEFAULT ON** (`enabled` absent or `true`). Opt out with `enabled: false`.
   */
  collapseDetector?: {
    enabled?: boolean;
    /** Canary set size minted on first run (owner-approved 30–50 range; default 40). */
    canaryCount?: number;
    /** Top-K cutoff for canary recall/nDCG (default 10). */
    k?: number;
    /** Trend window in qualifying cycles (default 5). */
    windowCycles?: number;
    /** Absolute mean-recall drop vs the window median that fires collapse (default 0.15). */
    recallDropThreshold?: number;
    /** distinct-content-ratio decline over the window that fires collapse (default 0.05). */
    entropyDropThreshold?: number;
    /** Accepted-action volume over the window below which churn never fires (default 25). */
    churnMinAcceptedActions?: number;
    /** improve_cycle_metrics retention in days (default 365, owner-approved). */
    retentionDays?: number;
  };
}

export interface AkmConfig {
  /** Schema version marker. "0.8.0" (or legacy integer 2) = already migrated. */
  configVersion?: string | number;
  /** Named LLM and agent profiles. */
  profiles?: {
    llm?: Record<string, LlmProfileConfig>;
    agent?: Record<string, AgentProfileConfig>;
    improve?: Record<string, ImproveProfileConfig>;
  };
  /** Default profile names and improve pipeline defaults. */
  defaults?: {
    llm?: string;
    agent?: string;
    /** Name of the default improve profile from profiles.improve. */
    improve?: string;
  };
  /** Path to the working stash directory. Resolved from env → config → default. */
  stashDir?: string;
  /** User preference for semantic search. "auto" means use semantic search whenever prerequisites are healthy. */
  semanticSearchMode: "off" | "auto";
  /** OpenAI-compatible embedding endpoint config. If not set, uses local @huggingface/transformers. */
  embedding?: EmbeddingConnectionConfig;
  /** Per-pass `akm index` configuration. See {@link IndexConfig}. */
  index?: IndexConfig;
  /** Installed stashes (from npm, GitHub, git, or local sources). */
  installed?: InstalledStashEntry[];
  /**
   * Configured registries for stash discovery.
   * - `undefined`: use the built-in default registries.
   * - `[]`: disable all registries.
   * - `[...]`: override defaults with this list.
   */
  registries?: RegistryConfigEntry[];
  /** Additional asset sources (filesystem paths and remote providers). */
  sources?: SourceConfigEntry[];
  /** Output defaults for CLI rendering. */
  output?: OutputConfig;
  /** When true, the primary stash is treated as a writable git repo. */
  writable?: boolean;
  /**
   * Default destination for `akm remember` / `akm import`. Names a configured
   * source. Resolution order: explicit --target → defaultWriteTarget →
   * stashDir → ConfigError (no implicit "first writable" fallback).
   */
  defaultWriteTarget?: string;
  /** Search-specific tuning parameters. */
  search?: {
    /** Minimum score floor for semantic-only hits. Default: 0.2. Set to 0 to disable. */
    minScore?: number;
    /**
     * #627 — asset types excluded from default (untyped) `akm search` / `akm
     * curate` results. When the key is ABSENT a built-in default of
     * `['session']` is applied in code (sessions pollute default results). An
     * explicit empty list `[]` disables exclusion = pre-#627 behavior. The
     * exclusion is a pure query-layer policy — it never applies when an
     * explicit `--type` is supplied, and `akm search --include-sessions`
     * re-includes excluded types on the default path.
     */
    defaultExcludeTypes?: string[];
    /** Gates the `akm curate` LLM-rerank pass. Default: false. */
    curateRerank?: { enabled?: boolean };
    /**
     * Search-time graph boost tuning knobs. Defaults preserve current behavior:
     * - directBoostPerEntity: 0.25, directBoostCap: 0.75
     * - hopBoostPerEntity: 0.1, hopBoostCap: 0.3
     * - maxHops: 1 (hard-capped at 3)
     * - confidenceMode: "blend", confidenceWeight: 0.2
     */
    graphBoost?: {
      directBoostPerEntity?: number;
      directBoostCap?: number;
      hopBoostPerEntity?: number;
      hopBoostCap?: number;
      /** Maximum traversal depth (default 1, hard-capped at 3 — values > 3 throw). */
      maxHops?: number;
      /**
       * Confidence integration mode:
       *  - "off": ignore confidence
       *  - "blend": downweight by confidence using confidenceWeight
       *  - "multiply": multiply by confidence directly
       */
      confidenceMode?: "off" | "blend" | "multiply";
      /** Blend strength in [0,1] when confidenceMode is "blend". Values > 1 throw. */
      confidenceWeight?: number;
    };
  };
  /** Feedback-specific configuration. */
  feedback?: {
    /**
     * When true, negative feedback without --reason throws a hard error (exit 2).
     * Default: true (F-3 / #384).
     */
    requireReason?: boolean;
    /**
     * When set, only these failure-mode values are accepted by `--failure-mode`.
     * Defaults to the built-in curated enum {@link FEEDBACK_FAILURE_MODES}.
     */
    allowedFailureModes?: string[];
  };
  /**
   * Days to retain soft-invalidated memory assets in `.akm/archive/`.
   * Default: 90. Set to 0 to disable TTL cleanup.
   */
  archiveRetentionDays?: number;
  /**
   * `akm improve` pipeline tuning. Persisted settings apply to every unattended run.
   */
  improve?: ImproveConfig;
  /**
   * Recommendations recorded by `akm setup` (e.g. `--reset-recommended`).
   * Advisory metadata only — actual task scheduling lives in the tasks
   * subsystem. Persisted so the value survives a re-run.
   */
  setup?: {
    /** Recommended cron schedules for background tasks. */
    taskSchedules?: {
      /** Cron expression for the `improve` task, e.g. "0 2 * * *". */
      improve?: string;
      /** Cron expression for the `index` task, e.g. "0 4 * * *". */
      index?: string;
    };
  };
}
