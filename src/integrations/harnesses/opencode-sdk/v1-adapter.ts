// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 1 wire adapter, on `@opencode-ai/sdk` 1.2.20.
 *
 * Everything here is the V1 protocol and nothing else: the readiness line
 * (`opencode server listening on <url>`), the SDK client, `session.create` /
 * `session.prompt` / `session.abort` with the per-call `query.directory`, the
 * `/event` stream, and `postSessionIdPermissionsPermissionId`. `agent`,
 * `system` and `tools` ride on the prompt body. The shared server lifecycle
 * lives in `sdk-runner.ts`.
 */

import { isRecord } from "../../../core/common";
import type { AgentTokenUsage } from "../../agent/spawn";
import {
  type OpencodeWireAdapter,
  otherMajorRemedy,
  type WireEvent,
  type WireFailure,
  type WirePromptResult,
  type WireSessionSpec,
} from "./wire";

/** Per-call working-directory scope (SDK `query.directory`). */
interface SdkDirectoryQuery {
  directory?: string;
}

/** Minimal surface of the OpenCode 1 SDK client used by this adapter. */
export interface V1Client {
  session: {
    create(args: { body: { title: string }; query?: SdkDirectoryQuery }): Promise<{ data?: { id?: string } }>;
    prompt(args: {
      path: { id: string };
      // Mirrors @opencode-ai/sdk's SessionPromptData.body.
      body: {
        parts: { type: string; text: string }[];
        agent?: string;
        system?: string;
        tools?: Record<string, boolean>;
      };
      query?: SdkDirectoryQuery;
    }): Promise<{
      // The client is created without `throwOnError`, so an HTTP error
      // resolves to `{ error }` (the parsed response body) instead of throwing.
      error?: unknown;
      data?: {
        // AssistantMessage projection (SDK 1.2.20 types.gen.d.ts): token
        // accounting lives on info.tokens, and a provider failure on
        // info.error. Optional so a fake or an older server that omits them
        // cannot crash extraction.
        info?: { tokens?: { input?: number; output?: number; reasoning?: number }; error?: unknown };
        parts?: { type: string; text?: string }[];
      };
    }>;
    // Optional so a fake that omits it cannot crash a dispatch; the real client has it.
    abort?(args: { path: { id: string }; query?: SdkDirectoryQuery }): Promise<unknown>;
  };
  // Optional so a fake that omits them cannot crash a dispatch; the real client has both.
  /** Server-sent events for the directory; the stream ends when `signal` aborts. */
  event?: {
    subscribe(args: { query?: SdkDirectoryQuery; signal: AbortSignal }): Promise<{ stream: AsyncIterable<unknown> }>;
  };
  /** Answer a pending permission request (`response`: "once" | "always" | "reject"). */
  postSessionIdPermissionsPermissionId?(args: {
    path: { id: string; permissionID: string };
    body: { response: "reject" };
    query?: SdkDirectoryQuery;
  }): Promise<{ error?: unknown }>;
}

const queryOf = (spec: WireSessionSpec): { query?: SdkDirectoryQuery } =>
  spec.directory ? { query: { directory: spec.directory } } : {};

/**
 * Best-effort token usage from a prompt response. Only numeric fields the
 * server actually reported are copied; undefined when nothing usable is
 * present (older servers, test fakes).
 */
function extractUsage(info?: {
  tokens?: { input?: number; output?: number; reasoning?: number };
}): AgentTokenUsage | undefined {
  const tokens = info?.tokens;
  if (!tokens) return undefined;
  const usage: AgentTokenUsage = {};
  if (typeof tokens.input === "number" && Number.isFinite(tokens.input)) usage.inputTokens = tokens.input;
  if (typeof tokens.output === "number" && Number.isFinite(tokens.output)) usage.outputTokens = tokens.output;
  if (typeof tokens.reasoning === "number" && Number.isFinite(tokens.reasoning)) {
    usage.reasoningTokens = tokens.reasoning;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Map an SDK `{ error }` result or a reply's `info.error` onto a failure
 * (#1015). Both are opencode NamedErrors, `{ name, data: { message } }`. An
 * aborted message is `aborted`, a reply cut off at the output limit is
 * `parse_error`, and every other error (auth, API, unknown, an HTTP error
 * body) is `non_zero_exit`.
 */
export function v1ErrorFailure(error: unknown): WireFailure {
  if (!isRecord(error) || typeof error.name !== "string") {
    return { reason: "non_zero_exit", message: typeof error === "string" ? error : JSON.stringify(error) };
  }
  const detail = isRecord(error.data) ? error.data.message : undefined;
  const message = typeof detail === "string" ? `${error.name}: ${detail}` : error.name;
  if (error.name === "MessageAbortedError") return { reason: "aborted", message };
  if (error.name === "MessageOutputLengthError") return { reason: "parse_error", message };
  return { reason: "non_zero_exit", message };
}

/**
 * Subscribe to the server's event stream. The SDK's own `event.subscribe`
 * cannot be closed safely: aborting it leaves an unhandled `AbortError`
 * rejection (from its un-awaited `reader.cancel()`), which akm's global
 * handler turns into a process exit. This reader ends quietly on abort.
 */
async function subscribeEvents(
  baseUrl: string,
  args: { query?: SdkDirectoryQuery; signal: AbortSignal },
): Promise<{ stream: AsyncIterable<unknown> }> {
  const eventUrl = new URL("/event", baseUrl);
  if (args.query?.directory) eventUrl.searchParams.set("directory", args.query.directory);
  const response = await fetch(eventUrl, { signal: args.signal, headers: { accept: "text/event-stream" } });
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  async function* stream(): AsyncGenerator<unknown> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s*/, ""))
            .join("\n");
          if (!data) continue;
          try {
            yield JSON.parse(data);
          } catch {
            /* not JSON: not an event we act on */
          }
        }
      }
    } catch (err) {
      if (!args.signal.aborted) throw err;
    }
  }
  return { stream: stream() };
}

/** The SDK `createOpencodeClient`, with the quiet event reader swapped in. */
async function connectV1(baseUrl: string): Promise<V1Client> {
  const { createOpencodeClient } = (await import("@opencode-ai/sdk").catch(() => {
    throw new Error("OpenCode SDK not available. Install @opencode-ai/sdk or configure a CLI agent instead.");
  })) as { createOpencodeClient: (options: { baseUrl: string }) => V1Client };
  const client = createOpencodeClient({ baseUrl });
  client.event = { subscribe: (args) => subscribeEvents(baseUrl, args) };
  return client;
}

export const V1_ADAPTER: OpencodeWireAdapter = {
  major: 1,

  serveArgv: (bin, port) => [bin, "serve", "--hostname=127.0.0.1", `--port=${port}`],

  // OpenCode 1 serves unauthenticated on loopback.
  authorize: () => ({ env: {} }),

  readiness(line) {
    if (line.startsWith("opencode server listening")) {
      const match = line.match(/on\s+(https?:\/\/\S+)/);
      return match?.[1] ? { url: match[1] } : { error: `Failed to parse the OpenCode server url from: ${line}` };
    }
    // OpenCode 2 prints "server listening on <url>" with no "opencode" prefix.
    if (line.startsWith("server listening on")) {
      return { error: `The binary is OpenCode 2 (${line.trim()}). ${otherMajorRemedy()}` };
    }
    return undefined;
  },

  connect: (baseUrl) => connectV1(baseUrl),

  async createSession(client, spec) {
    const created = await (client as V1Client).session.create({ body: { title: "akm" }, ...queryOf(spec) });
    return created.data?.id;
  },

  async prompt(client, sessionId, text, spec): Promise<WirePromptResult> {
    // Forward the exact native agent selector, system prompt and tools from the
    // abstract dispatch request (#564).
    const body: Parameters<V1Client["session"]["prompt"]>[0]["body"] = { parts: [{ type: "text", text }] };
    if (spec.agent) body.agent = spec.agent;
    if (spec.system) body.system = spec.system;
    if (spec.tools) body.tools = spec.tools;
    const prompted = await (client as V1Client).session.prompt({ path: { id: sessionId }, body, ...queryOf(spec) });
    const parts = prompted.data?.parts ?? [];
    // The last text part is the answer; earlier ones narrate the steps before it.
    const textOut = parts.filter((p) => p.type === "text").at(-1)?.text ?? "";
    const usage = extractUsage(prompted.data?.info);
    const sdkError = prompted.error ?? prompted.data?.info?.error;
    return {
      text: textOut,
      ...(usage ? { usage } : {}),
      ...(sdkError ? { failure: v1ErrorFailure(sdkError) } : {}),
    };
  },

  abort(client, sessionId, spec) {
    void (client as V1Client).session.abort?.({ path: { id: sessionId }, ...queryOf(spec) }).catch(() => {});
  },

  canWatch(client) {
    const c = client as V1Client;
    return Boolean(c.event?.subscribe && c.postSessionIdPermissionsPermissionId);
  },

  async subscribe(client, spec, signal) {
    const events = (client as V1Client).event;
    if (!events) throw new Error("the client has no event surface");
    const { stream } = await events.subscribe.call(events, { ...queryOf(spec), signal });
    return stream;
  },

  decodeEvent(raw): WireEvent | undefined {
    if (!isRecord(raw) || !isRecord(raw.properties)) return undefined;
    const props = raw.properties;
    if (raw.type === "session.created" && isRecord(props.info)) {
      const { id, parentID } = props.info;
      if (typeof id !== "string") return undefined;
      return { kind: "session", id, ...(typeof parentID === "string" ? { parentId: parentID } : {}) };
    }
    if (raw.type === "session.status") {
      const { sessionID, status } = props;
      if (typeof sessionID !== "string" || !isRecord(status) || status.type !== "retry") return undefined;
      // `action` is not present in the SDK's retry type yet, but current
      // OpenCode servers include it for provider/account limits.
      const action = isRecord(status.action) ? status.action : undefined;
      return {
        kind: "retry",
        sessionId: sessionID,
        ...(typeof status.attempt === "number" ? { attempt: status.attempt } : {}),
        message: typeof status.message === "string" ? status.message : "OpenCode is retrying",
        ...(typeof status.next === "number" ? { next: status.next } : {}),
        ...(typeof action?.provider === "string" ? { provider: action.provider } : {}),
        accountLimit: action?.reason === "account_rate_limit",
      };
    }
    // `permission.asked` (OpenCode >= 1.3) / `permission.updated` (older).
    if (raw.type !== "permission.asked" && raw.type !== "permission.updated") return undefined;
    const { id, sessionID } = props;
    if (typeof id !== "string" || typeof sessionID !== "string") return undefined;
    const patterns = Array.isArray(props.patterns) ? props.patterns : props.pattern ? [props.pattern] : [];
    return {
      kind: "permission",
      requestId: id,
      sessionId: sessionID,
      description: `${String(props.permission ?? props.type ?? "unknown")} (${patterns.join(", ")})`,
    };
  },

  async rejectPermission(client, event, spec) {
    const c = client as V1Client;
    const reply = c.postSessionIdPermissionsPermissionId;
    if (!reply) throw new Error("the client cannot answer permission requests");
    const r = await reply.call(c, {
      path: { id: event.sessionId, permissionID: event.requestId },
      body: { response: "reject" },
      ...queryOf(spec),
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
  },
};
