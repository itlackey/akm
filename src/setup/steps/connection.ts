// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup step 3: the connection. An endpoint, a key, and one model per alias
 * picked from the models the endpoint itself lists.
 */

import { type AkmConfig, type ConnectionConfig, defaultConnection } from "../../core/config/config";
import { resolveApiKey } from "../../core/config/credentials";
import { entryModel, STANDARD_ALIASES } from "../../core/config/model-aliases";
import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import { openAiBaseUrl } from "../../llm/client";
import { isEmbeddingModel } from "../../llm/model-list";
import type { LocalServerResult } from "../detect";
import type { EngineFlags } from "../engine-flags";
import type { ConnectionAnswer, KeyAnswer } from "../engine-plan";
import { listModels, pickModel, promptApiKey, promptEndpoint, promptModelName } from "./connection-shared";

export interface ConnectionStepInput {
  current: AkmConfig;
  flags: EngineFlags;
  interactive: boolean;
  /** Contact the endpoint to list its models. */
  probe: boolean;
  /** Model calls run on a harness, so a connection is not needed. */
  modelCallsOnHarness: boolean;
  localServers: readonly LocalServerResult[];
}

export interface ConnectionStepResult {
  /** Absent: the connections stay as they are. */
  answer?: ConnectionAnswer;
  /** Every model the endpoint listed; empty when it was not asked or could not say. */
  listed: readonly string[];
}

const NOTHING: ConnectionStepResult = { listed: [] };

/** The key to list models with now: the one just supplied, else the connection's own when the endpoint is its own. */
function listingKey(
  key: KeyAnswer | undefined,
  existing: { endpoint: string; apiKey?: string } | undefined,
  name: string,
  endpoint: string,
): string | undefined {
  if (key && "pasted" in key) return key.pasted;
  if (key) {
    const value = process.env[key.env]?.trim();
    if (!value) warn(`[akm setup] ${key.env} is not set; listing models without a key.`);
    return value || undefined;
  }
  return existing && openAiBaseUrl(existing.endpoint) === openAiBaseUrl(endpoint)
    ? resolveApiKey(existing.apiKey, name, process.env, true)
    : undefined;
}

/** One model per alias: the connection's current pick is kept; the others are chosen from the endpoint's list, or typed. */
async function pickAliases(
  existing: ConnectionConfig | undefined,
  listed: readonly string[],
  interactive: boolean,
): Promise<Record<string, string>> {
  const current = (alias: string) => {
    const entry = existing?.models?.[alias];
    return entry === undefined ? undefined : entryModel(entry);
  };
  const chat = listed.filter((model) => !isEmbeddingModel(model));
  const pool = chat.length > 0 ? chat : [...listed];
  const picks: Record<string, string> = {};

  if (pool.length > 0) {
    for (const alias of STANDARD_ALIASES) {
      const held = current(alias);
      if (!interactive) {
        picks[alias] = held ?? (pool[0] as string);
        continue;
      }
      const options = held !== undefined && !pool.includes(held) ? [held, ...pool] : pool;
      picks[alias] = await pickModel(`Model for "${alias}":`, options, held ?? (pool[0] as string));
    }
    return picks;
  }

  // The endpoint listed nothing: a model typed by hand answers every alias that has none yet.
  const missing = STANDARD_ALIASES.filter((alias) => current(alias) === undefined);
  if (!interactive || missing.length === 0) return picks;
  const typed = await promptModelName({
    message: "Model name (the endpoint could not list its models; change it later with `akm models set`):",
    initialValue: STANDARD_ALIASES.map(current).find((model) => model !== undefined),
  });
  for (const alias of missing) picks[alias] = typed;
  return picks;
}

export async function stepConnection(input: ConnectionStepInput): Promise<ConnectionStepResult> {
  const { current, flags, interactive } = input;
  const name = flags.name ?? defaultConnection(current)?.name ?? "default";
  const existing = current.connections?.[name];
  const flagged = flags.endpoint !== undefined || flags.apiKeyEnv !== undefined || flags.name !== undefined;
  const local = input.localServers.find((server) => server.available);
  const detected = local ? `${local.baseUrl}/v1` : undefined;

  const needed =
    flagged ||
    (interactive
      ? existing !== undefined || !input.modelCallsOnHarness
      : existing === undefined && !input.modelCallsOnHarness && detected !== undefined);
  if (!needed) return NOTHING;

  let endpoint = flags.endpoint;
  if (endpoint === undefined) {
    const start = existing?.endpoint ?? detected;
    endpoint = interactive
      ? await promptEndpoint({
          message: "Endpoint URL of an OpenAI-compatible server (blank for none):",
          ...(start ? { initialValue: start } : {}),
        })
      : start;
  }
  if (endpoint === undefined) {
    if (flagged) {
      throw new UsageError(
        `There is no connection "${name}" to update. Pass --endpoint to add one.`,
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    return NOTHING;
  }

  let key: KeyAnswer | undefined;
  if (flags.apiKeyEnv !== undefined) {
    key = { env: flags.apiKeyEnv };
  } else if (interactive) {
    const hasKey = resolveApiKey(existing?.apiKey, name, process.env, true) !== undefined;
    const typed = await promptApiKey(hasKey ? "API key (blank keeps the current one)" : "API key (blank for none)");
    if (typed) key = { pasted: typed };
  }

  const listed = input.probe ? await listModels(endpoint, listingKey(key, existing, name, endpoint), interactive) : [];
  const picks = await pickAliases(existing, listed, interactive);
  return { answer: { name, endpoint, ...(key ? { key } : {}), picks }, listed };
}
