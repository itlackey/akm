// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import catchup from "../../assets/improve-strategies/catchup.json" with { type: "json" };
import consolidate from "../../assets/improve-strategies/consolidate.json" with { type: "json" };
import defaultStrategy from "../../assets/improve-strategies/default.json" with { type: "json" };
import frequent from "../../assets/improve-strategies/frequent.json" with { type: "json" };
import graphRefresh from "../../assets/improve-strategies/graph-refresh.json" with { type: "json" };
import memoryFocus from "../../assets/improve-strategies/memory-focus.json" with { type: "json" };
import proactiveMaintenance from "../../assets/improve-strategies/proactive-maintenance.json" with { type: "json" };
import quick from "../../assets/improve-strategies/quick.json" with { type: "json" };
import recombineOnly from "../../assets/improve-strategies/recombine-only.json" with { type: "json" };
import reflectDistill from "../../assets/improve-strategies/reflect-distill.json" with { type: "json" };
import synthesize from "../../assets/improve-strategies/synthesize.json" with { type: "json" };
import thorough from "../../assets/improve-strategies/thorough.json" with { type: "json" };
import { parseAssetRef } from "../../core/asset/asset-ref";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import {
  BUILTIN_IMPROVE_STRATEGY_NAMES,
  IMPROVE_PROCESS_ENGINE_CAPABILITIES,
} from "../../core/config/engine-semantics";
import { ConfigError } from "../../core/errors";
import {
  type RunnerSpec,
  resolveImproveProcessRunner,
  resolveTriageJudgmentRunner,
} from "../../integrations/agent/runner";

/** 0.9 public name for the improve preset configuration. */
export type ImproveStrategyConfig = ImproveProfileConfig;

export interface SelectedStrategy {
  name: string;
  config: ImproveStrategyConfig;
}

export const DEFAULT_ALLOWED_TYPES: Record<"reflect" | "distill" | "consolidate", string[]> = {
  reflect: ["agent", "command", "knowledge", "lesson", "memory", "skill", "wiki", "workflow"],
  distill: ["memory"],
  consolidate: ["memory"],
};

const IMPROVE_PROCESS_DEFAULTS: Record<string, boolean> = {
  reflect: true,
  distill: true,
  consolidate: true,
  memoryInference: true,
  graphExtraction: true,
  validation: true,
  extract: true,
  triage: false,
  proactiveMaintenance: false,
  recombine: false,
  procedural: false,
};

/** Resolve process enablement from the selected strategy, the sole improve authority. */
export function resolveProcessEnabled(
  processName: keyof NonNullable<ImproveProfileConfig["processes"]> | string,
  strategy: ImproveProfileConfig,
): boolean {
  const processes = strategy.processes as Record<string, { enabled?: boolean } | undefined> | undefined;
  const entry = processes?.[processName];
  if (entry && typeof entry.enabled === "boolean") return entry.enabled;
  return IMPROVE_PROCESS_DEFAULTS[processName] ?? false;
}

export function shouldSkipRef(
  ref: string,
  processName: "reflect" | "distill" | "consolidate",
  strategy: ImproveProfileConfig,
): { skip: boolean; reason: string } {
  const process = strategy.processes?.[processName];
  if (process?.enabled === false) return { skip: true, reason: "process-disabled" };

  const parsed = parseAssetRef(ref);
  const allowed = process?.allowedTypes ?? DEFAULT_ALLOWED_TYPES[processName];
  if (!allowed.includes(parsed.type)) return { skip: true, reason: "type-filter" };
  if (parsed.type === "wiki" && parsed.name.split("/")[1] === "raw") return { skip: true, reason: "raw-wiki" };
  return { skip: false, reason: "" };
}

export function isStrategyFilteredForAllPasses(ref: string, strategy: ImproveProfileConfig): boolean {
  return shouldSkipRef(ref, "reflect", strategy).skip && shouldSkipRef(ref, "distill", strategy).skip;
}

const BUILTIN_STRATEGIES: Record<string, ImproveStrategyConfig> = {
  default: defaultStrategy as ImproveStrategyConfig,
  quick: quick as ImproveStrategyConfig,
  thorough: thorough as ImproveStrategyConfig,
  "memory-focus": memoryFocus as ImproveStrategyConfig,
  "graph-refresh": graphRefresh as ImproveStrategyConfig,
  frequent: frequent as ImproveStrategyConfig,
  consolidate: consolidate as ImproveStrategyConfig,
  catchup: catchup as ImproveStrategyConfig,
  synthesize: synthesize as ImproveStrategyConfig,
  "reflect-distill": reflectDistill as ImproveStrategyConfig,
  "proactive-maintenance": proactiveMaintenance as ImproveStrategyConfig,
  "recombine-only": recombineOnly as ImproveStrategyConfig,
};

if (BUILTIN_IMPROVE_STRATEGY_NAMES.some((name) => !(name in BUILTIN_STRATEGIES))) {
  throw new Error("Built-in improve strategy names are out of sync with their assets");
}

export function resolveImproveStrategy(name: string | undefined, config: AkmConfig): SelectedStrategy {
  const selectedName = name ?? config.defaults?.improveStrategy ?? "default";
  const userStrategies = config.improve?.strategies ?? {};
  if (!(selectedName in BUILTIN_STRATEGIES) && !userStrategies[selectedName]) {
    const valid = [...new Set([...Object.keys(BUILTIN_STRATEGIES), ...Object.keys(userStrategies)])].sort();
    throw new ConfigError(
      `Improve strategy "${selectedName}" not found. Valid strategies: ${valid.join(", ")}.`,
      "UNKNOWN_IMPROVE_STRATEGY",
    );
  }
  const selectedBuiltin = BUILTIN_STRATEGIES[selectedName] ?? {};
  const resolved = deepMergeConfig(
    deepMergeConfig(BUILTIN_STRATEGIES.default as Record<string, unknown>, selectedBuiltin as Record<string, unknown>),
    (userStrategies[selectedName] ?? {}) as Record<string, unknown>,
  ) as ImproveStrategyConfig;
  return { name: selectedName, config: resolved };
}

export function resolveStrategyProcessEnabled(strategy: SelectedStrategy, processName: string): boolean {
  return resolveProcessEnabled(processName, strategy.config);
}

const LLM_PROCESS_NAMES = Object.entries(IMPROVE_PROCESS_ENGINE_CAPABILITIES)
  .filter(([, capability]) => capability === "llm")
  .map(([name]) => name) as Array<keyof typeof IMPROVE_PROCESS_ENGINE_CAPABILITIES>;

export type ImproveLlmProcessName = (typeof LLM_PROCESS_NAMES)[number];
export type ImproveLlmRunner = Extract<RunnerSpec, { kind: "llm" }>;

/** Immutable engine selections for one improve invocation. */
export interface ResolvedImprovePlan {
  strategy: SelectedStrategy;
  processes: Partial<Record<ImproveLlmProcessName, ImproveLlmRunner>>;
  triageJudgment: RunnerSpec | null;
}

/** Resolve and materialize every enabled process before improve emits signals or performs I/O. */
export function resolveImprovePlan(
  name: string | undefined,
  config: AkmConfig,
  options: { repairValidationFailures?: boolean } = {},
): ResolvedImprovePlan {
  const strategy = resolveImproveStrategy(name, config);
  return materializeImprovePlan(strategy, config, options);
}

function materializeImprovePlan(
  strategy: SelectedStrategy,
  config: AkmConfig,
  options: { repairValidationFailures?: boolean },
): ResolvedImprovePlan {
  const processes: Partial<Record<ImproveLlmProcessName, ImproveLlmRunner>> = {};
  for (const processName of LLM_PROCESS_NAMES) {
    if (!resolveProcessEnabled(processName, strategy.config)) continue;
    // Validation itself is structural and always runs. Only its optional repair
    // step needs a model, so disabling repair must not create an LLM preflight.
    if (processName === "validation" && options.repairValidationFailures === false) continue;
    const runner = resolveImproveProcessRunner(strategy.config, processName, config);
    if (!runner) {
      const process = strategy.config.processes?.[processName];
      const hasModelIntent =
        strategy.config.model !== undefined ||
        strategy.config.llm !== undefined ||
        process?.model !== undefined ||
        process?.llm !== undefined;
      if (hasModelIntent) {
        throw new ConfigError(
          `Improve process "${processName}" configures model/llm overrides but has no fallback LLM engine. Set defaults.llmEngine or improve.strategies.${strategy.name}.processes.${processName}.engine.`,
          "LLM_NOT_CONFIGURED",
        );
      }
      continue;
    }
    processes[processName] = runner;
  }

  const triage = strategy.config.processes?.triage;
  const judgmentOptedIn = triage !== undefined && Object.hasOwn(triage, "judgment");
  const triageJudgment =
    resolveProcessEnabled("triage", strategy.config) && judgmentOptedIn
      ? resolveTriageJudgmentRunner(triage.judgment, config, triage, strategy.config)
      : null;
  return { strategy, processes, triageJudgment };
}
