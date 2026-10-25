// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the pieces of the engines conversion share: the shapes they pass around and the
 * few helpers more than one of them needs. See `convert-engines.ts`.
 */

import { isRecord } from "../common";
import { normalizeExtraParamKey } from "../extra-params";
import { inferenceWireFields, type LlmInference } from "../llm-inference";

export type Dict = Record<string, unknown>;

/** The connection or harness an engine became. */
export type EngineTarget = { readonly connection: string } | { readonly harness: string };

/** Connections and harnesses by name. */
export interface Entries {
  readonly connections: Dict;
  readonly harnesses: Dict;
}

/**
 * What one conversion has built up: its notes, and whether `raw` held anything of
 * the retired form. Every step reads and adds to it; none keeps state of its own.
 */
export interface Conversion {
  readonly notes: string[];
  changed: boolean;
}

export const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export const asDict = (value: unknown): Dict => (isRecord(value) ? (value as Dict) : {});

/**
 * The request fields an old engine's (or a `models.json` entry's) inference
 * becomes. The first-class settings win over `extraParams`: an `extraParams` key
 * that names the same field as one of them (`temperature`, `maxTokens`/`max_tokens`,
 * `enableThinking`, `reasoningEffort`, `chat_template_kwargs`) is dropped, with a
 * note that names the key and not its value.
 */
export function wireFieldsOf(inference: LlmInference, where: string, notes: string[]): Dict {
  const { extraParams, ...settings } = inference;
  const firstClass = inferenceWireFields(settings);
  const taken = new Set(Object.keys(firstClass).map(normalizeExtraParamKey));
  const extras: Dict = {};
  for (const [key, value] of Object.entries(isRecord(extraParams) ? extraParams : {})) {
    if (taken.has(normalizeExtraParamKey(key))) {
      notes.push(`${where}: extraParams.${key} is dropped, because the setting it shadows takes precedence.`);
    } else {
      extras[key] = value;
    }
  }
  return { ...extras, ...firstClass };
}

/** `holder[key]` as an object, made on `holder` when it is not one yet. */
export function objectAt(holder: Dict, key: string): Dict {
  if (!isRecord(holder[key])) holder[key] = {};
  return holder[key] as Dict;
}
