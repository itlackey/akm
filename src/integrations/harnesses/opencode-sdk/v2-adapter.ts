// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 2 wire adapter, on
 * `@opencode/client` 2.0.26 (the promise client, generated types).
 *
 * akm owns a private `opencode serve` child (never the v2 background
 * `service`). What differs from OpenCode 1, verified against the 2.0.26
 * binary:
 *
 *   - Readiness is `server listening on <url>` (no `opencode` prefix).
 *   - The server is basic-auth protected. akm chooses the password and hands it
 *     to the child as `OPENCODE_SERVER_PASSWORD` (and `OPENCODE_PASSWORD`,
 *     which wins when set), so nothing is scraped from stdout; the username is
 *     the server's default, `opencode`.
 *   - The working directory is the session's `location.directory`, set once at
 *     `session.create`. Later calls address the session by id.
 *   - The agent, the tool permissions (`permissions`: action/resource/effect
 *     rules) and the title are `session.create` fields. The prompt carries only
 *     text, so the system text is a session instruction entry.
 *   - `session.prompt` only enqueues. `session.wait` blocks until the session is
 *     idle, and `session.context` then holds the turn: our user message, the
 *     assistant messages and a closing `idle` message with the outcome.
 *   - Cancellation is `session.interrupt`; permission requests are answered with
 *     `permission.reply`; the event stream is global, so events are matched to
 *     the dispatch's sessions by id.
 *
 * Config (`OPENCODE_CONFIG_CONTENT`, built by the runner) keeps the V1 shape,
 * which the 2.0.26 server translates (`model`, `provider`, `agent`, `permission`).
 */

import { randomBytes } from "node:crypto";
import { OpenCode, type OpenCodeClient, type SessionMessageAssistant, type SessionMessageInfo } from "@opencode/client";
import { isRecord, toErrorMessage } from "../../../core/common";
import { sleep } from "../../../runtime";
import type { AgentTokenUsage } from "../../agent/spawn";
import { parseOpencodeMajor } from "../opencode/version";
import {
  decodeRetryStatus,
  type OpencodeWireAdapter,
  OTHER_MAJOR_REMEDY,
  type WireEvent,
  type WireFailure,
  type WirePromptResult,
  type WireSessionSpec,
} from "./wire";

/** Key of the session instruction entry carrying the dispatch's system text (`^[a-z0-9][a-z0-9._-]*$`). */
const SYSTEM_INSTRUCTION_KEY = "akm.system";

/** The server's default basic-auth username. */
const SERVER_USERNAME = "opencode";

const POLL_INTERVAL_MS = 100;

/** One finished turn, read from `session.context`. */
export interface V2Turn {
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly assistants: readonly SessionMessageAssistant[];
}

/**
 * The turn that began with the user message `userId`, once its closing `idle`
 * message exists; undefined while the turn is still running.
 */
export function v2Turn(messages: readonly SessionMessageInfo[], userId: string): V2Turn | undefined {
  const start = messages.findIndex((m) => m.id === userId);
  if (start < 0) return undefined;
  const assistants: SessionMessageAssistant[] = [];
  for (const message of messages.slice(start + 1)) {
    if (message.type === "assistant") assistants.push(message);
    else if (message.type === "idle") return { outcome: message.outcome, assistants };
  }
  return undefined;
}

/** Decode a finished turn into the answer, the usage of every step and the failure, if any. */
function v2PromptResult(turn: V2Turn): WirePromptResult {
  const text =
    turn.assistants
      .flatMap((a) => a.content)
      .filter((c) => c.type === "text")
      .at(-1)?.text ?? "";
  const usage: AgentTokenUsage = {};
  const add = (key: keyof AgentTokenUsage, value: number | undefined): void => {
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
  };
  for (const a of turn.assistants) {
    add("inputTokens", a.tokens?.input);
    add("outputTokens", a.tokens?.output);
    add("reasoningTokens", a.tokens?.reasoning);
  }
  const failure = v2Failure(turn);
  return {
    text,
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(failure ? { failure } : {}),
  };
}

function v2Failure(turn: V2Turn): WireFailure | undefined {
  if (turn.outcome === "interrupted") {
    return { reason: "aborted", message: "OpenCode session was interrupted" };
  }
  const last = turn.assistants.at(-1);
  if (turn.outcome === "failed") {
    const error = [...turn.assistants].reverse().find((a) => a.error)?.error;
    return {
      reason: "non_zero_exit",
      message: error ? `${error.type}: ${error.message}` : "OpenCode session failed",
    };
  }
  // A reply cut off at the output limit has no error of its own.
  if (last?.finish === "length") {
    return { reason: "parse_error", message: "OpenCode reply was cut off at the output limit" };
  }
  return undefined;
}

/** Tool enable/disable map -> session permission rules. */
function toolPermissions(tools: Record<string, boolean> | undefined) {
  return Object.entries(tools ?? {}).map(([action, enabled]) => ({
    action,
    resource: "*",
    effect: enabled ? ("allow" as const) : ("deny" as const),
  }));
}

export const V2_ADAPTER: OpencodeWireAdapter = {
  major: 2,

  serveArgv: (bin, port) => [bin, "serve", "--hostname", "127.0.0.1", "--port", String(port)],

  authorize() {
    const password = randomBytes(24).toString("base64url");
    return { env: { OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password }, credentials: password };
  },

  async connect(baseUrl, credentials) {
    const client = OpenCode.make({
      baseUrl,
      headers: { authorization: `Basic ${Buffer.from(`${SERVER_USERNAME}:${credentials ?? ""}`).toString("base64")}` },
    });
    let version: string;
    try {
      version = (await client.server.info()).version;
    } catch (err) {
      throw new Error(
        `Could not read the OpenCode 2 server info at ${baseUrl}: ${toErrorMessage(err)}. ${OTHER_MAJOR_REMEDY}`,
      );
    }
    // Only OpenCode 1 is refused: a newer major than akm knows runs on these adapters (`../opencode/version.ts`).
    if (parseOpencodeMajor(version) === 1) {
      throw new Error(`The server is OpenCode ${version}, not OpenCode 2. ${OTHER_MAJOR_REMEDY}`);
    }
    return client;
  },

  async createSession(client, spec) {
    const c = client as OpenCodeClient;
    const permissions = toolPermissions(spec.tools);
    const session = await c.session.create({
      title: "akm",
      ...(spec.agent ? { agent: spec.agent } : {}),
      ...(spec.directory ? { location: { directory: spec.directory } } : {}),
      ...(permissions.length > 0 ? { permissions } : {}),
    });
    if (spec.system) {
      await c.session.instructions.entry.put({
        sessionID: session.id,
        key: SYSTEM_INSTRUCTION_KEY,
        value: spec.system,
      });
    }
    return session.id;
  },

  async prompt(client, sessionId, text, _spec: WireSessionSpec, signal) {
    const c = client as OpenCodeClient;
    const user = await c.session.prompt({ sessionID: sessionId, text }, { signal });
    for (;;) {
      await c.session.wait({ sessionID: sessionId }, { signal });
      const turn = v2Turn(await c.session.context({ sessionID: sessionId }, { signal }), user.id);
      if (turn) return v2PromptResult(turn);
      // `wait` can return before the queued prompt starts; look again.
      await sleep(POLL_INTERVAL_MS);
      if (signal.aborted) throw new Error("OpenCode prompt cancelled");
    }
  },

  abort(client, sessionId) {
    void (client as OpenCodeClient).session.interrupt({ sessionID: sessionId }).catch(() => {});
  },

  async subscribe(client, _spec, signal) {
    const source = (client as OpenCodeClient).event.subscribe({ signal })[Symbol.asyncIterator]();
    // The stream's first event is `server.connected`: reading it proves the subscription is open.
    const first = await source.next();
    async function* stream(): AsyncGenerator<unknown> {
      try {
        if (!first.done) yield first.value;
        while (true) {
          const next = await source.next();
          if (next.done) return;
          yield next.value;
        }
      } catch (err) {
        if (!signal.aborted) throw err;
      }
    }
    return stream();
  },

  decodeEvent(raw): WireEvent | undefined {
    if (!isRecord(raw) || typeof raw.type !== "string" || !isRecord(raw.data)) return undefined;
    // Shape-checked below, field by field; the generated `V2Event` union documents what each carries.
    const data = raw.data;
    if (raw.type === "session.created") {
      if (typeof data.sessionID !== "string") return undefined;
      return {
        kind: "session",
        id: data.sessionID,
        ...(typeof data.parentID === "string" ? { parentId: data.parentID } : {}),
      };
    }
    if (raw.type === "session.status") return decodeRetryStatus(data.sessionID, data.status);
    if (raw.type === "permission.asked") {
      const { id, sessionID, action, resources } = data;
      if (typeof id !== "string" || typeof sessionID !== "string") return undefined;
      const patterns = Array.isArray(resources) ? resources : [];
      return {
        kind: "permission",
        requestId: id,
        sessionId: sessionID,
        description: `${String(action ?? "unknown")} (${patterns.join(", ")})`,
      };
    }
    return undefined;
  },

  async rejectPermission(client, event) {
    await (client as OpenCodeClient).permission.reply({
      sessionID: event.sessionId,
      requestID: event.requestId,
      decision: "reject",
    });
  },
};
