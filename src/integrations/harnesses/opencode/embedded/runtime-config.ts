// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode config content of akm's internal runtime: one provider per
 * configured connection and nothing else.
 *
 * - The provider is `akm-<connection name>`, `@ai-sdk/openai-compatible`, at the
 *   connection's endpoint. Its models are the names the connection's alias map
 *   lists, so a session picks one with `SessionCreateInput.model`.
 * - The key and the request fields a connection or model entry writes, and the
 *   portable settings of a call, are not declared here: a call's differ per
 *   session and are laid over each session's requests by the akm plugin
 *   (`./plugin.ts`), the key read when the call is dispatched.
 * - OpenCode's own `opencode` provider (its free models, present in the model
 *   snapshot even when nothing is fetched) is switched off: akm's runtime runs
 *   on the user's connections or on nothing.
 */

import { isRecord } from "../../../../core/common";
import type { ConnectionConfig } from "../../../../core/config/config-types";
import { openAiBaseUrl } from "../../../../llm/client";

/** The OpenCode provider id of the connection called `name`. */
export function runtimeProviderId(name: string): string {
  return `akm-${name}`;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** An alias's target: the model name, and the `max_tokens` its entry writes, if any. */
function modelTarget(entry: unknown): { readonly name: string; readonly maxTokens: unknown } | undefined {
  if (typeof entry === "string") return { name: entry, maxTokens: undefined };
  if (isRecord(entry) && typeof entry.model === "string") return { name: entry.model, maxTokens: entry.max_tokens };
  return undefined;
}

/**
 * OpenCode builds its requests to fit a model's `limit`, and refuses one with
 * only one of its two numbers: akm declares it when the connection's window and
 * the model's `max_tokens` are both known, and leaves OpenCode's defaults otherwise.
 */
function limitOf(contextLength: number | undefined, maxTokens: unknown): Record<string, unknown> {
  return isPositiveInteger(contextLength) && isPositiveInteger(maxTokens)
    ? { limit: { context: contextLength, output: maxTokens } }
    : {};
}

/** The models a connection's provider declares: the names its alias map lists, each with its `limit` if known. */
function modelsOf(connection: ConnectionConfig | undefined): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const entry of Object.values(connection?.models ?? {})) {
    const target = modelTarget(entry);
    if (!target) continue;
    // One model can sit under several aliases; a limit an earlier alias gave it is kept.
    models[target.name] = {
      ...(models[target.name] as object | undefined),
      ...limitOf(connection?.contextLength, target.maxTokens ?? connection?.max_tokens),
    };
  }
  return models;
}

/** The model names the connection called `name` declares on its provider, in the order its alias map lists them. */
export function declaredModels(
  connections: Readonly<Record<string, ConnectionConfig>> | undefined,
  name: string,
): string[] {
  return Object.keys(modelsOf(connections?.[name]));
}

function providerFor(connection: ConnectionConfig): Record<string, unknown> | undefined {
  const models = modelsOf(connection);
  if (Object.keys(models).length === 0) return undefined;
  return { npm: "@ai-sdk/openai-compatible", options: { baseURL: openAiBaseUrl(connection.endpoint) }, models };
}

/** The config content for the connections in `connections`. */
export function runtimeConfigContent(
  connections: Readonly<Record<string, ConnectionConfig>> | undefined,
): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  for (const [name, connection] of Object.entries(connections ?? {})) {
    const declared = providerFor(connection);
    if (declared) provider[runtimeProviderId(name)] = declared;
  }
  return { disabled_providers: ["opencode"], provider };
}
