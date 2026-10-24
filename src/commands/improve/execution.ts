// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, ImproveProcessConfig, ImproveProfileConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { buildExecution, resolveExecution } from "../../integrations/agent/execution";
import type { RunnerSpec } from "../../integrations/agent/runner";

/** The settings a layer of improve's cascade can carry: where to run, which model, and how. */
type ImproveExecutionLayer = Pick<ImproveProcessConfig, "connection" | "harness" | "model" | "timeoutMs" | "llm"> & {
  /** A flag's name: a connection by that name, else a harness. */
  readonly engine?: string;
};

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

function cascadeDefaults(layer: ImproveExecutionLayer | undefined): UnresolvedExecutionDefaults {
  if (!layer) return {};
  return {
    ...(own(layer, "connection") ? { connection: layer.connection } : {}),
    ...(own(layer, "harness") ? { harness: layer.harness } : {}),
    ...(own(layer, "engine") ? { engine: layer.engine } : {}),
    ...(own(layer, "model") ? { model: layer.model } : {}),
    ...(own(layer, "llm") ? { inference: layer.llm as UnresolvedExecutionDefaults["inference"] } : {}),
    ...(own(layer, "timeoutMs") ? { timeout: layer.timeoutMs ?? null } : {}),
  };
}

function mergeDefaults(
  farther: UnresolvedExecutionDefaults,
  nearer: UnresolvedExecutionDefaults,
): UnresolvedExecutionDefaults {
  return deepMergeConfig(
    farther as Record<string, unknown>,
    nearer as Record<string, unknown>,
  ) as UnresolvedExecutionDefaults;
}

export interface ResolveImproveExecutionOptions {
  config: AkmConfig;
  processName: string;
  /** The selected strategy; it says which processes run, never where, so it adds no layer. */
  profile?: ImproveProfileConfig;
  process?: ImproveProcessConfig;
  /**
   * The process's standing `index.<pass>` settings, when the process has one:
   * farther than the process's own settings.
   */
  index?: ImproveExecutionLayer;
  /** Nearer one-shot selection, such as an explicit CLI connection/harness/timeout. */
  current?: ImproveExecutionLayer;
}

export interface ResolvedImproveExecution {
  runner: RunnerSpec;
  notices: readonly Readonly<LoweringNotice>[];
}

/**
 * Resolve improve-owned model work: `improve.connection` / `improve.harness`
 * -> index.<pass> -> process -> current invocation, nearest wins, over the
 * default by name. `null` when no connection or harness is configured for it.
 */
export function resolveImproveExecution(options: ResolveImproveExecutionOptions): ResolvedImproveExecution | null {
  const improveWide = cascadeDefaults(options.config.improve);
  const indexDefaults = cascadeDefaults(options.index);
  const processDefaults = cascadeDefaults(options.process);
  const currentDefaults = cascadeDefaults(options.current);
  try {
    const prepared = resolveExecution({
      content: `improve ${options.processName} execution selection`,
      config: options.config,
      invocationDefaults: mergeDefaults(improveWide, indexDefaults),
      current: mergeDefaults(processDefaults, currentDefaults),
      modelWork: true,
    });
    const lowered = buildExecution(prepared.request, prepared.runner);
    return Object.freeze({ runner: lowered.runner, notices: lowered.notices });
  } catch (error) {
    if (error instanceof ConfigError && error.code === "LLM_NOT_CONFIGURED") return null;
    throw error;
  }
}
