// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, ImproveProcessConfig, ImproveProfileConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { buildExecution, resolveExecution } from "../../integrations/agent/execution";
import type { RunnerSpec } from "../../integrations/agent/runner";

type ImproveExecutionLayer = Pick<ImproveProfileConfig, "engine" | "model" | "timeoutMs" | "llm">;

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

function cascadeDefaults(layer: ImproveExecutionLayer | undefined): UnresolvedExecutionDefaults {
  if (!layer) return {};
  return {
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
  profile?: ImproveProfileConfig;
  process?: ImproveProcessConfig;
  /** Nearer one-shot selection, such as an explicit CLI engine/timeout. */
  current?: ImproveExecutionLayer;
}

export interface ResolvedImproveExecution {
  runner: RunnerSpec;
  notices: readonly Readonly<LoweringNotice>[];
}

/**
 * Resolve improve-owned model work through the canonical execution cascade.
 * The legacy improve precedence is preserved exactly:
 * defaults.llmEngine -> strategy -> process -> current invocation.
 */
export function resolveImproveExecution(options: ResolveImproveExecutionOptions): ResolvedImproveExecution | null {
  const defaultEngine = options.config.defaults?.llmEngine;
  const profileDefaults = cascadeDefaults(options.profile);
  const processDefaults = cascadeDefaults(options.process);
  const currentDefaults = cascadeDefaults(options.current);
  const selectedEngine = currentDefaults.engine ?? processDefaults.engine ?? profileDefaults.engine ?? defaultEngine;
  if (selectedEngine === undefined || selectedEngine === null) return null;

  const invocationDefaults = mergeDefaults(defaultEngine ? { engine: defaultEngine } : {}, profileDefaults);
  const current = mergeDefaults(processDefaults, currentDefaults);
  const prepared = resolveExecution({
    content: `improve ${options.processName} execution selection`,
    config: options.config,
    invocationDefaults,
    current,
  });
  const lowered = buildExecution(prepared.request, prepared.runner);
  return Object.freeze({ runner: lowered.runner, notices: lowered.notices });
}

export function resolveImproveLlmExecution(
  options: ResolveImproveExecutionOptions,
): { runner: Extract<RunnerSpec, { kind: "llm" }>; notices: readonly Readonly<LoweringNotice>[] } | null {
  const resolved = resolveImproveExecution(options);
  if (!resolved) return null;
  if (resolved.runner.kind !== "llm") {
    return null;
  }
  return { runner: resolved.runner, notices: resolved.notices };
}
