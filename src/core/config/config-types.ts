// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// VALID_HARNESS_IDS now derives from the unified HARNESS_REGISTRY (#562), which
// is the single source of truth replacing the previously-disconnected
// registries. config ← harnesses is the only import direction (harnesses/ is a
// dependency-graph leaf), so there is no cycle.
import { VALID_HARNESS_IDS } from "../../integrations/harnesses";
/**
 * Type definitions for the `AkmConfig` shape and its sub-shapes.
 *
 * The Zod schema in `./config-schema.ts` is the single source of truth for
 * runtime validation; the interfaces here mirror it for consumers that don't
 * want to import Zod just to get a type. Keep the two in sync — `bunx tsc`
 * will surface the drift through call-site errors.
 */
import type { InstalledStashEntry } from "../../registry/types";

/**
 * Canonical list of valid agent harness / platform ids. Re-exported from the
 * unified harness registry (#562) so the Zod `AgentPlatformSchema` enum, the
 * `AgentProfileConfigV2` platform union, `parseAgentProfilesMapV2`'s membership
 * check, and setup's `DetectedHarness` union all derive from one place and
 * cannot drift. Add a harness in `src/integrations/harnesses/index.ts`.
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

export interface AgentProfileConfigV2 {
  platform: HarnessId;
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
  /**
   * Minimum raw session character count for the `extract` process. Sessions
   * whose total content falls below this threshold are skipped before the LLM
   * call — avoids burning inference capacity on empty sessions (journal files)
   * that never yield candidates. Checked against pre-filter `inputCount` (raw
   * size), not `outputCount`, since the pre-filter strips so much boilerplate
   * that even signal-bearing sessions can have tiny output. Absent = default
   * 10 (only truly empty sessions are safe to skip — tiny sessions of a few
   * hundred chars regularly yield candidates). `0` disables the gate. Only
   * meaningful on the `extract` process.
   */
  minContentChars?: number;
  /**
   * Max chunk size for the consolidation pass (1–50).
   * Overrides the computed value derived from the model context window.
   * Absent = use computed value (capped at 50).
   */
  maxChunkSize?: number;
  /**
   * Narrows the consolidation candidate pool to memories modified within this
   * window (e.g. `"1h"`, `"4h"`, `"7d"`) plus their top-k graph neighbours.
   * Useful when consolidation runs more than once per day — keeps each pass
   * focused on recent changes. Absent = full-pool sweep. Only meaningful on
   * the `consolidate` process.
   */
  incrementalSince?: string;
  /**
   * Hard cap on memories processed per consolidation pass. Absent = no cap
   * (full pool after incremental narrowing). Only meaningful on the
   * `consolidate` process. For `reflect`/`distill`: max refs processed (same
   * semantics as the profile-level `limit` field).
   */
  limit?: number;
  /**
   * Number of graph neighbours to include per changed memory during
   * incremental consolidation. Default 5 (hardcoded). Only meaningful on the
   * `consolidate` process when `incrementalSince` is set.
   */
  neighborsPerChanged?: number;
  /**
   * When `true`, the distill process is skipped entirely if the reflect phase
   * produced zero planned refs (i.e. no refs passed the signal gate for
   * reflect). Prevents the distill loop from running against distill-only refs
   * and generating hundreds of `distill-skipped` events on quiet passes. Only
   * meaningful on the `distill` process.
   */
  requirePlannedRefs?: boolean;
  /**
   * Minimum number of pending split-parent memories below which the memory
   * inference pass is skipped entirely (zero LLM calls). Absent = always run
   * when enabled. Only meaningful on the `memoryInference` process.
   */
  minPendingCount?: number;
  /**
   * Minimum eligible-memory pool size for the consolidation pass. When the
   * eligible pool is below this threshold the pass skips entirely (emitting an
   * `improve_skipped` event with `reason: "pool_below_min_size"`) and makes
   * ZERO LLM calls. `0` disables the guard. Absent = default 500. Only
   * meaningful on the `consolidate` process.
   */
  minPoolSize?: number;
  /**
   * Deterministic near-duplicate dedup pre-pass for the `consolidate` process
   * (#617). A cheap, no-LLM fast path that collapses the obvious duplicates
   * (`.derived` origin pairs + content twins) in front of the embedding-clustered
   * LLM consolidation. Default OFF — when absent the consolidate pass behaves
   * byte-identically to today.
   *
   *   - `enabled`: turn the pre-pass on. Default `false`.
   *   - `cosineThreshold`: strict similarity floor in [0, 1] (default `0.97`)
   *     for the optional embedding-similarity match. Exact normalized
   *     content-hash equality always collapses regardless of this value;
   *     the cosine path only fires when embeddings are configured and a pair's
   *     similarity is >= this threshold. Genuinely distinct memories fall
   *     through untouched to the LLM consolidation.
   *
   * Only meaningful on the `consolidate` process.
   */
  dedup?: {
    enabled?: boolean;
    cosineThreshold?: number;
  };
  /**
   * Judged-state cache for the `consolidate` process (#581). When `enabled`,
   * each memory's frontmatter-stripped content hash is recorded after the LLM
   * judges its chunk; on a later run a memory whose current hash equals its
   * cached judged hash is SKIPPED from the LLM pool (judged-unchanged → no
   * re-judge). This lets a single run sweep the FULL corpus at O(changed/new)
   * cost rather than narrowing to a recent time-window slice (which leaves a
   * near-duplicate backlog). Default OFF — when absent the consolidate pass
   * behaves byte-identically to today and the `incrementalSince` path is
   * unaffected. Only meaningful on the `consolidate` process.
   *
   *   - `enabled`: turn the judged-state cache on. Default `false`.
   */
  judgedCache?: {
    enabled?: boolean;
  };
  /**
   * Minimum number of new (unseen, in-window) candidate sessions for the
   * `extract` process. When the candidate-session pool is below this threshold
   * the extract pass skips entirely (emitting an `improve_skipped` event with
   * `reason: "below_min_new_sessions"`) and makes ZERO LLM calls. `0` disables
   * the guard. Absent = default 0 (disabled), preserving existing always-run
   * behaviour. Only meaningful on the `extract` process.
   */
  minNewSessions?: number;
  /**
   * Maximum number of NEW (unseen) sessions the `extract` pass will process
   * (make an LLM call for) in a single run. Bounds per-run wall time + LLM cost
   * so a backlog of accumulated sessions (e.g. after downtime) can't push one
   * run past its task timeout. Sessions beyond the cap stay unseen and are
   * picked up by subsequent runs (no coverage loss). `0` disables the cap.
   * Absent = a built-in default. Only meaningful on the `extract` process.
   */
  maxSessionsPerRun?: number;
  /**
   * #561 — index agent sessions as a searchable `session` asset. When the
   * `extract` pass distills memory proposals from a session it ADDITIONALLY
   * writes `sessions/<harness>/<id>.md` (LLM `## Summary` + `## Key topics`) so
   * the session becomes discoverable via `akm search` / `akm curate`.
   *
   * ADDITIVE + FAIL-OPEN. The summary is generated through the same in-tree LLM
   * seam as the rest of extract; if no LLM is configured (or the call fails) no
   * asset is written and extract behaves EXACTLY as before. Absent = default
   * ON-WHEN-AVAILABLE: because the extract pass only runs at all when an LLM is
   * configured, defaulting on costs nothing when offline (the summary call
   * simply fails open) while making sessions searchable for the common
   * LLM-configured case. Set `false` to opt out entirely (byte-identical
   * legacy behaviour). Only meaningful on the `extract` process.
   */
  indexSessions?: boolean;
  /**
   * #561 — minimum session duration (ended_at − started_at) in MINUTES for a
   * session to be indexed as a `session` asset. Trivially short sessions carry
   * little reusable signal and are not worth an LLM summary call. Absent =
   * default 5. `0` disables the gate (index every session). Only meaningful on
   * the `extract` process when `indexSessions` is enabled.
   */
  minSessionDuration?: number;
  /**
   * Proactive-maintenance selector (Layer 2): staleness gate in DAYS. An asset
   * is eligible only when it has never been reflected/distilled OR was last
   * reflected/distilled more than this many days ago. This same value doubles as
   * the per-ref rotation cooldown — a freshly-reflected asset is excluded until
   * it ages back past `dueDays`, so successive runs rotate through the due pool.
   * Absent = default 30. Only meaningful on the `proactiveMaintenance` process.
   */
  dueDays?: number;
  /**
   * Proactive-maintenance selector (Layer 2): hard cap on how many due assets
   * are surfaced into the reflect/distill candidate set per run. Bounds the
   * blast radius of a scheduled maintenance sweep. Absent = default 25. Alias
   * for the per-process `limit` field; `maxPerRun` wins when both are set. Only
   * meaningful on the `proactiveMaintenance` process.
   */
  maxPerRun?: number;
  /**
   * Proactive-maintenance selector (Layer 2): optional override of the
   * importance multiplier applied per asset type in the composite priority.
   * Merged over the built-in defaults (skill/agent 1.5, command/workflow 1.3,
   * lesson 1.2, knowledge 1.0, script 0.9, memory 0.7) — supply only the types
   * you want to change. Only meaningful on the `proactiveMaintenance` process.
   */
  importanceWeights?: Record<string, number>;
  /**
   * Full-corpus scan for the `graphExtraction` process.
   * When `true`, graph extraction runs on ALL stash files instead of only
   * the files touched by actionable refs in the current run.
   * Use with the `graph-refresh` built-in profile or a scheduled weekly task.
   * Has no effect on other processes.
   */
  fullScan?: boolean;
  /**
   * Apply mode for drained proposals: `queue` stages only (never promotes),
   * `promote` accepts matching proposals (commits to git). Defaults to the
   * safe `queue`. Only meaningful on the `triage` process.
   */
  applyMode?: "queue" | "promote";
  /**
   * Built-in policy preset name (`personal-stash` | `conservative` | `manual`)
   * or a path to a custom policy file. Only meaningful on the `triage` process.
   */
  policy?: string;
  /**
   * Hard per-run accept ceiling. Accepts beyond this land in `skippedByCap`.
   * Only meaningful on the `triage` process.
   */
  maxAcceptsPerRun?: number;
  /**
   * Defer (never promote) accepts whose proposed content exceeds this many
   * lines. Only meaningful on the `triage` process.
   */
  maxDiffLines?: number;
  /**
   * Reject proposals whose diff is empty. Only meaningful on the `triage`
   * process.
   */
  rejectEmpty?: boolean;
  /**
   * Optional judgment tier for mid-band / ambiguous items. Only meaningful on
   * the `triage` process.
   */
  judgment?: {
    mode?: "llm" | "agent" | "sdk";
    profile?: string;
    timeoutMs?: number | null;
  };
}

export interface ImproveProfileConfig {
  description?: string;
  processes?: {
    reflect?: ImproveProcessConfig;
    distill?: ImproveProcessConfig;
    consolidate?: ImproveProcessConfig;
    memoryInference?: ImproveProcessConfig;
    graphExtraction?: ImproveProcessConfig;
    /** Third-tier classifier runner. Used by staleness/confidence/classification. */
    validation?: ImproveProcessConfig;
    /**
     * Gates the `akm extract` pass that reads native session files via the
     * session-log harness registry and queues durable-insight proposals.
     * Default: enabled.
     */
    extract?: ImproveProcessConfig;
    /**
     * Drains the standing pending proposal backlog using a deterministic
     * triage policy. Opt-in (default disabled).
     */
    triage?: ImproveProcessConfig;
    /**
     * Layer 2 — proactive-maintenance selector. On whole-stash / type scope,
     * surfaces the top-N highest-priority *due* assets (never reflected, or last
     * reflected > `dueDays` ago) into the reflect/distill candidate set so stable
     * high-value assets get refreshed on a schedule even without new feedback.
     * Opt-in (default DISABLED). Knobs: `enabled`, `dueDays` (30),
     * `maxPerRun`/`limit` (25), `importanceWeights`.
     */
    proactiveMaintenance?: ImproveProcessConfig;
  };
  autoAccept?: number;
  limit?: number;
  /**
   * #614 — symmetric valence weighting in the improve eligibility sort. The
   * legacy ranking weights feedback NEGATIVE-ONLY (`negative / total`), so
   * strong POSITIVE feedback never drives attention. When `true`, the feedback
   * attention term becomes the |valence| MAGNITUDE — both strong positive and
   * strong negative feedback lift an asset's attention (utility remains the
   * dominant ordering factor) — and strongly-signed assets are routed to a
   * lane: high-negative → fix, high-positive → reinforce.
   *
   * DEFAULT OFF. Absent or `false` preserves the legacy negative-only ranking
   * byte-for-byte.
   */
  symmetricValence?: boolean;
  /**
   * End-of-run auto-sync: batch-commit (and optionally push) the primary
   * git-backed stash once an improve run finishes. Default ON for git-backed
   * stashes; push is gated on `config.writable` + a configured remote.
   */
  sync?: {
    enabled?: boolean;
    push?: boolean;
    message?: string;
  };
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
   * #612 — auto-accept gate calibration + bounded, opt-in threshold auto-tune.
   *
   * Calibration (the reliability summary on `akm health`) is always computed
   * from gate decisions; this block controls only the OPT-IN threshold
   * auto-tune. DEFAULT OFF: absent — or `autoTune: false` — means the gate
   * threshold is never adjusted and behaviour is byte-identical to today.
   */
  calibration?: {
    /** Master switch for the bounded threshold auto-tune. Default false (parity). */
    autoTune?: boolean;
    /** Lower bound (0-100) the tuned threshold may never drop below. */
    minThreshold?: number;
    /** Upper bound (0-100) the tuned threshold may never rise above. */
    maxThreshold?: number;
    /** Maximum adjustment magnitude (points) applied in one tune step. */
    maxStep?: number;
    /** Minimum acted-on sample count required before any adjustment. */
    minSamples?: number;
    /** Target realized accept rate in [0, 1]. Default 0.9. */
    targetAcceptRate?: number;
  };
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
