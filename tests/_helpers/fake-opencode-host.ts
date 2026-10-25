// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A scripted stand-in for the embedded OpenCode, installed through the host
 * factory seam. Each prompt is answered by `reply`: the reply's text, or a
 * {@link FakeOpencodeReply} with usage or a provider error. A reply that never
 * settles leaves the turn running, for deadline and abort tests. What akm asked
 * of the host and the session is recorded in `calls`.
 *
 * The fake runs akm's plugin the way OpenCode would: it calls its `setup` with a
 * context that records the tools it registers, the providers it declares and the
 * session hooks it subscribes, and for every prompt it runs the `http.request` hooks over the
 * model request OpenCode would send (`requestBody`, `requestHeaders`), so a test
 * sees what a session's requests would carry.
 *
 * Tests that need OpenCode's real behaviour (tools, permissions, compaction) use
 * the real SDK with `startFakeModel()` instead.
 */

import {
  _setOpencodeHostFactoryForTests,
  type EmbeddedHost,
} from "../../src/integrations/harnesses/opencode/embedded/host";
import type { HostSpec } from "../../src/integrations/harnesses/opencode/embedded/host-spec";
import { overrideSeam } from "./seams";

export interface FakeOpencodeCall {
  /** The kind of host the session ran on. */
  readonly kind: HostSpec["kind"];
  readonly sessionID: string;
  /** The OpenCode config content the host was created with. */
  readonly config?: Record<string, unknown>;
  readonly prompt: string;
  readonly system?: string;
  readonly agent?: string;
  readonly directory?: string;
  readonly permissions?: unknown;
  readonly metadata?: unknown;
  /** The model the session was created with. */
  readonly model?: { readonly providerID: string; readonly id: string };
  /** The variables set on the session's environment. */
  readonly environment?: Readonly<Record<string, string>>;
  /** The JSON body of the session's model request after akm's `http.request` hook ran over a plain one. */
  readonly requestBody: Record<string, unknown>;
  /** The headers of that request. */
  readonly requestHeaders: Readonly<Record<string, string>>;
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
  /** How long closing a host takes. */
  readonly closeDelayMs?: number;
  /** Called with every session the fake interrupts. */
  readonly onInterrupt?: (sessionID: string) => void | Promise<void>;
}

export interface FakeOpencodeHosts {
  readonly calls: FakeOpencodeCall[];
  /** What each host was created with. */
  readonly specs: HostSpec[];
  /** The tools akm's plugin registered, by host kind. */
  readonly tools: Record<string, string[]>;
  /** The providers akm's plugin declared on the hosts, by provider id: what OpenCode would route a session's model to. */
  readonly providers: Map<string, FakeProvider>;
  /** Run a tool akm's plugin registered, as OpenCode would for a session on the host of `kind`. */
  runTool(kind: HostSpec["kind"], name: string, input: unknown, sessionID: string): Promise<{ content: string }>;
  /** A subagent session OpenCode starts under `parentID` on the host of `kind`. */
  spawnChild(kind: HostSpec["kind"], parentID: string): FakeChildSession;
  /** Hosts created and closed so far. */
  readonly lifecycle: { created: number; closed: number };
}

/** A provider akm's plugin declared, with the models it carries. */
export interface FakeProvider {
  readonly info: Record<string, unknown>;
  readonly models: readonly Record<string, unknown>[];
}

/** A subagent session on the fake host. */
export interface FakeChildSession {
  readonly sessionID: string;
  /** The variables set on the child's environment. */
  environment(): Readonly<Record<string, string>> | undefined;
  /** The model request OpenCode would send for the child, which names its parent in a header: the child's first, if none was sent. */
  request(): Promise<Pick<FakeOpencodeCall, "requestBody" | "requestHeaders">>;
}

interface HookEvent {
  sessionID: string;
  agent: string;
  model: unknown;
  kind: string;
  request: Request;
}

type ToolExecute = (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;

/** Run the plugin's setup against a context that keeps what it registers. */
async function loadPlugin(
  spec: HostSpec,
  providers: Map<string, FakeProvider>,
): Promise<{
  tools: string[];
  executes: Map<string, ToolExecute>;
  requestHooks: Array<(e: HookEvent) => Promise<void>>;
}> {
  const tools: string[] = [];
  const executes = new Map<string, ToolExecute>();
  const requestHooks: Array<(e: HookEvent) => Promise<void>> = [];
  const providerEdits: Array<(editor: { add: (provider: FakeProvider) => void }) => void> = [];
  const editor = { add: (provider: FakeProvider) => void providers.set(String(provider.info.id), provider) };
  const context = {
    provider: {
      transform: async (edit: (typeof providerEdits)[number]) => {
        providerEdits.push(edit);
        edit(editor);
      },
      reload: async () => {
        for (const edit of providerEdits) edit(editor);
      },
    },
    tool: {
      transform: async (edit: (editor: { add: (tool: { name: string; execute: ToolExecute }) => void }) => void) =>
        edit({
          add: (tool) => {
            tools.push(tool.name);
            executes.set(tool.name, tool.execute);
          },
        }),
    },
    session: {
      hook: async (name: string, callback: (e: HookEvent) => Promise<void>) => {
        if (name === "http.request") requestHooks.push(callback);
      },
    },
  };
  await spec.plugin.setup(context as never);
  return { tools, executes, requestHooks };
}

export function installFakeOpencodeHost(options: FakeOpencodeOptions): FakeOpencodeHosts {
  const calls: FakeOpencodeCall[] = [];
  const specs: HostSpec[] = [];
  const providers = new Map<string, FakeProvider>();
  const tools: Record<string, string[]> = {};
  const executes: Record<string, Map<string, ToolExecute>> = {};
  const children: Record<string, FakeOpencodeHosts["spawnChild"]> = {};
  const lifecycle = { created: 0, closed: 0 };
  overrideSeam(_setOpencodeHostFactoryForTests, async (spec) => {
    await options.ready;
    lifecycle.created += 1;
    specs.push(spec);
    const plugin = await loadPlugin(spec, providers);
    tools[spec.kind] = plugin.tools;
    executes[spec.kind] = plugin.executes;
    const sessions = new Map<
      string,
      {
        create: Record<string, unknown>;
        system?: string;
        environment?: Record<string, string>;
        messages: unknown[];
        done?: Promise<void>;
      }
    >();
    let n = 0;

    /** The model request OpenCode would send for a session, after akm's hook ran over it. */
    async function modelRequest(
      sessionID: string,
      model: { providerID: string; id: string } | undefined,
      headers: Record<string, string> = {},
    ) {
      let request = new Request("http://model.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: model?.id ?? "unset", stream: true, max_completion_tokens: 32000 }),
      });
      for (const hook of plugin.requestHooks) {
        const event: HookEvent = { sessionID, agent: "build", model, kind: "primary", request };
        await hook(event);
        request = event.request;
      }
      return {
        requestBody: (await request.json()) as Record<string, unknown>,
        requestHeaders: Object.fromEntries(request.headers.entries()),
      };
    }

    children[spec.kind] = (_kind, parentID) => {
      const sessionID = `ses_${++n}`;
      sessions.set(sessionID, { create: { parentID }, messages: [] });
      return {
        sessionID,
        environment: () => sessions.get(sessionID)?.environment,
        request: () => modelRequest(sessionID, undefined, { "x-opencode-parent-session-id": parentID }),
      };
    };

    const host: EmbeddedHost = {
      sessions: {
        create: async (input) => {
          const id = `ses_${++n}`;
          sessions.set(id, { create: input as unknown as Record<string, unknown>, messages: [] });
          return { id };
        },
        environment: async ({ sessionID, variables }) => {
          const session = sessions.get(sessionID);
          if (session) session.environment = variables;
        },
        instructions: {
          entry: {
            put: async ({ sessionID, value }) => {
              const session = sessions.get(sessionID);
              if (session) session.system = value;
            },
          },
        },
        prompt: async ({ sessionID, text }) => {
          const session = sessions.get(sessionID);
          if (!session) throw new Error(`no session ${sessionID}`);
          const userId = `msg_user_${++n}`;
          const location = session.create.location as { directory?: string } | undefined;
          const model = session.create.model as { providerID: string; id: string } | undefined;
          const call: FakeOpencodeCall = {
            kind: spec.kind,
            sessionID,
            ...(spec.content ? { config: spec.content } : {}),
            prompt: text,
            ...(session.system !== undefined ? { system: session.system } : {}),
            ...(typeof session.create.agent === "string" ? { agent: session.create.agent } : {}),
            ...(location?.directory ? { directory: location.directory } : {}),
            ...(session.create.permissions ? { permissions: session.create.permissions } : {}),
            ...(session.create.metadata ? { metadata: session.create.metadata } : {}),
            ...(model ? { model } : {}),
            ...(session.environment ? { environment: session.environment } : {}),
            ...(await modelRequest(sessionID, model)),
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
        wait: async ({ sessionID }) => {
          await sessions.get(sessionID)?.done;
        },
        interrupt: async ({ sessionID }) => {
          await options.onInterrupt?.(sessionID);
        },
        form: { cancel: async () => {} },
      },
      message: {
        // Pages like OpenCode: a cursor carries its page's order, and OpenCode refuses one combined with `order`.
        list: async (input) => {
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
        forEach: async (_handler, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      },
      close: async () => {
        if (options.closeDelayMs) await new Promise((resolve) => setTimeout(resolve, options.closeDelayMs));
        lifecycle.closed += 1;
      },
    };
    return host;
  });
  const runTool: FakeOpencodeHosts["runTool"] = async (kind, name, input, sessionID) => {
    const execute = executes[kind]?.get(name);
    if (!execute) throw new Error(`no tool ${name} on the ${kind} host`);
    return execute(input, { sessionID });
  };
  const spawnChild: FakeOpencodeHosts["spawnChild"] = (kind, parentID) => {
    const spawn = children[kind];
    if (!spawn) throw new Error(`no ${kind} host`);
    return spawn(kind, parentID);
  };
  return { calls, specs, tools, providers, runTool, spawnChild, lifecycle };
}
