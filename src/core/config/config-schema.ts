// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Zod schema for AkmConfig — the single source of truth for the on-disk shape.
 *
 * ASSEMBLY BARREL: the individual section schemas live under `./schema/*` (one
 * cohesive module per config area — engines, embedding, improve, sources/
 * bundles, index, search, output, feedback, workflow, setup, plus shared
 * `primitives`). This file assembles them into the top-level {@link AkmConfigShape}
 * / {@link AkmConfigSchema}, owns the cross-field {@link AkmConfigSchema.superRefine},
 * and RE-EXPORTS every section schema so all existing `./config-schema` imports
 * keep working unchanged. The decomposition is a pure structural refactor — the
 * generated `schemas/akm-config.json` is byte-identical.
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
import { BUILTIN_IMPROVE_STRATEGY_NAMES, IMPROVE_PROCESS_ENGINE_CAPABILITIES } from "./engine-semantics";
import { EmbeddingConnectionConfigSchema } from "./schema/embedding";
import { EnginesSchema } from "./schema/engines";
import { FeedbackConfigSchema } from "./schema/feedback";
import { ImproveConfigSchema } from "./schema/improve";
import { IndexConfigSchema } from "./schema/index-config";
import { OutputConfigSchema } from "./schema/output";
import {
  CURRENT_CONFIG_VERSION,
  engineName,
  GlobalModelAliasesSchema,
  nonEmptyString,
  nonNegativeNumber,
} from "./schema/primitives";
import { SearchConfigSchema } from "./schema/search";
import { SetupConfigSchema } from "./schema/setup";
import { BundlesConfigSchema, RegistryConfigEntrySchema } from "./schema/sources-bundles";
import { WorkflowConfigSchema } from "./schema/workflow";

// ── Section re-exports (keep every `./config-schema` import path working) ────

export { EmbeddingConnectionConfigSchema } from "./schema/embedding";
export { EngineConfigSchema, EnginesSchema, LlmConnectionConfigSchema, LlmProfileConfigSchema } from "./schema/engines";
export { FEEDBACK_FAILURE_MODES, FeedbackConfigSchema, type FeedbackFailureMode } from "./schema/feedback";
export { ImproveConfigSchema } from "./schema/improve";
export {
  ConsolidateProcessConfigSchema,
  DistillProcessConfigSchema,
  ExtractProcessConfigSchema,
  GraphExtractionProcessConfigSchema,
  ImproveProcessConfigSchema,
  ImproveProfileConfigSchema,
  MemoryInferenceProcessConfigSchema,
  ProactiveMaintenanceProcessConfigSchema,
  ReflectProcessConfigSchema,
  TriageProcessConfigSchema,
  ValidationProcessConfigSchema,
} from "./schema/improve-processes";
export { IndexConfigSchema, IndexPassConfigSchema } from "./schema/index-config";
export { OutputConfigSchema } from "./schema/output";
export { CURRENT_CONFIG_VERSION, LlmInvocationOverridesSchema } from "./schema/primitives";
export { SearchConfigSchema } from "./schema/search";
export { SetupConfigSchema, SetupTaskSchedulesSchema } from "./schema/setup";
export {
  BundleConfigEntrySchema,
  BundlesConfigSchema,
  InstalledStashEntrySchema,
  RegistryConfigEntrySchema,
  SourceConfigEntrySchema,
} from "./schema/sources-bundles";
export { WorkflowConfigSchema } from "./schema/workflow";

// ── Defaults ───────────────────────────────────────────────────────────────

export const DefaultsSchema = z
  .object({
    engine: engineName.optional(),
    llmEngine: engineName.optional(),
    improveStrategy: engineName.optional(),
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
  semanticSearchMode: z.enum(["off", "auto"]).default("auto"),
  embedding: EmbeddingConnectionConfigSchema.optional(),
  index: IndexConfigSchema.optional(),
  registries: z.array(RegistryConfigEntrySchema).optional(),
  // 0.9.0 config-shape cutover (spec §10.1 / D-R5). `bundles` + `defaultBundle`
  // are the ONLY source shape — the retired `stashDir`/`sources[]`/`installed[]`
  // trio is hard-rejected at load (see the top-level superRefine). The migrator
  // ({@link migrateConfigSourcesToBundles}) converts a pre-cutover config to this
  // shape before validation. `defaultBundle` names the primary bundle (spec
  // §11.1 short-ref resolution / D-R4). `SourceConfigEntrySchema` /
  // `InstalledStashEntrySchema` remain EXPORTED (the migrator + transitional
  // readers consume them) but are no longer top-level config fields.
  bundles: BundlesConfigSchema.optional(),
  defaultBundle: nonEmptyString.optional(),
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
  // `bindings` (spec §10.1) is Tier B — never emitted, never accepted. The
  // top-level schema is `.passthrough()`, so without this it would round-trip
  // silently; reject it loudly so a stray/hand-written bindings block is caught.
  if ("bindings" in raw) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bindings"],
      message: "bindings is not supported in 0.9.0 (Tier B); it is neither emitted nor accepted",
    });
  }
  // 0.9.0 config-shape cutover (spec §10.1): the retired `stashDir`/`sources`/
  // `installed` trio is HARD-REJECTED at load whenever present — `bundles` +
  // `defaultBundle` fully supersede it. A pre-cutover config never loads through
  // this validated path; the migrator ({@link migrateConfigSourcesToBundles})
  // normalizes old→bundles BEFORE validation, and `inspectConfig` classifies an
  // old-shape-alone config "old" (migration-eligible) via that same normalize.
  for (const key of ["stashDir", "sources", "installed"]) {
    if (key in raw && raw[key] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is the retired pre-cutover source shape; run \`akm migrate apply\` to convert it to bundles`,
      });
    }
  }
  // `defaultBundle`, when present, must name a configured bundle.
  if (config.defaultBundle !== undefined) {
    if (config.bundles === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultBundle"],
        message: "defaultBundle requires a bundles map",
      });
    } else if (!(config.defaultBundle in config.bundles)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultBundle"],
        message: `defaultBundle "${config.defaultBundle}" does not name a configured bundle`,
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
  // #464.a: defaultWriteTarget must name a configured source. 0.9.0 (spec
  // §10.1): sources are `bundles` keys, so it must name a bundle. With no
  // bundles configured, error out instead of silently accepting (no implicit
  // "first writable" fallback — see locked decision 3).
  if (config.defaultWriteTarget !== undefined) {
    const knownNames = Object.keys(config.bundles ?? {});
    if (knownNames.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultWriteTarget"],
        message:
          `defaultWriteTarget "${config.defaultWriteTarget}" cannot be resolved: no bundles configured. ` +
          "Add at least one entry to `bundles` first.",
      });
    } else if (!knownNames.includes(config.defaultWriteTarget)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultWriteTarget"],
        message: `defaultWriteTarget "${config.defaultWriteTarget}" does not match any configured bundle: ${knownNames.map((n) => `"${n}"`).join(", ")}.`,
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
