// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Improve profile + per-process (WI-9.6) discriminated schemas. Extracted
 * verbatim from the former `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";
import { IMPROVE_PROCESS_ENGINE_CAPABILITIES } from "../engine-semantics";
import { engineName, LlmInvocationOverridesSchema, nonEmptyString, positiveInt } from "./primitives";

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
 *     docs/architecture/specs/improve-collapse-churn-detector-design.md §7). In short:
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
