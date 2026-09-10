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
 *   silently dropped to keep cold-start working when a user has a field-level
 *   typo in an optional section.
 * - Unsupported top-level source shapes and provider kinds are hard-rejected;
 *   silently dropping them would mask user data loss.
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
import { warnOnce } from "../warn";
import { BUILTIN_IMPROVE_STRATEGY_NAMES, IMPROVE_PROCESS_ENGINE_CAPABILITIES } from "./engine-semantics";
import { EmbeddingConnectionConfigSchema } from "./schema/embedding";
import { EnginesSchema } from "./schema/engines";
import { ExperimentalConfigSchema } from "./schema/experimental";
import { FeedbackConfigSchema } from "./schema/feedback";
import { ImproveConfigSchema } from "./schema/improve";
import { IndexConfigSchema } from "./schema/index-config";
import { OutputConfigSchema } from "./schema/output";
import { CURRENT_CONFIG_VERSION, engineName, nonEmptyString, nonNegativeNumber } from "./schema/primitives";
import { SearchConfigSchema } from "./schema/search";
import { SetupConfigSchema } from "./schema/setup";
import { BundlesConfigSchema, RegistryConfigEntrySchema } from "./schema/sources-bundles";
import { WorkflowConfigSchema } from "./schema/workflow";

// ── Section re-exports (keep every `./config-schema` import path working) ────

export { EmbeddingConnectionConfigSchema } from "./schema/embedding";
export { EngineConfigSchema, EnginesSchema, LlmConnectionConfigSchema, LlmProfileConfigSchema } from "./schema/engines";
export { ExperimentalConfigSchema } from "./schema/experimental";
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
export { SetupConfigSchema } from "./schema/setup";
export {
  BundleConfigEntrySchema,
  BundlesConfigSchema,
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
 * the removed parser's warn-and-drop tolerance was a source of silent
 * configuration loss. There is no pre-schema compatibility transform.
 */
export const AkmConfigShape = {
  configVersion: z.literal(CURRENT_CONFIG_VERSION),
  // #945 — fleet inheritance. A filesystem path (relative to the directory of
  // the config file that declares it; `~` expands) or a `bundle//<path>` ref
  // naming an already-synced local file to deep-merge underneath this config
  // (local keys win) — the part after `//` is a plain file path relative to
  // that bundle's content root, not an asset conceptId; it needs no asset
  // type and is never indexed. No URL form: config load is synchronous and
  // runs on every invocation, and akm deliberately does not fetch network
  // resources at load time (see `registries`, never fetched until a
  // registry-touching command runs) — a URL-backed shared config should be
  // synced via `akm bundle add` (git/website) and referenced as
  // `extends: bundle//<path>` once materialized locally. Resolved in
  // `resolveExtendsChain` (./config.ts), not validated here (a bad ref
  // surfaces as a `ConfigError` at load, naming the ref).
  extends: nonEmptyString.optional(),
  engines: EnginesSchema.optional(),
  defaults: DefaultsSchema.optional(),
  semanticSearchMode: z.enum(["off", "auto"]).default("off"),
  embedding: EmbeddingConnectionConfigSchema.optional(),
  index: IndexConfigSchema.optional(),
  registries: z.array(RegistryConfigEntrySchema).optional(),
  // `bundles` + `defaultBundle` are the only source configuration shape. The
  // retired `stashDir`/`sources[]`/`installed[]` keys are rejected at load;
  // there is no runtime config translator. `defaultBundle` names the primary
  // bundle used for short-ref resolution.
  bundles: BundlesConfigSchema.optional(),
  defaultBundle: nonEmptyString.optional(),
  output: OutputConfigSchema.optional(),
  defaultWriteTarget: nonEmptyString.optional(),
  search: SearchConfigSchema.optional(),
  feedback: FeedbackConfigSchema.optional(),
  archiveRetentionDays: nonNegativeNumber.optional(),
  improve: ImproveConfigSchema.optional(),
  workflow: WorkflowConfigSchema.optional(),
  setup: SetupConfigSchema.optional(),
  // D8 — explicit opt-ins for behaviour outside the stability contract. Every
  // key defaults to OFF; see `src/core/config/experimental.ts` for the readers.
  experimental: ExperimentalConfigSchema.optional(),
} as const;

export const AkmConfigBaseSchema = z.object(AkmConfigShape).passthrough();

/**
 * Per-key overrides for unsupported pre-cutover source shapes.
 */
const RETIRED_SOURCE_SHAPE_KEY_MESSAGES: Record<string, string> = {
  stashDir:
    "stashDir is not supported; configure `bundles`, or use `akm config path --all` / `akm info` to inspect current paths.",
};

export const AkmConfigSchema = AkmConfigBaseSchema.superRefine((config, ctx) => {
  const raw = config as Record<string, unknown>;
  for (const key of ["profiles", "llm", "agent", "features", "stashes", "modelAliases", "bindings", "writable"]) {
    if (key in raw) {
      warnOnce(
        `config:retired-key:${key}`,
        `Config key "${key}" is retired in 0.9 and is ignored; configure engines/improve.strategies/bundles.<id> instead.`,
      );
    }
  }
  // Only the current source shape enters the runtime. There is no config
  // compatibility path; `bundles` + `defaultBundle` fully supersede these keys.
  for (const key of ["stashDir", "sources", "installed"]) {
    if (key in raw && raw[key] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message:
          RETIRED_SOURCE_SHAPE_KEY_MESSAGES[key] ?? `${key} is not supported; configure the current bundles shape`,
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
  const workflowJudge = config.workflow?.judgeEngine;
  if (workflowJudge && !config.engines?.[workflowJudge]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workflow", "judgeEngine"],
      message: "judgeEngine does not name a configured engine",
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
      const processConfig = process as { engine?: string; judgment?: { enabled?: boolean; engine?: string } };
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
      if (processConfig.judgment?.enabled === true && judgmentEngine) {
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
