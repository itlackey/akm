// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Type definitions for the `AkmConfig` shape and its sub-shapes.
 *
 * The Zod schema in `./config-schema.ts` is the single source of truth for
 * runtime validation; the interfaces here mirror it for consumers that don't
 * want to import Zod just to get a type. Keep the two in sync — `bunx tsc`
 * will surface the drift through call-site errors.
 */
import type { InstalledStashEntry } from "../registry/types";

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
}

export interface LlmProfileConfig extends LlmConnectionConfig {
  supportsJsonSchema?: boolean;
}

export interface AgentProfileConfigV2 {
  platform: "opencode" | "claude" | "opencode-sdk";
  bin?: string;
  args?: string[];
  workspace?: string;
  model?: string;
}

export interface ImproveProcessConfig {
  enabled?: boolean;
  mode?: "llm" | "agent" | "sdk";
  /** Named runner profile from profiles.llm or profiles.agent. */
  profile?: string;
  timeoutMs?: number | null;
  /**
   * Whitelist of asset types for this process. Absent = built-in default.
   * Only applied by per-ref processes (`reflect`, `distill`); ignored by
   * full-pass operations.
   */
  allowedTypes?: string[];
  /**
   * Optional LLM-as-judge quality gate. Fail-open: judge failures always pass.
   * Replaces the legacy `lesson_quality_gate` / `proposal_quality_gate` flags.
   */
  qualityGate?: { enabled?: boolean };
  /**
   * Optional contradiction-detection pass (M-1 / #367). Only meaningful on
   * the `consolidate` process.
   */
  contradictionDetection?: { enabled?: boolean };
  /**
   * Default discovery window for the `extract` process when the caller does
   * not pass an explicit `--since`. Accepts ISO timestamps or duration
   * strings (`24h`, `7d`, `30m`). Only meaningful on the `extract` process.
   * Defaults to `24h` when absent.
   */
  defaultSince?: string;
  /**
   * Pre-filter total-character budget. Once kept events exceed this many
   * chars, older events are dropped (recency-bias) so the prompt stays
   * within the model's context window. Only meaningful on the `extract`
   * process. Defaults to 80_000 when absent — chosen for 32K-token models;
   * raise it for larger-context models.
   */
  maxTotalChars?: number;
}

export interface ImproveProfileConfig {
  description?: string;
  processes?: {
    reflect?: ImproveProcessConfig;
    distill?: ImproveProcessConfig;
    consolidate?: ImproveProcessConfig;
    memoryInference?: ImproveProcessConfig;
    graphExtraction?: ImproveProcessConfig;
    /** Gates `akm distill <ref>`. Default: enabled. */
    feedbackDistillation?: ImproveProcessConfig;
    /** Third-tier classifier runner. Used by staleness/confidence/classification. */
    validation?: ImproveProcessConfig;
    /**
     * Gates the `akm extract` pass that reads native session files via the
     * session-log harness registry and queues durable-insight proposals.
     * Default: enabled.
     */
    extract?: ImproveProcessConfig;
  };
  autoAccept?: number;
  limit?: number;
}

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
  /** When true and the source is a git repo, akm runs `git push` after every asset commit. */
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
}

export interface AkmConfig {
  /** Schema version marker. "0.8.0" (or legacy integer 2) = already migrated. */
  configVersion?: string | number;
  /** Named LLM and agent profiles. */
  profiles?: {
    llm?: Record<string, LlmProfileConfig>;
    agent?: Record<string, AgentProfileConfigV2>;
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
}
