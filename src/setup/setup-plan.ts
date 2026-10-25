// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the setup answers change in the config. The steps ask (or take a flag or
 * a detected default) and produce answers; this turns them into the new
 * `connections`, `harnesses` and `embedding`, and the keys to put in
 * `credentials.json`. Nothing here prompts, reads the network or writes.
 */
import type { AkmConfig, ConnectionConfig, EmbeddingConnectionConfig, HarnessConfig } from "../core/config/config";
import { entryWithModel } from "../core/config/model-aliases";

/** How a key is supplied: the variable that holds it, or the key typed at the masked prompt. */
export type KeyAnswer = { readonly env: string } | { readonly pasted: string };

export interface HarnessAnswer {
  /** The platforms to have enabled. */
  readonly platforms: readonly string[];
  /** The one agent work runs on; one of `platforms`, absent when there are none. */
  readonly default?: string;
}

export interface ConnectionAnswer {
  readonly name: string;
  readonly endpoint: string;
  /** Absent: the connection keeps the key it has. */
  readonly key?: KeyAnswer;
  /** The model picked for each alias, written over the connection's `models`. */
  readonly picks: Readonly<Record<string, string>>;
}

export type EmbeddingAnswer =
  | { readonly kind: "off" }
  | { readonly kind: "local" }
  /** A model the default connection serves. */
  | { readonly kind: "connection"; readonly model: string }
  | { readonly kind: "endpoint"; readonly endpoint: string; readonly model: string; readonly key?: KeyAnswer };

export interface SetupAnswers {
  readonly harnesses?: HarnessAnswer;
  readonly connection?: ConnectionAnswer;
  readonly embedding?: EmbeddingAnswer;
}

/** The config keys setup replaces; a key present with `undefined` is removed. */
export type SetupPatch = {
  connections?: Record<string, ConnectionConfig>;
  harnesses?: Record<string, HarnessConfig> | undefined;
  embedding?: EmbeddingConnectionConfig | undefined;
};

export interface SetupChange {
  readonly patch: SetupPatch;
  /** Keys to store in `credentials.json`, by the name of the block they belong to. */
  readonly credentials: Readonly<Record<string, string>>;
}

/** `base`, or `base-2`, `base-3`, ... when `taken` has it. */
function freeName(taken: Readonly<Record<string, unknown>>, base: string): string {
  if (!(base in taken)) return base;
  for (let suffix = 2; ; suffix++) {
    if (!(`${base}-${suffix}` in taken)) return `${base}-${suffix}`;
  }
}

/**
 * The `harnesses` map once `platforms` are the ones enabled and `defaultPlatform`
 * is the one agent work runs on. Entries for platforms that stay enabled are kept
 * as they are; a new one is named for its platform. With several, the default is
 * the entry named `default`; a lone one keeps its name.
 */
export function harnessEntries(
  existing: Readonly<Record<string, HarnessConfig>> | undefined,
  platforms: readonly string[],
  defaultPlatform: string | undefined,
): Record<string, HarnessConfig> {
  const entries: Record<string, HarnessConfig> = {};
  for (const [name, harness] of Object.entries(existing ?? {})) {
    if (platforms.includes(harness.platform ?? name)) entries[name] = harness;
  }
  const platformOf = (name: string) => entries[name]?.platform ?? name;
  for (const platform of platforms) {
    if (Object.keys(entries).some((name) => platformOf(name) === platform)) continue;
    const name = freeName(entries, platform);
    entries[name] = name === platform ? {} : ({ platform } as HarnessConfig);
  }
  if (Object.keys(entries).length < 2) return entries;

  const names = Object.keys(entries);
  const wanted = defaultPlatform ?? platforms[0];
  const defaultName =
    names.find((name) => name === "default" && platformOf(name) === wanted) ??
    names.find((name) => platformOf(name) === wanted);
  if (defaultName === undefined || defaultName === "default") return entries;

  const { default: displaced, ...others } = entries;
  const { [defaultName]: chosen, ...rest } = others;
  const result: Record<string, HarnessConfig> = { default: { ...chosen, platform: wanted } as HarnessConfig };
  if (displaced) {
    const platform = displaced.platform as string;
    const name = freeName({ ...rest, default: displaced }, platform);
    const { platform: _platform, ...fields } = displaced;
    result[name] = name === platform ? (fields as HarnessConfig) : displaced;
  }
  for (const [name, harness] of Object.entries(rest)) result[name] = harness;
  return result;
}

function connectionEntry(existing: ConnectionConfig | undefined, answer: ConnectionAnswer): ConnectionConfig {
  const models = { ...(existing?.models ?? {}) };
  for (const [alias, model] of Object.entries(answer.picks)) models[alias] = entryWithModel(models[alias], model);
  const { apiKey, endpoint: _endpoint, models: _models, ...others } = existing ?? { endpoint: answer.endpoint };
  const key = answer.key;
  const keptKey = key === undefined && apiKey !== undefined ? { apiKey } : {};
  return {
    endpoint: answer.endpoint,
    ...(key && "env" in key ? { apiKey: `$${key.env}` } : keptKey),
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...others,
  };
}

function embeddingBlock(
  current: EmbeddingConnectionConfig | undefined,
  answer: EmbeddingAnswer,
): EmbeddingConnectionConfig | undefined {
  switch (answer.kind) {
    case "off":
      return current;
    case "local":
      return undefined;
    case "connection":
      return current?.endpoint === undefined && current?.model === answer.model ? current : { model: answer.model };
    case "endpoint": {
      const apiKey = answer.key && "env" in answer.key ? { apiKey: `$${answer.key.env}` } : {};
      const same = current?.endpoint === answer.endpoint && current.model === answer.model;
      if (same) {
        const { apiKey: _apiKey, ...kept } = current;
        return {
          ...kept,
          ...(answer.key === undefined && current.apiKey !== undefined ? { apiKey: current.apiKey } : apiKey),
        };
      }
      return { endpoint: answer.endpoint, model: answer.model, ...apiKey };
    }
  }
}

/** The config keys and credentials the answers change, over the current config. */
export function applySetupAnswers(current: AkmConfig, answers: SetupAnswers): SetupChange {
  const patch: SetupPatch = {};
  const credentials: Record<string, string> = {};

  if (answers.harnesses) {
    const entries = harnessEntries(current.harnesses, answers.harnesses.platforms, answers.harnesses.default);
    patch.harnesses = Object.keys(entries).length > 0 ? entries : undefined;
  }

  const connection = answers.connection;
  if (connection) {
    patch.connections = {
      ...(current.connections ?? {}),
      [connection.name]: connectionEntry(current.connections?.[connection.name], connection),
    };
    if (connection.key && "pasted" in connection.key) credentials[connection.name] = connection.key.pasted;
  }

  const embedding = answers.embedding;
  if (embedding) {
    patch.embedding = embeddingBlock(current.embedding, embedding);
    if (embedding.kind === "endpoint" && embedding.key && "pasted" in embedding.key) {
      credentials.embedding = embedding.key.pasted;
    }
  }

  return { patch, credentials };
}
