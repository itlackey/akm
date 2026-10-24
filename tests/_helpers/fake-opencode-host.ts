// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A scripted stand-in for the embedded OpenCode (`@opencode/sdk`), installed
 * through the SDK runner's host-factory seam. Each prompt is answered by
 * `reply`: the reply's text, or a {@link FakeOpencodeReply} with usage or a
 * provider error. A reply that never settles leaves the turn running, for
 * deadline and abort tests. What the runner sent is recorded in `calls`.
 *
 * Tests that need OpenCode's real behaviour (tools, permissions, compaction)
 * use the real SDK with `startFakeModel()` instead.
 */

import { _setOpencodeHostFactoryForTests } from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { overrideSeam } from "./seams";

export interface FakeOpencodeCall {
  /** The config content the host was created with (akm's model, when it names one). */
  readonly config?: Record<string, unknown>;
  readonly prompt: string;
  readonly system?: string;
  readonly agent?: string;
  readonly directory?: string;
  readonly permissions?: unknown;
  readonly metadata?: unknown;
}

export interface FakeOpencodeReply {
  readonly text?: string;
  readonly tokens?: { readonly input?: number; readonly output?: number };
  /** A provider error on the assistant message; the turn fails. */
  readonly error?: { readonly type: string; readonly message: string };
  /** Report `error` on the turn's `idle` message too, as OpenCode does for a turn-level failure. */
  readonly onTurn?: boolean;
  /** Earlier tool steps in the turn, each one assistant message, before the reply. */
  readonly steps?: number;
}

export interface FakeOpencodeOptions {
  readonly reply: (call: FakeOpencodeCall) => string | FakeOpencodeReply | Promise<string | FakeOpencodeReply>;
  /** Hold every host's creation until this settles (an in-flight start). */
  readonly ready?: Promise<void>;
}

export interface FakeOpencodeHosts {
  readonly calls: FakeOpencodeCall[];
  /** Hosts created and closed so far. */
  readonly lifecycle: { created: number; closed: number };
}

export function installFakeOpencodeHost(options: FakeOpencodeOptions): FakeOpencodeHosts {
  const calls: FakeOpencodeCall[] = [];
  const lifecycle = { created: 0, closed: 0 };
  overrideSeam(_setOpencodeHostFactoryForTests, async (create) => {
    await options.ready;
    lifecycle.created += 1;
    const content = (create as { config?: { content?: string } }).config?.content;
    const config = content ? (JSON.parse(content) as Record<string, unknown>) : undefined;
    const sessions = new Map<
      string,
      { create: Record<string, unknown>; system?: string; messages: unknown[]; done?: Promise<void> }
    >();
    let n = 0;
    const host = {
      sessions: {
        create: async (input: Record<string, unknown>) => {
          const id = `ses_${++n}`;
          sessions.set(id, { create: input, messages: [] });
          return { id };
        },
        instructions: {
          entry: {
            put: async ({ sessionID, value }: { sessionID: string; value: string }) => {
              const session = sessions.get(sessionID);
              if (session) session.system = value;
            },
          },
        },
        prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
          const session = sessions.get(sessionID);
          if (!session) throw new Error(`no session ${sessionID}`);
          const userId = `msg_user_${++n}`;
          const location = session.create.location as { directory?: string } | undefined;
          const call: FakeOpencodeCall = {
            ...(config ? { config } : {}),
            prompt: text,
            ...(session.system !== undefined ? { system: session.system } : {}),
            ...(typeof session.create.agent === "string" ? { agent: session.create.agent } : {}),
            ...(location?.directory ? { directory: location.directory } : {}),
            ...(session.create.permissions ? { permissions: session.create.permissions } : {}),
            ...(session.create.metadata ? { metadata: session.create.metadata } : {}),
          };
          calls.push(call);
          session.messages.push({ id: userId, type: "user" });
          session.done = Promise.resolve(options.reply(call)).then((answer) => {
            const reply = typeof answer === "string" ? { text: answer } : answer;
            for (let step = 0; step < (reply.steps ?? 0); step++) {
              session.messages.push({ id: `msg_s_${++n}`, type: "assistant", finish: "tool-calls", content: [] });
            }
            session.messages.push(
              {
                id: `msg_a_${++n}`,
                type: "assistant",
                finish: reply.error ? "error" : "stop",
                content: reply.text !== undefined ? [{ type: "text", text: reply.text }] : [],
                ...(reply.tokens ? { tokens: reply.tokens } : {}),
                ...(reply.error ? { error: reply.error } : {}),
              },
              {
                id: `msg_i_${++n}`,
                type: "idle",
                outcome: reply.error ? "failed" : "succeeded",
                ...(reply.error && reply.onTurn ? { error: reply.error } : {}),
              },
            );
          });
          return { id: userId };
        },
        wait: async ({ sessionID }: { sessionID: string }) => {
          await sessions.get(sessionID)?.done;
        },
        interrupt: async () => {},
        form: { cancel: async () => {} },
      },
      message: {
        // Pages like OpenCode: a cursor carries its page's order, and OpenCode refuses one combined with `order`.
        list: async (input: { sessionID: string; limit?: number; order?: "asc" | "desc"; cursor?: string }) => {
          if (input.cursor !== undefined && input.order !== undefined)
            throw new Error("Cursor cannot be combined with order");
          const [order, start] = input.cursor
            ? (input.cursor.split(":") as ["asc" | "desc", string])
            : [input.order ?? "asc", "0"];
          const all = [...(sessions.get(input.sessionID)?.messages ?? [])];
          const ordered = order === "desc" ? all.reverse() : all;
          const from = Number(start);
          const to = from + (input.limit ?? ordered.length);
          return { data: ordered.slice(from, to), cursor: { next: to < ordered.length ? `${order}:${to}` : null } };
        },
      },
      permission: { reply: async () => {} },
      events: {
        subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          },
        }),
      },
      close: async () => {
        lifecycle.closed += 1;
      },
    };
    return host as never;
  });
  return { calls, lifecycle };
}
