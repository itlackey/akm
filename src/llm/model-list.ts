// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The models an OpenAI-compatible endpoint serves: one `GET <base>/models`, with
 * the connection's key when it has one. `akm setup` (the connection, its local-server
 * detection and an embedding endpoint) and `akm models` list models this way, so
 * what they show agrees. `akm health` asks only whether the endpoint answers, with
 * its own request (`probeLlmEndpoint` in `client.ts`), and reads no list.
 */
import { openAiBaseUrl } from "./client";

const LIST_TIMEOUT_MS = 3_000;

export type EndpointModels =
  | { readonly ok: true; readonly models: string[] }
  | { readonly ok: false; readonly error: string };

/** The model ids the endpoint lists, in the order it lists them. Never throws; a failure says why. */
export async function listEndpointModels(
  connection: { readonly endpoint: string; readonly apiKey?: string },
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<EndpointModels> {
  try {
    const response = await fetch(`${openAiBaseUrl(connection.endpoint)}/models`, {
      headers: connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return { ok: false, error: "the response has no model list" };
    const ids = body.data.flatMap((entry: { id?: unknown }) =>
      typeof entry?.id === "string" && entry.id ? [entry.id] : [],
    );
    return { ok: true, models: [...new Set(ids)] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether a model id names an embedding model rather than a chat model. */
export function isEmbeddingModel(id: string): boolean {
  return /embed|nomic|minilm|bge/i.test(id);
}
