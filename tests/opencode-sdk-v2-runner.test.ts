// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode 2 adapter (`v2-adapter.ts`) driven through `runOpencodeSdk`
 * with a fake `@opencode/client`, mirroring the V1 fakes in
 * `opencode-sdk-runner.test.ts`. A profile with no `opencodeVersion` selects
 * V2 (`DEFAULT_OPENCODE_VERSION`). The real 2.0.26 binary is exercised by
 * `tests/integration/opencode-sdk-real-binary.test.ts` (gated).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config/config";
import { buildExecution, resolveExecution } from "../src/integrations/agent/execution";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import {
  __setServerFactory,
  __setTestServer,
  closeServer,
  runOpencodeSdk,
} from "../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { V1_ADAPTER } from "../src/integrations/harnesses/opencode-sdk/v1-adapter";
import { V2_ADAPTER, v2Turn } from "../src/integrations/harnesses/opencode-sdk/v2-adapter";
import { detectHarness } from "../src/setup/detect";

const profile: AgentProfile = {
  name: "opencode-sdk",
  bin: "opencode",
  args: [],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
};

type Msg = Record<string, unknown>;

const USER = { id: "msg-user", type: "user", text: "p" };
const IDLE_OK = { id: "msg-idle", type: "idle", outcome: "succeeded" };
const assistant = (id: string, text: string, extra: Msg = {}): Msg => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

/** A pushable event stream whose first event is `server.connected`, like the real one. */
function eventFeed() {
  const queue: unknown[] = [{ type: "server.connected", data: {} }];
  let wake: (() => void) | undefined;
  let subscriptions = 0;
  let closed = 0;
  return {
    push(event: unknown) {
      queue.push(event);
      wake?.();
    },
    subscriptions: () => subscriptions,
    closed: () => closed,
    subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> {
      subscriptions++;
      options.signal.addEventListener("abort", () => {
        closed++;
        wake?.();
      });
      return (async function* () {
        while (!options.signal.aborted) {
          while (queue.length > 0) yield queue.shift();
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        // A real stream rejects when its request is aborted.
        throw new DOMException("aborted", "AbortError");
      })();
    },
  };
}

interface FakeOptions {
  /** What `session.context` returns on each call (the last entry repeats). */
  contexts?: Msg[][];
  promptImpl?: () => Promise<unknown>;
  waitImpl?: () => Promise<void>;
  feed?: ReturnType<typeof eventFeed>;
}

function makeFakeV2(opts: FakeOptions = {}) {
  const calls = {
    create: [] as Msg[],
    prompt: [] as Msg[],
    put: [] as Msg[],
    interrupt: [] as Msg[],
    reply: [] as Msg[],
    remove: 0,
  };
  const feed = opts.feed ?? eventFeed();
  const contexts = opts.contexts ?? [[USER, assistant("msg-a", "ok-response"), IDLE_OK]];
  let contextCall = 0;
  const client = {
    session: {
      create: async (input: Msg) => {
        calls.create.push(input);
        return { id: "sess-v2" };
      },
      prompt: async (input: Msg) => {
        calls.prompt.push(input);
        if (opts.promptImpl) return opts.promptImpl();
        return { id: USER.id };
      },
      wait: async () => {
        if (opts.waitImpl) await opts.waitImpl();
      },
      context: async () => contexts[Math.min(contextCall++, contexts.length - 1)],
      interrupt: async (input: Msg) => {
        calls.interrupt.push(input);
        return { interrupted: true };
      },
      // Tripwire: sessions are kept (#1100).
      remove: async () => {
        calls.remove++;
      },
      instructions: {
        entry: {
          put: async (input: Msg) => {
            calls.put.push(input);
          },
        },
      },
    },
    event: { subscribe: (options: { signal: AbortSignal }) => feed.subscribe(options) },
    permission: {
      reply: async (input: Msg) => {
        calls.reply.push(input);
      },
    },
  };
  return { calls, feed, server: { client, server: { close() {} } } };
}

afterEach(() => {
  __setTestServer(null);
  __setServerFactory(null);
  closeServer();
});

describe("OpenCode 2 adapter — session and result", () => {
  test("a profile with no opencodeVersion runs on V2: session scoped by location, prompt carries the text", async () => {
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          assistant("msg-a1", "narration", {
            tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 0, write: 0 } },
          }),
          assistant("msg-a2", "final answer", {
            tokens: { input: 20, output: 7, reasoning: 2, cache: { read: 0, write: 0 } },
          }),
          IDLE_OK,
        ],
      ],
    });
    __setTestServer(fake.server as never);

    const res = await runOpencodeSdk(profile, "p", {
      cwd: "/work/tree",
      dispatch: { prompt: "p", agent: "Review-Team.Exact", systemPrompt: "Be careful.", tools: ["read", "grep"] },
      timeoutMs: null,
    });

    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("final answer");
    expect(res.sessionId).toBe("sess-v2");
    // Usage is the sum of every step of the turn.
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 12, reasoningTokens: 3 });
    expect(fake.calls.create).toEqual([
      {
        title: "akm",
        agent: "Review-Team.Exact",
        location: { directory: "/work/tree" },
        permissions: [
          { action: "read", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
        ],
      },
    ]);
    expect(fake.calls.put).toEqual([{ sessionID: "sess-v2", key: "akm.system", value: "Be careful." }]);
    expect(fake.calls.prompt).toEqual([{ sessionID: "sess-v2", text: "p" }]);
    // The session is kept, and its subscription closed.
    expect(fake.calls.remove).toBe(0);
    expect(fake.feed.closed()).toBe(1);
  });

  test("a boolean tool map becomes allow and deny rules; no agent, directory or system is sent when absent", async () => {
    const fake = makeFakeV2();
    __setTestServer(fake.server as never);
    await runOpencodeSdk(profile, "p", {
      dispatch: { prompt: "p", tools: { bash: false, read: true } as never },
      timeoutMs: null,
    });
    expect(fake.calls.create).toEqual([
      {
        title: "akm",
        permissions: [
          { action: "bash", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
        ],
      },
    ]);
    expect(fake.calls.put).toEqual([]);
  });

  test("an engine's default agent (#1098) reaches the V2 session", async () => {
    const config = {
      configVersion: "0.9.0",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", agent: "akm-workflow" } },
      defaults: { engine: "sdk" },
    } as unknown as AkmConfig;
    const resolved = resolveExecution({ content: "Who are you?", config });
    const built = buildExecution(resolved.request, resolved.runner);
    expect(resolved.runner.kind).toBe("sdk");
    const sdkProfile = (resolved.runner as { profile: AgentProfile }).profile;
    // No opencodeVersion configured: the default major, V2.
    expect(sdkProfile.opencodeVersion).toBeUndefined();

    const fake = makeFakeV2();
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(sdkProfile, "Who are you?", { ...built.options, timeoutMs: null });

    expect(res.ok).toBe(true);
    expect(fake.calls.create[0]?.agent).toBe("akm-workflow");
  });

  test("the model-work dispatch selects its confined agent", async () => {
    const fake = makeFakeV2();
    __setTestServer(fake.server as never);
    await runOpencodeSdk(profile, "p", { dispatch: { prompt: "p", modelWork: true } as never, timeoutMs: null });
    expect(fake.calls.create[0]?.agent).toBe("akm-model-work");
  });

  test("a prompt that returns before the turn has started is waited on again", async () => {
    const fake = makeFakeV2({
      contexts: [[USER], [USER, assistant("msg-a", "late"), IDLE_OK]],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("late");
  });

  test("only the turn that follows our own message counts", async () => {
    const earlier = [
      { id: "old-user", type: "user", text: "old" },
      assistant("old-a", "stale answer"),
      { id: "old-idle", type: "idle", outcome: "failed" },
    ];
    const fake = makeFakeV2({ contexts: [[...earlier, USER, assistant("msg-a", "fresh"), IDLE_OK]] });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("fresh");
  });

  test("v2Turn is undefined until the closing idle message exists", () => {
    expect(v2Turn([USER as never, assistant("a", "x") as never], "msg-user")).toBeUndefined();
    expect(v2Turn([USER as never], "missing")).toBeUndefined();
  });
});

describe("OpenCode 2 adapter — failures", () => {
  test("a failed turn is ok:false with the assistant's structured error, and the session is kept", async () => {
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          assistant("msg-a", "", {
            content: [],
            finish: "error",
            error: { type: "provider.auth", message: "Provider request failed with HTTP 403", status: 403 },
          }),
          { id: "msg-idle", type: "idle", outcome: "failed" },
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("non_zero_exit");
    expect(res.error).toBe("provider.auth: Provider request failed with HTTP 403");
    expect(res.sessionId).toBe("sess-v2");
    expect(fake.calls.remove).toBe(0);
  });

  test("an interrupted turn is reason aborted", async () => {
    const fake = makeFakeV2({ contexts: [[USER, { id: "msg-idle", type: "idle", outcome: "interrupted" }]] });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("aborted");
    expect(res.exitCode).toBeNull();
  });

  test("a reply cut off at the output limit is reason parse_error", async () => {
    const fake = makeFakeV2({ contexts: [[USER, assistant("msg-a", "partial", { finish: "length" }), IDLE_OK]] });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("parse_error");
    expect(res.stdout).toBe("partial");
  });

  test("a prompt rejection is non_zero_exit and keeps the session", async () => {
    const fake = makeFakeV2({
      promptImpl: async () => {
        throw new Error("boom");
      },
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("non_zero_exit");
    expect(res.error).toBe("boom");
    expect(res.sessionId).toBe("sess-v2");
  });

  test("a deadline interrupts the session on the server and keeps it", async () => {
    const fake = makeFakeV2({ waitImpl: () => new Promise(() => {}) });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: 30 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("timeout");
    expect(fake.calls.interrupt).toEqual([{ sessionID: "sess-v2" }]);
    expect(fake.calls.remove).toBe(0);
  });

  test("a caller abort interrupts the session", async () => {
    const fake = makeFakeV2({ waitImpl: () => new Promise(() => {}) });
    __setTestServer(fake.server as never);
    const controller = new AbortController();
    const running = runOpencodeSdk(profile, "p", { timeoutMs: null, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const res = await running;
    expect(res.reason).toBe("aborted");
    expect(fake.calls.interrupt).toEqual([{ sessionID: "sess-v2" }]);
  });
});

describe("OpenCode 2 adapter — permission requests and retries", () => {
  const asked = (id: string, sessionID: string) => ({
    type: "permission.asked",
    data: { id, sessionID, action: "external_directory", resources: ["/etc/*"] },
  });

  test("rejects each permission request once, including a sub-session's, and ignores other sessions", async () => {
    const feed = eventFeed();
    const fake = makeFakeV2({
      feed,
      waitImpl: async () => {
        feed.push({ type: "session.created", data: { sessionID: "sub-1", parentID: "sess-v2" } });
        feed.push(asked("perm-1", "sess-v2"));
        feed.push(asked("perm-1", "sess-v2"));
        feed.push(asked("perm-2", "sub-1"));
        feed.push(asked("perm-3", "someone-else"));
        await new Promise((r) => setTimeout(r, 30));
      },
    });
    __setTestServer(fake.server as never);

    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });

    expect(res.ok).toBe(true);
    expect(fake.calls.reply).toEqual([
      { sessionID: "sess-v2", requestID: "perm-1", decision: "reject" },
      { sessionID: "sub-1", requestID: "perm-2", decision: "reject" },
    ]);
    expect(res.stderr).toContain("permission requested: external_directory (/etc/*); auto-rejecting");
    expect(fake.feed.closed()).toBe(1);
  });

  test("a failed subscription does not fail the dispatch and is recorded", async () => {
    const fake = makeFakeV2();
    (fake.server.client.event as { subscribe: unknown }).subscribe = () => {
      throw new Error("no stream");
    };
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(true);
    expect(res.stderr).toContain("permission requests will not be answered: event subscription failed: no stream");
  });

  const retry = (extra: Msg = {}) => ({
    type: "session.status",
    data: {
      sessionID: "sess-v2",
      status: { type: "retry", attempt: 2, message: "Rate limited", next: Date.now() + 1_000, ...extra },
    },
  });

  test("a retry is recorded and lets the run continue", async () => {
    const feed = eventFeed();
    const fake = makeFakeV2({
      feed,
      waitImpl: async () => {
        feed.push(retry());
        await new Promise((r) => setTimeout(r, 30));
      },
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(true);
    expect(res.stderr).toContain("OpenCode retry attempt 2: Rate limited; retrying at ");
  });

  test("a provider usage limit stops the run as llm_rate_limit and interrupts the session (#1108)", async () => {
    const feed = eventFeed();
    const fake = makeFakeV2({
      feed,
      waitImpl: async () => {
        feed.push(retry({ action: { reason: "account_rate_limit", provider: "openai" } }));
        await new Promise(() => {});
      },
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("llm_rate_limit");
    expect(res.error).toContain("OpenCode provider limit stopped this run (openai): Rate limited");
    expect(fake.calls.interrupt).toEqual([{ sessionID: "sess-v2" }]);
  });

  test("a retry due after the deadline stops the run", async () => {
    const feed = eventFeed();
    const fake = makeFakeV2({
      feed,
      waitImpl: async () => {
        feed.push(retry({ next: Date.now() + 60_000 }));
        await new Promise(() => {});
      },
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: 5_000 });
    expect(res.reason).toBe("llm_rate_limit");
    expect(res.error).toContain("is after this run's deadline");
  });
});

describe("OpenCode 2 adapter — server selection", () => {
  test("a v1 and a v2 engine never share a server entry", async () => {
    const majors: number[] = [];
    __setServerFactory((async (options: { adapter: { major: number } }) => {
      majors.push(options.adapter.major);
      return makeFakeV2().server;
    }) as never);
    await runOpencodeSdk({ ...profile, opencodeVersion: 2 }, "p", { timeoutMs: 2_000 });
    await runOpencodeSdk({ ...profile, opencodeVersion: 1 }, "p", { timeoutMs: 2_000 }).catch(() => {});
    // Same bin, env and config: only the major tells the two servers apart.
    expect(majors).toEqual([2, 1]);
  });

  test("V2 serves with --hostname/--port flags and chooses its own server password", () => {
    expect(V2_ADAPTER.serveArgv("oc", 4999)).toEqual(["oc", "serve", "--hostname", "127.0.0.1", "--port", "4999"]);
    const a = V2_ADAPTER.authorize();
    const b = V2_ADAPTER.authorize();
    expect(a.credentials).toBeTruthy();
    expect(a.credentials).not.toBe(b.credentials);
    expect(a.env.OPENCODE_SERVER_PASSWORD).toBe(a.credentials as string);
    expect(a.env.OPENCODE_PASSWORD).toBe(a.credentials as string);
    expect(V1_ADAPTER.authorize().env).toEqual({});
  });

  test("readiness lines: each adapter accepts its own and names opencodeVersion for the other major's", () => {
    expect(V2_ADAPTER.readiness("server listening on http://127.0.0.1:4999")).toEqual({ url: "http://127.0.0.1:4999" });
    expect(V1_ADAPTER.readiness("opencode server listening on http://127.0.0.1:4999")).toEqual({
      url: "http://127.0.0.1:4999",
    });
    expect(V2_ADAPTER.readiness("some log line")).toBeUndefined();

    const v1Binary = V2_ADAPTER.readiness("opencode server listening on http://127.0.0.1:4999");
    expect(v1Binary && "error" in v1Binary ? v1Binary.error : "").toContain('"opencodeVersion": 1');
    const v2Binary = V1_ADAPTER.readiness("server listening on http://127.0.0.1:4999");
    expect(v2Binary && "error" in v2Binary ? v2Binary.error : "").toContain("OpenCode 2");
    expect(v2Binary && "error" in v2Binary ? v2Binary.error : "").toContain("opencodeVersion");
  });

  test("decodeEvent ignores events the runner does not act on", () => {
    expect(V2_ADAPTER.decodeEvent({ type: "session.idle", data: { sessionID: "s" } })).toBeUndefined();
    expect(
      V2_ADAPTER.decodeEvent({ type: "session.status", data: { sessionID: "s", status: { type: "busy" } } }),
    ).toBeUndefined();
    expect(V2_ADAPTER.decodeEvent("nope")).toBeUndefined();
  });
});

describe("setup harness detection follows the selected OpenCode major", () => {
  test("opencode-sdk is detected for either major when its binary is on PATH", async () => {
    const which = (name: string) => (name === "opencode" ? "/usr/bin/opencode" : null);
    expect(await detectHarness(which as never)).toBe("opencode-sdk");
    expect(await detectHarness(which as never, 1)).toBe("opencode-sdk");
    expect(await detectHarness(which as never, 2)).toBe("opencode-sdk");
  });
});
