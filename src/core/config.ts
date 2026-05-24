import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { InstalledStashEntry } from "../registry/types";
import { writeFileAtomic } from "./common";
import { CURRENT_CONFIG_VERSION, compareConfigVersion, migrateConfigShape } from "./config-migration";
import { AkmConfigSchema, AkmConfigShape } from "./config-schema";
import { ConfigError } from "./errors";
import { getCacheDir, getConfigPath } from "./paths";
import { warn } from "./warn";

// Re-export the AgentConfig alias (now `= AkmConfig`) for source-compat with
// pre-0.8.0 callers that imported it from this module.
export type { AgentConfig } from "../integrations/agent/config";

// ── Feedback failure-mode constants (F-3 / #384) ────────────────────────────

/**
 * Curated taxonomy of failure modes for negative feedback (F-3 / #384).
 *
 * Structured failure modes enable aggregation across feedback events so the
 * distill pipeline can detect that "5 assets failed for the same reason" and
 * act on it — free-text strings about the same issue are not aggregatable.
 *
 * Based on CAI principle-driven feedback (arXiv:2212.08073) and PRM/ORM
 * process-level reward modelling (arXiv:2305.20050).
 */
export const FEEDBACK_FAILURE_MODES = [
  "incorrect", // Factually wrong or logically flawed content
  "outdated", // Correct at some point but now stale
  "dangerous", // Could cause harm if followed (security, safety)
  "incomplete", // Missing key steps, context, or caveats
  "redundant", // Duplicates another asset without adding value
] as const;

/** Union of the curated failure-mode values. */
export type FeedbackFailureMode = (typeof FEEDBACK_FAILURE_MODES)[number];

// ── Types ───────────────────────────────────────────────────────────────────

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
 * Consumers route via {@link hasRemoteEndpoint}, which checks for an http(s)
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
  /** Optional local transformer model name (e.g. "Xenova/bge-small-en-v1.5"). Overrides the default when using local embeddings. */
  localModel?: string;
  /** Max tokens per document chunk before splitting. */
  maxTokens?: number;
  /** Documents per embedding API batch (default 100). */
  batchSize?: number;
  /** Max characters per text chunk before splitting. */
  chunkSize?: number;
  /**
   * Context window size passed as `num_ctx` to Ollama's native `/api/embed` endpoint.
   * Has no effect on non-Ollama providers. Use when long documents produce 400 errors
   * from the embedding model's default context limit (e.g. set to 8192 for most models).
   */
  contextLength?: number;
  /**
   * Arbitrary options forwarded verbatim as the `options` field in the Ollama
   * native `/api/embed` request body. Takes precedence over `contextLength` when both
   * are set. Use this for Ollama-specific tunables not covered by first-class fields.
   * Example: `{ "num_ctx": 8192 }`
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
   * Max parallel LLM requests issued by index passes (graph extraction,
   * memory inference, metadata enrichment). Defaults to 1. Cloud users can
   * set this to 4 or higher; local model servers (LM Studio, Ollama) that
   * run one inference at a time should leave it at the default.
   */
  concurrency?: number;
  /** Capability flags learned at setup time (e.g. structured-output support). */
  capabilities?: LlmCapabilities;
  /**
   * Arbitrary key-value pairs forwarded verbatim into every chat completions
   * request body. Use this for provider-specific parameters not covered by
   * first-class fields, e.g. `{ "reasoning_effort": "none" }` to disable
   * thinking on Ollama qwen3/qwen3.5 models.
   */
  extraParams?: Record<string, unknown>;
  /**
   * Model context window size in tokens. When set, features that build
   * LLM prompts (e.g. `akm consolidate`) use this to compute safe chunk
   * sizes instead of relying on a conservative hard-coded default.
   * Set this to the value your model was loaded with in LMStudio / Ollama
   * (e.g. 16384 for a 16K context model). Has no effect on the HTTP request
   * body itself.
   */
  contextLength?: number;
  /**
   * Optional model name override for the LLM-as-judge quality gate (P2-B).
   * When set, the judge call uses this model instead of `llm.model`, enabling
   * cheaper/faster model routing (e.g. "haiku" while distillation uses "sonnet").
   */
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
   * Whitelist of asset types for this process.
   * Absent = built-in default applies.
   *   reflect:     ["agent","command","knowledge","lesson","memory","skill","wiki","workflow"]
   *   distill:     ["memory"]
   *   consolidate: ["memory"]
   *
   * Only applied by per-ref processes — `reflect` and `distill`. The
   * full-pass operations (`consolidate`, `memoryInference`, `graphExtraction`)
   * do not iterate per asset and therefore ignore this field; setting it on
   * those entries triggers a parse-time warning.
   */
  allowedTypes?: string[];
  /** Per-type cooldown overrides in days for this process. */
  cooldownByType?: Partial<Record<string, number>>;
  /** Uniform cooldown in days for types not covered by cooldownByType. */
  cooldownDays?: number;
  /**
   * Optional LLM-as-judge quality gate. When enabled, generated outputs are
   * scored before entering the proposal queue. Fail-open: judge failures
   * always pass.
   *
   * - For `distill`: gates lesson quality at
   *   `profiles.improve.default.processes.distill.qualityGate.enabled`
   *   (replaces the legacy `lesson_quality_gate` flag).
   * - For `reflect`: gates proposal quality at
   *   `profiles.improve.default.processes.reflect.qualityGate.enabled`
   *   (replaces the legacy `proposal_quality_gate` flag).
   */
  qualityGate?: { enabled?: boolean };
  /**
   * Optional contradiction-detection pass (M-1 / #367). Only meaningful on
   * the `consolidate` process. When enabled, derived memories within the
   * same parent family are checked pairwise for contradictions.
   */
  contradictionDetection?: { enabled?: boolean };
}

export interface ImproveProfileConfig {
  description?: string;
  processes?: {
    reflect?: ImproveProcessConfig;
    distill?: ImproveProcessConfig;
    consolidate?: ImproveProcessConfig;
    memoryInference?: ImproveProcessConfig;
    graphExtraction?: ImproveProcessConfig;
    /**
     * Gates the feedback-distillation pass run by `akm distill <ref>` at
     * `profiles.improve.default.processes.feedbackDistillation.enabled`.
     * (Replaces the legacy `features.improve.feedback_distillation` /
     * `llm.features.feedback_distillation` flag.) Default: enabled.
     */
    feedbackDistillation?: ImproveProcessConfig;
    /**
     * Third-tier classifier runner (Advantage D3). Used by staleness detection,
     * confidence scoring, and lesson classification. When absent, callers fall
     * back to the `defaults.llm` profile.
     */
    validation?: ImproveProcessConfig;
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
 *
 * This is the canonical runtime model. The on-disk config keeps using the
 * flat `{ type, path, url, ... }` shape (see {@link SourceConfigEntry}); a
 * {@link SourceSpec} value is constructed from those fields by
 * {@link parseSourceSpec} at load time and attached to the runtime
 * {@link ConfiguredSource}. `SourceSpec` values are not serialized in this shape —
 * they are derived.
 */
export type SourceSpec =
  | { type: "filesystem"; path: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "npm"; package: string; version?: string }
  | { type: "github"; owner: string; repo: string; ref?: string }
  | { type: "website"; url: string; maxPages?: number }
  | { type: "local"; path: string };

/**
 * ConfiguredSource — runtime representation of a configured stash.
 *
 * Unifies the four overlapping types this codebase used to carry
 * (`SourceConfigEntry`, `InstalledStashEntry`, `SourceEntry`, `SearchSource`)
 * into one value. Persisted on disk via {@link SourceConfigEntry}; the
 * `source` field is derived at load time and never written back out.
 *
 * Iteration order convention (see `resolveConfiguredSources()`):
 *   1. The entry marked `primary: true` (or, as a backwards-compat shim,
 *      a synthetic filesystem entry built from the top-level `stashDir`).
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

/**
 * Provider-specific options for a configured source entry.
 * Fields accessed by name are listed explicitly for type safety; additional
 * provider-specific keys are accepted via the index signature.
 */
export interface SourceConfigEntryOptions {
  /**
   * When true and the source is a git repo, akm will run `git push` after
   * every asset commit (write-source.ts §5).
   */
  pushOnCommit?: boolean;
  /** Pass-through catch-all for provider-specific options not listed above. */
  [key: string]: unknown;
}

/**
 * @deprecated Use {@link ConfiguredSource} (runtime) and let the loader derive
 * {@link SourceSpec} from the persisted fields. `SourceConfigEntry` describes
 * the on-disk JSON shape; new code should not reach for it directly.
 */
export interface SourceConfigEntry {
  /** Provider type (e.g. "filesystem", "git", "website", "npm") */
  type: string;
  /** Filesystem path (for type: "filesystem") */
  path?: string;
  /** URL (for remote providers like git or website) */
  url?: string;
  /** Human-friendly label */
  name?: string;
  /** Whether this stash is active. Default: true */
  enabled?: boolean;
  /** If true, the stash is a git repo the user can commit and push changes back to. */
  writable?: boolean;
  /** Marks this entry as the primary working stash (replaces top-level stashDir). */
  primary?: boolean;
  /** Typed provider-specific options (see {@link SourceConfigEntryOptions}). */
  options?: SourceConfigEntryOptions;
  /** If set, all .md files in this stash are indexed as wiki pages under this wiki name */
  wikiName?: string;
}

export interface InstallAuditConfig {
  enabled?: boolean;
  blockOnCritical?: boolean;
  blockUnlistedRegistries?: boolean;
  registryAllowlist?: string[];
  registryWhitelist?: string[];
  allowedFindings?: InstallAuditAllowedFinding[];
}

export interface InstallAuditAllowedFinding {
  id: string;
  ref?: string;
  path?: string;
  reason?: string;
}

export interface SecurityConfig {
  installAudit?: InstallAuditConfig;
}

export interface AkmConfig {
  /** v2: schema version marker. "0.8.0" (or legacy integer 2) = already migrated to v2 shape. */
  configVersion?: string | number;
  /** v2: named LLM and agent profiles. */
  profiles?: {
    llm?: Record<string, LlmProfileConfig>;
    agent?: Record<string, AgentProfileConfigV2>;
    improve?: Record<string, ImproveProfileConfig>;
  };
  /** v2: default profile names and improve pipeline defaults. */
  defaults?: {
    llm?: string;
    agent?: string;
    /** Name of the default improve profile from profiles.improve. */
    improve?: string;
  };
  /** Path to the working stash directory. Resolved from env → config → default. */
  stashDir?: string;
  /** User preference for semantic search. "auto" means use semantic search whenever runtime prerequisites are healthy. */
  semanticSearchMode: "off" | "auto";
  /** OpenAI-compatible embedding endpoint config. If not set, uses local @huggingface/transformers */
  embedding?: EmbeddingConnectionConfig;
  /**
   * Per-pass `akm index` configuration. See {@link IndexConfig}. Each pass
   * defaults to the default LLM profile; setting `index.<pass>.llm = false`
   * opts a pass out. Per-pass alternative provider configuration is
   * intentionally not supported (#208).
   */
  index?: IndexConfig;
  /** Installed stashes (from npm, GitHub, git, or local sources) */
  installed?: InstalledStashEntry[];
  /**
   * Configured registries for stash discovery.
   * - `undefined` (field absent): use the built-in default registries.
   * - `[]` (explicit empty array): disable all registries (no registry search).
   * - `[...]` (non-empty array): use exactly the listed registries, overriding defaults.
   */
  registries?: RegistryConfigEntry[];
  /** Additional asset sources (filesystem paths and remote providers) */
  sources?: SourceConfigEntry[];
  /**
   * @deprecated use sources
   * Legacy alias for `sources` — preserved for backward-compatibility with
   * existing configs and tests that reference `stashes`.
   */
  stashes?: SourceConfigEntry[];
  /** Security controls for install-time auditing and registry allowlists */
  security?: SecurityConfig;
  /** Output defaults for CLI rendering */
  output?: OutputConfig;
  /**
   * When true, the primary stash is treated as a writable git repo and
   * `akm save` will push after committing (if a remote is configured).
   */
  writable?: boolean;
  /**
   * Default destination for `akm remember` / `akm import` and any other write
   * helper that does not receive an explicit `--target`. Names a configured
   * source by `name`. Per locked decision 3 (v1 implementation plan §6) the
   * resolution order is: explicit `--target` → `defaultWriteTarget` →
   * `stashDir` → `ConfigError`. There is no implicit "first writable in
   * source-array order" fallback.
   */
  defaultWriteTarget?: string;
  /**
   * Search-specific tuning parameters.
   */
  search?: {
    /**
     * Minimum score floor for semantic-only hits (cosine-only, no FTS match).
     * Hits at or above this score are kept; hits below are dropped. FTS and
     * hybrid hits are never filtered. Default: 0.2. Set to 0 to disable.
     */
    minScore?: number;
    /**
     * Gates the `akm curate` LLM-rerank pass at `search.curateRerank.enabled`.
     * (Replaces the legacy `features.search.curate_rerank` /
     * `llm.features.curate_rerank` flag.) Default: false. When disabled (or
     * absent) curate falls back to the deterministic pipeline.
     */
    curateRerank?: { enabled?: boolean };
    /**
     * Search-time graph boost tuning knobs.
     *
     * Defaults preserve current behavior:
     * - directBoostPerEntity: 0.25
     * - directBoostCap: 0.75
     * - hopBoostPerEntity: 0.1
     * - hopBoostCap: 0.3
     * - maxHops: 1
     * - confidenceMode: "blend"
     * - confidenceWeight: 0.2
     */
    graphBoost?: {
      /** Additive direct-match boost per matched entity in the hit. */
      directBoostPerEntity?: number;
      /** Maximum total direct-match additive boost for one hit. */
      directBoostCap?: number;
      /** Base additive connected-entity boost per matched hop entity. */
      hopBoostPerEntity?: number;
      /** Maximum total connected-entity additive boost for one hit. */
      hopBoostCap?: number;
      /**
       * Maximum traversal depth from query-matched entities.
       * Default: 1 (existing behavior). Hard-capped conservatively at 3.
       */
      maxHops?: number;
      /**
       * Confidence integration mode for graph boost scoring.
       * - "off": ignore confidence values.
       * - "blend": softly downweight by confidence using confidenceWeight.
       * - "multiply": directly multiply by confidence.
       */
      confidenceMode?: "off" | "blend" | "multiply";
      /**
       * Blend strength in [0,1] when confidenceMode is "blend".
       * 0 means no effect; 1 means full confidence-driven downweight.
       */
      confidenceWeight?: number;
    };
  };
  /**
   * Feedback-specific configuration.
   */
  feedback?: {
    /**
     * When true, negative feedback without --reason throws a hard error
     * (exit 2). When false, a non-blocking warning is emitted instead.
     *
     * Default: true (F-3 / #384). Structured failure signals are required
     * for the distill verbal-gradient pipeline to aggregate failure patterns
     * across feedback events (PRM/ORM, arXiv:2305.20050; CAI, arXiv:2212.08073).
     */
    requireReason?: boolean;
    /**
     * When set, only these failure-mode values are accepted by `--failure-mode`.
     * Defaults to the built-in curated enum {@link FEEDBACK_FAILURE_MODES}.
     * Set to an empty array to allow any string.
     */
    allowedFailureModes?: string[];
  };
  /**
   * Number of days to retain soft-invalidated (superseded) memory assets in
   * `.akm/archive/` before TTL cleanup removes them. Default: 90.
   * Set to 0 to disable TTL cleanup entirely (archives accumulate indefinitely).
   */
  archiveRetentionDays?: number;
  /**
   * `akm improve` pipeline tuning. All fields are optional; missing fields fall
   * back to built-in defaults. Persisted settings apply to every unattended run
   * (cron / launchd / schtasks). Use CLI flags for one-off overrides.
   */
  improve?: ImproveConfig;
}

export interface ImproveConfig {
  /**
   * Phase 2A / Rec 5 — configurable forgetting curve.
   *
   * Tunes the exponential utility-score recency decay applied during search
   * ranking. `halfLifeDays` (default 30) replaces the historical hardcoded
   * `RECENCY_DECAY_DAYS = 30`. `feedbackStabilityBoost` (default 1.5)
   * multiplicatively extends the half-life by `^positiveFeedbackCount`,
   * capped at `halfLifeDays × 4`, so memories that have repeatedly proven
   * useful decay more slowly than first-use memories.
   *
   * Default-safe: the absence of this object — and the absence of any
   * recorded positive feedback events — collapses the formula back to the
   * original `exp(-days / 30)` curve so pre-2A behaviour is preserved.
   */
  utilityDecay?: {
    /** Recency half-life in days (default 30). Minimum 0.1. */
    halfLifeDays?: number;
    /**
     * Multiplicative half-life extension applied per positive feedback event
     * recorded against the entry. Default 1.5; minimum 1.0 (no boost).
     * Effective half-life is capped at `halfLifeDays × 4`.
     */
    feedbackStabilityBoost?: number;
  };
  /**
   * Retention window (days) for rows in state.db's `events` table. The improve
   * post-loop maintenance pass calls `purgeOldEvents()` with this value so
   * state.db doesn't grow unbounded — `akm health` writes a `health_probe` row
   * on every invocation, and the events table accumulates one row per command
   * surface besides.
   *
   * Default: 90 days. Set to 0 to disable purging entirely (rows accumulate
   * forever, equivalent to pre-0.8.0 behaviour).
   */
  eventRetentionDays?: number;
}

export interface OutputConfig {
  format?: "json" | "yaml" | "text";
  detail?: "brief" | "normal" | "full";
}

/**
 * Per-pass index configuration. Each named pass that uses an LLM defaults to
 * the top-level `akm.llm` block; setting `llm: false` opts a single pass out.
 *
 * v1 contract (#208): boolean opt-out only. Per-pass alternative provider
 * configuration is deliberately out of scope — any non-boolean value for
 * `llm`, or any other key, fails at config load with a `ConfigError`.
 *
 * Batch-size knobs:
 *   - `graphExtractionBatchSize` — how many asset bodies to pack into one
 *     graph-extraction LLM call. Default: 4 (chosen to amortise per-call HTTP
 *     overhead while staying within typical 8K–16K context windows). When
 *     `llm.contextLength` is set, the runtime clamps the effective batch size
 *     via {@link resolveBatchSize} to fit within the context window.
 *   - `graphExtractionIncludeTypes` — asset types eligible for graph extraction.
 *     Default: ["memory", "knowledge"] (backwards compatible).
 *   - `memoryInferenceBatchSize` — same for the memory-inference pass.
 *     Default: 1 (one call per memory).
 * Set higher values to amortise LLM HTTP round-trips across more assets.
 */
export interface IndexPassConfig {
  /** When `false`, the pass skips its LLM call even if `akm.llm` is set. */
  llm?: boolean;
  /**
   * Number of asset bodies to batch into a single graph-extraction LLM call.
   * Default: {@link DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE} (4). Practical range:
   * 1–10. Higher values reduce HTTP round-trips at the cost of larger prompts;
   * values above ~10 risk hitting context limits. The effective value is
   * additionally clamped at runtime by {@link resolveBatchSize} when
   * `llm.contextLength` is set.
   */
  graphExtractionBatchSize?: number;
  /**
   * Asset types eligible for graph extraction.
   * Default: ["memory", "knowledge"] (existing behavior).
   * Unknown values are rejected at config-load time.
   */
  graphExtractionIncludeTypes?: string[];
  /**
   * Number of memory bodies to batch into a single memory-inference LLM call.
   * Default: 1 (one call per memory — existing behaviour, fully opt-in).
   * Practical range: 1–10.
   */
  memoryInferenceBatchSize?: number;
}

/**
 * Index-time configuration. Supports both well-known feature sections (e.g.
 * {@link IndexConfig.metadataEnhance}, {@link IndexConfig.stalenessDetection})
 * and per-pass overrides keyed by pass name (e.g. `index.graph`,
 * `index.enrichment`). Per-pass entries are validated for shape; unknown keys
 * fall through to the per-pass map.
 *
 * Feature-section keys take precedence over per-pass keys when reserved (i.e.
 * `metadataEnhance` and `stalenessDetection` cannot also be used as pass
 * names).
 */
/** Reserved well-known keys on IndexConfig that are NOT per-pass entries. */
export interface IndexConfigReservedKeys {
  /**
   * Gates the `akm index` metadata-enhancement pass at
   * `index.metadataEnhance.enabled`. (Replaces the legacy
   * `features.index.metadata_enhance` / `llm.features.metadata_enhance` flag.)
   * Default: enabled.
   */
  metadataEnhance?: { enabled?: boolean };
  /**
   * Gates the `akm index` staleness-detection pass. Replaces the legacy
   * `features.index.staleness_detection` entry. Default: disabled.
   */
  stalenessDetection?: { enabled?: boolean; thresholdDays?: number };
}

/**
 * Index-time configuration. Combines well-known feature sections
 * ({@link IndexConfigReservedKeys}) with per-pass overrides keyed by pass name
 * (e.g. `graph`, `enrichment`). Use {@link getIndexPassConfig} to read a
 * pass-named entry safely (without confusing the reserved feature-section
 * keys for a pass).
 */
export type IndexConfig = IndexConfigReservedKeys & {
  [passName: string]: IndexPassConfig | IndexConfigReservedKeys[keyof IndexConfigReservedKeys] | undefined;
};

/**
 * Default value for {@link IndexPassConfig.graphExtractionBatchSize}. Chosen
 * empirically: 4 amortises the per-call HTTP overhead 4× while keeping the
 * combined prompt size well under common 8K/16K context windows (each body is
 * sliced to ~500 chars in the graph-extract prompt builder).
 */
export const DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE = 4;

/**
 * Approximate character budget per asset body inside a batched
 * graph-extraction prompt — used by {@link resolveBatchSize} to derive a
 * context-window ceiling when `llm.contextLength` is configured. This accounts
 * for the actual `MAX_BODY_CHARS` (500) in graph-extract.ts plus the system
 * prompt, user prompt wrapper, and expected JSON response overhead.
 */
const GRAPH_EXTRACTION_CHARS_PER_BODY = 1500;

/**
 * Clamp a configured batch size against the model's known context window.
 *
 * `configured` defaults to {@link DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE} when
 * `undefined`. When `contextLength` is provided, the result is the smaller of
 * `configured` and `floor(contextLength / GRAPH_EXTRACTION_CHARS_PER_BODY)`,
 * with a floor of 1 so the batched path always processes at least one body.
 */
export function resolveBatchSize(configured: number | undefined, contextLength?: number): number {
  const base = configured && configured > 0 ? configured : DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE;
  if (!contextLength || contextLength <= 0) return base;
  const ceiling = Math.max(1, Math.floor(contextLength / GRAPH_EXTRACTION_CHARS_PER_BODY));
  return Math.max(1, Math.min(base, ceiling));
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AkmConfig = {
  semanticSearchMode: "auto",
  registries: [
    { url: "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json", name: "akm-registry" },
    { url: "https://skills.sh", name: "skills.sh", provider: "skills-sh", enabled: false },
  ],
  output: {
    format: "json",
    detail: "brief",
  },
};

// ── Private helpers ─────────────────────────────────────────────────────────

function clearAllCaches(): void {
  cachedConfig = undefined;
  cachedUserConfig = undefined;
}

// ── Load / Save / Update ────────────────────────────────────────────────────

const PROJECT_CONFIG_RELATIVE_PATH = path.join(".akm", "config.json");

let cachedConfig: { config: AkmConfig; signature: string } | undefined;
let cachedUserConfig: { config: AkmConfig; path: string; mtime: number; size: number } | undefined;

export function resetConfigCache(): void {
  clearAllCaches();
}

export function loadUserConfig(): AkmConfig {
  const configPath = getConfigPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch {
    cachedUserConfig = undefined;
    return applyRuntimeEnvApiKeys({ ...DEFAULT_CONFIG });
  }

  // Cache key: mtimeMs + size. Tests that write rapidly back-to-back inside
  // the mtime resolution window MUST call resetConfigCache() between writes —
  // every public test helper already does.
  if (
    cachedUserConfig &&
    cachedUserConfig.path === configPath &&
    cachedUserConfig.mtime === stat.mtimeMs &&
    cachedUserConfig.size === stat.size
  ) {
    return cachedUserConfig.config;
  }

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    cachedUserConfig = undefined;
    return applyRuntimeEnvApiKeys({ ...DEFAULT_CONFIG });
  }

  // ── Auto-migration hook (between parse and normalize) ─────────────────────
  // Check if the raw config needs migrating to the 0.8.0 shape. This runs on
  // every cache miss so we catch configs written before the feature shipped.
  // AKM_NO_AUTO_MIGRATE=1 skips the disk rewrite (still applies in-memory).
  text = maybeAutoMigrateConfigFile(configPath, text);

  const config = parseAndValidate(text, configPath);
  const finalConfig = applyRuntimeEnvApiKeys(config);

  // Re-stat after potential write-back so the cache key reflects the new mtime.
  let finalStat = stat;
  try {
    finalStat = fs.statSync(configPath);
  } catch {
    // Stat failed — use original stat for cache; no harm done.
  }
  cachedUserConfig = {
    config: finalConfig,
    path: configPath,
    mtime: finalStat.mtimeMs,
    size: finalStat.size,
  };
  return finalConfig;
}

/**
 * Parse raw config text, run pre-Zod lossless legacy migrations
 * (`migrateConfigShape`), then validate-and-transform via Zod
 * ({@link AkmConfigSchema}). Returns the merged-with-defaults AkmConfig.
 *
 * Three hard-throw rules survive Zod (they would silently drop user data
 * otherwise):
 *   - Malformed JSON / non-object root → `ConfigError("INVALID_CONFIG_FILE")`.
 *   - `stashes[]` (legacy v0 key) → `ConfigError("INVALID_CONFIG_FILE")` with
 *     a rename hint.
 *   - openviking source type → `ConfigError("INVALID_CONFIG_FILE")` with a
 *     migration hint.
 *
 * All other malformed sub-shapes are silently dropped (matches the legacy
 * parser's warn-and-ignore semantics for field-level errors).
 */
function parseAndValidate(text: string, sourcePath?: string): AkmConfig {
  const raw = parseConfigObjectFromText(text, sourcePath);
  rejectHardErrors(raw);
  // Migration is idempotent on already-migrated configs.
  const migrated = migrateConfigShape(raw).result;
  const parsed = AkmConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    const where = sourcePath ? ` at ${sourcePath}` : "";
    throw new ConfigError(`Invalid config${where}:\n${lines}`, "INVALID_CONFIG_FILE");
  }
  // Strip the `passthrough` extras from the surface AkmConfig (the schema
  // preserves them on the parsed object, but they're not part of the typed
  // shape). Drop any with a key matching a known schema field — those are the
  // ones Zod actually transformed.
  const result = parsed.data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(AkmConfigShape)) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return mergeLoadedConfig(DEFAULT_CONFIG, out as Partial<AkmConfig>);
}

/**
 * Pre-Zod hard-reject checks. Two legacy keys carried explicit migration
 * paths in v0.8.x — silently dropping them would mask user data loss.
 */
function rejectHardErrors(raw: Record<string, unknown>): void {
  if (Array.isArray((raw as Record<string, unknown>).stashes)) {
    throw new ConfigError(
      "The legacy `stashes[]` config key is no longer supported. Rename it to `sources`.",
      "INVALID_CONFIG_FILE",
    );
  }
  const sourcesRaw = (raw as Record<string, unknown>).sources;
  if (Array.isArray(sourcesRaw)) {
    for (const entry of sourcesRaw) {
      if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).type === "openviking") {
        const name = (entry as Record<string, unknown>).name;
        const nameStr = typeof name === "string" && name ? name : "unnamed";
        throw new ConfigError(
          `openviking is not supported in akm v1. API-backed sources will return as a\nseparate QuerySource tier post-v1. Remove the source named "${nameStr}" from your config file\nor downgrade to 0.6.x. See docs/migration/v1.md.`,
          "INVALID_CONFIG_FILE",
          `Run \`akm remove ${nameStr}\` then re-run, or edit your config file directly at ${getConfigPath()} to remove the openviking entry.`,
        );
      }
    }
  }
}

export function getSources(config: AkmConfig): SourceConfigEntry[] {
  return config.sources ?? [];
}

export function getEffectiveRegistries(config: AkmConfig): RegistryConfigEntry[] {
  return config.registries ?? DEFAULT_CONFIG.registries ?? [];
}

/**
 * Resolve the default LLM connection from `profiles.llm[defaults.llm]`.
 *
 * Throws {@link ConfigError} when `defaults.llm` is unset or points at a
 * profile that does not exist under `profiles.llm`. Use this in code paths
 * that must have an LLM configured (per-pass index calls, distill,
 * consolidate, etc).
 */
export function requireLlmConfig(config: AkmConfig): LlmConnectionConfig {
  const defaultName = config.defaults?.llm;
  if (!defaultName) {
    throw new ConfigError(
      "LLM is not configured. Run `akm setup` or set `defaults.llm` to a profile defined in `profiles.llm`.",
      "LLM_NOT_CONFIGURED",
    );
  }
  const profile = config.profiles?.llm?.[defaultName];
  if (!profile) {
    throw new ConfigError(
      `LLM default profile "${defaultName}" not found in profiles.llm.`,
      "LLM_NOT_CONFIGURED",
      `Available profiles: ${Object.keys(config.profiles?.llm ?? {}).join(", ") || "none"}. Run \`akm setup\` to configure.`,
    );
  }
  return profile;
}

/**
 * Like {@link requireLlmConfig} but returns `undefined` instead of throwing
 * when no LLM is configured. Use in code paths where the LLM is optional.
 */
export function getDefaultLlmConfig(config: AkmConfig): LlmConnectionConfig | undefined {
  const defaultName = config.defaults?.llm;
  if (!defaultName) return undefined;
  return config.profiles?.llm?.[defaultName];
}

/**
 * Parse the config text, run `migrateConfigShape`, and — unless
 * `AKM_NO_AUTO_MIGRATE=1` is set — write the migrated result back to disk.
 *
 * Returns the (possibly migrated) config JSON as a string so that the caller
 * can continue with the standard `readNormalizedConfigFromText` path.
 */
function maybeAutoMigrateConfigFile(configPath: string, text: string): string {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stripJsonComments(text));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return text; // Not a valid JSON object — let the normal loader handle it
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return text; // Malformed JSON — let the normal loader surface the error
  }

  // If the on-disk config is newer than this binary, do NOT attempt to
  // "migrate" — `migrateConfigShape` only knows how to upgrade to
  // CURRENT_CONFIG_VERSION, and downgrading would silently strip fields. We
  // still let the rest of loadUserConfig run (so reads keep working), but
  // we leave the bytes on disk untouched.
  if (compareConfigVersion((raw as { configVersion?: string | number }).configVersion, CURRENT_CONFIG_VERSION) === 1) {
    return text;
  }

  const { changed, result } = migrateConfigShape(raw);
  if (!changed) {
    return text;
  }

  const migratedText = `${JSON.stringify(result, null, 2)}\n`;

  if (process.env.AKM_NO_AUTO_MIGRATE !== "1") {
    try {
      backupExistingConfig(configPath);
      writeConfigObject(configPath, result);
      warn(
        `[akm] Config at ${configPath} migrated to ${result.configVersion ?? "0.8.0"} format. Backup written to cache dir.`,
      );
    } catch (err) {
      // #461: if we can't persist the migration, do NOT return the migrated
      // in-memory shape — that triggers an infinite re-migrate loop on every
      // load. Throw a hard error so the user notices and resolves the disk
      // issue (or sets AKM_NO_AUTO_MIGRATE=1 + runs `akm config migrate`).
      const detail = err instanceof Error ? err.message : String(err);
      throw new ConfigError(
        `Failed to write migrated config to ${configPath}: ${detail}`,
        "INVALID_CONFIG_FILE",
        "Check filesystem permissions, free space, and disk health. To skip the auto-migration " +
          "until the issue is resolved, set AKM_NO_AUTO_MIGRATE=1.",
      );
    }
  }

  return migratedText;
}

export function loadConfig(): AkmConfig {
  // Single-layer load: only the user-level config file is read. Project-level
  // .akm/config.json files discovered under cwd-ancestors emit a one-time
  // deprecation warning (#457) but are NOT merged. Removed in this release;
  // the warning stays for one cycle to help users notice they have a now-dead
  // file on disk.
  warnIfProjectConfigPresent(process.cwd());

  const userConfigPath = getConfigPath();
  const signature = `${userConfigPath}:${getFileSignatureToken(userConfigPath)}`;
  if (cachedConfig && cachedConfig.signature === signature) {
    return cachedConfig.config;
  }

  const config = loadUserConfig();
  const finalConfig = applyRuntimeEnvApiKeys(config);
  cachedConfig = { config: finalConfig, signature };
  return finalConfig;
}

export function saveConfig(config: AkmConfig): void {
  clearAllCaches();
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  const sanitized = sanitizeConfigForWrite(config);

  // Final validation gate before bytes hit disk. Catches schema violations
  // (unknown keys in registries[] / sources[] / profiles.*; out-of-range
  // numbers; etc. — closes #462) before we corrupt the user's config.
  const parseResult = AkmConfigSchema.safeParse(sanitized);
  if (!parseResult.success) {
    const lines = parseResult.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(
      `Refusing to save invalid config:\n${lines}`,
      "INVALID_CONFIG_FILE",
      "Fix the listed fields, or undo the offending `akm config set`. " +
        "If this looks like an akm bug, re-run with --debug to attach the traceback.",
    );
  }

  backupExistingConfig(configPath);
  writeConfigObject(configPath, sanitized);
}

/** Maximum number of timestamped config backups to retain (#459). */
const MAX_CONFIG_BACKUPS = 5;

function backupExistingConfig(configPath: string): void {
  if (!fs.existsSync(configPath)) return;

  const backupDir = path.join(getCacheDir(), "config-backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const backupPath = path.join(backupDir, `config-${timestamp}.json`);
  fs.copyFileSync(configPath, backupPath);

  const latestPath = path.join(backupDir, "config.latest.json");
  fs.copyFileSync(configPath, latestPath);

  pruneOldBackups(backupDir);
}

/**
 * Keep only the {@link MAX_CONFIG_BACKUPS} most-recent timestamped backups
 * (#459). `config.latest.json` is preserved separately as the always-newest
 * pointer.
 */
function pruneOldBackups(backupDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDir);
  } catch {
    return;
  }
  const timestamped = entries
    .filter((name) => name.startsWith("config-") && name.endsWith(".json") && name !== "config.latest.json")
    .map((name) => ({ name, path: path.join(backupDir, name) }))
    .map((entry) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(entry.path).mtimeMs;
      } catch {
        // Drop unreadable entries by giving them mtime 0 (they sort to the end).
      }
      return { ...entry, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  for (const stale of timestamped.slice(MAX_CONFIG_BACKUPS)) {
    try {
      fs.unlinkSync(stale.path);
    } catch {
      // Ignore — best-effort prune. The next save will retry.
    }
  }
}

/**
 * Strip apiKey fields before writing config to disk.
 * API keys should be provided via environment variables
 * AKM_EMBED_API_KEY and AKM_LLM_API_KEY.
 */
function sanitizeConfigForWrite(config: AkmConfig): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...config };
  if (config.embedding) {
    const { apiKey, ...rest } = config.embedding;
    sanitized.embedding = rest;
  }
  if (config.profiles?.llm) {
    const llmProfiles: Record<string, unknown> = {};
    for (const [name, profile] of Object.entries(config.profiles.llm)) {
      const { apiKey: _apiKey, ...rest } = profile;
      llmProfiles[name] = rest;
    }
    sanitized.profiles = {
      ...((sanitized.profiles as Record<string, unknown> | undefined) ?? {}),
      llm: llmProfiles,
    };
  }
  // Drop empty keys to keep config clean
  return sanitized;
}

export function updateConfig(partial: Partial<AkmConfig>): AkmConfig {
  const current = loadUserConfig();
  const merged = mergeLoadedConfig(current, partial);
  saveConfig(merged);
  return merged;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a single secret value by expanding `${VAR}` / `$VAR` /
 * `${VAR:-default}` references against `process.env`. Use this at apiKey /
 * authorization-header consumption sites (LLM client, embedder, agent SDK
 * runner) — NOT on the load path. Non-string inputs pass through unchanged.
 *
 * Returns the input unchanged when no substitution markers are present, so
 * literal API key strings (already-resolved secrets) are zero-cost.
 *
 * Other config string values (URLs, endpoints, model names, prompts) are
 * preserved verbatim on read — only fields explicitly routed through this
 * helper are expanded.
 */
export function resolveSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;
  if (!value.includes("$")) return value;
  return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    if (braced) {
      const [name, ...rest] = (braced as string).split(":-");
      const fallback = rest.join(":-");
      return process.env[name] ?? fallback ?? "";
    }
    return process.env[bare as string] ?? "";
  });
}

function parseConfigObjectFromText(text: string, sourcePath?: string): Record<string, unknown> {
  // #458: malformed JSON or non-object root raises ConfigError. Silent
  // fallback to DEFAULT_CONFIG masked real corruption from users.
  const where = sourcePath ? ` at ${sourcePath}` : "";
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `Failed to parse config JSON${where}: ${detail}`,
      "INVALID_CONFIG_FILE",
      "Edit the file to fix the JSON syntax error. Comments (// and /* */) are allowed; trailing commas are not.",
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `Config file${where} must contain a JSON object at the root, got ${describeJsonRoot(raw)}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return raw as Record<string, unknown>;
}

function describeJsonRoot(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return "a string";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "a boolean";
  return typeof value;
}

function writeConfigObject(configPath: string, config: Record<string, unknown>): void {
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Strip JavaScript-style comments from a JSON string (JSONC support).
 * Handles // line comments and /* block comments while preserving
 * comment-like sequences inside quoted strings.
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\") {
        result += text[i] + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }
    // JSON only uses double-quoted strings; single quotes are not valid JSON
    if (text[i] === '"') {
      inString = true;
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

/**
 * Read a per-pass {@link IndexPassConfig} entry from {@link IndexConfig},
 * filtering out the reserved feature-section keys so callers don't mistake
 * `metadataEnhance` / `stalenessDetection` for a pass.
 */
/** Reserved well-known keys on IndexConfig that are NOT per-pass entries. */
const INDEX_RESERVED_KEYS = new Set(["metadataEnhance", "stalenessDetection"]);

export function getIndexPassConfig(config: IndexConfig | undefined, passName: string): IndexPassConfig | undefined {
  if (!config) return undefined;
  if (INDEX_RESERVED_KEYS.has(passName)) return undefined;
  const entry = config[passName];
  if (!entry || typeof entry !== "object") return undefined;
  return entry as IndexPassConfig;
}

// ── ConfiguredSource runtime construction ─────────────────────────────────────────

/**
 * Synthesize a stable identifier when a {@link SourceConfigEntry} omits its
 * `name`. Uses a short hash of the discriminating fields so two equivalent
 * entries collapse to the same generated name.
 */
function deriveStashEntryName(entry: SourceConfigEntry): string {
  if (entry.name) return entry.name;
  const seed = JSON.stringify({
    type: entry.type,
    path: entry.path ?? null,
    url: entry.url ?? null,
  });
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${entry.type}-${hash}`;
}

/**
 * Convert a persisted {@link SourceConfigEntry} into the runtime
 * {@link SourceSpec} discriminated union. Returns `undefined` when the
 * entry is missing the fields its provider type requires (e.g. a
 * `filesystem` entry with no `path`); callers should drop or warn for those.
 *
 * Unknown provider types fall back to `{ type: "filesystem", path: ... }` when
 * a `path` is supplied, so future provider types still produce a usable
 * runtime value.
 */
export function parseSourceSpec(entry: SourceConfigEntry): SourceSpec | undefined {
  switch (entry.type) {
    case "filesystem":
      return entry.path ? { type: "filesystem", path: entry.path } : undefined;
    case "git":
      return entry.url ? { type: "git", url: entry.url } : undefined;
    case "website":
      return entry.url
        ? {
            type: "website",
            url: entry.url,
            ...(typeof entry.options?.maxPages === "number" ? { maxPages: entry.options.maxPages as number } : {}),
          }
        : undefined;
    case "npm":
      // Persisted `npm` stash entries are unusual but supported for symmetry.
      return entry.path ? { type: "npm", package: entry.path } : undefined;
    default:
      // Unknown provider — best-effort fallback so callers still get something.
      return entry.path ? { type: "filesystem", path: entry.path } : undefined;
  }
}

/**
 * Build the full ordered list of runtime {@link ConfiguredSource} values from a
 * loaded {@link AkmConfig}. Order is the canonical iteration order:
 *
 *   1. The entry marked `primary: true` (or, as a backwards-compat shim,
 *      a synthetic filesystem entry built from the top-level `stashDir`).
 *   2. Remaining `sources[]` entries in declared order.
 *   3. Legacy `installed[]` entries, mapped into runtime entries.
 *
 * Entries with `enabled: false` are still emitted — callers decide whether
 * to honour the flag (mirrors how `installed[]` entries have always been
 * unconditional). Entries that fail {@link parseSourceSpec} are
 * dropped silently.
 */
export function resolveConfiguredSources(config: AkmConfig): ConfiguredSource[] {
  const entries: ConfiguredSource[] = [];
  const sources = config.sources ?? [];

  // (1) Primary entry: explicit `primary: true` wins; fall back to top-level stashDir.
  let primary = sources.find((entry) => entry.primary === true);
  if (!primary && config.stashDir) {
    primary = { type: "filesystem", path: config.stashDir, primary: true };
  }
  if (primary) {
    const runtime = toConfiguredSource(primary, true);
    if (runtime) entries.push(runtime);
  }

  // (2) Declared sources (skip the primary entry — already added).
  for (const entry of sources) {
    if (entry === primary) continue;
    const runtime = toConfiguredSource(entry, false);
    if (runtime) entries.push(runtime);
  }

  // (3) Legacy installed[] entries.
  for (const installed of config.installed ?? []) {
    entries.push({
      name: installed.id,
      type: "filesystem",
      source: { type: "filesystem", path: installed.stashRoot },
      enabled: true,
      writable: installed.writable,
      ...(installed.wikiName ? { wikiName: installed.wikiName } : {}),
    });
  }

  return entries;
}

function toConfiguredSource(persisted: SourceConfigEntry, isPrimary: boolean): ConfiguredSource | undefined {
  const source = parseSourceSpec(persisted);
  if (!source) return undefined;
  return {
    name: deriveStashEntryName(persisted),
    type: persisted.type,
    source,
    ...(persisted.enabled !== undefined ? { enabled: persisted.enabled } : {}),
    ...(persisted.writable !== undefined ? { writable: persisted.writable } : {}),
    ...(isPrimary || persisted.primary ? { primary: true } : {}),
    ...(persisted.options ? { options: persisted.options } : {}),
    ...(persisted.wikiName ? { wikiName: persisted.wikiName } : {}),
  };
}

/**
 * Merge a partial user-config override onto a base config. Used for two
 * single-layer cases:
 *   1) {@link loadUserConfig} layering normalized disk config on top of
 *      {@link DEFAULT_CONFIG}.
 *   2) {@link updateConfig} layering a partial patch on top of the currently
 *      loaded user config.
 *
 * Multi-layer (project + user) merging is no longer supported — see
 * {@link loadConfig} and {@link warnIfProjectConfigPresent}.
 */
function mergeLoadedConfig(base: AkmConfig, override?: Partial<AkmConfig>): AkmConfig {
  if (!override) return { ...base };

  const merged: AkmConfig = {
    ...base,
    ...override,
  };

  if (base.output && override.output) {
    merged.output = { ...base.output, ...override.output };
  }
  if (base.embedding && override.embedding) {
    merged.embedding = { ...base.embedding, ...override.embedding };
  }
  if (base.index && override.index) {
    merged.index = { ...base.index, ...override.index };
  }
  if (base.profiles && override.profiles) {
    const mergedProfiles: NonNullable<AkmConfig["profiles"]> = { ...base.profiles };
    if (override.profiles.llm) {
      mergedProfiles.llm = { ...(mergedProfiles.llm ?? {}), ...override.profiles.llm };
    }
    if (override.profiles.agent) {
      mergedProfiles.agent = { ...(mergedProfiles.agent ?? {}), ...override.profiles.agent };
    }
    if (override.profiles.improve) {
      mergedProfiles.improve = { ...(mergedProfiles.improve ?? {}), ...override.profiles.improve };
    }
    merged.profiles = mergedProfiles;
  }
  if (base.defaults && override.defaults) {
    merged.defaults = { ...base.defaults, ...override.defaults };
  }
  if (base.security && override.security) {
    merged.security = { ...base.security, ...override.security };
  }
  // sources: override wins entirely when provided (single-layer semantics).
  if (override.sources !== undefined) {
    merged.sources = override.sources;
  }

  return merged;
}

function applyRuntimeEnvApiKeys(config: AkmConfig): AkmConfig {
  const next = { ...config };

  if (next.embedding && !next.embedding.apiKey) {
    const envKey = process.env.AKM_EMBED_API_KEY?.trim();
    if (envKey) next.embedding = { ...next.embedding, apiKey: envKey };
  }

  // v2: inject AKM_LLM_API_KEY into the default LLM profile
  if (next.profiles?.llm && next.defaults?.llm) {
    const defaultProfileName = next.defaults.llm;
    const defaultProfile = next.profiles.llm[defaultProfileName];
    if (defaultProfile && !defaultProfile.apiKey) {
      const envKey = process.env.AKM_LLM_API_KEY?.trim();
      if (envKey) {
        next.profiles = {
          ...next.profiles,
          llm: {
            ...next.profiles.llm,
            [defaultProfileName]: { ...defaultProfile, apiKey: envKey },
          },
        };
      }
    }
  }

  // v2: per-profile AKM_PROFILE_<UPPER_NAME>_API_KEY
  if (next.profiles?.llm) {
    const updatedLlmProfiles = { ...next.profiles.llm };
    let changed = false;
    for (const [profileName, profile] of Object.entries(updatedLlmProfiles)) {
      if (!profile.apiKey) {
        const envVarName = `AKM_PROFILE_${profileName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
        const envKey = process.env[envVarName]?.trim();
        if (envKey) {
          updatedLlmProfiles[profileName] = { ...profile, apiKey: envKey };
          changed = true;
        }
      }
    }
    if (changed) {
      next.profiles = { ...next.profiles, llm: updatedLlmProfiles };
    }
  }

  return next;
}

/**
 * Walk cwd-ancestors looking for `.akm/config.json`. If one is found, emit a
 * one-time deprecation warning per path. The file's contents are NOT read —
 * multi-layer project config was removed in this release; the warning stays
 * for one cycle so users notice they have a now-dead file on disk and can
 * migrate its settings to the user-level config.
 */
const PROJECT_CONFIG_DEPRECATION_WARNED = new Set<string>();
function warnIfProjectConfigPresent(startDir: string): void {
  let currentDir = path.resolve(startDir);
  while (true) {
    const configPath = path.join(currentDir, PROJECT_CONFIG_RELATIVE_PATH);
    if (isFile(configPath) && !PROJECT_CONFIG_DEPRECATION_WARNED.has(configPath)) {
      PROJECT_CONFIG_DEPRECATION_WARNED.add(configPath);
      warn(
        `[akm] DEPRECATED: project-level config file found at ${configPath}. ` +
          "Project-level config files are no longer merged (removed after 0.8.x deprecation). " +
          "Move any needed settings to ~/.config/akm/config.json; this file is ignored.",
      );
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getFileSignatureToken(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}
