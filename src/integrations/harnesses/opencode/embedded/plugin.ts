// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The plugin akm loads into every embedded OpenCode it starts.
 *
 * - **akm's read tools** (`akm_search`, `akm_show`, `akm_curate`): they run in
 *   akm's process, so an agent reads the library without a shell.
 *   A call records its usage event under the source of the run it is in (the
 *   session's `AKM_EVENT_SOURCE`), so a stamped run's reads (a task's, a
 *   workflow's) never count as user demand.
 * - **The models of the runs it serves**: a run's connection is declared as a
 *   provider of its own when the run asks (`./runner-models.ts`), so the host
 *   never reads config.
 * - **Per-session request settings**: what a call resolves to differs from
 *   session to session on the one shared host: the request fields (the connection's
 *   and model entry's, and the portable settings of the call, in the endpoint's
 *   own spelling) and the key, which is read when the call is dispatched. The
 *   runner records them under the session's id and the `http.request` hook lays
 *   them over that session's model requests, so a call reaches the endpoint
 *   exactly as the direct-chat path would send it. A subagent the run starts has
 *   its own session; it runs with its run's settings and environment.
 */

import type { Plugin } from "@opencode/plugin";
import { isRecord, toErrorMessage } from "../../../../core/common";
import { openAiOperationUrl } from "../../../../core/endpoint-url";
import { mergeRequestFields } from "../../../../core/llm-inference";
import { AKM_READ_TOOLS } from "../../../agent/akm-read-tools";
import type { RunnerModels } from "./runner-models";

/** What akm knows about one session on a host, from `sessions.create` until the run ends. */
export interface SessionSettings {
  /** Request fields (wire names) to lay over the session's model requests. */
  readonly requestFields?: Readonly<Record<string, unknown>>;
  /** The connection's endpoint: every model request of the session goes to it, whatever URL OpenCode built. */
  readonly endpoint: string;
  /** The endpoint's key, sent as a bearer token with the session's model requests. */
  readonly apiKey?: string;
  /** The run's `AKM_EVENT_SOURCE`, which akm's read tools record their usage events under. */
  readonly eventSource?: string;
  /** The environment the run's commands get, which a subagent session the run starts is given too. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The settings of the sessions a host is running, by session id: a run's session,
 * and the subagent sessions it starts, which share the run's settings.
 */
export type SessionRegistry = Map<string, SessionSettings>;

/** Forget a run's session and the subagent sessions that shared its settings. */
export function forgetSession(sessions: SessionRegistry, sessionID: string): void {
  const settings = sessions.get(sessionID);
  for (const [id, other] of sessions) if (id === sessionID || other === settings) sessions.delete(id);
}

/**
 * The request with the session's endpoint, key and request fields applied. The
 * key and the destination are set together, so a key is only ever sent to the
 * endpoint of the connection it belongs to. A request with no JSON object body
 * keeps its body.
 */
async function withSettings(request: Request, { requestFields, apiKey, endpoint }: SessionSettings): Promise<Request> {
  const headers = new Headers(request.headers);
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const text = request.body === null ? undefined : await request.clone().text();
  let parsed: unknown;
  try {
    parsed = text === undefined ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  let body = text;
  if (isRecord(parsed)) {
    // OpenCode sizes every request's output cap from the model's limit (32,000 tokens when the limit does not say)
    // and sends it as `max_tokens` or `max_completion_tokens`. That is its own accounting, not a cap anyone
    // asked for: akm's runtime sends the cap the connection or the call writes, and none otherwise, as the chat
    // transport does.
    const { max_tokens: _own, max_completion_tokens: _ownCompletion, ...kept } = parsed;
    body = JSON.stringify(mergeRequestFields(kept, requestFields ?? {}));
    headers.delete("content-length");
  }
  return new Request(openAiOperationUrl(endpoint, "chat/completions"), {
    method: request.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: request.signal,
  });
}

/**
 * `setEnvironment` sets a session's environment on the host the plugin is loaded
 * into; a subagent session gets its run's. `models` holds the connections the
 * host's runs bring.
 */
export function akmPlugin(
  sessions: SessionRegistry,
  models: RunnerModels,
  setEnvironment: (sessionID: string, variables: Record<string, string>) => Promise<void>,
): Plugin.Plugin {
  return {
    id: "akm",
    setup: async (ctx) => {
      const detach = await models.attach(ctx.provider);
      await ctx.tool.transform((editor) => {
        for (const tool of AKM_READ_TOOLS) {
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema,
            options: { codemode: false },
            execute: async (input: unknown, context: { sessionID: string }) => {
              try {
                const eventSource = sessions.get(context.sessionID)?.eventSource;
                return { content: await tool.run(isRecord(input) ? input : {}, { eventSource }) };
              } catch (error) {
                return { content: `${tool.name} failed: ${toErrorMessage(error)}` };
              }
            },
          } as never);
        }
      });
      await ctx.session.hook("http.request", async (event) => {
        let settings = sessions.get(event.sessionID);
        // A subagent session is not one akm created: its first request names the session that started it. It runs with
        // that run's settings and environment, set before the request goes out, so before any command it runs.
        const parentID = event.request.headers.get("x-opencode-parent-session-id");
        if (!settings && parentID) {
          settings = sessions.get(parentID);
          if (settings) {
            sessions.set(event.sessionID, settings);
            if (settings.env) await setEnvironment(event.sessionID, { ...settings.env });
          }
        }
        if (settings) event.request = await withSettings(event.request, settings);
      });
      return detach;
    },
  };
}
