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
 * - UNKNOWN-KEY POLICY: object schemas use passthrough (unknown keys are
 *   preserved and ignored, NOT rejected). akm runs across multiple installed
 *   versions sharing one config.json; a newer version writes keys an older
 *   version's schema doesn't know yet, so hard-rejecting unknown keys turned
 *   benign version skew into `INVALID_CONFIG_FILE` failures. Known keys are
 *   still type-checked; passthrough preserves unknown keys across a
 *   load→save round trip so an older reader never strips a newer writer's
 *   settings. (Replaced the prior strict-mode object walls.)
 * - `defaultWriteTarget` resolution and similar cross-field invariants are
 *   enforced at save time via `superRefine` on the top-level schema.
 */
import { z } from "zod";
import type { InstalledStashEntry } from "../../registry/types";
import { validateExtraParams } from "../extra-params";
import { HARNESS_BY_ID, VALID_HARNESS_IDS } from "./config-types";
import {
  BUILTIN_IMPROVE_STRATEGY_NAMES,
  ENGINE_NAME_PATTERN_SOURCE,
  IMPROVE_PROCESS_ENGINE_CAPABILITIES,
} from "./engine-semantics";

/** Persisted config schema version. Package prerelease/patch versions do not change this value. */
export const CURRENT_CONFIG_VERSION = "0.9.0" as const;

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

const ENGINE_NAME_PATTERN = new RegExp(ENGINE_NAME_PATTERN_SOURCE);
const ENV_REFERENCE_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const engineName = z
  .string()
  .max(63)
  .regex(ENGINE_NAME_PATTERN, "names must be lowercase kebab-case and must not begin with reserved akm-");

const chatCompletionsEndpoint = z.string().superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint must use http:// or https://" });
    }
    if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/chat/completions")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endpoint must be a credential-free OpenAI chat-completions URL without query or fragment",
      });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint must be a complete URL" });
  }
});

const ExtraParamsSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  for (const issue of validateExtraParams(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
});

function normalizeAliasKeys(raw: unknown, ctx: z.RefinementCtx): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const normalized: Record<string, unknown> = {};
  const originalByKey = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    const previous = originalByKey.get(lower);
    if (previous !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `alias collides case-insensitively with ${previous}`,
      });
      continue;
    }
    originalByKey.set(lower, key);
    normalized[lower] = value;
  }
  return normalized;
}

const ModelAliasMapSchema = z.preprocess(
  (raw, ctx) => normalizeAliasKeys(raw, ctx),
  z.record(z.string().min(1), z.string().min(1)),
);

const GlobalModelAliasesSchema = z.preprocess(
  (raw, ctx) => normalizeAliasKeys(raw, ctx),
  z.record(z.string().min(1), z.record(z.string().min(1), z.string().min(1))),
);

// ── Feedback failure modes (F-3 / #384) ─────────────────────────────────────

/**
 * Curated taxonomy of failure modes for negative feedback.
 *
 * Structured failure modes enable aggregation across feedback events so the
 * distill pipeline can detect that "5 assets failed for the same reason" and
 * act on it — free-text strings about the same issue are not aggregatable.
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

// ── Connection configs (LLM / embedding) ────────────────────────────────────

const LlmCapabilitiesSchema = z
  .object({
    structuredOutput: z.boolean().optional(),
  })
  .passthrough();

/**
 * OpenAI-compatible connection fields shared by named LLM engines and bounded
 * internal call helpers. `model` is required at schema level — partial entries
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
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    concurrency: positiveInt.optional(),
    capabilities: LlmCapabilitiesSchema.optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
  })
  .passthrough();

export const LlmProfileConfigSchema = LlmConnectionConfigSchema.extend({
  supportsJsonSchema: z.boolean().optional(),
}).passthrough();

const EmbeddingOllamaOptionsSchema = z
  .object({
    num_ctx: positiveInt.optional(),
  })
  .passthrough();

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
    apiKey: z.string().regex(ENV_REFERENCE_PATTERN, `apiKey must be $VAR or \${VAR}`).optional(),
    dimension: positiveInt.optional(),
    localModel: z.string().min(1).optional(),
    maxTokens: positiveInt.optional(),
    batchSize: positiveInt.optional(),
    chunkSize: positiveInt.optional(),
    contextLength: positiveInt.optional(),
    ollamaOptions: EmbeddingOllamaOptionsSchema.optional(),
  })
  .passthrough();

// ── Agent engines ───────────────────────────────────────────────────────────

// Derives from the canonical VALID_HARNESS_IDS (#565) so the Zod gate cannot
// drift from the TS union / parse check / setup detection.
const AgentPlatformSchema = z.enum(VALID_HARNESS_IDS);

export const LlmInvocationOverridesSchema = z
  .object({
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    supportsJsonSchema: z.boolean().optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
  })
  .passthrough();

const LlmEngineSchema = z
  .object({
    kind: z.literal("llm"),
    provider: z.string().optional(),
    endpoint: chatCompletionsEndpoint,
    model: nonEmptyString,
    apiKey: z.string().regex(ENV_REFERENCE_PATTERN, `apiKey must be $VAR or \${VAR}`).optional(),
    temperature: z.number().finite().optional(),
    maxTokens: positiveInt.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    concurrency: positiveInt.optional(),
    supportsJsonSchema: z.boolean().optional(),
    extraParams: ExtraParamsSchema.optional(),
    contextLength: positiveInt.optional(),
    enableThinking: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of ["platform", "bin", "args", "workspace", "modelAliases", "llmEngine"]) {
      if (key in value)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is not valid on an LLM engine` });
    }
  });

const AgentEngineSchema = z
  .object({
    kind: z.literal("agent"),
    platform: AgentPlatformSchema.refine(
      (platform) => HARNESS_BY_ID.get(platform)?.capabilities.agentDispatch === true,
      {
        message: "platform does not support agent dispatch",
      },
    ),
    bin: nonEmptyString.optional(),
    args: z.array(z.string()).optional(),
    workspace: nonEmptyString.optional(),
    model: nonEmptyString.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    modelAliases: ModelAliasMapSchema.optional(),
    llmEngine: engineName.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of [
      "provider",
      "endpoint",
      "apiKey",
      "temperature",
      "maxTokens",
      "concurrency",
      "supportsJsonSchema",
      "extraParams",
      "contextLength",
      "enableThinking",
    ]) {
      if (key in value)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is not valid on an agent engine` });
    }
    if (value.platform !== "opencode-sdk" && value.llmEngine !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["llmEngine"],
        message: "llmEngine is only valid on opencode-sdk",
      });
    }
    if (value.platform === "opencode-sdk" && value.args !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["args"], message: "args is not valid on opencode-sdk" });
    }
  });

export const EngineConfigSchema = z.union([LlmEngineSchema, AgentEngineSchema]);
export const EnginesSchema = z.record(engineName, EngineConfigSchema);

// ── Improve profile / process ──────────────────────────────────────────────

export const ImproveProcessConfigSchema = z
  .object({
    engine: engineName.optional(),
    model: nonEmptyString.optional(),
    llm: LlmInvocationOverridesSchema.optional(),
    enabled: z.boolean().optional(),
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
      .passthrough()
      .optional(),
    // Consolidate process: judged-state cache (#581). When enabled, a memory
    // whose current content hash equals its cached judged hash is SKIPPED from
    // the LLM pool (judged-unchanged → no re-judge), letting one run sweep the
    // whole corpus at O(changed/new) cost instead of narrowing to a recent
    // time-window slice. Default OFF — when absent the consolidate pass behaves
    // byte-identically to today (the incrementalSince path is unaffected). Only
    // meaningful on the `consolidate` process.
    judgedCache: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    // Distill process: LLM-as-judge lesson quality gate. Default ON (R3);
    // fail-open — judge failure/timeout/parse errors pass through. Set
    // `enabled: false` on the distill process to opt out.
    qualityGate: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    contradictionDetection: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
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
    // graphExtraction process (#624 P2): when set, rank eligible files by
    // utility_scores DESC and process only the top-N per run (incremental
    // high-signal-first sweep). Unset = process all eligible (current
    // behavior). Only meaningful on `graphExtraction`.
    topN: positiveInt.optional(),
    // Improve-owned graph extraction scope and batching. These are passed to
    // the invocation directly and never inherited from standalone index.graph.
    includeTypes: z.array(z.string().min(1)).min(1).optional(),
    batchSize: positiveInt.optional(),
    // graphExtraction process: full-corpus scan. When true, graph extraction
    // runs on ALL stash files instead of only files touched by actionable refs
    // in the current run. Used by the `graph-refresh` built-in profile / a
    // scheduled weekly task. Only meaningful on `graphExtraction`.
    fullScan: z.boolean().optional(),
    // #626 — extract process: pre-LLM heuristic triage gate. When enabled, a
    // deterministic scorer decides BEFORE the extraction LLM call whether a
    // session carries enough signal to be worth extracting; low-signal sessions
    // are skipped at zero LLM cost. Default OFF. Only meaningful on `extract`.
    // `minScore` is the minimum total heuristic score to PASS (default 2).
    triage: z
      .object({
        enabled: z.boolean().optional(),
        minScore: z.number().min(0).optional(),
      })
      .passthrough()
      .optional(),
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
    // COST: when on, each processed session makes a SECOND LLM call (the session
    // summary) on top of the extraction call — i.e. ~2 LLM calls/session. Set to
    // false to halve per-session extract cost at the price of unsearchable
    // sessions. (Unchanged/skip sessions still cost zero — the content-hash
    // ledger gates both calls upstream.)
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
    // (WS-3b step 0a `homeostaticDemotion` was removed — R4. The key is
    // tolerated via passthrough if an old config still carries it; continuous
    // decay is now part of the always-applied salience recency term.)
    // WS-3b: Schema-similarity gate (step 0b). At intake, if a new candidate's
    // body embedding is within epsilon of an existing derived-layer lesson/knowledge
    // node, mark it schema-consistent and lower its priority. Default ON for
    // the `extract` process since R3 (fail-open; set `enabled: false` to opt out).
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
      .passthrough()
      .optional(),
    // WS-3b: Hot-probation intake buffer (step 0c, #604). New system-generated
    // extractions enter captureMode: hot-probation and spend ONE consolidation
    // cycle in probation. Dedup + quality second-pass runs before promotion.
    // Default OFF. Only meaningful on the `extract` process.
    hotProbation: z
      .object({
        enabled: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    // WS-3b: Anti-collapse guards (step 8). Prevents the consolidation pipeline
    // from collapsing too aggressively and losing diversity.
    //   - maxGeneration: refuse to merge two assets both above this generation (default 2).
    //   - lexicalDiversityCheck: low n-gram diversity ⇒ raise merge threshold.
    //   - randomClusterFraction: occasional random (non-similar) cluster in pool (default 0.05).
    //   - mergeInformationFloor: measure that merges keep provenance + specificity
    //     (R5 §4.2; ADVISORY in v1 — counted, never refused).
    //   - minSpecificityRetention: distinct-token retention floor for merges (default 0.6).
    // Default ON since R5 (opt out via enabled: false). Only meaningful on the
    // `consolidate` process.
    antiCollapse: z
      .object({
        enabled: z.boolean().optional(),
        maxGeneration: z.number().int().min(1).optional(),
        lexicalDiversityCheck: z.boolean().optional(),
        randomClusterFraction: z.number().min(0).max(1).optional(),
        mergeInformationFloor: z.boolean().optional(),
        minSpecificityRetention: z.number().min(0).max(1).optional(),
      })
      .passthrough()
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
      .passthrough()
      .optional(),
    // WS-3b: Distill→source fidelity check (step 10). After a distill proposal,
    // check it against its cited source memories; a contradiction flag forces
    // human review. Default OFF. Only meaningful on `distill` process.
    fidelityCheck: z
      .object({
        enabled: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    // #609 — recombine process: minimum related-memory cluster size before an
    // LLM generalization call. Default 3. Only meaningful on `recombine`.
    minClusterSize: z.number().int().min(2).optional(),
    // #609 — recombine process: hard cap on clusters processed per run (one
    // bounded LLM call each). Default 5. Only meaningful on `recombine`.
    maxClustersPerRun: positiveInt.optional(),
    // #632 — recombine process: max members a cluster may contain before it is
    // SKIPPED (drops bland over-broad buckets). When set, largest-first ranking
    // no longer starves tighter clusters. Default UNSET = no cap. Only
    // meaningful on `recombine`.
    maxClusterSize: positiveInt.optional(),
    // #632 — recombine process: tag values that must never form a tag cluster
    // (generic project-wide tags). Default UNSET/[]. Only meaningful on
    // `recombine`.
    excludeTags: z.array(z.string().min(1)).optional(),
    // #632 — recombine process: entity_norm values that must never form an
    // entity cluster (user counterpart to the built-in generic-entity filter).
    // Default UNSET/[]. Only meaningful on `recombine`.
    excludeEntities: z.array(z.string().min(1)).optional(),
    // #609 — recombine process: relatedness signal used to form clusters
    // (tags | graph | both). Clustering is by relatedness, never embedding
    // similarity. Default "both" (#632). Only meaningful on `recombine`.
    relatednessSource: z.enum(["tags", "graph", "both"]).optional(),
    // #609 — recombine process: consecutive re-inductions required before a
    // hypothesis is promoted to a lesson. Default 2. Only meaningful on
    // `recombine`.
    confirmThreshold: z.number().int().min(1).optional(),
    // #615 — procedural process: minimum number of distinct assets sharing the
    // same successful normalized ordered-action sequence before it is compiled
    // into a workflow proposal. Default 3. Only meaningful on `procedural`.
    minRecurrence: z.number().int().min(2).optional(),
    // #615 — procedural process: hard cap on workflow proposals emitted per run
    // (one bounded LLM call each). Default 3. Only meaningful on `procedural`.
    maxProposalsPerRun: positiveInt.optional(),
    // #615 — procedural process: asset type a compiled sequence is emitted as.
    // Reserved; v1 always emits "workflow". Only meaningful on `procedural`.
    emitAs: z.enum(["workflow", "skill"]).optional(),
    // #639 — semantic value-floor filter for the `reflect` process. When
    // enabled, proposals classified as "low-value" by the deterministic noise
    // gate are deferred. DEFAULT OFF (absent / { enabled: false } = pre-#639
    // byte-identical behaviour). Only meaningful on the `reflect` process.
    lowValueFilter: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    // #641 — procedural-aware floor for the `extract` process triage gate.
    // When true, a session must have markers>=1 OR editCommit>=0.5 to pass, even
    // if score>=minScore. DEFAULT OFF (absent/false = pre-#641 byte-identical).
    // Only meaningful on the `extract` process when triage is also enabled.
    proceduralAwareFloor: z.boolean().optional(),
    // Triage process config (only meaningful for the `triage` process)
    applyMode: z.enum(["queue", "promote"]).optional(),
    policy: z.string().min(1).optional(),
    maxAcceptsPerRun: positiveInt.optional(),
    maxDiffLines: positiveInt.optional(),
    rejectEmpty: z.boolean().optional(),
    judgment: z
      .object({
        engine: engineName.optional(),
        model: nonEmptyString.optional(),
        timeoutMs: z.union([positiveInt, z.null()]).optional(),
        llm: LlmInvocationOverridesSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of ["mode", "profile"]) {
      if (key in value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is retired; use engine` });
      }
    }
    const judgment = value.judgment as Record<string, unknown> | undefined;
    if (judgment) {
      for (const key of ["mode", "profile"]) {
        if (key in judgment) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["judgment", key],
            message: `${key} is retired; use engine`,
          });
        }
      }
    }
  });

const ImproveProfileProcessesSchema = z
  .object({
    reflect: ImproveProcessConfigSchema.optional(),
    distill: ImproveProcessConfigSchema.optional(),
    consolidate: ImproveProcessConfigSchema.optional(),
    memoryInference: ImproveProcessConfigSchema.optional(),
    graphExtraction: ImproveProcessConfigSchema.optional(),
    extract: ImproveProcessConfigSchema.optional(),
    validation: ImproveProcessConfigSchema.optional(),
    triage: ImproveProcessConfigSchema.optional(),
    proactiveMaintenance: ImproveProcessConfigSchema.optional(),
    recombine: ImproveProcessConfigSchema.optional(),
    procedural: ImproveProcessConfigSchema.optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    // 0.8.0 removed the duplicated `feedbackDistillation` process key — it was
    // a thin wrapper around `processes.distill.enabled`. Keep the migration
    // hint so a stale config gets an actionable message rather than silently
    // doing nothing. All OTHER unknown process keys are tolerated (passthrough)
    // — see the unknown-key policy in this file's header. Hard-rejecting them
    // turned benign cross-version skew into INVALID_CONFIG_FILE failures.
    if ("feedbackDistillation" in (val as Record<string, unknown>)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "feedbackDistillation was removed in 0.8.0 — use processes.distill.enabled instead. " +
          "It now controls both the orchestration gate and the LLM-call gate.",
      });
    }
  });

export const ImproveProfileConfigSchema = z
  .object({
    engine: engineName.optional(),
    model: nonEmptyString.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    llm: LlmInvocationOverridesSchema.optional(),
    description: z.string().min(1).optional(),
    processes: ImproveProfileProcessesSchema.optional(),
    autoAccept: nonNegativeNumber.optional(),
    limit: positiveInt.optional(),
    // #616 — bounded multi-cycle phasing. Number of prep->loop->post-loop
    // cycles per run. positiveInt forbids 0/negative. DEFAULT 1 => byte-identical
    // single-pass behavior.
    maxCycles: positiveInt.optional(),
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
      .passthrough()
      .optional(),
  })
  .passthrough();

// ── Defaults ───────────────────────────────────────────────────────────────

export const DefaultsSchema = z
  .object({
    engine: engineName.optional(),
    llmEngine: engineName.optional(),
    improveStrategy: engineName.optional(),
  })
  .passthrough();

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
  .passthrough()
  .superRefine((entry, ctx) => {
    if (!["filesystem", "git", "website", "npm"].includes(entry.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: `unsupported source type "${entry.type}"; expected filesystem, git, website, or npm`,
      });
    }
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
  .passthrough();

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
  .passthrough()
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
  .passthrough();

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
  .passthrough();

export const SearchConfigSchema = z
  .object({
    minScore: nonNegativeNumber.optional(),
    defaultExcludeTypes: z.array(nonEmptyString).optional(),
    graphBoost: SearchGraphBoostSchema.optional(),
  })
  .passthrough();

// ── Feedback ────────────────────────────────────────────────────────────────

export const FeedbackConfigSchema = z
  .object({
    requireReason: z.boolean().optional(),
    allowedFailureModes: z.array(nonEmptyString).optional(),
  })
  .passthrough();

// ── Improve top-level (utility decay, event retention) ─────────────────────

const ImproveUtilityDecaySchema = z
  .object({
    halfLifeDays: z.number().finite().min(0.1).optional(),
    feedbackStabilityBoost: z.number().finite().min(1).optional(),
  })
  .passthrough();

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
  .passthrough();

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
  .passthrough();

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
  .passthrough();

// R5 — longitudinal collapse/churn detector (observe-only in v1; deterministic,
// fail-open, runs only on cycles where consolidate/recombine did work).
// Default ON; opt out via `improve.collapseDetector.enabled: false`.
// See docs/design/improve-collapse-churn-detector-design.md.
const ImproveCollapseDetectorSchema = z
  .object({
    enabled: z.boolean().optional(),
    // Canary set size minted on first run (owner-approved 30–50 range; default 40).
    canaryCount: z.number().int().min(3).max(200).optional(),
    // Top-K cutoff for canary recall/nDCG (default 10).
    k: z.number().int().min(1).max(100).optional(),
    // Trend window in qualifying cycles (default 5).
    windowCycles: z.number().int().min(2).max(50).optional(),
    // Absolute mean-recall drop vs window median that fires collapse (default 0.15).
    recallDropThreshold: z.number().min(0).max(1).optional(),
    // distinct-content-ratio decline over the window that fires collapse (default 0.05).
    entropyDropThreshold: z.number().min(0).max(1).optional(),
    // Accepted-action volume over the window below which churn never fires (default 25).
    churnMinAcceptedActions: z.number().int().min(1).optional(),
    // improve_cycle_metrics retention (default 365 days, owner-approved).
    retentionDays: z.number().int().min(1).optional(),
  })
  .passthrough();

export const ImproveConfigSchema = z
  .object({
    strategies: z.record(engineName, ImproveProfileConfigSchema).optional(),
    utilityDecay: ImproveUtilityDecaySchema.optional(),
    eventRetentionDays: nonNegativeNumber.optional(),
    calibration: ImproveCalibrationSchema.optional(),
    exploration: ImproveExplorationSchema.optional(),
    salience: ImproveSalienceSchema.optional(),
    collapseDetector: ImproveCollapseDetectorSchema.optional(),
  })
  .passthrough();

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
  "fact",
] as const;

const INDEX_PASS_RETIRED_KEYS = new Set([
  "endpoint",
  "provider",
  "apiKey",
  "baseUrl",
  "temperature",
  "maxTokens",
  "capabilities",
]);

const INDEX_PASS_KNOWN_KEYS = new Set([
  "engine",
  "model",
  "timeoutMs",
  "enabled",
  "llm",
  "graphExtractionBatchSize",
  "graphExtractionIncludeTypes",
  "lazyGraphExtraction",
]);

/**
 * Per-pass `index.<pass>` entry. Uses preprocess + manual validation so we can
 * emit targeted error messages ("Retired or misplaced engine setting",
 * "Unknown key `index.<pass>.<key>`")
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
      if (INDEX_PASS_RETIRED_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Retired or misplaced engine setting: \`${[...(ctx.path ?? []), key].join(".")}\` is not allowed. ` +
            "Select a named engine and use typed invocation fields instead.",
        });
        return raw;
      }
      if (!INDEX_PASS_KNOWN_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Unknown key \`${[...(ctx.path ?? []), key].join(".")}\`. Per-pass entries support ` +
            "`engine`, `model`, `timeoutMs`, `enabled`, `llm`, `graphExtractionBatchSize`, " +
            "`graphExtractionIncludeTypes`, and `lazyGraphExtraction`.",
        });
        return raw;
      }
    }
    return raw;
  },
  z
    .object({
      engine: engineName.optional(),
      model: nonEmptyString.optional(),
      timeoutMs: z.union([positiveInt, z.null()]).optional(),
      enabled: z.boolean().optional(),
      llm: LlmInvocationOverridesSchema.optional(),
      graphExtractionBatchSize: positiveInt.optional(),
      graphExtractionIncludeTypes: z.array(z.enum(GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED)).nonempty().optional(),
      lazyGraphExtraction: z.boolean().optional(),
    })
    .passthrough(),
);

const MetadataEnhanceSchema = z.object({ enabled: z.boolean().optional() }).passthrough();

/**
 * RETIRED (meta-review 10-Q3): the staleness-detect pass was deleted; nothing
 * reads this section anymore. The key stays TOLERATED here so configs that
 * still carry `index.stalenessDetection` (written by 0.8.x migrations) do not
 * fail validation — deleting the key would route it into the per-pass
 * catchall, which rejects its `enabled`/`thresholdDays` fields.
 */
const StalenessDetectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdDays: positiveInt.optional(),
  })
  .passthrough();

/**
 * Index config is a union of reserved feature sections and per-pass entries.
 * Passthrough so per-pass entries (keyed by arbitrary pass names like `graph`,
 * `enrichment`) can live next to the reserved keys.
 *
 * Reserved scalar key `indexBodyOpening` (stash-conventions SPEC-8, default
 * false): when true, the metadata pass captures the first prose paragraph of
 * each markdown asset body into `entry.bodyOpening`, which folds into the
 * lowest-weight `content` FTS column and the embedding text. It is a boolean,
 * not a per-pass object — the preprocess below exempts it from the
 * object-shape check so it never routes into the per-pass catchall.
 *
 * The outer preprocess emits the legacy parser's actionable error messages
 * for the two most common type-shape mistakes:
 *   - An array at the `index` block.
 *   - A non-object at `index.<passName>`.
 * Inner field validation (graphExtractionIncludeTypes enum, invocation
 * overrides, provider-key rejection) is delegated to {@link IndexPassConfigSchema}.
 */
export const IndexConfigSchema = z.preprocess(
  (raw, ctx) => {
    if (raw === undefined || raw === null) return raw;
    if (Array.isArray(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Invalid `index` config: expected an object keyed by pass name (e.g. `{ "enrichment": { "enabled": false } }`).',
      });
      return raw;
    }
    if (typeof raw !== "object") return raw;
    for (const [passName, value] of Object.entries(raw as Record<string, unknown>)) {
      if (passName === "indexBodyOpening") {
        if (typeof value !== "boolean") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Invalid `index.indexBodyOpening`: expected a boolean (true to index the first body paragraph " +
              `of markdown assets into search). Got ${Array.isArray(value) ? "array" : typeof value}.`,
          });
          return raw;
        }
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid \`index.${passName}\` config: expected an object like \`{ "enabled": false }\`.`,
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
      defaults: z
        .object({
          engine: engineName.optional(),
          model: nonEmptyString.optional(),
          timeoutMs: z.union([positiveInt, z.null()]).optional(),
          llm: LlmInvocationOverridesSchema.optional(),
        })
        .passthrough()
        .optional(),
      metadataEnhance: MetadataEnhanceSchema.optional(),
      stalenessDetection: StalenessDetectionSchema.optional(),
      graph: IndexPassConfigSchema.optional(),
      memory: IndexPassConfigSchema.optional(),
      enrichment: IndexPassConfigSchema.optional(),
      indexBodyOpening: z
        .boolean()
        .optional()
        .describe(
          "Index the first prose paragraph of each markdown asset body (capped at 280 chars) into the " +
            "lowest-weight `content` search column and the embedding text (default false). Secret/env files " +
            "and session-kind memories are never captured. Toggling the flag changes indexed text: run " +
            "`akm index --full` afterwards to re-extract every entry and regenerate embeddings, and re-mint " +
            "collapse-detector canary baselines via `akm improve canary --refresh`.",
        ),
    })
    // The preprocess validates arbitrary named pass entries. Passthrough keeps
    // extension pass names without imposing an index signature that would
    // incorrectly require reserved scalar keys to have the pass-object shape.
    .passthrough(),
);

// ── Workflow engine ─────────────────────────────────────────────────────────

/**
 * Workflow-engine settings (`workflow`).
 *
 * `maxConcurrency` is the engine-wide ceiling on concurrent units for native
 * fan-out (`akm workflow run`). It replaces the hard-coded `min(16, cores−2)`
 * cap (which matched Claude Code) with a user knob:
 *   - UNSET  → the CPU-derived default `min(16, max(1, cores−2))`.
 *   - SET    → the explicit positive integer, CLAMPED at read time to
 *     `[1, WORKFLOW_MAX_CONCURRENCY_CEILING]` (64). Values above the ceiling
 *     are clamped, not rejected, so a config shared across machines with wildly
 *     different core counts never hard-fails validation.
 * The R3 brief/report driver surface does NOT consult this — drivers own their
 * own parallelism (the engine only caps native dispatch).
 */
export const WorkflowConfigSchema = z
  .object({
    maxConcurrency: positiveInt.optional(),
  })
  .passthrough();

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
  .passthrough();

export const SetupConfigSchema = z
  .object({
    taskSchedules: SetupTaskSchedulesSchema.optional(),
  })
  .passthrough();

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
  configVersion: z.literal(CURRENT_CONFIG_VERSION),
  engines: EnginesSchema.optional(),
  defaults: DefaultsSchema.optional(),
  // Global model-alias tiers: alias → platform → exact model string, with a
  // reserved `"*"` platform key as fallback. Lets workflows/callers name a
  // semantic tier ("fast", "deep") that resolves per-harness at dispatch
  // time. Values are literal model strings, never other aliases (one
  // resolution level). Platform keys match the platform string a command
  // builder resolves against ("claude", "opencode", "opencode-sdk", or a
  // custom profile's name for the default builder) — unknown keys are inert.
  // Precedence: profile modelAliases > this table > built-in aliases.
  modelAliases: GlobalModelAliasesSchema.optional(),
  stashDir: nonEmptyString.optional(),
  semanticSearchMode: z.enum(["off", "auto"]).default("auto"),
  embedding: EmbeddingConnectionConfigSchema.optional(),
  index: IndexConfigSchema.optional(),
  // The `installed[]` shape is OWNED by the registry (`InstalledStashEntry`):
  // its `source` is the 4-value `InstallKind` produced by the registry ref
  // parser, and installed entries never carry the extra passthrough keys. The
  // schema still validates entries at runtime, but its OUTPUT type is pinned to
  // the domain type so config consumers get the registry `InstalledStashEntry`
  // (not a looser schema-local mirror) — the single-source-of-truth boundary.
  installed: z.array(InstalledStashEntrySchema).optional() as unknown as z.ZodOptional<
    z.ZodArray<z.ZodType<InstalledStashEntry>>
  >,
  registries: z.array(RegistryConfigEntrySchema).optional(),
  sources: z.array(SourceConfigEntrySchema).optional(),
  output: OutputConfigSchema.optional(),
  writable: z.boolean().optional(),
  defaultWriteTarget: nonEmptyString.optional(),
  search: SearchConfigSchema.optional(),
  feedback: FeedbackConfigSchema.optional(),
  archiveRetentionDays: nonNegativeNumber.optional(),
  improve: ImproveConfigSchema.optional(),
  workflow: WorkflowConfigSchema.optional(),
  setup: SetupConfigSchema.optional(),
} as const;

export const AkmConfigBaseSchema = z.object(AkmConfigShape).passthrough();

export const AkmConfigSchema = AkmConfigBaseSchema.superRefine((config, ctx) => {
  const raw = config as Record<string, unknown>;
  for (const key of ["profiles", "llm", "agent", "features", "stashes"]) {
    if (key in raw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is retired in 0.9; configure engines and improve.strategies instead`,
      });
    }
  }
  for (const key of ["llm", "agent", "improve"]) {
    if (config.defaults && key in config.defaults) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaults", key],
        message: `defaults.${key} is retired in 0.9`,
      });
    }
  }
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    if (engine.kind === "agent" && engine.llmEngine) {
      const fallback = config.engines?.[engine.llmEngine];
      if (!fallback || fallback.kind !== "llm") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["engines", name, "llmEngine"],
          message: "llmEngine must name an LLM engine",
        });
      }
    }
  }
  const defaultEngine = config.defaults?.engine;
  if (defaultEngine && !config.engines?.[defaultEngine]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaults", "engine"],
      message: "engine does not name a configured engine",
    });
  }
  const defaultLlm = config.defaults?.llmEngine;
  if (defaultLlm && config.engines?.[defaultLlm]?.kind !== "llm") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaults", "llmEngine"],
      message: "llmEngine must name an LLM engine",
    });
  }
  const defaultStrategy = config.defaults?.improveStrategy;
  if (
    defaultStrategy &&
    !BUILTIN_IMPROVE_STRATEGY_NAMES.includes(defaultStrategy as (typeof BUILTIN_IMPROVE_STRATEGY_NAMES)[number]) &&
    !config.improve?.strategies?.[defaultStrategy]
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaults", "improveStrategy"],
      message: "improveStrategy does not name a built-in or configured strategy",
    });
  }
  for (const [strategyName, strategy] of Object.entries(config.improve?.strategies ?? {})) {
    const strategyEngine = strategy.engine;
    if (strategyEngine) {
      const engine = config.engines?.[strategyEngine];
      if (!engine || engine.kind !== "llm") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["improve", "strategies", strategyName, "engine"],
          message: engine ? "strategy engine must be an LLM engine" : "engine does not name a configured engine",
        });
      }
    }
    for (const [processName, process] of Object.entries(strategy.processes ?? {})) {
      const processConfig = process as { engine?: string; judgment?: { engine?: string } };
      const capability =
        IMPROVE_PROCESS_ENGINE_CAPABILITIES[processName as keyof typeof IMPROVE_PROCESS_ENGINE_CAPABILITIES];
      if (processConfig.engine && capability === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["improve", "strategies", strategyName, "processes", processName, "engine"],
          message: `${processName} does not dispatch an engine`,
        });
      } else {
        const processEngine = processConfig.engine ?? strategyEngine;
        if (processEngine && capability === "llm") {
          const engine = config.engines?.[processEngine];
          if (!engine || engine.kind !== "llm") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["improve", "strategies", strategyName, "processes", processName, "engine"],
              message: engine ? `${processName} requires an LLM engine` : "engine does not name a configured engine",
            });
          }
        } else if (processConfig.engine && capability === "runner" && !config.engines?.[processConfig.engine]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["improve", "strategies", strategyName, "processes", processName, "engine"],
            message: "engine does not name a configured engine",
          });
        }
      }
      const judgmentEngine = processConfig.judgment?.engine;
      if (judgmentEngine) {
        const engine = config.engines?.[judgmentEngine];
        if (!engine) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["improve", "strategies", strategyName, "processes", processName, "judgment", "engine"],
            message: "engine does not name a configured engine",
          });
        }
      }
    }
  }
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
