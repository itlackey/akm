// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup step 3: the connection. An endpoint, a key, and one model per alias
 * picked from the models the endpoint itself lists.
 */

import { type AkmConfig, type ConnectionConfig, defaultConnection } from "../../core/config/config";
import { apiKeyReference, resolveApiKey, storedCredential } from "../../core/config/credentials";
import { entryModel, STANDARD_ALIASES } from "../../core/config/model-aliases";
import { sameEndpoint } from "../../core/endpoint-url";
import { UsageError } from "../../core/errors";
import { redactUrlCredentials } from "../../core/redaction";
import { warn } from "../../core/warn";
import { isEmbeddingModel } from "../../llm/model-list";
import type { LocalServerResult } from "../detect";
import type { SetupFlags } from "../setup-flags";
import type { ConnectionAnswer, KeyAnswer } from "../setup-plan";
import { listModels, pickModel, promptApiKey, promptEndpoint, promptModelName, warnUser } from "./connection-shared";

export interface ConnectionStepInput {
  current: AkmConfig;
  flags: SetupFlags;
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
  /** This step added a connection that is the default: the one named `default`, or the first and so the lone one. */
  addedDefault: boolean;
}

const NOTHING: ConnectionStepResult = { listed: [], addedDefault: false };

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
  return existing && sameEndpoint(existing.endpoint, endpoint)
    ? resolveApiKey(existing.apiKey, { connection: name }, existing.endpoint, process.env, true)
    : undefined;
}

/** Whether the connection has a key of its own: a `$VAR` it references, or one stored for it, at whatever endpoint. */
function holdsKey(existing: ConnectionConfig, name: string): boolean {
  return apiKeyReference(existing.apiKey) !== undefined || storedCredential({ connection: name }) !== undefined;
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

/** One warning for the picks setup keeps that the endpoint, which did list its models, does not serve. */
function warnOfUnlistedPicks(
  existing: ConnectionConfig | undefined,
  picks: Readonly<Record<string, string>>,
  listed: readonly string[],
  endpoint: string,
  interactive: boolean,
): void {
  if (listed.length === 0) return;
  const kept = new Set<string>();
  for (const [alias, pick] of Object.entries(picks)) {
    const held = existing?.models?.[alias];
    if (held !== undefined && entryModel(held) === pick && !listed.includes(pick)) kept.add(pick);
  }
  if (kept.size === 0) return;
  const names = [...kept].map((model) => `"${model}"`).join(", ");
  warnUser(
    `Keeping ${names}: ${redactUrlCredentials(endpoint)} does not list ${kept.size === 1 ? "it" : "them"}. Change a pick with \`akm models set\`.`,
    interactive,
  );
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

  // A key belongs to the endpoint it was given for, so the current one is offered for that endpoint alone.
  const sameServer = existing !== undefined && sameEndpoint(existing.endpoint, endpoint);
  let key: KeyAnswer | undefined;
  if (flags.apiKeyEnv !== undefined) {
    key = { env: flags.apiKeyEnv };
  } else if (interactive) {
    const hasKey =
      sameServer && resolveApiKey(existing?.apiKey, { connection: name }, endpoint, process.env, true) !== undefined;
    const typed = await promptApiKey(hasKey ? "API key (blank keeps the current one)" : "API key (blank for none)");
    if (typed) key = { pasted: typed };
  }
  if (key === undefined && existing && !sameServer && holdsKey(existing, name)) {
    warnUser(
      `The endpoint of "${name}" changed, so its current key is not used with ${redactUrlCredentials(endpoint)}. Give the new endpoint's key with --api-key-env (or at the prompt).`,
      interactive,
    );
  }

  const listed = input.probe ? await listModels(endpoint, listingKey(key, existing, name, endpoint), interactive) : [];
  const picks = await pickAliases(existing, listed, interactive);
  warnOfUnlistedPicks(existing, picks, listed, endpoint, interactive);
  const addedDefault =
    existing === undefined && (name === "default" || Object.keys(current.connections ?? {}).length === 0);
  return { answer: { name, endpoint, ...(key ? { key } : {}), picks }, listed, addedDefault };
}
