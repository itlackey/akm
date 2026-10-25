// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How akm reads a connection's `endpoint`: the OpenAI-compatible base URL
 * (`…/v1`) or the chat-completions URL itself. The endpoint is a URL, so only
 * its pathname is edited here; a query string (an `api-version`, say) stays
 * where it is, after the pathname, and a fragment, which is never sent, goes.
 * Every consumer of an endpoint (the chat client, model listing, health probes,
 * setup, the stored-key binding, the embedded runtime) reads it through this
 * one module.
 */

const CHAT_COMPLETIONS = /\/chat\/completions$/;

function parse(endpoint: string): URL | undefined {
  try {
    return new URL(endpoint);
  } catch {
    return undefined;
  }
}

/** The pathname of the endpoint's base: no trailing slash, no `/chat/completions`. */
function basePathname(url: URL): string {
  return url.pathname.replace(/\/+$/, "").replace(CHAT_COMPLETIONS, "");
}

function withPathname(url: URL, pathname: string): string {
  url.hash = "";
  url.pathname = pathname;
  const text = url.toString();
  // A bare host serializes with a "/" the endpoint never had.
  return pathname === "" && url.search === "" ? text.replace(/\/$/, "") : text;
}

/** The base of an OpenAI-compatible endpoint: the URL without `/chat/completions` or a trailing slash. */
export function openAiBaseUrl(endpoint: string): string {
  const url = parse(endpoint);
  return url ? withPathname(url, basePathname(url)) : endpoint;
}

/** The URL of one operation (`chat/completions`, `models`) of the endpoint. */
export function openAiOperationUrl(endpoint: string, operation: "chat/completions" | "models"): string {
  const url = parse(endpoint);
  return url ? withPathname(url, `${basePathname(url)}/${operation}`) : `${endpoint}/${operation}`;
}

/** Whether two endpoints are the same server: the same base, however either is spelled. */
export function sameEndpoint(a: string, b: string): boolean {
  return openAiBaseUrl(a) === openAiBaseUrl(b);
}
