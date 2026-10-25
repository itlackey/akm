// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Prompts the connection and embedding steps share: an endpoint, a key typed at
 * a masked prompt (the one place a key is ever typed), and a model.
 */

import * as p from "../../cli/clack";
import { warn } from "../../core/warn";
import { listEndpointModels } from "../../llm/model-list";
import { endpointProblem, normalizeEndpoint } from "../endpoint";
import { prompt } from "../prompt";

/** The endpoint typed at the prompt, as its base URL; a blank answer is `undefined`. */
export async function promptEndpoint(opts: { message: string; initialValue?: string }): Promise<string | undefined> {
  const answer = await prompt(() =>
    p.text({
      message: opts.message,
      placeholder: "http://localhost:11434/v1",
      ...(opts.initialValue ? { initialValue: opts.initialValue } : {}),
      validate: (value) => (value?.trim() ? endpointProblem(value) : undefined),
    }),
  );
  return answer.trim() ? normalizeEndpoint(answer) : undefined;
}

/** The key typed at the masked prompt; a blank answer is `undefined`. */
export async function promptApiKey(message: string): Promise<string | undefined> {
  const answer = await prompt(() => p.password({ message, mask: "*" }));
  return answer.trim() || undefined;
}

/** A model name typed by hand: what the endpoint could not list. */
export async function promptModelName(opts: { message: string; initialValue?: string }): Promise<string> {
  const answer = await prompt(() =>
    p.text({
      message: opts.message,
      ...(opts.initialValue ? { initialValue: opts.initialValue } : {}),
      validate: (value) => (value?.trim() ? undefined : "Model name cannot be empty"),
    }),
  );
  return answer.trim();
}

/** One model out of the endpoint's list. */
export async function pickModel(message: string, models: readonly string[], initialValue?: string): Promise<string> {
  return prompt(() =>
    p.select({
      message,
      options: models.map((model) => ({ value: model, label: model })),
      ...(initialValue !== undefined ? { initialValue } : {}),
    }),
  );
}

/** A warning for the user: in the wizard's own output when it is interactive, on stderr otherwise. */
export function warnUser(message: string, interactive: boolean): void {
  if (interactive) p.log.warn(message);
  else warn(`[akm setup] ${message}`);
}

/** The models the endpoint lists, with a note when it cannot say; never throws. */
export async function listModels(
  endpoint: string,
  apiKey: string | undefined,
  interactive: boolean,
): Promise<string[]> {
  const spin = interactive ? p.spinner() : undefined;
  spin?.start("Listing the endpoint's models...");
  const result = await listEndpointModels({ endpoint, ...(apiKey ? { apiKey } : {}) });
  if (result.ok) {
    spin?.stop(`The endpoint lists ${result.models.length} model${result.models.length === 1 ? "" : "s"}.`);
    return result.models;
  }
  spin?.stop("Could not list models.");
  warnUser(`Could not list models from ${endpoint} (${result.error}).`, interactive);
  return [];
}
