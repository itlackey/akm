// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config-types";
import { cloneExecutionJsonObject } from "../../execution/json";
import type {
  ResolvedCommandContent,
  ResolvedConversationMessage,
  ResolvedExecutionRequestV1,
  ResolvedPersonaContent,
} from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { withEngineFallback } from "./engine-fallback";
import {
  type ExecutionEngineDefinition,
  type ExecutionInvocationKind,
  planExecutionCascade,
  type ResolvedExecutionPlanV1,
  type ToolAuthorizer,
} from "./execution-cascade";
import { executionEngineDefinitionsFromConfig } from "./execution-definitions";
import { loadModelMap, type ResolvedModelMapV1 } from "./model-map";

export interface ResolvedExecutionLayer {
  readonly id: string;
  readonly values: UnresolvedExecutionDefaults;
}

export interface PrepareResolvedExecutionOptions {
  readonly command: ResolvedCommandContent;
  readonly config: AkmConfig;
  readonly invocationKind: ExecutionInvocationKind;
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  readonly persona?: ResolvedPersonaContent | null;
  readonly agentLayer?: ResolvedExecutionLayer;
  readonly commandLayer: ResolvedExecutionLayer;
  readonly invocationDefaults?: UnresolvedExecutionDefaults;
  readonly current?: UnresolvedExecutionDefaults;
  readonly modelMap?: ResolvedModelMapV1;
  readonly authorizeTools?: ToolAuthorizer;
}

export interface PlanPreparedExecutionOptions {
  readonly command: ResolvedCommandContent;
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  readonly persona?: ResolvedPersonaContent | null;
  readonly installationEngine?: string;
  readonly agentLayer?: ResolvedExecutionLayer;
  readonly commandLayer: ResolvedExecutionLayer;
  readonly invocationDefaults?: UnresolvedExecutionDefaults;
  readonly current?: UnresolvedExecutionDefaults;
  readonly engines: Readonly<Record<string, ExecutionEngineDefinition>>;
  readonly modelMap: ResolvedModelMapV1;
  readonly invocationKind: ExecutionInvocationKind;
  readonly authorizeTools?: ToolAuthorizer;
}

export interface PreparedResolvedExecution {
  readonly plan: ResolvedExecutionPlanV1;
  readonly request: ResolvedExecutionRequestV1;
  readonly config: AkmConfig;
  readonly fallbackEngineName?: string;
}

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

/** Pure common cascade composition once caller-specific sources are rendered. */
export function planPreparedExecution(options: PlanPreparedExecutionOptions): ResolvedExecutionPlanV1 {
  return planExecutionCascade({
    command: options.command,
    ...(own(options, "conversation") ? { conversation: options.conversation } : {}),
    ...(own(options, "persona") ? { persona: options.persona } : {}),
    layers: {
      installation: {
        id: "installation-defaults",
        values: options.installationEngine === undefined ? {} : { engine: options.installationEngine },
      },
      ...(options.agentLayer ? { agent: options.agentLayer } : {}),
      command: options.commandLayer,
      ...(options.invocationDefaults
        ? { invocationDefaults: { id: "invocation-defaults", values: options.invocationDefaults } }
        : {}),
      ...(options.current ? { current: { id: "current-invocation", values: options.current } } : {}),
    },
    engines: options.engines,
    modelMap: options.modelMap,
    invocationKind: options.invocationKind,
    ...(options.authorizeTools ? { authorizeTools: options.authorizeTools } : {}),
  });
}

/**
 * The one planner adapter for already-rendered command/persona content.
 * Direct, task, improve, proposal, and workflow callers contribute named
 * layers here; none may rebuild engine/model precedence around the cascade.
 */
export function prepareResolvedExecution(options: PrepareResolvedExecutionOptions): PreparedResolvedExecution {
  const inputConfig = cloneExecutionJsonObject(options.config, "execution preparation input config") as AkmConfig;
  const fallback = withEngineFallback(inputConfig);
  const config = cloneExecutionJsonObject(fallback.config, "execution preparation resolved config") as AkmConfig;
  const defaults = own(config, "defaults") ? config.defaults : undefined;
  const installationEngine = defaults && own(defaults, "engine") ? defaults.engine : undefined;
  const plan = planPreparedExecution({
    command: options.command,
    ...(own(options, "conversation") ? { conversation: options.conversation } : {}),
    ...(own(options, "persona") ? { persona: options.persona } : {}),
    ...(installationEngine === undefined ? {} : { installationEngine }),
    ...(options.agentLayer ? { agentLayer: options.agentLayer } : {}),
    commandLayer: options.commandLayer,
    ...(options.invocationDefaults ? { invocationDefaults: options.invocationDefaults } : {}),
    ...(options.current ? { current: options.current } : {}),
    engines: executionEngineDefinitionsFromConfig(config),
    modelMap: options.modelMap ?? loadModelMap({ engines: config.engines }).map,
    invocationKind: options.invocationKind,
    ...(options.authorizeTools ? { authorizeTools: options.authorizeTools } : {}),
  });
  return Object.freeze({
    plan,
    request: plan.request,
    config,
    ...(fallback.fallbackEngineName ? { fallbackEngineName: fallback.fallbackEngineName } : {}),
  });
}
