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
import type { AkmConfig, ImproveProcessConfig, ImproveProfileConfig } from "../../core/config/config";
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

/** Resolve process enablement from the selected strategy, the sole improve authority. */
export function resolveProcessEnabled(
  processName: keyof NonNullable<ImproveProfileConfig["processes"]> | string,
  strategy: ImproveProfileConfig,
): boolean {
  const processes = strategy.processes as Record<string, { enabled?: boolean } | undefined> | undefined;
  return processes?.[processName]?.enabled === true;
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

export type ImproveLlmRunner = Extract<RunnerSpec, { kind: "llm" }>;
export type ImproveProcessName = keyof typeof IMPROVE_PROCESS_ENGINE_CAPABILITIES;

export interface ResolvedImproveProcess {
  enabled: boolean;
  config: Readonly<ImproveProcessConfig>;
  runner: ImproveLlmRunner | null;
}

/** Complete immutable process behavior for one improve invocation. */
export interface ResolvedImprovePlan {
  strategy: Readonly<SelectedStrategy>;
  processes: Readonly<Record<ImproveProcessName, ResolvedImproveProcess>>;
  triageJudgment: RunnerSpec | null;
}

function cloneAndFreeze<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone;
}

/** Resolve every enabled process structurally before improve emits signals or performs I/O. */
export function resolveImprovePlan(
  name: string | undefined,
  config: AkmConfig,
  options: { repairValidationFailures?: boolean } = {},
): ResolvedImprovePlan {
  const strategy = resolveImproveStrategy(name, config);
  return buildImprovePlan(strategy, config, options);
}

function buildImprovePlan(
  strategy: SelectedStrategy,
  config: AkmConfig,
  options: { repairValidationFailures?: boolean },
): ResolvedImprovePlan {
  const processes = {} as Record<ImproveProcessName, ResolvedImproveProcess>;
  for (const processName of Object.keys(IMPROVE_PROCESS_ENGINE_CAPABILITIES) as ImproveProcessName[]) {
    const processConfig = cloneAndFreeze(strategy.config.processes?.[processName] ?? {});
    const enabled = processConfig.enabled === true;
    let runner: ImproveLlmRunner | null = null;
    if (IMPROVE_PROCESS_ENGINE_CAPABILITIES[processName] !== "llm" || !enabled) {
      processes[processName] = Object.freeze({ enabled, config: processConfig, runner });
      continue;
    }
    // Validation itself is structural and always runs. Only its optional repair
    // step needs a model, so disabling repair must not create an LLM preflight.
    if (processName !== "validation" || options.repairValidationFailures !== false) {
      runner = resolveImproveProcessRunner(strategy.config, processName, config);
    }
    if (!runner && !(processName === "validation" && options.repairValidationFailures === false)) {
      throw new ConfigError(
        `Enabled improve process "${processName}" requires an LLM engine. Set defaults.llmEngine or improve.strategies.${strategy.name}.processes.${processName}.engine.`,
        "LLM_NOT_CONFIGURED",
      );
    }
    if (runner) runner = cloneAndFreeze(runner) as ImproveLlmRunner;
    processes[processName] = Object.freeze({ enabled, config: processConfig, runner });
  }

  const triage = strategy.config.processes?.triage;
  const judgmentOptedIn = triage !== undefined && Object.hasOwn(triage, "judgment");
  const triageJudgment =
    processes.triage.enabled && judgmentOptedIn
      ? resolveTriageJudgmentRunner(triage.judgment, config, triage, strategy.config)
      : null;
  if (processes.triage.enabled && judgmentOptedIn && !triageJudgment) {
    throw new ConfigError(
      `Enabled improve triage judgment requires an engine. Set defaults.llmEngine or improve.strategies.${strategy.name}.processes.triage.judgment.engine.`,
      "LLM_NOT_CONFIGURED",
    );
  }
  const frozenProcesses = Object.freeze(processes);
  const frozenStrategy: SelectedStrategy = Object.freeze({
    name: strategy.name,
    config: cloneAndFreeze({
      ...strategy.config,
      processes: Object.fromEntries(
        Object.entries(frozenProcesses).map(([name, process]) => [name, process.config]),
      ) as NonNullable<ImproveProfileConfig["processes"]>,
    }),
  });
  return Object.freeze({
    strategy: frozenStrategy,
    processes: frozenProcesses,
    triageJudgment: triageJudgment ? cloneAndFreeze(triageJudgment) : null,
  });
}
