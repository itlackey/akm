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
import { HARNESS_AGENT_DISPATCH_IDS, VALID_HARNESS_IDS } from "./config-types";
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
    platform: AgentPlatformSchema.refine((platform) => HARNESS_AGENT_DISPATCH_IDS.has(platform), {
      message: "platform does not support agent dispatch",
    }),
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
//
// WI-9.6 (§4.2/§10.2): each of the 9 improve processes (reflect, distill,
// consolidate, memoryInference, graphExtraction, extract, validation, triage,
// proactiveMaintenance) gets its OWN schema below — a shared base (engine,
// model, llm, enabled, timeoutMs) extended with only the fields meaningful on
// that process — replacing the prior single ImproveProcessConfigSchema reused
// via `.optional()` for all 9 keys (which accepted, and silently ignored, any
// field on any process). Field→process assignment is derived from each
// field's original "only meaningful on X" doc comment, cross-checked against
// its actual runtime consumers and the built-in strategy assets
// (src/assets/improve-strategies/*.json).
//
// `ImproveProcessConfigSchema` ITSELF STAYS (unnarrowed — the union of every
// field across every process): it backs (a) the wide `ImproveProcessConfig`
// TS type that generic dynamic-process-name code needs (getImproveProcessConfig,
// ResolvedImproveProcess.config, agent/runner.ts's cast — the process name
// isn't known at the type level there, so the type must be a supertype every
// process's narrow output is assignable to), and (b) two existing tests that
// parse fields from multiple processes against it directly with no process
// context (tests/integration/extract-command.test.ts,
// tests/config-triage-process.test.ts). Real per-config validation for
// `processes.<name>` uses the NARROW per-process schemas via
// {@link ImproveProfileProcessesSchema} below — setting a field on the wrong
// process there is now rejected (the intended §4.2 improvement).

const IMPROVE_PROCESS_BASE_FIELDS = {
  engine: engineName.optional(),
  model: nonEmptyString.optional(),
  llm: LlmInvocationOverridesSchema.optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.union([positiveInt, z.null()]).optional(),
};

/** Reflect/distill/consolidate: process-level asset-type filter (see improve-strategies.ts shouldSkipRef/DEFAULT_ALLOWED_TYPES). */
const allowedTypesField = z.array(z.string().min(1)).optional();

/**
 * Consolidate process: hard cap on memories processed per pass.
 * Reflect/distill: max refs processed (same as profile-level `limit`).
 * proactiveMaintenance: fallback when `maxPerRun` is absent.
 */
const processLimitField = positiveInt.optional();

/**
 * Distill process: LLM-as-judge lesson quality gate. Default ON (R3);
 * fail-open — judge failure/timeout/parse errors pass through. Set
 * `enabled: false` on the distill process to opt out. Also read on the
 * `reflect` process (proposal-side quality gate; see reflect.ts).
 */
const qualityGateField = z.object({ enabled: z.boolean().optional() }).passthrough().optional();

/** Consolidate process: gate for the M-1 (#367) contradiction-detection pass. */
const contradictionDetectionField = z.object({ enabled: z.boolean().optional() }).passthrough().optional();

/**
 * WS-3b: CLS (Complementary Learning System) interleaving (step 9).
 * distill/memoryInference prompts include embedding-retrieved existing adjacent
 * lessons/knowledge to prevent catastrophic interference with prior generalizations.
 * Default OFF. Only meaningful on `distill` and `memoryInference` processes.
 */
const clsField = z
  .object({
    enabled: z.boolean().optional(),
    // Number of adjacent lessons/knowledge to include in prompts (default 3).
    adjacentCount: z.number().int().min(1).optional(),
  })
  .passthrough()
  .optional();

/**
 * WS-3b: Distill→source fidelity check (step 10). After a distill proposal,
 * check it against its cited source memories; a contradiction flag forces
 * human review. Default OFF. Distill process only.
 */
const fidelityCheckField = z.object({ enabled: z.boolean().optional() }).passthrough().optional();

/**
 * #639 — semantic value-floor filter for the `reflect` process. When
 * enabled, proposals classified as "low-value" by the deterministic noise
 * gate are deferred. DEFAULT OFF (absent / { enabled: false } = pre-#639
 * byte-identical behaviour). Reflect process only.
 */
const lowValueFilterField = z.object({ enabled: z.boolean().optional() }).passthrough().optional();

/**
 * #626 — extract process: pre-LLM heuristic triage gate. When enabled, a
 * deterministic scorer decides BEFORE the extraction LLM call whether a
 * session carries enough signal to be worth extracting; low-signal sessions
 * are skipped at zero LLM cost. Default OFF. `minScore` is the minimum total
 * heuristic score to PASS (default 2). Extract process only — NOTE: unrelated
 * to the `triage` PROCESS (`processes.triage`); this is a nested object under
 * `processes.extract.triage` that happens to share the name.
 */
const extractTriageGateField = z
  .object({
    enabled: z.boolean().optional(),
    minScore: z.number().min(0).optional(),
  })
  .passthrough()
  .optional();

/** Triage process: LLM-as-judge triage-apply decision engine override. */
const triageJudgmentField = z
  .object({
    engine: engineName.optional(),
    model: nonEmptyString.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    llm: LlmInvocationOverridesSchema.optional(),
  })
  .passthrough()
  .optional();

/**
 * WS-3b: Anti-collapse guards (step 8). Prevents the consolidation pipeline
 * from collapsing too aggressively and losing diversity. Consolidate process
 * only. Default ON since R5 (opt out via enabled: false).
 *   - maxGeneration: refuse to merge two assets both above this generation (default 2).
 *   - lexicalDiversityCheck: low n-gram diversity ⇒ raise merge threshold.
 *   - randomClusterFraction: occasional random (non-similar) cluster in pool (default 0.05).
 *   - mergeInformationFloor: LIVE gate (anti-collapse.ts:143) — NOT a
 *     decorative/inert knob. `false` skips the merge-information-floor
 *     measurement entirely (no counting, no warning) for every merge;
 *     true/absent (default) measures it on every merge. The MEASUREMENT's
 *     outcome is advisory in v1: a failing merge is counted
 *     (`merge_floor_violations`) and warned but never refused (promotion path:
 *     docs/design/improve-collapse-churn-detector-design.md §7). In short:
 *     this field gates whether the check runs at all (a real code path), not
 *     whether a merge is allowed.
 *   - minSpecificityRetention: distinct-token retention floor for merges (default 0.6).
 * (WS-3b step 0a `homeostaticDemotion` was removed — R4. Continuous decay is
 * now part of the always-applied salience recency term.)
 */
const antiCollapseField = z
  .object({
    enabled: z.boolean().optional(),
    maxGeneration: z.number().int().min(1).optional(),
    lexicalDiversityCheck: z.boolean().optional(),
    randomClusterFraction: z.number().min(0).max(1).optional(),
    mergeInformationFloor: z.boolean().optional(),
    minSpecificityRetention: z.number().min(0).max(1).optional(),
  })
  .passthrough()
  .optional();

const REFLECT_PROCESS_FIELDS = {
  allowedTypes: allowedTypesField,
  limit: processLimitField,
  qualityGate: qualityGateField,
  lowValueFilter: lowValueFilterField,
};

const DISTILL_PROCESS_FIELDS = {
  allowedTypes: allowedTypesField,
  limit: processLimitField,
  qualityGate: qualityGateField,
  // Skip distill entirely when reflect produced zero planned refs.
  requirePlannedRefs: z.boolean().optional(),
  cls: clsField,
  fidelityCheck: fidelityCheckField,
};

const CONSOLIDATE_PROCESS_FIELDS = {
  allowedTypes: allowedTypesField,
  limit: processLimitField,
  // Minimum eligible-memory pool size below which the consolidation pass skips
  // entirely (emits `pool_below_min_size`). 0 disables the guard. Default 500.
  minPoolSize: z.number().int().min(0).optional(),
  maxChunkSize: z.number().int().min(1).max(50).optional(),
  // Narrow candidate pool to memories modified within this duration window
  // plus their graph neighbours. Absent = full-pool sweep.
  incrementalSince: z.string().optional(),
  // Graph neighbours per changed memory during incremental consolidation.
  // Default 5. Only meaningful with incrementalSince.
  neighborsPerChanged: z.number().int().min(1).optional(),
  // Fallback p90 wall-clock time per consolidation chunk in seconds, used for
  // cold-start budget estimation when no telemetry history exists. The actual
  // p90 is derived from observed run durations once sufficient history
  // accumulates; this value is only used on the very first run. Default 30s.
  p90ChunkSecondsDefault: z.number().finite().positive().optional(),
  antiCollapse: antiCollapseField,
  contradictionDetection: contradictionDetectionField,
};

const MEMORY_INFERENCE_PROCESS_FIELDS = {
  // Minimum pending memory count to run the pass.
  minPendingCount: z.number().int().min(0).optional(),
  cls: clsField,
};

/**
 * GraphExtraction process fields: improve-owned graph extraction scope and
 * batching. Passed to the invocation directly and never inherited from
 * standalone index.graph.
 */
const GRAPH_EXTRACTION_PROCESS_FIELDS = {
  // #624 P2: when set, rank eligible files by utility_scores DESC and process
  // only the top-N per run (incremental high-signal-first sweep). Unset =
  // process all eligible (current behavior).
  topN: positiveInt.optional(),
  includeTypes: z.array(z.string().min(1)).min(1).optional(),
  batchSize: positiveInt.optional(),
  // Full-corpus scan. When true, graph extraction runs on ALL stash files
  // instead of only files touched by actionable refs in the current run.
  // Used by the `graph-refresh` built-in profile / a scheduled weekly task.
  fullScan: z.boolean().optional(),
};

const EXTRACT_PROCESS_FIELDS = {
  defaultSince: z.string().min(1).optional(),
  maxTotalChars: positiveInt.optional(),
  // Minimum raw session size (pre-filter inputCount) below which the extract
  // LLM call is skipped (#595/#596). 0 disables the gate. Absent = default 10
  // (skip only truly empty sessions).
  minContentChars: z.number().int().min(0).optional(),
  triage: extractTriageGateField,
  // Minimum number of new (unseen, in-window) candidate sessions below which
  // the extract pass skips entirely (emits an `improve_skipped` event with
  // `reason: "below_min_new_sessions"`). 0 disables the guard. Default 0
  // (disabled) so existing behaviour is preserved; only opted-in profiles set it.
  minNewSessions: z.number().int().min(0).optional(),
  // Cap on NEW sessions processed (LLM-called) per run; the rest roll to the
  // next run (still unseen). 0 disables. Absent = default 25.
  maxSessionsPerRun: z.number().int().min(0).optional(),
  // #561 — index agent sessions as a searchable `session` asset. Absent =
  // on-when-an-LLM-is-available (fail-open when offline). COST: when on, each
  // processed session makes a SECOND LLM call (the session summary) on top of
  // the extraction call — i.e. ~2 LLM calls/session. Set to false to halve
  // per-session extract cost at the price of unsearchable sessions.
  // (Unchanged/skip sessions still cost zero — the content-hash ledger gates
  // both calls upstream.)
  indexSessions: z.boolean().optional(),
  // #561 — minimum session duration in minutes for session indexing. 0
  // disables the gate. Absent = default 5.
  minSessionDuration: z.number().min(0).optional(),
};

const TRIAGE_PROCESS_FIELDS = {
  applyMode: z.enum(["queue", "promote"]).optional(),
  policy: z.string().min(1).optional(),
  maxAcceptsPerRun: positiveInt.optional(),
  maxDiffLines: positiveInt.optional(),
  rejectEmpty: z.boolean().optional(),
  judgment: triageJudgmentField,
};

/** proactiveMaintenance process fields (Layer 2). */
const PROACTIVE_MAINTENANCE_PROCESS_FIELDS = {
  // Staleness gate + rotation cooldown in days (default 30).
  dueDays: z.number().int().min(0).optional(),
  // Top-N bound per run (default 25). Alias for `limit`; `maxPerRun` wins
  // when both are set.
  maxPerRun: positiveInt.optional(),
  limit: processLimitField,
};

/**
 * Shared cross-process superRefine: rejects the retired `mode`/`profile`
 * knobs (top-level and inside a `judgment` sub-object) in favour of `engine`.
 * Applied identically to every per-process schema and to the wide
 * ImproveProcessConfigSchema.
 */
function checkRetiredProcessKeys(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
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
}

export const ImproveProcessConfigSchema = z
  .object({
    ...IMPROVE_PROCESS_BASE_FIELDS,
    ...REFLECT_PROCESS_FIELDS,
    ...DISTILL_PROCESS_FIELDS,
    ...CONSOLIDATE_PROCESS_FIELDS,
    ...MEMORY_INFERENCE_PROCESS_FIELDS,
    ...GRAPH_EXTRACTION_PROCESS_FIELDS,
    ...EXTRACT_PROCESS_FIELDS,
    ...TRIAGE_PROCESS_FIELDS,
    ...PROACTIVE_MAINTENANCE_PROCESS_FIELDS,
  })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.reflect` — narrow per-process schema (WI-9.6). */
export const ReflectProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS, ...REFLECT_PROCESS_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.distill` — narrow per-process schema (WI-9.6). */
export const DistillProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS, ...DISTILL_PROCESS_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.consolidate` — narrow per-process schema (WI-9.6). */
export const ConsolidateProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS, ...CONSOLIDATE_PROCESS_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.memoryInference` — narrow per-process schema (WI-9.6). */
export const MemoryInferenceProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS, ...MEMORY_INFERENCE_PROCESS_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.graphExtraction` — narrow per-process schema (WI-9.6). */
export const GraphExtractionProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS, ...GRAPH_EXTRACTION_PROCESS_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.extract` — narrow per-process schema (WI-9.6). */
export const ExtractProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS, ...EXTRACT_PROCESS_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.validation` — narrow per-process schema (WI-9.6); no extra fields beyond the shared base. */
export const ValidationProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.triage` — narrow per-process schema (WI-9.6). */
export const TriageProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS, ...TRIAGE_PROCESS_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

/** `processes.proactiveMaintenance` — narrow per-process schema (WI-9.6). */
export const ProactiveMaintenanceProcessConfigSchema = z
  .object({ ...IMPROVE_PROCESS_BASE_FIELDS, ...PROACTIVE_MAINTENANCE_PROCESS_FIELDS })
  .passthrough()
  .superRefine(checkRetiredProcessKeys);

const ImproveProfileProcessesSchema = z
  .object({
    reflect: ReflectProcessConfigSchema.optional(),
    distill: DistillProcessConfigSchema.optional(),
    consolidate: ConsolidateProcessConfigSchema.optional(),
    memoryInference: MemoryInferenceProcessConfigSchema.optional(),
    graphExtraction: GraphExtractionProcessConfigSchema.optional(),
    extract: ExtractProcessConfigSchema.optional(),
    validation: ValidationProcessConfigSchema.optional(),
    triage: TriageProcessConfigSchema.optional(),
    proactiveMaintenance: ProactiveMaintenanceProcessConfigSchema.optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    // 0.8.0 removed the duplicated `feedbackDistillation` process key — it was
    // a thin wrapper around `processes.distill.enabled`. Keep the migration
    // hint so a stale config gets an actionable message rather than silently
    // doing nothing. Other unknown process keys remain preserved for
    // cross-version compatibility, but an enabled one is rejected below because
    // this version cannot execute it.
    if ("feedbackDistillation" in (val as Record<string, unknown>)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "feedbackDistillation was removed in 0.8.0 — use processes.distill.enabled instead. " +
          "It now controls both the orchestration gate and the LLM-call gate.",
      });
    }
    for (const [name, process] of Object.entries(val as Record<string, unknown>)) {
      if (
        !(name in IMPROVE_PROCESS_ENGINE_CAPABILITIES) &&
        process !== null &&
        typeof process === "object" &&
        (process as { enabled?: unknown }).enabled === true
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `Unknown enabled improve process "${name}"`,
        });
      }
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

const ImproveSalienceSchema = z
  .object({
    /**
     * WS-2 Part-V gate: enable the outcome-weight term in the salience projection.
     * Default TRUE/absent (DEFAULT ON since the G2 saturation cap landed — see
     * salience.ts): uses the WS-2 weights (w_e=0.25, w_o=0.15, w_r=0.60) so the
     * prediction-error outcome signal shapes rankScore (the R1 loop-closure).
     * Set to `false` to opt out and restore the WS-1 parity weights
     * (w_e=0.30, w_r=0.70, w_o=0); the `outcome` sub-score is still computed
     * and stored for observability in that mode.
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
// fail-open, runs only on cycles where consolidate did work).
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
    salience: ImproveSalienceSchema.optional(),
    collapseDetector: ImproveCollapseDetectorSchema.optional(),
  })
  .passthrough();

// ── Index / per-pass ────────────────────────────────────────────────────────
//
// WI-9.6c: `graphExtractionIncludeTypes` is no longer validated against a
// hardcoded allowlist (the prior GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED,
// which included a stale `wiki` entry and was already missing `fact` from the
// runtime consumer's own list — the schema-level allowlist had drifted from
// reality). Accept-any until Chunk 2 sources a real type list from adapter
// metadata: the field is now an array of arbitrary non-empty strings.
// Runtime consumers already handle unknown/unsupported type strings
// gracefully — src/indexer/graph/graph-extraction.ts's
// `SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES` set (and `collectEligibleFiles`)
// silently skips any type it doesn't recognize (no placement entry ⇒ zero
// eligible files for that type; no crash). This is a permissive-direction
// behavior change: configs with a previously-rejected type string now parse.

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
      // Accept-any until Chunk 2 (WI-9.6c) — no longer enum-restricted.
      graphExtractionIncludeTypes: z.array(z.string().min(1)).nonempty().optional(),
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

const IndexDefaultsSchema = z
  .object({
    engine: engineName.optional(),
    model: nonEmptyString.optional(),
    timeoutMs: z.union([positiveInt, z.null()]).optional(),
    llm: LlmInvocationOverridesSchema.optional(),
  })
  .passthrough();

type IndexConfigOutput = {
  [key: string]: unknown;
  defaults?: z.infer<typeof IndexDefaultsSchema>;
  metadataEnhance?: z.infer<typeof MetadataEnhanceSchema>;
  stalenessDetection?: z.infer<typeof StalenessDetectionSchema>;
  graph?: z.infer<typeof IndexPassConfigSchema>;
  memory?: z.infer<typeof IndexPassConfigSchema>;
  enrichment?: z.infer<typeof IndexPassConfigSchema>;
  indexBodyOpening?: boolean;
};

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
 * Inner field validation (graphExtractionIncludeTypes shape, invocation
 * overrides, provider-key rejection) is delegated to {@link IndexPassConfigSchema}.
 * `graphExtractionIncludeTypes` accepts arbitrary non-empty strings
 * (WI-9.6c — no hardcoded type allowlist; accept-any until Chunk 2).
 */
const IndexConfigRuntimeSchema = z.preprocess(
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
    }
    return raw;
  },
  z
    .object({
      defaults: IndexDefaultsSchema.optional(),
      metadataEnhance: MetadataEnhanceSchema.optional(),
      stalenessDetection: StalenessDetectionSchema.optional(),
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
    .catchall(IndexPassConfigSchema),
);

// The runtime catchall correctly validates arbitrary pass objects, but its
// inferred string index signature also covers reserved scalar keys. Publish a
// precise output type while retaining the stricter runtime and JSON schemas.
export const IndexConfigSchema = IndexConfigRuntimeSchema as z.ZodType<IndexConfigOutput>;

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
