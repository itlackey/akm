// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The endpoint as a connection stores it: the OpenAI-compatible base URL
 * (`…/v1`), whatever form the user typed it in.
 */
import { openAiBaseUrl } from "../core/endpoint-url";

/** Ollama's native embedding routes, which the embedder calls as they are (`src/llm/embedders/remote.ts`). */
const OLLAMA_EMBED_ROUTE = /\/api\/embed(?:dings)?$/;

/** The base URL for `input`, or a thrown Error saying what is wrong with it. */
export function normalizeEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("endpoint must be a complete URL such as http://localhost:11434/v1");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("endpoint must use http or https");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("endpoint cannot contain credentials, query, or fragment");
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!OLLAMA_EMBED_ROUTE.test(pathname)) {
    // An operation URL (`…/chat/completions`, `…/embeddings`) names its base.
    pathname = new URL(openAiBaseUrl(url.toString())).pathname.replace(/\/+$/, "");
    if (!/\/v1$/i.test(pathname) && !pathname.toLowerCase().includes("/openai")) pathname += "/v1";
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

/** `normalizeEndpoint` as a prompt validator: the problem, or `undefined` when the URL is fine. */
export function endpointProblem(input: string): string | undefined {
  try {
    normalizeEndpoint(input);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
