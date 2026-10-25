// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, ImproveWhere } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { IMPROVE_ENGINE_PROCESSES } from "../../core/config/engine-semantics";
import { ConfigError } from "../../core/errors";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { buildExecution, resolveExecution } from "../../integrations/agent/execution";
import type { RunnerSpec } from "../../integrations/agent/runner";

/** The settings a layer of improve's cascade can carry: where to run, which model, and how. */
type ImproveExecutionLayer = Pick<ImproveWhere, "connection" | "harness" | "model" | "timeoutMs" | "llm"> & {
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

const TARGET_KEYS = ["connection", "harness", "engine"] as const;

/**
 * `nearer` over `farther`. A layer that names a connection or harness replaces the
 * farther layer's choice of one, whichever of the keys either used.
 */
function mergeDefaults(
  farther: UnresolvedExecutionDefaults,
  nearer: UnresolvedExecutionDefaults,
): UnresolvedExecutionDefaults {
  const names = TARGET_KEYS.some((key) => nearer[key] !== undefined);
  const base = names
    ? Object.fromEntries(Object.entries(farther).filter(([key]) => !(TARGET_KEYS as readonly string[]).includes(key)))
    : farther;
  return deepMergeConfig(
    base as Record<string, unknown>,
    nearer as Record<string, unknown>,
  ) as UnresolvedExecutionDefaults;
}

export interface ResolveImproveExecutionOptions {
  config: AkmConfig;
  /** What the call is for. When it names an improve process, `improve.processes.<name>` applies to it. */
  processName: string;
  /** The `improve.processes` entry that applies, for a call that is not itself an improve process (a judge). */
  process?: (typeof IMPROVE_ENGINE_PROCESSES)[number];
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
 * -> index.<pass> -> `improve.processes.<name>` -> current invocation, nearest
 * wins, over the default by name. A strategy adds no layer: it says which
 * processes run, never where. `null` when no connection or harness is
 * configured for it.
 */
export function resolveImproveExecution(options: ResolveImproveExecutionOptions): ResolvedImproveExecution | null {
  const improveWide = cascadeDefaults(options.config.improve);
  const indexDefaults = cascadeDefaults(options.index);
  const processKey = options.process ?? options.processName;
  const processDefaults = cascadeDefaults(
    (IMPROVE_ENGINE_PROCESSES as readonly string[]).includes(processKey)
      ? (options.config.improve?.processes as Record<string, ImproveWhere | undefined> | undefined)?.[processKey]
      : undefined,
  );
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
