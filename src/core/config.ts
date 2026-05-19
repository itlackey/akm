import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type AgentConfig, parseAgentConfig } from "../integrations/agent/config";
import type { InstalledStashEntry, KitSource } from "../registry/types";
import { asNonEmptyString, filterNonEmptyStrings, writeFileAtomic } from "./common";
import { migrateConfigShape } from "./config-migration";
import { ConfigError } from "./errors";
import { getCacheDir, getConfigPath } from "./paths";
import { warn } from "./warn";

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

export interface EmbeddingConnectionConfig extends BaseConnectionConfig {
  /** Optional output dimension for providers that support it */
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
   * v1 spec §14 — bounded in-tree LLM feature gates. Each call site is
   * gated behind exactly one key. Unknown keys are warn-and-ignored at
   * config-load time. Currently only `memory_inference` is parsed by this
   * loader; remaining locked keys are accepted into the schema as later
   * issues wire them in.
   */
  features?: LlmFeatureFlags;
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

export interface ProcessEntry {
  enabled?: boolean;
  mode?: "llm" | "agent" | "sdk";
  profile?: string;
  timeoutMs?: number | null;
  options?: Record<string, unknown>;
}

export interface FeaturesConfig {
  /**
   * Per-process runner overrides for the `improve` section (reflect, distill,
   * propose, memory_consolidation, feedback_distillation, etc.).
   *
   * Known keys include:
   *  - `validation`: third model tier (Advantage D3). A lower-cost classifier
   *    runner used by staleness detection, confidence scoring, and lesson
   *    classification. Default: off — callers fall back to `defaults.llm`
   *    via {@link resolveValidationRunner}. Set this to point at a cheap
   *    profile (for example a small local model) when running large
   *    improvement passes where the primary model would be overkill.
   */
  improve?: Record<string, ProcessEntry | boolean>;
  index?: Record<string, ProcessEntry | boolean>;
  search?: Record<string, ProcessEntry | boolean>;
}

export interface LlmFeatureFlags {
  /** Gates the `akm index` memory-inference pass (#201). Default: true. */
  memory_inference?: boolean;
  /**
   * Gates the `akm index` graph-extraction pass (#207). Default: true (the
   * pass is still off by default unless `akm.llm` is configured AND
   * `index.graph.llm !== false`, per the orthogonal-gates rule in v1
   * spec §14). Set to `false` to block every graph_extraction call site
   * regardless of any per-pass setting.
   */
  graph_extraction?: boolean;
  /**
   * Gates the `akm curate` LLM-rerank pass (#227). Default: false.
   * When false (or absent) curate falls back to the deterministic pipeline.
   */
  curate_rerank?: boolean;
  /**
   * Gates `akm distill <ref>` (§14.5, #227). Default: false.
   * When false (or absent), `akm distill` is skipped as a no-op rather than
   * failing with `ConfigError`.
   */
  feedback_distillation?: boolean;
  /**
   * Gates `akm consolidate` memory deduplication and promotion. Default: false.
   * When false (or absent), `akm consolidate` throws a ConfigError.
   */
  memory_consolidation?: boolean;
  /**
   * Gates the LLM-as-judge quality gate in `akmDistill`. When enabled, each
   * generated lesson is scored on novelty, actionability, and non-redundancy
   * before entering the proposal queue. Fail-open: judge failures always pass.
   * Default: false.
   */
  lesson_quality_gate?: boolean;
  /**
   * Gates the LLM-as-judge quality gate on reflect proposals (R-5 / #374).
   *
   * When true, each proposal from `akm reflect` is scored by the judge before
   * entering the proposal queue. Fail-open: judge failures always pass. Uses the
   * same `runLessonQualityJudge` infrastructure as `lesson_quality_gate`.
   *
   * Also extends `lesson_quality_gate` semantics — both flags are checked by
   * the reflect quality gate. Set either to enable it on reflect proposals.
   * Default: false.
   */
  proposal_quality_gate?: boolean;
  /**
   * Gates the `akm index` metadata-enhancement pass. Default: false.
   * When false (or absent), metadata enhancement is skipped and falls back to
   * returning an empty enrichment object (no description/searchHints/tags update).
   */
  metadata_enhance?: boolean;
  /**
   * Gates the M-1 contradiction-detection pass in `akm improve` (#367).
   * Default: false. When enabled, derived memories within the same parent family
   * are checked pairwise for contradictions using an LLM judge, and
   * `contradictedBy` edges are written to their frontmatter so the SCC resolver
   * in `resolveFamilyContradictions` has edges to work on.
   */
  memory_contradiction_detection?: boolean;
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
  };
  /** v2: default profile names and improve pipeline defaults. */
  defaults?: {
    llm?: string;
    agent?: string;
    improve?: {
      limit?: number;
      preset?: "fast" | "thorough" | "mixed" | "custom";
    };
  };
  /** v2: unified features tree replacing the old top-level features flags. */
  features?: FeaturesConfig;
  /** Path to the working stash directory. Resolved from env → config → default. */
  stashDir?: string;
  /** User preference for semantic search. "auto" means use semantic search whenever runtime prerequisites are healthy. */
  semanticSearchMode: "off" | "auto";
  /** OpenAI-compatible embedding endpoint config. If not set, uses local @huggingface/transformers */
  embedding?: EmbeddingConnectionConfig;
  /** OpenAI-compatible LLM endpoint config for metadata generation. If not set, uses heuristic generation */
  llm?: LlmConnectionConfig;
  /**
   * Per-pass `akm index` configuration. See {@link IndexPassConfig}. Each
   * pass defaults to the top-level `akm.llm` block; setting
   * `index.<pass>.llm = false` opts a pass out. Per-pass alternative provider
   * configuration is intentionally not supported (#208).
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
  /**
   * When set on a later config layer (typically project config), controls how
   * the layer's `stashes` interact with stashes inherited from earlier layers.
   * - `"merge"` (default): append the layer's stashes to the inherited list.
   * - `"replace"`: discard the inherited stashes before applying this layer's.
   */
  stashInheritance?: "merge" | "replace";
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
   * Optional agent CLI integration block (v1 spec §12). Configures
   * external agent CLIs that akm can shell out to. Missing block disables
   * agent commands; unknown nested keys are warn-and-ignored. Built-in
   * profiles ship for opencode, claude, codex, gemini, aider — users can
   * override or add profiles via `agent.profiles[<name>]`.
   */
  agent?: AgentConfig;
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

/**
 * Per-type reflect cooldown configuration for `akm improve`.
 * Each key is an asset type (`memory`, `knowledge`, `skill`, etc.) and the
 * value is the cooldown window in days. Set a type to 0 to disable cooldown
 * for that type. Unknown type keys are accepted and used as-is.
 */
export interface ImproveConfig {
  /**
   * Per-asset-type reflect cooldown in days. Overrides the built-in defaults
   * for any type listed. Types not listed continue to use their built-in default.
   *
   * Built-in defaults:
   *   memory: 2, lesson: 7, workflow/skill/agent/command/knowledge/script/wiki: 30, task: 60
   *
   * Example:
   * ```json
   * { "improve": { "reflectCooldownByType": { "memory": 1, "knowledge": 60 } } }
   * ```
   */
  reflectCooldownByType?: Record<string, number>;
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
 * Index-time configuration. The keys are pass names; values are
 * {@link IndexPassConfig}. Unknown pass names are accepted (so future passes
 * configure via the same shape) but their entries are validated for shape.
 */
export type IndexConfig = Record<string, IndexPassConfig>;

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

// ── Paths ───────────────────────────────────────────────────────────────────

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Returns `value` if it is a finite positive integer; otherwise `undefined`.
 * Used to validate numeric config fields like `dimension`, `contextLength`,
 * `timeoutMs`, `maxTokens`, and `ollamaOptions.num_ctx`.
 */
function parsePositiveInteger(_fieldPath: string, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Returns `value` if it is a string present in `allowed`; otherwise `undefined`.
 */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/**
 * Validates that `url` starts with `http://` or `https://`. Returns `url` on
 * success and warns+returns `undefined` on failure. `fieldName` is used only
 * in the warning message.
 */
function isValidHttpUrl(url: unknown, fieldName: string): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    warn(`[akm] Ignoring ${fieldName}: endpoint must start with http:// or https://, got "${url}"`);
    return undefined;
  }
  return url;
}

function clearAllCaches(): void {
  cachedConfig = undefined;
  cachedUserConfig = undefined;
}

// ── Load / Save / Update ────────────────────────────────────────────────────

const PROJECT_CONFIG_RELATIVE_PATH = path.join(".akm", "config.json");

let cachedConfig: { config: AkmConfig; signature: string } | undefined;
let cachedUserConfig: { config: AkmConfig; path: string; mtime: number; size: number; contentHash: string } | undefined;

export function resetConfigCache(): void {
  clearAllCaches();
}

function hashString(text: string): string {
  // Simple, fast non-cryptographic hash (FNV-1a 32-bit) — sufficient to detect
  // content changes between config writes when filesystem mtime resolution is
  // too coarse to reflect rapid back-to-back writes (common in tests).
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
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

  // Cache key combines mtimeMs + size + content hash. mtimeMs alone is unreliable
  // when tests write multiple times within the filesystem mtime resolution
  // window (often 1ms+). Reading + hashing on cache miss is cheap and ensures
  // we never serve stale config.
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

  const contentHash = hashString(text);

  if (
    cachedUserConfig &&
    cachedUserConfig.path === configPath &&
    cachedUserConfig.mtime === stat.mtimeMs &&
    cachedUserConfig.size === stat.size &&
    cachedUserConfig.contentHash === contentHash
  ) {
    return cachedUserConfig.config;
  }

  const config = mergeLoadedConfig(DEFAULT_CONFIG, readNormalizedConfigFromText(text));
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
    contentHash,
  };
  return finalConfig;
}

export function getSources(config: AkmConfig): SourceConfigEntry[] {
  return config.sources ?? [];
}

export function getEffectiveRegistries(config: AkmConfig): RegistryConfigEntry[] {
  return config.registries ?? DEFAULT_CONFIG.registries ?? [];
}

export function requireLlmConfig(config: AkmConfig): LlmConnectionConfig {
  if (!config.llm)
    throw new ConfigError("LLM is not configured. Run `akm config set llm` to configure one.", "LLM_NOT_CONFIGURED");
  return config.llm;
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
    } catch {
      warn(`[akm] Could not write migrated config to ${configPath}. Run 'akm config migrate' manually.`);
    }
  }

  return migratedText;
}

export function loadConfig(): AkmConfig {
  const configPaths = getEffectiveConfigPaths();
  const signature = getConfigSignature(configPaths);
  if (cachedConfig && cachedConfig.signature === signature) {
    return cachedConfig.config;
  }

  let config = loadUserConfig();
  const userConfigPath = getConfigPath();
  for (const configPath of configPaths) {
    if (configPath === userConfigPath) continue;
    config = mergeLoadedConfig(config, readNormalizedConfig(configPath));
  }

  const finalConfig = applyRuntimeEnvApiKeys(config);
  cachedConfig = { config: finalConfig, signature };
  return finalConfig;
}

export function saveConfig(config: AkmConfig): void {
  clearAllCaches();
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  backupExistingConfig(configPath);
  const sanitized = sanitizeConfigForWrite(config);
  writeConfigObject(configPath, sanitized);
}

function backupExistingConfig(configPath: string): void {
  if (!fs.existsSync(configPath)) return;

  const backupDir = path.join(getCacheDir(), "config-backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const backupPath = path.join(backupDir, `config-${timestamp}.json`);
  fs.copyFileSync(configPath, backupPath);

  const latestPath = path.join(backupDir, "config.latest.json");
  fs.copyFileSync(configPath, latestPath);
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
  if (config.llm) {
    const { apiKey, ...rest } = config.llm;
    sanitized.llm = rest;
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
 * Normalize a raw config object into a sparse config layer containing only
 * recognized keys that were valid in the source object. This function does not
 * merge with DEFAULT_CONFIG; callers are responsible for layering defaults and
 * combining multiple config sources so project config files only override what
 * they set.
 */
function parseConfigLayer(raw: Record<string, unknown>): Partial<AkmConfig> {
  const config: Partial<AkmConfig> = {};

  if (typeof raw.stashDir === "string" && raw.stashDir.trim()) {
    config.stashDir = raw.stashDir.trim();
  }

  // Backward compatibility: coerce legacy boolean values to string
  if (typeof raw.semanticSearchMode === "boolean") {
    config.semanticSearchMode = raw.semanticSearchMode ? "auto" : "off";
  } else if (isOneOf(raw.semanticSearchMode, ["off", "auto"] as const)) {
    config.semanticSearchMode = raw.semanticSearchMode;
  }

  const embedding = parseEmbeddingConfig(raw.embedding);
  if (embedding) config.embedding = embedding;

  const llm = parseLlmConfig(raw.llm);
  if (llm) config.llm = llm;

  const index = parseIndexConfig(raw.index);
  if (index) config.index = index;

  const installed = parseInstalledEntries(raw.installed);
  if (installed) config.installed = installed;

  const registries = parseRegistriesConfig(raw.registries);
  if (registries) config.registries = registries;

  if (isOneOf(raw.stashInheritance, ["replace", "merge"] as const)) {
    config.stashInheritance = raw.stashInheritance;
  }

  if (Array.isArray((raw as Record<string, unknown>).stashes)) {
    throw new ConfigError(
      "The legacy `stashes[]` config key is no longer supported. Rename it to `sources`.",
      "INVALID_CONFIG_FILE",
    );
  }

  const sources = parseSourcesConfig(raw.sources);
  if (sources) {
    config.sources = sources;
  }

  const security = parseSecurityConfig(raw.security);
  if (security) config.security = security;

  const output = parseOutputConfig(raw.output);
  if (output) config.output = output;

  if (typeof raw.writable === "boolean") {
    config.writable = raw.writable;
  }

  if (typeof raw.defaultWriteTarget === "string" && raw.defaultWriteTarget.trim()) {
    config.defaultWriteTarget = raw.defaultWriteTarget.trim();
  }

  if ("agent" in raw) {
    const agent = parseAgentConfig(raw.agent);
    if (agent) config.agent = agent;
  }

  if (typeof raw.search === "object" && raw.search !== null && !Array.isArray(raw.search)) {
    const searchRaw = raw.search as Record<string, unknown>;
    const searchConfig: AkmConfig["search"] = {};
    for (const key of Object.keys(searchRaw)) {
      if (key !== "minScore" && key !== "graphBoost") {
        warn(`[akm] Ignoring unknown search key "${key}".`);
      }
    }
    if (typeof searchRaw.minScore === "number" && Number.isFinite(searchRaw.minScore) && searchRaw.minScore >= 0) {
      searchConfig.minScore = searchRaw.minScore;
    }
    if (
      typeof searchRaw.graphBoost === "object" &&
      searchRaw.graphBoost !== null &&
      !Array.isArray(searchRaw.graphBoost)
    ) {
      const graphBoostRaw = searchRaw.graphBoost as Record<string, unknown>;
      const graphBoostConfig: NonNullable<AkmConfig["search"]>["graphBoost"] = {};
      for (const key of Object.keys(graphBoostRaw)) {
        if (
          key !== "directBoostPerEntity" &&
          key !== "directBoostCap" &&
          key !== "hopBoostPerEntity" &&
          key !== "hopBoostCap" &&
          key !== "maxHops" &&
          key !== "confidenceMode" &&
          key !== "confidenceWeight"
        ) {
          warn(`[akm] Ignoring unknown search.graphBoost key "${key}".`);
        }
      }

      const directBoostPerEntity = parseNonNegativeNumber(graphBoostRaw.directBoostPerEntity);
      if (directBoostPerEntity !== undefined) graphBoostConfig.directBoostPerEntity = directBoostPerEntity;

      const directBoostCap = parseNonNegativeNumber(graphBoostRaw.directBoostCap);
      if (directBoostCap !== undefined) graphBoostConfig.directBoostCap = directBoostCap;

      const hopBoostPerEntity = parseNonNegativeNumber(graphBoostRaw.hopBoostPerEntity);
      if (hopBoostPerEntity !== undefined) graphBoostConfig.hopBoostPerEntity = hopBoostPerEntity;

      const hopBoostCap = parseNonNegativeNumber(graphBoostRaw.hopBoostCap);
      if (hopBoostCap !== undefined) graphBoostConfig.hopBoostCap = hopBoostCap;

      const maxHops = parsePositiveInteger("search.graphBoost.maxHops", graphBoostRaw.maxHops);
      if (maxHops !== undefined) graphBoostConfig.maxHops = Math.min(maxHops, 3);

      if (isOneOf(graphBoostRaw.confidenceMode, ["off", "blend", "multiply"] as const)) {
        graphBoostConfig.confidenceMode = graphBoostRaw.confidenceMode;
      }

      const confidenceWeight = parseNonNegativeNumber(graphBoostRaw.confidenceWeight);
      if (confidenceWeight !== undefined) graphBoostConfig.confidenceWeight = Math.min(confidenceWeight, 1);

      if (Object.keys(graphBoostConfig).length > 0) searchConfig.graphBoost = graphBoostConfig;
    }
    if (Object.keys(searchConfig).length > 0) config.search = searchConfig;
  }

  if (typeof raw.feedback === "object" && raw.feedback !== null && !Array.isArray(raw.feedback)) {
    const feedbackRaw = raw.feedback as Record<string, unknown>;
    const feedbackConfig: AkmConfig["feedback"] = {};
    if (typeof feedbackRaw.requireReason === "boolean") {
      feedbackConfig.requireReason = feedbackRaw.requireReason;
    }
    // F-3 / #384: parse allowedFailureModes override list.
    if (Array.isArray(feedbackRaw.allowedFailureModes)) {
      feedbackConfig.allowedFailureModes = feedbackRaw.allowedFailureModes.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
    }
    if (Object.keys(feedbackConfig).length > 0) config.feedback = feedbackConfig;
  }

  if (
    typeof raw.archiveRetentionDays === "number" &&
    Number.isFinite(raw.archiveRetentionDays) &&
    raw.archiveRetentionDays >= 0
  ) {
    config.archiveRetentionDays = raw.archiveRetentionDays;
  }

  if (raw.improve !== null && typeof raw.improve === "object") {
    const improveRaw = raw.improve as Record<string, unknown>;
    const improveConfig: ImproveConfig = {};
    if (improveRaw.reflectCooldownByType !== null && typeof improveRaw.reflectCooldownByType === "object") {
      const byType: Record<string, number> = {};
      for (const [type, days] of Object.entries(improveRaw.reflectCooldownByType as Record<string, unknown>)) {
        if (typeof days === "number" && Number.isFinite(days) && days >= 0) {
          byType[type] = days;
        } else {
          warn(`[akm] Ignoring improve.reflectCooldownByType["${type}"]: expected a non-negative number.`);
        }
      }
      if (Object.keys(byType).length > 0) improveConfig.reflectCooldownByType = byType;
    }
    // Phase 2A / Rec 5: configurable forgetting curve.
    if (improveRaw.utilityDecay !== null && typeof improveRaw.utilityDecay === "object") {
      const decayRaw = improveRaw.utilityDecay as Record<string, unknown>;
      const decay: NonNullable<ImproveConfig["utilityDecay"]> = {};
      if (
        typeof decayRaw.halfLifeDays === "number" &&
        Number.isFinite(decayRaw.halfLifeDays) &&
        decayRaw.halfLifeDays >= 0.1
      ) {
        decay.halfLifeDays = decayRaw.halfLifeDays;
      } else if (decayRaw.halfLifeDays !== undefined) {
        warn(`[akm] Ignoring improve.utilityDecay.halfLifeDays: expected a number ≥ 0.1.`);
      }
      if (
        typeof decayRaw.feedbackStabilityBoost === "number" &&
        Number.isFinite(decayRaw.feedbackStabilityBoost) &&
        decayRaw.feedbackStabilityBoost >= 1.0
      ) {
        decay.feedbackStabilityBoost = decayRaw.feedbackStabilityBoost;
      } else if (decayRaw.feedbackStabilityBoost !== undefined) {
        warn(`[akm] Ignoring improve.utilityDecay.feedbackStabilityBoost: expected a number ≥ 1.0.`);
      }
      if (Object.keys(decay).length > 0) improveConfig.utilityDecay = decay;
    }
    if (Object.keys(improveConfig).length > 0) config.improve = improveConfig;
  }

  // v2 fields
  if (typeof raw.configVersion === "number" && Number.isFinite(raw.configVersion)) {
    config.configVersion = raw.configVersion;
  } else if (typeof raw.configVersion === "string" && raw.configVersion.trim()) {
    config.configVersion = raw.configVersion.trim();
  }

  const profiles = parseProfilesConfig(raw.profiles);
  if (profiles) config.profiles = profiles;

  const defaults = parseDefaultsConfig(raw.defaults);
  if (defaults) config.defaults = defaults;

  const features = parseFeaturesConfig(raw.features);
  if (features) config.features = features;

  return config;
}

function parseLlmProfileConfig(obj: Record<string, unknown>): LlmProfileConfig | undefined {
  const base = parseLlmConfig(obj);
  if (!base) return undefined;
  const profile: LlmProfileConfig = { ...base };
  if (typeof obj.supportsJsonSchema === "boolean") {
    profile.supportsJsonSchema = obj.supportsJsonSchema;
  }
  return profile;
}

function parseAgentProfileConfigV2(obj: Record<string, unknown>): AgentProfileConfigV2 | undefined {
  const VALID_PLATFORMS = ["opencode", "claude", "opencode-sdk"] as const;
  if (!isOneOf(obj.platform, VALID_PLATFORMS)) {
    warn(
      `[akm] Ignoring agent profile: missing or invalid "platform" (must be one of: ${VALID_PLATFORMS.join(", ")}).`,
    );
    return undefined;
  }
  const profile: AgentProfileConfigV2 = { platform: obj.platform };
  if (typeof obj.bin === "string" && obj.bin.trim()) profile.bin = obj.bin.trim();
  if (Array.isArray(obj.args) && obj.args.every((a) => typeof a === "string")) {
    profile.args = obj.args as string[];
  }
  if (typeof obj.workspace === "string" && obj.workspace.trim()) profile.workspace = obj.workspace.trim();
  if (typeof obj.model === "string" && obj.model.trim()) profile.model = obj.model.trim();
  return profile;
}

function parseProfilesConfig(value: unknown): AkmConfig["profiles"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const result: NonNullable<AkmConfig["profiles"]> = {};

  if (typeof obj.llm === "object" && obj.llm !== null && !Array.isArray(obj.llm)) {
    const llmMap: Record<string, LlmProfileConfig> = {};
    for (const [name, raw] of Object.entries(obj.llm as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        warn(`[akm] Ignoring profiles.llm["${name}"]: expected an object.`);
        continue;
      }
      const parsed = parseLlmProfileConfig(raw as Record<string, unknown>);
      if (parsed) llmMap[name] = parsed;
      else warn(`[akm] Ignoring profiles.llm["${name}"]: invalid or incomplete LLM connection config.`);
    }
    if (Object.keys(llmMap).length > 0) result.llm = llmMap;
  }

  if (typeof obj.agent === "object" && obj.agent !== null && !Array.isArray(obj.agent)) {
    const agentMap: Record<string, AgentProfileConfigV2> = {};
    for (const [name, raw] of Object.entries(obj.agent as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        warn(`[akm] Ignoring profiles.agent["${name}"]: expected an object.`);
        continue;
      }
      const parsed = parseAgentProfileConfigV2(raw as Record<string, unknown>);
      if (parsed) agentMap[name] = parsed;
    }
    if (Object.keys(agentMap).length > 0) result.agent = agentMap;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseDefaultsConfig(value: unknown): AkmConfig["defaults"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const result: NonNullable<AkmConfig["defaults"]> = {};

  if (typeof obj.llm === "string" && obj.llm.trim()) result.llm = obj.llm.trim();
  if (typeof obj.agent === "string" && obj.agent.trim()) result.agent = obj.agent.trim();

  if (typeof obj.improve === "object" && obj.improve !== null && !Array.isArray(obj.improve)) {
    const improveRaw = obj.improve as Record<string, unknown>;
    const improve: NonNullable<NonNullable<AkmConfig["defaults"]>["improve"]> = {};
    const limit = parsePositiveInteger("defaults.improve.limit", improveRaw.limit);
    if (limit !== undefined) improve.limit = limit;
    if (isOneOf(improveRaw.preset, ["fast", "thorough", "mixed", "custom"] as const)) {
      improve.preset = improveRaw.preset;
    }
    if (Object.keys(improve).length > 0) result.improve = improve;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseProcessEntry(value: unknown): ProcessEntry | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const entry: ProcessEntry = {};
  if (typeof obj.enabled === "boolean") entry.enabled = obj.enabled;
  if (isOneOf(obj.mode, ["llm", "agent", "sdk"] as const)) entry.mode = obj.mode;
  if (typeof obj.profile === "string" && obj.profile.trim()) entry.profile = obj.profile.trim();
  if (obj.timeoutMs === null) {
    entry.timeoutMs = null;
  } else if (typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0) {
    entry.timeoutMs = obj.timeoutMs;
  }
  if (typeof obj.options === "object" && obj.options !== null && !Array.isArray(obj.options)) {
    entry.options = obj.options as Record<string, unknown>;
  }
  return entry;
}

function parseFeaturesSection(value: unknown, section: string): Record<string, ProcessEntry | boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const result: Record<string, ProcessEntry | boolean> = {};
  for (const [name, raw] of Object.entries(obj)) {
    const parsed = parseProcessEntry(raw);
    if (parsed === undefined) {
      warn(`[akm] Ignoring features.${section}["${name}"]: expected a boolean or process entry object.`);
      continue;
    }
    result[name] = parsed;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseFeaturesConfig(value: unknown): FeaturesConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const result: FeaturesConfig = {};

  const improve = parseFeaturesSection(obj.improve, "improve");
  if (improve) result.improve = improve;

  const index = parseFeaturesSection(obj.index, "index");
  if (index) result.index = index;

  const search = parseFeaturesSection(obj.search, "search");
  if (search) result.search = search;

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseConfigText(text: string): Partial<AkmConfig> | undefined {
  const raw = parseConfigObjectFromText(text);
  if (!raw) return undefined;
  const expanded = expandEnvVars(raw);
  return parseConfigLayer(expanded);
}

function readNormalizedConfig(configPath: string): Partial<AkmConfig> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  return parseConfigText(text);
}

function readNormalizedConfigFromText(text: string): Partial<AkmConfig> | undefined {
  return parseConfigText(text);
}

function parseOutputConfig(value: unknown): OutputConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const output: OutputConfig = {};

  if (isOneOf(obj.format, ["json", "yaml", "text"] as const)) {
    output.format = obj.format;
  }

  if (isOneOf(obj.detail, ["brief", "normal", "full"] as const)) {
    output.detail = obj.detail;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Field names that hold URLs and must NOT have env var substitution applied.
 * Expanding ${VAR} inside a URL could leak secrets by redirecting requests to
 * an attacker-controlled server if the config file is world-readable.
 */
const URL_FIELD_NAMES = new Set(["url", "endpoint", "artifactUrl"]);

/**
 * Recursively expand `${VAR}` references in all string values.
 * Supports `${VAR}`, `${VAR:-default}`, and bare `$VAR` at the start of a value.
 * Non-string values pass through unchanged.
 *
 * URL-type fields (named `url`, `endpoint`, `artifactUrl`, or whose value starts
 * with `http://` / `https://`) are skipped to prevent secret injection into URLs.
 */
function expandEnvVars<T>(value: T, fieldName?: string): T {
  if (typeof value === "string") {
    // Skip URL-type fields by name or by value prefix, unless they contain ${VAR} syntax
    if (
      !value.includes("${") &&
      ((fieldName !== undefined && URL_FIELD_NAMES.has(fieldName)) ||
        value.startsWith("http://") ||
        value.startsWith("https://"))
    ) {
      return value;
    }
    return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
      if (braced) {
        const [name, ...rest] = braced.split(":-");
        const fallback = rest.join(":-");
        return process.env[name] ?? fallback ?? "";
      }
      return process.env[bare] ?? "";
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvVars(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnvVars(v, k);
    }
    return out as T;
  }
  return value;
}

function parseConfigObjectFromText(text: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(stripJsonComments(text));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    return raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
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

function parseEmbeddingConfig(value: unknown): EmbeddingConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  // Extract localModel early — it's valid even without a remote endpoint
  const localModel = typeof obj.localModel === "string" && obj.localModel ? obj.localModel : undefined;

  // If no endpoint is provided, the config is only valid when localModel is set
  // (local-only embedding configuration).
  // Sentinel: { endpoint: "", model: "" } means "local-only" — use hasRemoteEndpoint()
  // (in embedder.ts) to distinguish from a real remote config. Do NOT check
  // endpoint/model directly in consuming code.
  if (typeof obj.endpoint !== "string" || !obj.endpoint) {
    if (localModel) {
      return { endpoint: "", model: "", localModel };
    }
    return undefined;
  }
  if (!isValidHttpUrl(obj.endpoint, "embedding config")) {
    // Still return localModel-only config if localModel was set
    if (localModel) {
      return { endpoint: "", model: "", localModel };
    }
    return undefined;
  }
  if (typeof obj.model !== "string" || !obj.model) {
    // No remote model, but localModel may still be valid
    if (localModel) {
      warn(
        `[akm] Embedding endpoint "${obj.endpoint as string}" ignored: model is required for remote embeddings. Using local model only.`,
      );
      return { endpoint: "", model: "", localModel };
    }
    return undefined;
  }
  const result: EmbeddingConnectionConfig = {
    endpoint: obj.endpoint,
    model: obj.model,
  };
  if (typeof obj.provider === "string" && obj.provider) {
    result.provider = obj.provider;
  }
  if ("dimension" in obj) {
    const dim = parsePositiveInteger("embedding.dimension", obj.dimension);
    if (dim === undefined) return undefined;
    result.dimension = dim;
  }
  if (typeof obj.apiKey === "string" && obj.apiKey) {
    result.apiKey = obj.apiKey;
  }
  if (localModel) {
    result.localModel = localModel;
  }
  if ("contextLength" in obj) {
    const ctx = parsePositiveInteger("embedding.contextLength", obj.contextLength);
    if (ctx === undefined) return undefined;
    result.contextLength = ctx;
  }
  if (typeof obj.ollamaOptions === "object" && obj.ollamaOptions !== null && !Array.isArray(obj.ollamaOptions)) {
    const opts = obj.ollamaOptions as Record<string, unknown>;
    const parsed: EmbeddingConnectionConfig["ollamaOptions"] = {};
    const numCtx = parsePositiveInteger("embedding.ollamaOptions.num_ctx", opts.num_ctx);
    if (numCtx !== undefined) {
      parsed.num_ctx = numCtx;
    }
    if (Object.keys(parsed).length > 0) {
      result.ollamaOptions = parsed;
    }
  }
  return result;
}

function parseLlmConfig(value: unknown): LlmConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.endpoint !== "string" || !obj.endpoint) return undefined;
  if (!isValidHttpUrl(obj.endpoint, "llm config")) {
    return undefined;
  }
  if (!obj.endpoint.endsWith("/chat/completions")) {
    warn(
      `[akm] llm.endpoint "${obj.endpoint}" does not end in /chat/completions. ` +
        `Did you mean "${obj.endpoint.replace(/\/+$/, "")}/chat/completions"?`,
    );
  }
  const model = typeof obj.model === "string" ? obj.model : "";
  const result: LlmConnectionConfig = {
    endpoint: obj.endpoint,
    model,
  };
  if (typeof obj.provider === "string" && obj.provider) {
    result.provider = obj.provider;
  }
  if (typeof obj.temperature === "number" && Number.isFinite(obj.temperature)) {
    result.temperature = obj.temperature;
  }
  if ("timeoutMs" in obj) {
    const t = parsePositiveInteger("llm.timeoutMs", obj.timeoutMs);
    if (t === undefined) return undefined;
    result.timeoutMs = t;
  }
  if ("concurrency" in obj) {
    const c = parsePositiveInteger("llm.concurrency", obj.concurrency);
    if (c === undefined) return undefined;
    result.concurrency = c;
  }
  if ("maxTokens" in obj) {
    const m = parsePositiveInteger("llm.maxTokens", obj.maxTokens);
    if (m === undefined) return undefined;
    result.maxTokens = m;
  }
  if ("contextLength" in obj) {
    const ctx = parsePositiveInteger("llm.contextLength", obj.contextLength);
    if (ctx !== undefined) result.contextLength = ctx;
  }
  if (typeof obj.apiKey === "string" && obj.apiKey) {
    result.apiKey = obj.apiKey;
  }
  if (typeof obj.capabilities === "object" && obj.capabilities !== null && !Array.isArray(obj.capabilities)) {
    const capsRaw = obj.capabilities as Record<string, unknown>;
    const caps: LlmConnectionConfig["capabilities"] = {};
    if (typeof capsRaw.structuredOutput === "boolean") caps.structuredOutput = capsRaw.structuredOutput;
    if (Object.keys(caps).length > 0) result.capabilities = caps;
  }
  if (typeof obj.features === "object" && obj.features !== null && !Array.isArray(obj.features)) {
    const features = parseLlmFeatures(obj.features as Record<string, unknown>);
    if (Object.keys(features).length > 0) result.features = features;
  }
  if (typeof obj.judgeModel === "string" && obj.judgeModel.trim()) {
    result.judgeModel = obj.judgeModel.trim();
  }
  if (typeof obj.extraParams === "object" && obj.extraParams !== null && !Array.isArray(obj.extraParams)) {
    result.extraParams = obj.extraParams as Record<string, unknown>;
  }
  return result;
}

/**
 * v1 spec §14 — locked feature keys. Defined here so unknown keys can
 * be warn-and-ignored at load time (per spec §14.3 / §9.2). The set is
 * deliberately the *full* locked table even though only a subset has
 * runtime parsing today; this lets users author future-flagged configs
 * without spurious warnings.
 */
const LOCKED_LLM_FEATURE_KEYS: ReadonlySet<string> = new Set([
  "curate_rerank",
  "feedback_distillation",
  "memory_inference",
  "graph_extraction",
  "memory_consolidation",
  "lesson_quality_gate",
  "proposal_quality_gate",
  "metadata_enhance",
  "memory_contradiction_detection",
]);

function parseLlmFeatures(raw: Record<string, unknown>): LlmFeatureFlags {
  const out: LlmFeatureFlags = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!LOCKED_LLM_FEATURE_KEYS.has(key)) {
      warn(`[akm] Ignoring unknown llm.features key "${key}".`);
      continue;
    }
    if (typeof value !== "boolean") {
      warn(`[akm] Ignoring llm.features.${key}: expected boolean, got ${typeof value}.`);
      continue;
    }
    if (LOCKED_LLM_FEATURE_KEYS.has(key as keyof LlmFeatureFlags)) {
      (out as Record<string, boolean>)[key] = value as boolean;
    }
  }
  return out;
}

/**
 * Keys that, if present anywhere under `index.<pass>`, indicate the user is
 * trying to supply a parallel LLM provider configuration. Per #208 this is
 * deliberately rejected at load time so there is exactly one place to
 * configure the LLM (`akm.llm`).
 */
const PROVIDER_CONFIG_KEYS = new Set([
  "endpoint",
  "model",
  "provider",
  "apiKey",
  "baseUrl",
  "temperature",
  "maxTokens",
  "capabilities",
]);

const GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED = new Set([
  "memory",
  "knowledge",
  "skill",
  "command",
  "agent",
  "workflow",
  "lesson",
  "task",
  "wiki",
]);

/**
 * Parse the `index` config block. Each entry is a pass name → small object
 * `{ llm?: boolean }`. Anything richer (a parallel provider config, unknown
 * keys, non-boolean `llm`) throws `ConfigError("INVALID_CONFIG_FILE")` at
 * load time so the failure is visible at startup, not on the next index run.
 */
function parseIndexConfig(value: unknown): IndexConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      'Invalid `index` config: expected an object keyed by pass name (e.g. `{ "enrichment": { "llm": false } }`).',
      "INVALID_CONFIG_FILE",
    );
  }

  const out: IndexConfig = {};
  for (const [passName, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigError(
        `Invalid \`index.${passName}\` config: expected an object like \`{ "llm": false }\`.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const passRaw = raw as Record<string, unknown>;

    // Reject any provider-shaped key — there must be exactly one place to
    // configure the LLM (#208). This is the duplicate-provider guard.
    for (const key of Object.keys(passRaw)) {
      if (PROVIDER_CONFIG_KEYS.has(key)) {
        throw new ConfigError(
          `Duplicate LLM provider configuration: \`index.${passName}.${key}\` is not allowed. ` +
            "Configure provider/model/endpoint under top-level `llm` only; per-pass entries support `{ llm: false }` opt-out.",
          "INVALID_CONFIG_FILE",
          'Move provider settings to the top-level "llm" block, then set `index.<pass>.llm = false` to opt a single pass out.',
        );
      }
      if (
        key !== "llm" &&
        key !== "graphExtractionBatchSize" &&
        key !== "graphExtractionIncludeTypes" &&
        key !== "memoryInferenceBatchSize"
      ) {
        throw new ConfigError(
          `Unknown key \`index.${passName}.${key}\`. Per-pass entries support \`llm\` (boolean opt-out), \`graphExtractionBatchSize\`, \`graphExtractionIncludeTypes\`, and \`memoryInferenceBatchSize\`.`,
          "INVALID_CONFIG_FILE",
        );
      }
    }

    const passConfig: IndexPassConfig = {};
    if ("llm" in passRaw) {
      const llmFlag = passRaw.llm;
      if (typeof llmFlag !== "boolean") {
        throw new ConfigError(
          `Invalid \`index.${passName}.llm\`: expected a boolean (true to use \`akm.llm\`, false to opt out). Got ${typeof llmFlag}.`,
          "INVALID_CONFIG_FILE",
          "Per-pass alternative provider config is intentionally unsupported in v1 (#208). Use `false` to disable LLM for this pass.",
        );
      }
      passConfig.llm = llmFlag;
    }
    if ("graphExtractionBatchSize" in passRaw) {
      const n = parsePositiveInteger(`index.${passName}.graphExtractionBatchSize`, passRaw.graphExtractionBatchSize);
      if (n !== undefined) passConfig.graphExtractionBatchSize = n;
    }
    if ("graphExtractionIncludeTypes" in passRaw) {
      const rawTypes = passRaw.graphExtractionIncludeTypes;
      if (!Array.isArray(rawTypes) || !rawTypes.every((t) => typeof t === "string" && t.trim().length > 0)) {
        throw new ConfigError(
          `Invalid \`index.${passName}.graphExtractionIncludeTypes\`: expected a non-empty string array of asset types.`,
          "INVALID_CONFIG_FILE",
        );
      }
      const normalized = rawTypes.map((t) => t.trim().toLowerCase());
      const invalid = normalized.filter((t) => !GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED.has(t));
      if (invalid.length > 0) {
        throw new ConfigError(
          `Invalid \`index.${passName}.graphExtractionIncludeTypes\`: unsupported type(s): ${invalid.join(", ")}.`,
          "INVALID_CONFIG_FILE",
        );
      }
      passConfig.graphExtractionIncludeTypes = normalized;
    }
    if ("memoryInferenceBatchSize" in passRaw) {
      const n = parsePositiveInteger(`index.${passName}.memoryInferenceBatchSize`, passRaw.memoryInferenceBatchSize);
      if (n !== undefined) passConfig.memoryInferenceBatchSize = n;
    }
    out[passName] = passConfig;
  }
  return out;
}

/**
 * Parse an array of values with a per-item parser, filtering out undefined
 * results. Returns undefined when the input is not an array, or (unless
 * `allowEmpty` is true) when all items parse to undefined.
 */
function parseArray<T>(value: unknown, parseOne: (v: unknown) => T | undefined, allowEmpty = false): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(parseOne).filter((x): x is T => x !== undefined);
  return items.length > 0 || allowEmpty ? items : undefined;
}

function parseInstalledEntries(value: unknown): InstalledStashEntry[] | undefined {
  return parseArray(value, parseInstalledStashEntry);
}

function parseInstalledStashEntry(value: unknown): InstalledStashEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  const id = asNonEmptyString(obj.id);
  const source = asKitSource(obj.source);
  const ref = asNonEmptyString(obj.ref);
  const artifactUrl = asNonEmptyString(obj.artifactUrl);
  const stashRoot = asNonEmptyString(obj.stashRoot);
  const cacheDir = asNonEmptyString(obj.cacheDir);
  const installedAt = asNonEmptyString(obj.installedAt);
  if (!id || !source || !ref || !artifactUrl || !stashRoot || !cacheDir || !installedAt) return undefined;

  const entry: InstalledStashEntry = {
    id,
    source,
    ref,
    artifactUrl,
    stashRoot,
    cacheDir,
    installedAt,
  };
  if (typeof obj.writable === "boolean") entry.writable = obj.writable;
  if (entry.writable === true && entry.source !== "git") {
    throw new ConfigError(
      `writable: true is only supported on filesystem and git sources (got "${entry.source}" on installed entry "${entry.id}").`,
      "INVALID_CONFIG_FILE",
      "Remove `writable: true` from the installed entry or re-add it as a git source instead.",
    );
  }
  const resolvedVersion = asNonEmptyString(obj.resolvedVersion);
  if (resolvedVersion) entry.resolvedVersion = resolvedVersion;
  const resolvedRevision = asNonEmptyString(obj.resolvedRevision);
  if (resolvedRevision) entry.resolvedRevision = resolvedRevision;
  const wikiName = asNonEmptyString(obj.wikiName);
  if (wikiName) entry.wikiName = wikiName;
  return entry;
}

/**
 * Validate a legacy lockfile/installed-entry source string.
 *
 * Restricted to the four kinds that the install pipeline produces
 * (`"npm" | "github" | "git" | "local"`). The full {@link KitSource} union is
 * wider, but persisted `installed[]` entries should never carry the runtime
 * provider kinds (`"filesystem" | "website"`).
 */
function asKitSource(value: unknown): KitSource | undefined {
  if (value === "npm" || value === "github" || value === "git" || value === "local") return value as KitSource;
  return undefined;
}

function parseRegistriesConfig(value: unknown): RegistryConfigEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value
    .map((entry) => parseRegistryConfigEntry(entry))
    .filter((entry): entry is RegistryConfigEntry => entry !== undefined);

  // Return the array even if empty — an explicit empty array means "no registries"
  // which overrides the default. Only return undefined if the field was not an array.
  return entries;
}

function parseSourcesConfig(value: unknown): SourceConfigEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries = value
    .map((entry) => parseSourceConfigEntry(entry))
    .filter((entry): entry is SourceConfigEntry => entry !== undefined);

  return entries;
}

function parseSecurityConfig(value: unknown): SecurityConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const installAudit = parseInstallAuditConfig(obj.installAudit);
  if (!installAudit) return undefined;
  return { installAudit };
}

function parseInstallAuditConfig(value: unknown): InstallAuditConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const config: InstallAuditConfig = {};
  if (typeof obj.enabled === "boolean") config.enabled = obj.enabled;
  if (typeof obj.blockOnCritical === "boolean") config.blockOnCritical = obj.blockOnCritical;
  if (typeof obj.blockUnlistedRegistries === "boolean") config.blockUnlistedRegistries = obj.blockUnlistedRegistries;
  const rawAllowlist = filterNonEmptyStrings(obj.registryAllowlist) ?? filterNonEmptyStrings(obj.registryWhitelist);
  if (!obj.registryAllowlist && obj.registryWhitelist) {
    warn("[akm] config: `registryWhitelist` is deprecated; rename it to `registryAllowlist`");
  }
  if (rawAllowlist) {
    config.registryAllowlist = rawAllowlist;
  }
  const allowedFindings = parseInstallAuditAllowedFindings(obj.allowedFindings);
  if (allowedFindings) {
    config.allowedFindings = allowedFindings;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function parseInstallAuditAllowedFindings(value: unknown): InstallAuditAllowedFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const findings = value
    .map((entry) => parseInstallAuditAllowedFinding(entry))
    .filter((entry): entry is InstallAuditAllowedFinding => entry !== undefined);
  return findings.length > 0 ? findings : undefined;
}

function parseInstallAuditAllowedFinding(value: unknown): InstallAuditAllowedFinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const id = asNonEmptyString(obj.id);
  if (!id) return undefined;
  const finding: InstallAuditAllowedFinding = { id };
  const ref = asNonEmptyString(obj.ref);
  if (ref) finding.ref = ref;
  const entryPath = asNonEmptyString(obj.path);
  if (entryPath) finding.path = entryPath;
  const reason = asNonEmptyString(obj.reason);
  if (reason) finding.reason = reason;
  return finding;
}

function parseSourceConfigEntry(value: unknown): SourceConfigEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  const type = asNonEmptyString(obj.type);
  if (!type) return undefined;

  if (type === "openviking") {
    const name = asNonEmptyString(obj.name) ?? "unnamed";
    throw new ConfigError(
      `openviking is not supported in akm v1. API-backed sources will return as a\nseparate QuerySource tier post-v1. Remove the source named "${name}" from your config file\nor downgrade to 0.6.x. See docs/migration/v1.md.`,
      "INVALID_CONFIG_FILE",
      `Run \`akm remove ${name}\` then re-run, or edit your config file directly at ${getConfigPath()} to remove the openviking entry.`,
    );
  }

  const entry: SourceConfigEntry = { type };
  const entryPath = asNonEmptyString(obj.path);
  if (entryPath) entry.path = entryPath;
  const url = asNonEmptyString(obj.url);
  if (url) entry.url = url;
  const name = asNonEmptyString(obj.name);
  if (name) entry.name = name;
  if (typeof obj.enabled === "boolean") entry.enabled = obj.enabled;
  if (typeof obj.writable === "boolean") entry.writable = obj.writable;
  if (typeof obj.primary === "boolean") entry.primary = obj.primary;
  // Locked decision 4 (§6 v1 implementation plan): reject writable: true on
  // website / npm sources at config load. The next sync() would clobber
  // writes — allowing this is a footgun, not a feature. Throw early so the
  // user sees the problem at `akm` startup, not when they try to write.
  if (entry.writable === true && (type === "website" || type === "npm")) {
    const label = entry.name ? ` "${entry.name}"` : "";
    throw new ConfigError(
      `writable: true is only supported on filesystem and git sources (got "${type}" on source${label}).`,
      "INVALID_CONFIG_FILE",
      "To author into a checked-out package, add the same path as a separate filesystem source.",
    );
  }
  if (typeof obj.options === "object" && obj.options !== null && !Array.isArray(obj.options)) {
    entry.options = obj.options as SourceConfigEntryOptions;
  }
  const wikiName = asNonEmptyString(obj.wikiName);
  if (wikiName) entry.wikiName = wikiName;
  return entry;
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

function parseRegistryConfigEntry(value: unknown): RegistryConfigEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;

  const url = asNonEmptyString(obj.url);
  if (!url?.startsWith("http")) return undefined;

  const entry: RegistryConfigEntry = { url };
  const name = asNonEmptyString(obj.name);
  if (name) entry.name = name;
  if (typeof obj.enabled === "boolean") entry.enabled = obj.enabled;
  const provider = asNonEmptyString(obj.provider);
  if (provider) entry.provider = provider;
  if (typeof obj.options === "object" && obj.options !== null && !Array.isArray(obj.options)) {
    entry.options = obj.options as Record<string, unknown>;
  }
  return entry;
}

function mergeAgentConfig(base: AgentConfig, override: AgentConfig): AgentConfig {
  const merged: AgentConfig = { ...base, ...override };
  const baseProfiles = base.profiles;
  const overrideProfiles = override.profiles;
  if (baseProfiles && overrideProfiles) {
    const profiles: NonNullable<AgentConfig["profiles"]> = { ...baseProfiles };
    for (const [name, entry] of Object.entries(overrideProfiles)) {
      const existing = baseProfiles[name];
      profiles[name] = existing ? { ...existing, ...entry } : entry;
    }
    merged.profiles = profiles;
  }
  // Shallow merge per-key: later layer wins per process name (same as profiles).
  const baseProcesses = base.processes;
  const overrideProcesses = override.processes;
  if (baseProcesses || overrideProcesses) {
    merged.processes = { ...(baseProcesses ?? {}), ...(overrideProcesses ?? {}) };
  }
  return merged;
}

function mergeSecurityConfig(base?: SecurityConfig, override?: SecurityConfig): SecurityConfig | undefined {
  if (!base && !override) return undefined;
  const installAudit = mergeInstallAuditConfig(base?.installAudit, override?.installAudit);
  return installAudit ? { installAudit } : undefined;
}

function mergeInstallAuditConfig(
  base?: InstallAuditConfig,
  override?: InstallAuditConfig,
): InstallAuditConfig | undefined {
  if (!base && !override) return undefined;
  const merged: InstallAuditConfig = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

/**
 * Merge a normalized config layer into an accumulated config.
 *
 * Scalar fields follow normal override semantics. Known nested objects are
 * deep-merged so project config files can override individual fields without
 * clobbering sibling settings. `sources` are additive by default, but a later
 * layer can set `stashInheritance: "replace"` to drop inherited sources first.
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
  if (base.llm && override.llm) {
    merged.llm = { ...base.llm, ...override.llm };
  }
  if (base.index || override.index) {
    // Deep-merge per-pass entries so a project layer can opt one pass out
    // without dropping siblings configured in user config.
    const mergedIndex: IndexConfig = { ...(base.index ?? {}) };
    for (const [passName, passOverride] of Object.entries(override.index ?? {})) {
      mergedIndex[passName] = { ...(mergedIndex[passName] ?? {}), ...passOverride };
    }
    if (Object.keys(mergedIndex).length > 0) merged.index = mergedIndex;
  }
  if (base.security && override.security) {
    merged.security = mergeSecurityConfig(base.security, override.security);
  }
  if (base.agent && override.agent) {
    merged.agent = mergeAgentConfig(base.agent, override.agent);
  }
  const replaceSources = override.stashInheritance === "replace";
  const overrideSources = override.sources ?? [];
  const baseSources = base.sources ?? [];
  if (replaceSources) {
    merged.sources = [...overrideSources];
  } else if (overrideSources.length > 0) {
    merged.sources = [...baseSources, ...overrideSources];
  } else if (baseSources.length > 0) {
    merged.sources = [...baseSources];
  }

  return merged;
}

function applyRuntimeEnvApiKeys(config: AkmConfig): AkmConfig {
  const next = { ...config };

  if (next.embedding && !next.embedding.apiKey) {
    const envKey = process.env.AKM_EMBED_API_KEY?.trim();
    if (envKey) next.embedding = { ...next.embedding, apiKey: envKey };
  }
  if (next.llm && !next.llm.apiKey) {
    const envKey = process.env.AKM_LLM_API_KEY?.trim();
    if (envKey) next.llm = { ...next.llm, apiKey: envKey };
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
 * Return config file paths in merge order: user config first, then project
 * config files from the outermost parent directory down to the current working
 * directory. Later entries have higher precedence when merged.
 */
function getEffectiveConfigPaths(): string[] {
  const configPath = getConfigPath();
  const paths: string[] = [];
  if (isFile(configPath)) {
    paths.push(configPath);
  }
  return [...paths, ...discoverProjectConfigPaths(process.cwd())];
}

/**
 * Walk from `startDir` up to the filesystem root and collect `.akm/config.json`
 * files. Paths are returned from outermost parent to innermost directory so
 * nearer project directories override broader project settings.
 */
function discoverProjectConfigPaths(startDir: string): string[] {
  const paths: string[] = [];
  let currentDir = path.resolve(startDir);

  while (true) {
    const configPath = path.join(currentDir, PROJECT_CONFIG_RELATIVE_PATH);
    if (isFile(configPath)) {
      paths.unshift(configPath);
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return paths;
}

function getConfigSignature(configPaths: string[]): string {
  if (configPaths.length === 0) return "defaults";
  return configPaths.map((configPath) => `${configPath}:${getFileSignatureToken(configPath)}`).join("|");
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
    // mtimeMs alone is unreliable on filesystems with low-resolution mtime
    // (HFS+, some network FS, or very fast back-to-back writes in tests).
    // Combine mtime + size + content hash so the signature actually changes
    // when content does.
    let contentHash = "";
    try {
      contentHash = hashString(fs.readFileSync(filePath, "utf8"));
    } catch {
      // ignore — fall back to stat-only signature
    }
    return `${stat.mtimeMs}:${stat.size}:${contentHash}`;
  } catch {
    return "missing";
  }
}
