// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What runs where, in words, once setup has chosen: model calls, agent work and
 * embeddings. Each target comes from `resolveTarget`, the resolver the calls
 * themselves use, so the summary says what will happen.
 */
import type { AkmConfig } from "../core/config/config";
import { SHIPPED_ALIAS } from "../core/config/model-aliases";
import { resolveTarget } from "../integrations/agent/resolution";
import { getHarness } from "../integrations/harnesses";
import { effectiveEmbedding } from "../llm/embedders/connection";

export interface SetupRuns {
  modelCalls: string;
  agentWork: string;
  embeddings: string;
}

/** Whether akm can run this platform read-only for model calls, which keeps them from changing anything. */
export function runsReadOnly(platform: string): boolean {
  return getHarness(platform)?.capabilities.modelWork === true;
}

function describeTarget(config: AkmConfig, modelWork: boolean): string {
  try {
    const target = resolveTarget({
      config,
      modelWork,
      layers: [{ model: modelWork ? SHIPPED_ALIAS.improve : SHIPPED_ALIAS.agent }],
    });
    if (target.kind === "connection") {
      return `${modelWork ? "connection" : "akm's own runtime over connection"} "${target.name}" (${target.model})`;
    }
    const restriction = modelWork
      ? runsReadOnly(target.platform)
        ? ", read-only"
        : ", cannot be restricted to read-only"
      : "";
    return `harness "${target.name}"${target.model ? ` (${target.model})` : ""}${restriction}`;
  } catch {
    return "off: no connection or harness is configured";
  }
}

function describeEmbeddings(config: AkmConfig): string {
  if (config.semanticSearchMode === "off") return "off";
  const embedding = effectiveEmbedding(config);
  if (!embedding?.endpoint) return "akm's built-in local embedder";
  return `${embedding.model ?? "a model"} at ${embedding.endpoint}`;
}

export function describeRuns(config: AkmConfig): SetupRuns {
  return {
    modelCalls: describeTarget(config, true),
    agentWork: describeTarget(config, false),
    embeddings: describeEmbeddings(config),
  };
}
