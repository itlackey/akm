// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode 2 adapter (`v2-adapter.ts`) driven through `runOpencodeSdk`
 * with a fake `@opencode/client`, mirroring the V1 fakes in
 * `opencode-sdk-runner.test.ts`. A binary that reports 2.x (a fake `--version` here)
 * selects V2. The real 2.0.26 binary is exercised by
 * `tests/integration/opencode-sdk-real-binary.test.ts` (gated).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { V2_ADAPTER, v2InterruptedTurn, v2Turn } from "../src/integrations/harnesses/opencode-sdk/v2-adapter";
import { parseReadiness } from "../src/integrations/harnesses/opencode-sdk/wire";

const parseReadiness1 = (line: string) => parseReadiness(line, 1);
const parseReadiness2 = (line: string) => parseReadiness(line, 2);

import { fakeOpencodeMajor } from "./_helpers/opencode-version";

beforeEach(() => fakeOpencodeMajor(2));

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
/** The feedback `opencode run` sends with a rejection, so the model continues without the action. */
const REJECTED =
  "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.";
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
  /** The session's message timeline, oldest first, on each read (the last entry repeats). */
  contexts?: Msg[][];
  /** Page size `message.list` serves (default: the requested limit). */
  pageSize?: number;
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
    cancel: [] as { input: Msg; options?: unknown }[],
    list: [] as Msg[],
    remove: 0,
  };
  const feed = opts.feed ?? eventFeed();
  const contexts = opts.contexts ?? [[USER, assistant("msg-a", "ok-response"), IDLE_OK]];
  let contextCall = 0;
  let timeline: Msg[] = [];
  const client = {
    // `session.message.list`, newest first, paged by an opaque cursor.
    message: {
      list: async (input: { limit?: number; cursor?: string }) => {
        calls.list.push(input);
        if (input.cursor === undefined) timeline = contexts[Math.min(contextCall++, contexts.length - 1)] ?? [];
        const newest = [...timeline].reverse();
        const start = input.cursor === undefined ? 0 : Number(input.cursor);
        const end = start + (opts.pageSize ?? input.limit ?? 200);
        return { data: newest.slice(start, end), cursor: end < newest.length ? { next: String(end) } : {} };
      },
    },
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
      // Only the messages after the last compaction: akm must not read the turn from here.
      context: async () => {
        throw new Error("session.context read");
      },
      form: {
        cancel: async (input: Msg, options?: unknown) => {
          calls.cancel.push({ input, ...(options ? { options } : {}) });
        },
      },
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
  test("a binary reporting OpenCode 2 runs on V2: session scoped by location, prompt carries the text", async () => {
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
        // A list is an allowlist: every other tool is denied first, and the last matching rule wins.
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
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
      dispatch: { prompt: "p", tools: { shell: false, read: true } as never },
      timeoutMs: null,
    });
    expect(fake.calls.create).toEqual([
      {
        title: "akm",
        permissions: [
          { action: "shell", resource: "*", effect: "deny" },
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

  test("a turn OpenCode 2 interrupts after a rejected permission ends the dispatch promptly (no closing idle message)", async () => {
    // Recorded from 2.0.26: after `permission.reply: reject` the step fails with `aborted: Step interrupted`, the
    // tool call is `error` ("The user declined this tool call"), the session goes idle and NO `idle` message is
    // written, so the turn never "finished" for the poll loop and the dispatch ran to its deadline.
    const feed = eventFeed();
    const fake = makeFakeV2({
      feed,
      waitImpl: async () => {
        feed.push({
          type: "permission.asked",
          data: { id: "perm-1", sessionID: "sess-v2", action: "shell", resources: ["date"] },
        });
        await new Promise((r) => setTimeout(r, 30));
      },
      contexts: [
        [
          USER,
          assistant("msg-a", "", {
            content: [
              {
                type: "tool",
                state: {
                  status: "error",
                  input: { command: "date" },
                  error: { type: "aborted", message: "The user declined this tool call" },
                },
              },
            ],
            finish: "error",
            error: { type: "aborted", message: "Step interrupted" },
          }),
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: 3000 });
    expect(res.reason).toBe("aborted");
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBeNull();
    expect(res.durationMs).toBeLessThan(2000);
    expect(res.error).toContain("Step interrupted");
    expect(res.error).toContain("The user declined this tool call");
    expect(res.stderr).toContain("permission requested: shell (date); auto-rejecting");
    expect(fake.calls.reply).toEqual([
      { sessionID: "sess-v2", requestID: "perm-1", decision: "reject", message: REJECTED },
    ]);
    expect(res.sessionId).toBe("sess-v2");
  });

  test("an assistant step that is still running is not mistaken for an interrupted turn", () => {
    expect(
      v2InterruptedTurn([USER as never, assistant("a", "x", { finish: "tool-calls" }) as never], "msg-user"),
    ).toBeUndefined();
    expect(
      v2InterruptedTurn(
        [
          USER as never,
          assistant("a", "x", { finish: "error", error: { type: "provider.auth", message: "m" } }) as never,
        ],
        "msg-user",
      ),
    ).toBeUndefined();
    expect(v2InterruptedTurn([USER as never], "missing")).toBeUndefined();
  });

  test("a reply cut off at the output limit is reason parse_error", async () => {
    const fake = makeFakeV2({ contexts: [[USER, assistant("msg-a", "partial", { finish: "length" }), IDLE_OK]] });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("parse_error");
    expect(res.stdout).toBe("partial");
  });

  test("a turn with a compaction inside it is still found and answered", async () => {
    // `session.context` would hold only what follows the compaction, without our user message.
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          assistant("msg-a", "", { content: [], finish: "tool-calls" }),
          { id: "msg-c", type: "compaction", status: "completed", auto: true },
          assistant("msg-b", "final"),
          IDLE_OK,
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("final");
  });

  test("the turn is found across pages of a long history, newest first", async () => {
    const older = Array.from({ length: 5 }, (_, i) => ({ id: `msg-old-${i}`, type: "user", text: "earlier" }));
    const fake = makeFakeV2({
      pageSize: 2,
      contexts: [[...older, USER, assistant("msg-a", "late answer"), IDLE_OK]],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.stdout).toBe("late answer");
    expect(fake.calls.list[0]).toMatchObject({ sessionID: "sess-v2", order: "desc" });
    // Paging stops at our user message: the older history is never read.
    expect(fake.calls.list).toHaveLength(2);
  });

  test("the idle message's error is the turn's failure, not an earlier step's recovered one", async () => {
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          assistant("msg-a", "a", {
            finish: "error",
            error: { type: "provider.transport", message: "Connection lost" },
          }),
          assistant("msg-b", "b", { finish: "length" }),
          {
            id: "msg-idle",
            type: "idle",
            outcome: "failed",
            error: { type: "output-limit", message: "Response still truncated" },
          },
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.reason).toBe("parse_error");
    expect(res.error).toContain("cut off at the output limit");
  });

  test("a reply whose stream broke and that OpenCode continued keeps the text from before the break", async () => {
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          assistant("msg-a", "HEAD-", {
            finish: "error",
            error: { type: "provider.transport", message: "Connection lost" },
          }),
          {
            id: "msg-syn",
            type: "synthetic",
            text: "Continue from where you left off without repeating completed content.",
          },
          assistant("msg-b", "TAIL", { finish: "stop" }),
          IDLE_OK,
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("HEAD-TAIL");
  });

  test("a provider content filter fails the turn as llm_content_filter", async () => {
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          {
            id: "msg-idle",
            type: "idle",
            outcome: "failed",
            error: { type: "provider.content-filter", message: "blocked" },
          },
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.reason).toBe("llm_content_filter");
  });

  test("a reply OpenCode continues after the output limit is the cut-off text plus its continuation", async () => {
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          assistant("msg-a", "Let me look.", { finish: "tool-calls" }),
          assistant("msg-b", "Hello wo", { finish: "length" }),
          { id: "msg-syn", type: "synthetic", text: "Your last response hit the output token limit" },
          assistant("msg-c", "rld", { finish: "stop" }),
          IDLE_OK,
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("Hello world");
  });

  test("a reply still cut off after OpenCode's continuations is parse_error, from the idle message's error", async () => {
    const cut = { finish: "length" };
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          assistant("msg-a", "a", cut),
          assistant("msg-b", "b", cut),
          assistant("msg-c", "c", cut),
          {
            id: "msg-idle",
            type: "idle",
            outcome: "failed",
            error: {
              type: "output-limit",
              message: "Response still truncated after two output token limit continuations",
            },
          },
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("parse_error");
    expect(res.error).toContain("cut off at the output limit");
    expect(res.stdout).toBe("abc");
  });

  test("a failed turn whose only error is on the idle message reports that error", async () => {
    const fake = makeFakeV2({
      contexts: [
        [
          USER,
          { id: "msg-idle", type: "idle", outcome: "failed", error: { type: "provider.free-limit", message: "limit" } },
        ],
      ],
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.reason).toBe("llm_rate_limit");
    expect(res.error).toBe("provider.free-limit: limit");
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
      { sessionID: "sess-v2", requestID: "perm-1", decision: "reject", message: REJECTED },
      { sessionID: "sub-1", requestID: "perm-2", decision: "reject", message: REJECTED },
    ]);
    expect(res.stderr).toContain("permission requested: external_directory (/etc/*); auto-rejecting");
    expect(fake.feed.closed()).toBe(1);
  });

  test("cancels the question tool's form with a message, and an unowned form in the dispatch's directory; other sessions' forms are left alone", async () => {
    const feed = eventFeed();
    const form = (id: string, sessionID: string, kind: string, directory = "/work/tree") => ({
      type: "form.created",
      location: { directory },
      data: { form: { id, sessionID, metadata: { kind } } },
    });
    const fake = makeFakeV2({
      feed,
      waitImpl: async () => {
        feed.push(form("form-q", "sess-v2", "question"));
        feed.push(form("form-mcp", "global", "mcp-elicitation"));
        feed.push(form("form-elsewhere", "global", "mcp-elicitation", "/other/dir"));
        feed.push(form("form-other", "someone-else", "question"));
        await new Promise((r) => setTimeout(r, 30));
      },
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { cwd: "/work/tree", timeoutMs: null });
    expect(res.ok).toBe(true);
    expect(fake.calls.cancel).toEqual([
      {
        input: {
          sessionID: "sess-v2",
          formID: "form-q",
          message:
            "This non-interactive run cannot ask the user questions, so the question was cancelled. Continue without an answer; make reasonable assumptions and state them.",
        },
      },
      {
        input: { sessionID: "global", formID: "form-mcp" },
        options: { headers: { "x-opencode-directory": encodeURIComponent("/work/tree") } },
      },
    ]);
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

  // The event both OpenCode 2.0 and 2.1 servers publish for a retry; neither publishes `session.status`.
  const retry = (data: Msg = {}, error: Msg = {}) => ({
    type: "session.retry.scheduled",
    data: {
      sessionID: "sess-v2",
      assistantMessageID: "msg-a",
      attempt: 2,
      at: Date.now() + 1_000,
      error: { type: "provider.rate-limit", message: "Rate limited", ...error },
      ...data,
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
        feed.push(retry({}, { type: "provider.quota" }));
        await new Promise(() => {});
      },
    });
    __setTestServer(fake.server as never);
    const res = await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("llm_rate_limit");
    expect(res.error).toContain("OpenCode provider limit stopped this run: Rate limited");
    expect(fake.calls.interrupt).toEqual([{ sessionID: "sess-v2" }]);
  });

  test("a retry due after the deadline stops the run", async () => {
    const feed = eventFeed();
    const fake = makeFakeV2({
      feed,
      waitImpl: async () => {
        feed.push(retry({ at: Date.now() + 60_000 }));
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
    fakeOpencodeMajor(2);
    await runOpencodeSdk(profile, "p", { timeoutMs: 2_000 });
    fakeOpencodeMajor(1);
    await runOpencodeSdk(profile, "p", { timeoutMs: 2_000 }).catch(() => {});
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

  test("readiness lines: each adapter accepts its own and names the remedy for the other major's", () => {
    expect(parseReadiness2("server listening on http://127.0.0.1:4999")).toEqual({ url: "http://127.0.0.1:4999" });
    expect(parseReadiness1("opencode server listening on http://127.0.0.1:4999")).toEqual({
      url: "http://127.0.0.1:4999",
    });
    expect(parseReadiness2("some log line")).toBeUndefined();

    const v1Binary = parseReadiness2("opencode server listening on http://127.0.0.1:4999");
    expect(v1Binary && "error" in v1Binary ? v1Binary.error : "").toContain("OpenCode 1");
    expect(v1Binary && "error" in v1Binary ? v1Binary.error : "").toContain(
      'Upgrade to OpenCode 2, or set this engine\'s "bin"',
    );
    const v2Binary = parseReadiness1("server listening on http://127.0.0.1:4999");
    expect(v2Binary && "error" in v2Binary ? v2Binary.error : "").toContain("OpenCode 2");
    expect(v2Binary && "error" in v2Binary ? v2Binary.error : "").toContain('set this engine\'s "bin"');
  });

  test("decodeEvent ignores events the runner does not act on", () => {
    expect(V2_ADAPTER.decodeEvent({ type: "session.idle", data: { sessionID: "s" } })).toBeUndefined();
    expect(
      V2_ADAPTER.decodeEvent({
        type: "session.status",
        data: { sessionID: "s", status: { type: "retry", attempt: 1 } },
      }),
    ).toBeUndefined();
    expect(V2_ADAPTER.decodeEvent("nope")).toBeUndefined();
  });
});
