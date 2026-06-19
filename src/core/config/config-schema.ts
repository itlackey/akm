// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Zod schema for AkmConfig — the single source of truth for the on-disk shape.
 *
 * Two responsibilities:
 * 1. **Validate + transform** the raw JSON-parsed config object into the runtime
 *    `AkmConfig` shape consumed by the rest of the codebase. Replaces the
 *    ~1.4k LOC of legacy per-shape parsers (parseLlmConfig, parseEmbeddingConfig,
 *    parseIndexConfig, etc.) — see `loadConfig` in `./config.ts`.
 * 2. **Reject hard-errored values** (openviking source type, legacy
 *    `stashes[]` key) at load time via `superRefine`.
 *
 * Design rules:
 * - Top-level uses `.passthrough()` so unknown future keys round-trip intact on
 *   read; `sanitizeConfigForWrite` decides what to persist.
 * - Most nested sub-objects use `.catch(undefined)` so malformed entries are
 *   silently dropped (matches the legacy parser's warn-and-ignore semantics for
 *   field-level shape errors — keeps cold-start working when a user has a
 *   typo in their config).
 * - Two exceptions (hard-rejected): openviking source type and legacy
 *   `stashes[]` key. Both have explicit migration paths; silently dropping
 *   would mask user data loss.
 * - `.strict()` walls still gate `registries[]`, `sources[]`, `profiles.*`
 *   sub-shapes so typos in those structured records are caught (#462).
 * - `defaultWriteTarget` resolution and similar cross-field invariants are
 *   enforced at save time via `superRefine` on the top-level schema.
 */
import { z } from "zod";
import { VALID_HARNESS_IDS } from "./config-types";

// ── Reusable atomic schemas ─────────────────────────────────────────────────

/** Positive integer (used for tokens, timeouts, batch sizes). */
const positiveInt = z.number().int().positive();

/** Non-negative finite number (used for scores, weights, days). */
const nonNegativeNumber = z.number().finite().min(0);

/** Non-empty string (rejects "" and whitespace-only). */
const nonEmptyString = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, { message: "expected a non-empty string" });

/** HTTP(S) URL string. */
const httpUrl = z.string().refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
  message: "endpoint must start with http:// or https://",
});

// ── Feedback failure modes ──────────────────────────────────────────────────

export const FEEDBACK_FAILURE_MODES = ["incorrect", "outdated", "dangerous", "incomplete", "redundant"] as const;

// ── Connection configs (LLM / embedding) ────────────────────────────────────

const LlmCapabilitiesSchema = z
  .object({
    structuredOutput: z.boolean().optional(),
  })
  .strict();

/**
 * Connection config used for both top-level `llm` (after migration) and
 * `profiles.llm[*]`. `model` is required at schema level — partial entries
 * created by `akm config set llm.endpoint <url>` (where model is left absent)
 * are normalized to `model: ""` *before* Zod sees them by the load-time
 * pre-Zod migrator hook, so this strict shape gates CLI writes without
 * breaking legacy load-time partial configs.
 */
export const LlmConnectionConfigSchema = z
  .object({
    provider: z.string().optional(),
    endpoint: z.string(),
    model: z.string(),
    apiKey: z.string().optional(),
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    timeoutMs: positiveInt.optional(),
    concurrency: positiveInt.optional(),
    capabilities: LlmCapabilitiesSchema.optional(),
    extraParams: z.record(z.unknown()).optional(),
    contextLength: positiveInt.optional(),
    judgeModel: z.string().min(1).optional(),
    enableThinking: z.boolean().optional(),
  })
  .strict();

export const LlmProfileConfigSchema = LlmConnectionConfigSchema.extend({
  supportsJsonSchema: z.boolean().optional(),
}).strict();

const EmbeddingOllamaOptionsSchema = z
  .object({
    num_ctx: positiveInt.optional(),
  })
  .strict();

/**
 * Embedding connection config. Both `endpoint` and `model` are optional:
 *   - Remote: provide `endpoint` (http/https URL) + `model`.
 *   - Local-only: omit `endpoint`/`model`; set `localModel` (or fall back to
 *     {@link DEFAULT_LOCAL_MODEL}).
 *
 * Consumers route via `hasRemoteEndpoint()` which checks for an http(s)
 * endpoint — absent fields take the local path naturally, no sentinels needed.
 */
export const EmbeddingConnectionConfigSchema = z
  .object({
    provider: z.string().optional(),
    endpoint: z.string().optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    dimension: positiveInt.optional(),
    localModel: z.string().min(1).optional(),
    maxTokens: positiveInt.optional(),
    batchSize: positiveInt.optional(),
    chunkSize: positiveInt.optional(),
    contextLength: positiveInt.optional(),
    ollamaOptions: EmbeddingOllamaOptionsSchema.optional(),
  })
  .strict();

// ── Agent profiles ──────────────────────────────────────────────────────────

// Derives from the canonical VALID_HARNESS_IDS (#565) so the Zod gate cannot
// drift from the TS union / parse check / setup detection.
const AgentPlatformSchema = z.enum(VALID_HARNESS_IDS);

export const AgentProfileConfigSchema = z
  .object({
    platform: AgentPlatformSchema,
    bin: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    workspace: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

// ── Improve profile / process ──────────────────────────────────────────────

export const ImproveProcessConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["llm", "agent", "sdk"]).optional(),
    profile: z.string().min(1).optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    allowedTypes: z.array(z.string().min(1)).optional(),
    // Consolidate process: minimum eligible-memory pool size below which the
    // consolidation pass skips entirely (emits `pool_below_min_size`). 0 disables
    // the guard. Only meaningful on the `consolidate` process. Default 500.
    minPoolSize: z.number().int().min(0).optional(),
    // Consolidate process: deterministic near-duplicate dedup pre-pass (#617).
    // A cheap, no-LLM fast path that collapses obvious duplicates (`.derived`
    // origin pairs + content twins) before the LLM consolidation. Default OFF
    // — when absent the consolidate pass behaves byte-identically to today.
    // `cosineThreshold` is a strict floor in [0, 1] (default 0.97) for the
    // optional embedding-similarity match; exact normalized content-hash
    // equality always collapses regardless of the threshold. Only meaningful
    // on the `consolidate` process.
    dedup: z
      .object({
        enabled: z.boolean().optional(),
        cosineThreshold: z.number().min(0).max(1).optional(),
        // WS-3a: maximum pool size for the O(n²) cosine-similarity twin compare.
        // Only the first `cosineCandidateLimit` memories are cosine-compared;
        // exact-hash matches still run over the full pool. Default 500. Raise
        // with care — cost is O(n²).
        cosineCandidateLimit: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    // Consolidate process: judged-state cache (#581). When enabled, a memory
    // whose current content hash equals its cached judged hash is SKIPPED from
    // the LLM pool (judged-unchanged → no re-judge), letting one run sweep the
    // whole corpus at O(changed/new) cost instead of narrowing to a recent
    // time-window slice. Default OFF — when absent the consolidate pass behaves
    // byte-identically to today (the incrementalSince path is unaffected). Only
    // meaningful on the `consolidate` process.
    judgedCache: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    qualityGate: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    contradictionDetection: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    // Extract process config (only meaningful for extract process)
    defaultSince: z.string().min(1).optional(),
    maxTotalChars: positiveInt.optional(),
    // Extract process: minimum raw session size (pre-filter inputCount) below
    // which the extract LLM call is skipped (#595/#596). 0 disables the gate.
    // Absent = default 10 (skip only truly empty sessions). Only meaningful
    // on the `extract` process.
    minContentChars: z.number().int().min(0).optional(),
    maxChunkSize: z.number().int().min(1).max(50).optional(),
    // Consolidate process: narrow candidate pool to memories modified within
    // this duration window plus their graph neighbours. Only meaningful on
    // the `consolidate` process. Absent = full-pool sweep.
    incrementalSince: z.string().optional(),
    // Consolidate process: hard cap on memories processed per pass.
    // Reflect/distill: max refs processed (same as profile-level `limit`).
    limit: positiveInt.optional(),
    // Consolidate process: graph neighbours per changed memory during
    // incremental consolidation. Default 5. Only meaningful with incrementalSince.
    neighborsPerChanged: z.number().int().min(1).optional(),
    // Distill process: skip distill entirely when reflect produced zero planned refs.
    requirePlannedRefs: z.boolean().optional(),
    // proactiveMaintenance process (Layer 2): staleness gate + rotation cooldown
    // in days (default 30). Only meaningful on `proactiveMaintenance`.
    dueDays: z.number().int().min(0).optional(),
    // proactiveMaintenance process: top-N bound per run (default 25). Alias for
    // `limit`; `maxPerRun` wins when both are set.
    maxPerRun: positiveInt.optional(),
    // MemoryInference process: minimum pending memory count to run the pass.
    minPendingCount: z.number().int().min(0).optional(),
    // Extract process: minimum number of new (unseen, in-window) candidate
    // sessions below which the extract pass skips entirely (emits an
    // `improve_skipped` event with `reason: "below_min_new_sessions"`). 0
    // disables the guard. Only meaningful on the `extract` process. Default 0
    // (disabled) so existing behaviour is preserved; only opted-in profiles set it.
    minNewSessions: z.number().int().min(0).optional(),
    // Extract process: cap on NEW sessions processed (LLM-called) per run; the
    // rest roll to the next run (still unseen). 0 disables. Absent = default 25.
    maxSessionsPerRun: z.number().int().min(0).optional(),
    // #561 — index agent sessions as a searchable `session` asset (extract
    // process). Absent = on-when-an-LLM-is-available (fail-open when offline).
    indexSessions: z.boolean().optional(),
    // #561 — minimum session duration in minutes for session indexing. 0
    // disables the gate. Absent = default 5. Only meaningful on `extract`.
    minSessionDuration: z.number().min(0).optional(),
    // Consolidate process: fallback p90 wall-clock time per consolidation chunk
    // in seconds, used for cold-start budget estimation when no telemetry
    // history exists. The actual p90 is derived from observed run durations
    // once sufficient history accumulates; this value is only used on the very
    // first run. Default 30 s. Only meaningful on the `consolidate` process.
    p90ChunkSecondsDefault: z.number().finite().positive().optional(),
    // WS-3b: Homeostatic demotion (step 0a). Before any LLM merge, demote
    // retrievalSalience for stale/low-value assets so the merge pool is bounded
    // and high-SNR. Demotion is state.db-only (file content untouched);
    // re-promotable on re-retrieval. Default OFF. Only meaningful on the
    // `consolidate` process.
    homeostaticDemotion: z
      .object({
        enabled: z.boolean().optional(),
        // Minimum days since last retrieval to consider an asset stale (default 30).
        staleDays: z.number().int().min(0).optional(),
        // Demotion factor: multiply retrievalSalience by this when stale (default 0.5).
        demotionFactor: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    // WS-3b: Schema-similarity gate (step 0b). At intake, if a new candidate's
    // body embedding is within epsilon of an existing derived-layer lesson/knowledge
    // node, mark it schema-consistent and lower its priority. Default OFF.
    // Only meaningful on the `consolidate` and `extract` processes.
    schemaSimilarity: z
      .object({
        enabled: z.boolean().optional(),
        // Epsilon: cosine similarity threshold above which a candidate is schema-consistent
        // (default 0.85 — looser than dedup's 0.97 since we want to catch conceptual overlap).
        epsilon: z.number().min(0).max(1).optional(),
        // Multiplicative factor applied to candidate confidence when schema-consistent.
        // Default 0.5 — halves the confidence so schema-consistent candidates are less likely
        // to pass the quality gate and create redundant stash entries.
        confidencePenalty: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    // WS-3b: Hot-probation intake buffer (step 0c, #604). New system-generated
    // extractions enter captureMode: hot-probation and spend ONE consolidation
    // cycle in probation. Dedup + quality second-pass runs before promotion.
    // Default OFF. Only meaningful on the `extract` process.
    hotProbation: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // WS-3b: Anti-collapse guards (step 8). Prevents the consolidation pipeline
    // from collapsing too aggressively and losing diversity.
    //   - maxGeneration: refuse to merge two assets both above this generation (default 2).
    //   - lexicalDiversityCheck: low n-gram diversity ⇒ raise merge threshold.
    //   - randomClusterFraction: occasional random (non-similar) cluster in pool (default 0.05).
    // Default OFF. Only meaningful on the `consolidate` process.
    antiCollapse: z
      .object({
        enabled: z.boolean().optional(),
        maxGeneration: z.number().int().min(1).optional(),
        lexicalDiversityCheck: z.boolean().optional(),
        randomClusterFraction: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    // WS-3b: CLS (Complementary Learning System) interleaving (step 9).
    // distill/memoryInference prompts include embedding-retrieved existing adjacent
    // lessons/knowledge to prevent catastrophic interference with prior generalizations.
    // Default OFF. Only meaningful on `distill` and `memoryInference` processes.
    cls: z
      .object({
        enabled: z.boolean().optional(),
        // Number of adjacent lessons/knowledge to include in prompts (default 3).
        adjacentCount: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    // WS-3b: Distill→source fidelity check (step 10). After a distill proposal,
    // check it against its cited source memories; a contradiction flag forces
    // human review. Default OFF. Only meaningful on `distill` process.
    fidelityCheck: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // #609 — recombine process: minimum related-memory cluster size before an
    // LLM generalization call. Default 3. Only meaningful on `recombine`.
    minClusterSize: z.number().int().min(2).optional(),
    // #609 — recombine process: hard cap on clusters processed per run (one
    // bounded LLM call each). Default 5. Only meaningful on `recombine`.
    maxClustersPerRun: positiveInt.optional(),
    // #609 — recombine process: relatedness signal used to form clusters
    // (tags | graph | both). Clustering is by relatedness, never embedding
    // similarity. Default "tags". Only meaningful on `recombine`.
    relatednessSource: z.enum(["tags", "graph", "both"]).optional(),
    // #609 — recombine process: consecutive re-inductions required before a
    // hypothesis is promoted to a lesson. Default 2. Only meaningful on
    // `recombine`.
    confirmThreshold: z.number().int().min(1).optional(),
    // Triage process config (only meaningful for the `triage` process)
    applyMode: z.enum(["queue", "promote"]).optional(),
    policy: z.string().min(1).optional(),
    maxAcceptsPerRun: positiveInt.optional(),
    maxDiffLines: positiveInt.optional(),
    rejectEmpty: z.boolean().optional(),
    judgment: z
      .object({
        mode: z.enum(["llm", "agent", "sdk"]).optional(),
        profile: z.string().min(1).optional(),
        timeoutMs: z.union([positiveInt, z.null()]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ImproveProfileProcessesSchema = z
  .object({
    reflect: ImproveProcessConfigSchema.optional(),
    distill: ImproveProcessConfigSchema.optional(),
    consolidate: ImproveProcessConfigSchema.optional(),
    memoryInference: ImproveProcessConfigSchema.optional(),
    graphExtraction: ImproveProcessConfigSchema.optional(),
    validation: ImproveProcessConfigSchema.optional(),
    triage: ImproveProcessConfigSchema.optional(),
    proactiveMaintenance: ImproveProcessConfigSchema.optional(),
    recombine: ImproveProcessConfigSchema.optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    // 0.8.0 removed the duplicated `feedbackDistillation` process key — it was
    // a thin wrapper around `processes.distill.enabled`. Single source of truth.
    const raw = val as Record<string, unknown>;
    if ("feedbackDistillation" in raw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "feedbackDistillation was removed in 0.8.0 — use processes.distill.enabled instead. " +
          "It now controls both the orchestration gate and the LLM-call gate.",
      });
      return;
    }
    const allowed = new Set([
      "reflect",
      "distill",
      "consolidate",
      "memoryInference",
      "graphExtraction",
      "validation",
      "extract",
      "triage",
      "proactiveMaintenance",
      "recombine",
    ]);
    for (const k of Object.keys(raw)) {
      if (!allowed.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.unrecognized_keys,
          keys: [k],
          message: `Unrecognized improve process key: "${k}".`,
        });
      }
    }
  });

export const ImproveProfileConfigSchema = z
  .object({
    description: z.string().min(1).optional(),
    processes: ImproveProfileProcessesSchema.optional(),
    autoAccept: nonNegativeNumber.optional(),
    limit: positiveInt.optional(),
    // #614 — symmetric valence weighting in the eligibility sort. When true,
    // the attention term becomes |valence| MAGNITUDE so BOTH strong positive
    // and strong negative feedback drive attention (utility stays dominant) and
    // strong-signed assets are routed to a fix/reinforce lane. DEFAULT OFF —
    // false/absent preserves the legacy negative-only ranking byte-for-byte.
    symmetricValence: z.boolean().optional(),
    sync: z
      .object({
        enabled: z.boolean().optional(),
        push: z.boolean().optional(),
        message: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ── Profiles / defaults ────────────────────────────────────────────────────

export const ProfilesSchema = z
  .object({
    llm: z.record(z.string(), LlmProfileConfigSchema).optional(),
    agent: z.record(z.string(), AgentProfileConfigSchema).optional(),
    improve: z.record(z.string(), ImproveProfileConfigSchema).optional(),
  })
  .strict();

export const DefaultsSchema = z
  .object({
    llm: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    improve: z.string().min(1).optional(),
  })
  .strict();

// ── Sources / registries / installed ────────────────────────────────────────

const SourceConfigEntryOptionsSchema = z
  .object({
    /**
     * @deprecated 0.9.0 (issue #507). Retired per-asset push-on-commit. Kept so
     * old configs still parse; its intent maps onto the batch push gate and
     * encountering it emits a one-time deprecation warning.
     */
    pushOnCommit: z.boolean().optional(),
  })
  .passthrough();

export const SourceConfigEntrySchema = z
  .object({
    type: nonEmptyString,
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    writable: z.boolean().optional(),
    primary: z.boolean().optional(),
    options: SourceConfigEntryOptionsSchema.optional(),
    wikiName: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.writable === true && (entry.type === "website" || entry.type === "npm")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `writable: true is only supported on filesystem and git sources (got "${entry.type}"` +
          (entry.name ? ` on source "${entry.name}"` : "") +
          ").",
      });
    }
  });

export const RegistryConfigEntrySchema = z
  .object({
    url: httpUrl,
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    provider: z.string().min(1).optional(),
    options: z.record(z.unknown()).optional(),
  })
  .strict();

const KitSourceSchema = z.enum(["filesystem", "git", "npm", "github", "website", "local"]);

export const InstalledStashEntrySchema = z
  .object({
    id: nonEmptyString,
    source: KitSourceSchema,
    ref: nonEmptyString,
    artifactUrl: nonEmptyString,
    stashRoot: nonEmptyString,
    cacheDir: nonEmptyString,
    installedAt: nonEmptyString,
    writable: z.boolean().optional(),
    resolvedVersion: z.string().min(1).optional(),
    resolvedRevision: z.string().min(1).optional(),
    wikiName: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.writable === true && entry.source !== "git" && entry.source !== "filesystem") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `writable: true is only supported on filesystem and git sources (got "${entry.source}" on installed entry "${entry.id}").`,
      });
    }
  });

// ── Output ──────────────────────────────────────────────────────────────────

export const OutputConfigSchema = z
  .object({
    format: z.enum(["json", "yaml", "text"]).optional(),
    detail: z.enum(["brief", "normal", "full"]).optional(),
  })
  .strict();

// ── Search ──────────────────────────────────────────────────────────────────

const SearchGraphBoostSchema = z
  .object({
    directBoostPerEntity: nonNegativeNumber.optional(),
    directBoostCap: nonNegativeNumber.optional(),
    hopBoostPerEntity: nonNegativeNumber.optional(),
    hopBoostCap: nonNegativeNumber.optional(),
    /** Hard-capped at 3; values > 3 hard-error so users see the typo. */
    maxHops: positiveInt.max(3).optional(),
    confidenceMode: z.enum(["off", "blend", "multiply"]).default("blend").optional(),
    /** Range [0, 1]; values > 1 hard-error (no silent clamp). */
    confidenceWeight: z.number().finite().min(0).max(1).default(0.2).optional(),
  })
  .strict();

export const SearchConfigSchema = z
  .object({
    minScore: nonNegativeNumber.optional(),
    curateRerank: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    graphBoost: SearchGraphBoostSchema.optional(),
  })
  .strict();

// ── Feedback ────────────────────────────────────────────────────────────────

export const FeedbackConfigSchema = z
  .object({
    requireReason: z.boolean().optional(),
    allowedFailureModes: z.array(nonEmptyString).optional(),
  })
  .strict();

// ── Improve top-level (utility decay, event retention) ─────────────────────

const ImproveUtilityDecaySchema = z
  .object({
    halfLifeDays: z.number().finite().min(0.1).optional(),
    feedbackStabilityBoost: z.number().finite().min(1).optional(),
  })
  .strict();

// #612 / WS-4 — auto-accept gate calibration + bounded, opt-in per-phase
// threshold auto-tune. DEFAULT OFF: when absent (or `autoTune: false`) no
// tuning occurs, so the gate behaves byte-identically to today.
// WS-4 adds: per-phase persistence (state.db) + auto-tune ceiling default 85.
const ImproveCalibrationSchema = z
  .object({
    /** Master switch for the bounded threshold auto-tune. Default false (parity). */
    autoTune: z.boolean().optional(),
    /** Lower bound (0-100) the tuned threshold may never drop below. */
    minThreshold: z.number().int().min(0).max(100).optional(),
    /**
     * Upper bound (0-100) the tuned threshold may never rise above.
     * WS-4 default: 85 (prevents gate converging to pure exploitation).
     */
    maxThreshold: z.number().int().min(0).max(100).optional(),
    /** Maximum adjustment magnitude (points) applied in one tune step. */
    maxStep: positiveInt.optional(),
    /** Minimum acted-on sample count required before any adjustment. */
    minSamples: nonNegativeNumber.optional(),
    /** Target realized accept rate in [0, 1]. Default 0.9. */
    targetAcceptRate: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

// WS-4 — exploration budget: a fixed fraction of proposals accepted per run
// regardless of confidence. DEFAULT OFF.
const ImproveExplorationSchema = z
  .object({
    /**
     * Enable the exploration budget lane. Default false (parity).
     * When true, a fraction of proposals are accepted regardless of confidence.
     */
    enabled: z.boolean().optional(),
    /**
     * Fraction of proposals per run to accept as exploration [0, 1].
     * Default 0.05 (5%). Clamped to [0, 1] at read time.
     */
    budgetFraction: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const ImproveSalienceSchema = z
  .object({
    /**
     * WS-2 Part-V gate: enable the outcome-weight term in the salience projection.
     * Default false (parity — WS-1 weights w_e=0.30, w_r=0.70 until Part-V confirms
     * no regression). Set to true after running scripts/akm-eval + health report.
     */
    outcomeWeightEnabled: z.boolean().optional(),
    /**
     * Minimum encoding salience score [0, 1] for a zero-feedback asset to be
     * admitted to the high-salience improve lane (#608).
     * Default 0.75. Set to 1.0 to disable the lane entirely.
     */
    salienceThreshold: z.number().min(0).max(1).optional(),
    /**
     * Per-run additive replay budget (#610). Up to this many top-salience refs are
     * revisited even with no reactive signal and regardless of cooldown. Additive
     * on top of --limit. Default 0 = no replay.
     */
    replayBudget: z.number().int().min(0).optional(),
  })
  .strict();

export const ImproveConfigSchema = z
  .object({
    utilityDecay: ImproveUtilityDecaySchema.optional(),
    eventRetentionDays: nonNegativeNumber.optional(),
    calibration: ImproveCalibrationSchema.optional(),
    exploration: ImproveExplorationSchema.optional(),
    salience: ImproveSalienceSchema.optional(),
  })
  .strict();

// ── Index / per-pass ────────────────────────────────────────────────────────

const GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED = [
  "memory",
  "knowledge",
  "skill",
  "command",
  "agent",
  "workflow",
  "lesson",
  "task",
  "wiki",
] as const;

const INDEX_PASS_PROVIDER_KEYS = new Set([
  "endpoint",
  "model",
  "provider",
  "apiKey",
  "baseUrl",
  "temperature",
  "maxTokens",
  "capabilities",
]);

const INDEX_PASS_KNOWN_KEYS = new Set([
  "llm",
  "graphExtractionBatchSize",
  "graphExtractionIncludeTypes",
  "memoryInferenceBatchSize",
]);

/**
 * Per-pass `index.<pass>` entry. Uses preprocess + manual validation so we can
 * emit the legacy parser's targeted error messages ("Duplicate LLM provider
 * configuration", "Unknown key `index.<pass>.<key>`", "expected a boolean")
 * instead of Zod's generic `Unrecognized key` / `Expected boolean, received
 * string` strings — keeps `akm` startup errors actionable.
 */
export const IndexPassConfigSchema = z.preprocess(
  (raw, ctx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return raw; // let z.object below produce the type error
    }
    const obj = raw as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (INDEX_PASS_PROVIDER_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Duplicate LLM provider configuration: \`${[...(ctx.path ?? []), key].join(".")}\` is not allowed. ` +
            "Configure provider/model/endpoint under `profiles.llm` only; per-pass entries support `{ llm: false }` opt-out.",
        });
        return raw;
      }
      if (!INDEX_PASS_KNOWN_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Unknown key \`${[...(ctx.path ?? []), key].join(".")}\`. Per-pass entries support \`llm\` ` +
            "(boolean opt-out), `graphExtractionBatchSize`, `graphExtractionIncludeTypes`, and " +
            "`memoryInferenceBatchSize`.",
        });
        return raw;
      }
    }
    if ("llm" in obj && typeof obj.llm !== "boolean") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid \`${[...(ctx.path ?? []), "llm"].join(".")}\`: expected a boolean (true to use the default LLM profile, false to opt out). Got ${typeof obj.llm}.`,
      });
      return raw;
    }
    return raw;
  },
  z
    .object({
      llm: z.boolean().optional(),
      graphExtractionBatchSize: positiveInt.optional(),
      graphExtractionIncludeTypes: z.array(z.enum(GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED)).nonempty().optional(),
      memoryInferenceBatchSize: positiveInt.optional(),
    })
    .passthrough(),
);

const MetadataEnhanceSchema = z.object({ enabled: z.boolean().optional() }).strict();

const StalenessDetectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdDays: positiveInt.optional(),
  })
  .strict();

/**
 * Index config is a union of reserved feature sections and per-pass entries.
 * Passthrough so per-pass entries (keyed by arbitrary pass names like `graph`,
 * `enrichment`) can live next to the reserved keys.
 *
 * The outer preprocess emits the legacy parser's actionable error messages
 * for the two most common type-shape mistakes:
 *   - An array at the `index` block.
 *   - A non-object at `index.<passName>`.
 * Inner field validation (graphExtractionIncludeTypes enum, llm boolean,
 * provider-key rejection) is delegated to {@link IndexPassConfigSchema}.
 */
export const IndexConfigSchema = z.preprocess(
  (raw, ctx) => {
    if (raw === undefined || raw === null) return raw;
    if (Array.isArray(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Invalid `index` config: expected an object keyed by pass name (e.g. `{ "enrichment": { "llm": false } }`).',
      });
      return raw;
    }
    if (typeof raw !== "object") return raw;
    for (const [passName, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid \`index.${passName}\` config: expected an object like \`{ "llm": false }\`.`,
        });
        return raw;
      }
      if (
        passName !== "metadataEnhance" &&
        passName !== "stalenessDetection" &&
        Array.isArray((value as Record<string, unknown>).graphExtractionIncludeTypes)
      ) {
        const arr = (value as Record<string, unknown>).graphExtractionIncludeTypes as unknown[];
        const invalid: string[] = [];
        for (const t of arr) {
          if (
            typeof t === "string" &&
            !GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED.includes(
              t.toLowerCase() as (typeof GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED)[number],
            )
          ) {
            invalid.push(t);
          }
        }
        if (invalid.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid \`index.${passName}.graphExtractionIncludeTypes\`: unsupported type(s): ${invalid.join(", ")}.`,
          });
          return raw;
        }
      }
    }
    return raw;
  },
  z
    .object({
      metadataEnhance: MetadataEnhanceSchema.optional(),
      stalenessDetection: StalenessDetectionSchema.optional(),
    })
    .catchall(IndexPassConfigSchema),
);

// ── Setup-derived recommendations ──────────────────────────────────────────

/**
 * Cron-style schedule hints derived by `akm setup --reset-recommended`.
 *
 * These record the *recommended* cadence for the improve and index background
 * tasks. They are advisory metadata persisted into config so the value
 * survives a re-run; actual task scheduling lives in the tasks subsystem.
 */
export const SetupTaskSchedulesSchema = z
  .object({
    improve: z.string().min(1).optional(),
    index: z.string().min(1).optional(),
  })
  .strict();

export const SetupConfigSchema = z
  .object({
    taskSchedules: SetupTaskSchedulesSchema.optional(),
  })
  .strict();

// ── Top-level AkmConfig ────────────────────────────────────────────────────

/**
 * Base object schema used both as the top-level shape and as the source of
 * truth for {@link listTopLevelConfigKeys}. {@link AkmConfigSchema} wraps this
 * with cross-field refinements (`.superRefine()`).
 *
 * All fields validate loudly — typos and shape errors throw at load time. The
 * legacy parser's warn-and-drop tolerance was a frequent source of silent
 * configuration loss; the migration module ({@link migrateConfigShape}) handles
 * one-time 0.7→0.8 input transforms before the schema sees the value.
 */
export const AkmConfigShape = {
  configVersion: z.union([z.string().min(1), z.number()]).optional(),
  profiles: ProfilesSchema.optional(),
  defaults: DefaultsSchema.optional(),
  stashDir: nonEmptyString.optional(),
  semanticSearchMode: z.enum(["off", "auto"]).default("auto"),
  embedding: EmbeddingConnectionConfigSchema.optional(),
  index: IndexConfigSchema.optional(),
  installed: z.array(InstalledStashEntrySchema).optional(),
  registries: z.array(RegistryConfigEntrySchema).optional(),
  sources: z.array(SourceConfigEntrySchema).optional(),
  output: OutputConfigSchema.optional(),
  writable: z.boolean().optional(),
  defaultWriteTarget: nonEmptyString.optional(),
  search: SearchConfigSchema.optional(),
  feedback: FeedbackConfigSchema.optional(),
  archiveRetentionDays: nonNegativeNumber.optional(),
  improve: ImproveConfigSchema.optional(),
  setup: SetupConfigSchema.optional(),
} as const;

export const AkmConfigBaseSchema = z.object(AkmConfigShape).strict();

export const AkmConfigSchema = AkmConfigBaseSchema.superRefine((config, ctx) => {
  // #464.a: defaultWriteTarget must name a configured source when sources
  // are present. With no sources configured, error out instead of silently
  // accepting (no implicit "first writable" fallback — see locked decision 3).
  if (config.defaultWriteTarget !== undefined) {
    const knownNames = (config.sources ?? [])
      .map((s) => s.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    if (knownNames.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultWriteTarget"],
        message:
          `defaultWriteTarget "${config.defaultWriteTarget}" cannot be resolved: no sources configured. ` +
          "Add at least one entry to `sources` with a matching `name` first.",
      });
    } else if (!knownNames.includes(config.defaultWriteTarget)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultWriteTarget"],
        message: `defaultWriteTarget "${config.defaultWriteTarget}" does not match any configured source name: ${knownNames.map((n) => `"${n}"`).join(", ")}.`,
      });
    }
  }
});

/** Canonical inferred type. Mirrors the runtime `AkmConfig` shape. */
export type AkmConfigInput = z.input<typeof AkmConfigSchema>;
export type AkmConfigParsed = z.output<typeof AkmConfigSchema>;

// ── Validation helpers ──────────────────────────────────────────────────────

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

/**
 * Validate a raw object against {@link AkmConfigSchema}. Returns a structured
 * result so callers can render errors as a list (instead of throwing on the
 * first issue).
 */
export function validateConfigShape(
  raw: unknown,
): { ok: true; value: AkmConfigParsed; errors: [] } | { ok: false; errors: ConfigValidationIssue[] } {
  const result = AkmConfigSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data, errors: [] };
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

// ── Top-level key listing (for hint messages) ───────────────────────────────

/**
 * Return the sorted list of top-level config keys recognized by the schema.
 * Used by error hints so the list stays in sync with the schema automatically
 * (#460).
 */
export function listTopLevelConfigKeys(): string[] {
  return Object.keys(AkmConfigShape).sort();
}
