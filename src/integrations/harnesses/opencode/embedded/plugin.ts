// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The plugin akm loads into every embedded OpenCode it starts.
 *
 * - **akm's read tools** (`akm_search`, `akm_show`, `akm_curate`): they run in
 *   akm's process, so an agent on either host reads the library without a shell.
 * - **Per-session request settings**: what a call resolves to differs from
 *   session to session on one shared host: the request fields (the connection's
 *   and model entry's, and the portable settings of the call, in the endpoint's
 *   own spelling) and the key, which is read when the call is dispatched. The
 *   runner records them under the session's id and the `http.request` hook lays
 *   them over that session's model requests, so a call reaches the endpoint
 *   exactly as the direct-chat path would send it.
 */

import type { Plugin } from "@opencode/plugin";
import { isRecord, toErrorMessage } from "../../../../core/common";
import { mergeRequestFields } from "../../../../core/llm-inference";
import { AKM_READ_TOOLS } from "../../../agent/akm-read-tools";

/** What akm knows about one session on a host, from `sessions.create` until the run ends. */
export interface SessionSettings {
  /** Request fields (wire names) to lay over the session's model requests. */
  readonly requestFields?: Readonly<Record<string, unknown>>;
  /** The endpoint's key, sent as a bearer token with the session's model requests. */
  readonly apiKey?: string;
}

/** The settings of the sessions a host is running, by session id. */
export type SessionRegistry = Map<string, SessionSettings>;

/** The request with the session's key and request fields applied; a request with no JSON object body keeps its body. */
async function withSettings(request: Request, { requestFields, apiKey }: SessionSettings): Promise<Request> {
  const headers = new Headers(request.headers);
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const fields = requestFields ?? {};
  const body: unknown =
    Object.keys(fields).length > 0
      ? await request
          .clone()
          .json()
          .catch(() => undefined)
      : undefined;
  if (!isRecord(body)) return new Request(request, { headers });
  const merged = mergeRequestFields(body, fields);
  // OpenCode states the output limit as `max_completion_tokens`; the chat transport sends `max_tokens`
  // alone, so one the call writes replaces it rather than riding beside it.
  if (Object.hasOwn(fields, "max_tokens")) delete merged.max_completion_tokens;
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(merged),
    signal: request.signal,
  });
}

export function akmPlugin(sessions: SessionRegistry): Plugin.Plugin {
  return {
    id: "akm",
    setup: async (ctx) => {
      await ctx.tool.transform((editor) => {
        for (const tool of AKM_READ_TOOLS) {
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema,
            options: { codemode: false },
            execute: async (input: unknown) => {
              try {
                return { content: await tool.run(isRecord(input) ? input : {}) };
              } catch (error) {
                return { content: `${tool.name} failed: ${toErrorMessage(error)}` };
              }
            },
          } as never);
        }
      });
      await ctx.session.hook("http.request", async (event) => {
        const settings = sessions.get(event.sessionID);
        if (settings) event.request = await withSettings(event.request, settings);
      });
    },
  };
}
