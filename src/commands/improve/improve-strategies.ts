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
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";

/** 0.9 public name for the improve preset configuration. */
export type ImproveStrategyConfig = ImproveProfileConfig;

export interface SelectedStrategy {
  name: string;
  config: ImproveStrategyConfig;
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
  const process = (strategy.config.processes as Record<string, { enabled?: boolean } | undefined> | undefined)?.[
    processName
  ];
  return process?.enabled !== false;
}
