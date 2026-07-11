// Tests for the OpenCode SDK runner (`runOpencodeSdk`) — specifically the three
// #564 bug fixes that turned silently-dropped inputs and an unbounded await
// into correct, observable behaviour:
//
//   (1) AgentDispatchRequest.systemPrompt is forwarded to the SDK prompt call.
//   (2) AgentDispatchRequest.tools is forwarded (as the SDK's {name: bool} map).
//   (3) runOpencodeSdk() enforces a hard timeout like the CLI path (runAgent),
//       returning a structured `timeout` failure instead of hanging forever.
//
// These assert the CORRECTED behaviour: before #564 the runner built the prompt
// body as `{ parts: [...] }` with no `system`/`tools` and awaited
// `session.prompt()` with no timer, so a stalled SDK call blocked the caller.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import type { RunAgentOptions } from "../src/integrations/agent/spawn";
import {
  __setServerFactory,
  __setTestServer,
  closeServer,
  runOpencodeSdk,
} from "../src/integrations/harnesses/opencode-sdk/sdk-runner";

const baseProfile: AgentProfile = {
  name: "opencode-sdk",
  bin: "opencode",
  args: [],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
  sdkMode: true,
};

/** Records the body/query passed to the session calls so tests can assert forwarding. */
interface PromptCapture {
  body?: {
    parts: { type: string; text: string }[];
    system?: string;
    tools?: Record<string, boolean>;
  };
  /** `query.directory` seen by create / prompt / delete (R2 per-call cwd). */
  createQuery?: { directory?: string };
  promptQuery?: { directory?: string };
  deleteQuery?: { directory?: string };
}

/**
 * Build a fake SdkServer. `promptImpl` lets a test control resolution (e.g. a
 * never-resolving promise to drive the timeout path). The captured prompt body
 * is recorded into `capture`.
 */
function makeFakeServer(
  capture: PromptCapture,
  promptImpl?: () => Promise<{ data?: { parts?: { type: string; text?: string }[] } }>,
  overrides: {
    createImpl?: () => Promise<{ data?: { id?: string } }>;
    deleteImpl?: () => Promise<unknown>;
  } = {},
) {
  let deleted = false;
  let deleteCount = 0;
  return {
    deletedRef: () => deleted,
    deleteCountRef: () => deleteCount,
    server: {
      client: {
        session: {
          create: async (args?: { query?: { directory?: string } }) => {
            capture.createQuery = args?.query;
            if (overrides.createImpl) return overrides.createImpl();
            return { data: { id: "sess-1" } };
          },
          prompt: async (args: PromptCapture & { path: { id: string }; query?: { directory?: string } }) => {
            capture.body = args.body;
            capture.promptQuery = args.query;
            if (promptImpl) return promptImpl();
            return { data: { parts: [{ type: "text", text: "ok-response" }] } };
          },
          delete: async (args?: { query?: { directory?: string } }) => {
            deleted = true;
            deleteCount++;
            capture.deleteQuery = args?.query;
            if (overrides.deleteImpl) return overrides.deleteImpl();
            return {};
          },
        },
      },
      server: {
        close() {
          /* no-op stub */
        },
      },
    },
  };
}

afterEach(() => {
  __setTestServer(null);
});

describe("runOpencodeSdk — #564 bug fix (1): systemPrompt forwarding", () => {
  test("forwards dispatch.systemPrompt to the SDK prompt body", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);

    const res = await runOpencodeSdk(baseProfile, "do the thing", {
      dispatch: { prompt: "do the thing", systemPrompt: "You are a careful agent." },
      timeoutMs: null,
    });

    expect(res.ok).toBe(true);
    expect(capture.body?.system).toBe("You are a careful agent.");
    expect(capture.body?.parts).toEqual([{ type: "text", text: "do the thing" }]);
  });

  test("omits system when no systemPrompt is provided (behaviour-preserving)", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);

    const res = await runOpencodeSdk(baseProfile, "hi", { dispatch: { prompt: "hi" }, timeoutMs: null });

    expect(res.ok).toBe(true);
    expect(capture.body?.system).toBeUndefined();
  });
});

describe("runOpencodeSdk — #564 bug fix (2): tools forwarding", () => {
  test("forwards a tool list as a {name: true} allowlist map", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);

    const res = await runOpencodeSdk(baseProfile, "p", {
      dispatch: { prompt: "p", tools: ["read", "write"] },
      timeoutMs: null,
    });

    expect(res.ok).toBe(true);
    expect(capture.body?.tools).toEqual({ read: true, write: true });
  });

  test("forwards a comma-separated tool string as an allowlist map", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);

    await runOpencodeSdk(baseProfile, "p", {
      dispatch: { prompt: "p", tools: "read, write , bash" } as RunAgentOptions["dispatch"],
      timeoutMs: null,
    });

    expect(capture.body?.tools).toEqual({ read: true, write: true, bash: true });
  });

  test("omits tools when none are provided (behaviour-preserving)", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);

    await runOpencodeSdk(baseProfile, "p", { dispatch: { prompt: "p" }, timeoutMs: null });

    expect(capture.body?.tools).toBeUndefined();
  });
});

describe("runOpencodeSdk — #564 bug fix (3): timeout enforcement", () => {
  test("returns a structured `timeout` failure when the prompt call stalls", async () => {
    const capture: PromptCapture = {};
    // A prompt that never resolves — pre-#564 this would hang the caller forever.
    const fake = makeFakeServer(capture, () => new Promise(() => {}));
    __setTestServer(fake.server as never);

    // Deterministic timer: fire the timeout callback synchronously instead of
    // waiting on a wall clock, so the test never actually blocks.
    let timers = 0;
    const fakeSetTimeout = ((fn: () => void) => {
      timers++;
      // session.create is now timeout-protected too. Let its timer stay idle,
      // then fire the prompt timer deterministically.
      if (timers === 2) fn();
      return timers as unknown as ReturnType<typeof setTimeout>;
      // biome-ignore lint/suspicious/noExplicitAny: timer shim signature
    }) as any;
    // biome-ignore lint/suspicious/noExplicitAny: timer shim signature
    const fakeClearTimeout = (() => {}) as any;

    const res = await runOpencodeSdk(baseProfile, "p", {
      dispatch: { prompt: "p" },
      timeoutMs: 50,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("timeout");
    expect(res.error).toContain("timed out");
    // The stalled session is still cleaned up (delete called in finally).
    expect(fake.deletedRef()).toBe(true);
  });

  test("does not time out when the prompt resolves before the timer", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);

    // Real timer with a generous budget; prompt resolves immediately.
    const res = await runOpencodeSdk(baseProfile, "p", { dispatch: { prompt: "p" }, timeoutMs: 10_000 });

    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("ok-response");
    expect(res.reason).toBeUndefined();
  });
});

// ── buildSdkConfig — model alias resolution on the SDK path ──────────────────

describe("buildSdkConfig — model alias resolution", () => {
  const baseProfile: AgentProfile = {
    name: "opencode-sdk",
    bin: "",
    args: [],
    stdio: "captured",
    envPassthrough: [],
    parseOutput: "text",
    sdkMode: true,
  };

  test("profile.modelAliases resolves before the SDK config is built", async () => {
    const { buildSdkConfig } = await import("../src/integrations/harnesses/opencode-sdk/sdk-runner");
    const cfg = buildSdkConfig({
      ...baseProfile,
      model: "fast",
      modelAliases: { fast: "anthropic/claude-haiku-4-5" },
    });
    expect(cfg.model).toBe("anthropic/claude-haiku-4-5");
  });

  test("global tier table resolves via the opencode-sdk platform column, then '*'", async () => {
    const { buildSdkConfig } = await import("../src/integrations/harnesses/opencode-sdk/sdk-runner");
    const viaColumn = buildSdkConfig({
      ...baseProfile,
      model: "deep",
      globalModelAliases: { deep: { "opencode-sdk": "anthropic/claude-opus-4-7", "*": "wrong" } },
    });
    expect(viaColumn.model).toBe("anthropic/claude-opus-4-7");
    const viaStar = buildSdkConfig({
      ...baseProfile,
      model: "deep",
      globalModelAliases: { deep: { "*": "anthropic/claude-opus-4-7" } },
    });
    expect(viaStar.model).toBe("anthropic/claude-opus-4-7");
  });

  test("unaliased model passes through verbatim; unqualified model gets akm-custom prefix with endpoint", async () => {
    const { buildSdkConfig } = await import("../src/integrations/harnesses/opencode-sdk/sdk-runner");
    const plain = buildSdkConfig({ ...baseProfile, model: "anthropic/claude-sonnet-4-6" });
    expect(plain.model).toBe("anthropic/claude-sonnet-4-6");
    const prefixed = buildSdkConfig({ ...baseProfile, model: "my-local-model", endpoint: "http://localhost:1234/v1" });
    expect(prefixed.model).toBe("akm-custom/my-local-model");
  });

  test("alias resolving to an unqualified string still gets akm-custom prefix with endpoint", async () => {
    const { buildSdkConfig } = await import("../src/integrations/harnesses/opencode-sdk/sdk-runner");
    const cfg = buildSdkConfig({
      ...baseProfile,
      model: "fast",
      modelAliases: { fast: "qwen3-30b-a3b" },
      endpoint: "http://localhost:1234/v1",
    });
    expect(cfg.model).toBe("akm-custom/qwen3-30b-a3b");
  });
});

// ── P0.5 seams: usage + sessionId + cooperative abort ─────────────────────────

describe("runOpencodeSdk — usage/sessionId seams (P0.5)", () => {
  const profile: AgentProfile = {
    name: "opencode-sdk",
    bin: "",
    args: [],
    stdio: "captured",
    envPassthrough: [],
    parseOutput: "text",
    sdkMode: true,
  };

  test("token usage from the AssistantMessage is surfaced (previously discarded)", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture, async () => ({
      data: {
        info: { tokens: { input: 120, output: 45, reasoning: 7 } },
        parts: [{ type: "text", text: "answer" }],
      },
    }));
    __setTestServer(fake.server as never);
    const result = await runOpencodeSdk(profile, "hi", {});
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 45, reasoningTokens: 7 });
    expect(result.sessionId).toBe("sess-1");
  });

  test("missing token info yields no usage field, not a crash", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);
    const result = await runOpencodeSdk(profile, "hi", {});
    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
    expect(result.sessionId).toBe("sess-1");
  });

  test("abort mid-prompt returns reason 'aborted' and reaps the session", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture, () => new Promise(() => {})); // never resolves
    __setTestServer(fake.server as never);
    const controller = new AbortController();
    const promise = runOpencodeSdk(profile, "hi", { timeoutMs: null, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("aborted");
    expect(fake.deletedRef()).toBe(true);
  });

  test("pre-aborted signal short-circuits before any session is created", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);
    const controller = new AbortController();
    controller.abort();
    const result = await runOpencodeSdk(profile, "hi", { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("aborted");
    expect(capture.body).toBeUndefined();
  });

  test("session.create rejection returns structured spawn_failed", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture, undefined, {
      createImpl: async () => {
        throw new Error("create exploded");
      },
    });
    __setTestServer(fake.server as never);

    const result = await runOpencodeSdk(profile, "hi", { timeoutMs: null });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn_failed");
    expect(result.error).toContain("create exploded");
    expect(capture.body).toBeUndefined();
    expect(fake.deletedRef()).toBe(false);
  });

  test("session.create timeout returns structured timeout", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture, undefined, {
      createImpl: () => new Promise(() => {}),
    });
    __setTestServer(fake.server as never);
    const fakeSetTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
      // biome-ignore lint/suspicious/noExplicitAny: timer shim signature
    }) as any;
    // biome-ignore lint/suspicious/noExplicitAny: timer shim signature
    const fakeClearTimeout = (() => {}) as any;

    const result = await runOpencodeSdk(profile, "hi", {
      timeoutMs: 50,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.error).toContain("creating a session");
    expect(capture.body).toBeUndefined();
  });

  test("a session that is created after timeout is deleted when it arrives", async () => {
    const capture: PromptCapture = {};
    let resolveCreate!: (value: { data: { id: string } }) => void;
    const fake = makeFakeServer(capture, undefined, {
      createImpl: () => new Promise((resolve) => (resolveCreate = resolve)),
    });
    __setTestServer(fake.server as never);
    const immediateTimer = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
      // biome-ignore lint/suspicious/noExplicitAny: timer shim signature
    }) as any;

    const result = await runOpencodeSdk(profile, "hi", {
      timeoutMs: 50,
      setTimeoutFn: immediateTimer,
      clearTimeoutFn: (() => {}) as never,
    });
    expect(result.reason).toBe("timeout");

    resolveCreate({ data: { id: "late-session" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.deleteCountRef()).toBe(1);
  });

  test("prompt rejection returns non_zero_exit and still deletes the session", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture, async () => {
      throw new Error("prompt exploded");
    });
    __setTestServer(fake.server as never);

    const result = await runOpencodeSdk(profile, "hi", { timeoutMs: null });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("non_zero_exit");
    expect(result.error).toContain("prompt exploded");
    expect(fake.deletedRef()).toBe(true);
  });

  test("hung session.delete is bounded and reported without masking success", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture, undefined, {
      deleteImpl: () => new Promise(() => {}),
    });
    __setTestServer(fake.server as never);
    const fakeSetTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
      // biome-ignore lint/suspicious/noExplicitAny: timer shim signature
    }) as any;
    // biome-ignore lint/suspicious/noExplicitAny: timer shim signature
    const fakeClearTimeout = (() => {}) as any;

    const result = await runOpencodeSdk(profile, "hi", {
      timeoutMs: null,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("ok-response");
    expect(fake.deletedRef()).toBe(true);
    expect(result.stderr).toContain("OpenCode session cleanup timed out");
  });

  test("a prompt that settles after timeout triggers a second session cleanup", async () => {
    const capture: PromptCapture = {};
    let resolvePrompt!: (value: { data: { parts: { type: string; text: string }[] } }) => void;
    const fake = makeFakeServer(capture, () => new Promise((resolve) => (resolvePrompt = resolve)));
    __setTestServer(fake.server as never);
    let timers = 0;
    const promptTimer = ((fn: () => void) => {
      timers++;
      if (timers === 2) fn();
      return timers as unknown as ReturnType<typeof setTimeout>;
      // biome-ignore lint/suspicious/noExplicitAny: timer shim signature
    }) as any;

    const result = await runOpencodeSdk(profile, "p", {
      timeoutMs: 50,
      setTimeoutFn: promptTimer,
      clearTimeoutFn: (() => {}) as never,
    });
    expect(result.reason).toBe("timeout");
    expect(fake.deleteCountRef()).toBe(1);

    resolvePrompt({ data: { parts: [{ type: "text", text: "late" }] } });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.deleteCountRef()).toBe(2);
  });
});

// ── R2 seams: per-call cwd + env-keyed server registry ───────────────────────
//
// Redesign addendum R2 (open seam decision 1, resolved in the sdk-runner
// module doc): cwd is PER-CALL (`query.directory` on every session call);
// env is PER-SERVER (registry keyed by the binding signature, bindings
// overlaid onto process.env only for the synchronous prefix of the
// createOpencode call — the window where the SDK snapshots the child env).

describe("runOpencodeSdk — per-call cwd (R2 worktree isolation seam)", () => {
  test("opts.cwd is forwarded as query.directory on create, prompt, AND delete", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);

    const res = await runOpencodeSdk(baseProfile, "p", { cwd: "/tmp/akm-worktrees/run-1/unit-a", timeoutMs: null });

    expect(res.ok).toBe(true);
    expect(capture.createQuery).toEqual({ directory: "/tmp/akm-worktrees/run-1/unit-a" });
    expect(capture.promptQuery).toEqual({ directory: "/tmp/akm-worktrees/run-1/unit-a" });
    expect(capture.deleteQuery).toEqual({ directory: "/tmp/akm-worktrees/run-1/unit-a" });
  });

  test("no cwd ⇒ no query at all (behaviour-preserving for non-isolated units)", async () => {
    const capture: PromptCapture = {};
    const fake = makeFakeServer(capture);
    __setTestServer(fake.server as never);

    await runOpencodeSdk(baseProfile, "p", { timeoutMs: null });

    expect(capture.createQuery).toBeUndefined();
    expect(capture.promptQuery).toBeUndefined();
    expect(capture.deleteQuery).toBeUndefined();
  });
});

describe("runOpencodeSdk — env-keyed server registry (R2 env bindings on the sdk runner)", () => {
  afterEach(() => {
    __setServerFactory(null);
    closeServer();
  });

  const ENV_KEY = "OPENCODE_SDK_TEST_INJECTED";

  interface FactoryCall {
    /** process.env[ENV_KEY] snapshotted in the factory's SYNCHRONOUS prefix. */
    injectedValue: string | undefined;
  }

  /**
   * Fake `createOpencode`. Snapshots the injected env var SYNCHRONOUSLY —
   * exactly where the real SDK's `spawn` reads `process.env` — so the test
   * proves injection reaches the child-spawn window and nothing later.
   */
  function makeFactory(calls: FactoryCall[], capture: PromptCapture) {
    return (_options: { config?: Record<string, unknown> }) => {
      // Synchronous prefix: the real createOpencodeServer spawns here.
      calls.push({ injectedValue: process.env[ENV_KEY] });
      return Promise.resolve(makeFakeServer(capture).server as never) as never;
    };
  }

  test("env bindings are visible to the server spawn and restored immediately after (round trip)", async () => {
    const calls: FactoryCall[] = [];
    const capture: PromptCapture = {};
    __setServerFactory(makeFactory(calls, capture) as never);

    expect(process.env[ENV_KEY]).toBeUndefined();
    const res = await runOpencodeSdk(baseProfile, "p", { env: { [ENV_KEY]: "reached-the-child" }, timeoutMs: null });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // The injection was live exactly when the SDK snapshots the child env…
    expect(calls[0].injectedValue).toBe("reached-the-child");
    // …and the overlay never leaked out of the synchronous window.
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  test("same bindings reuse one server; different bindings (and no bindings) get their own", async () => {
    const calls: FactoryCall[] = [];
    const capture: PromptCapture = {};
    __setServerFactory(makeFactory(calls, capture) as never);

    await runOpencodeSdk(baseProfile, "p", { env: { [ENV_KEY]: "v1" }, timeoutMs: null });
    await runOpencodeSdk(baseProfile, "p", { env: { [ENV_KEY]: "v1" }, timeoutMs: null });
    expect(calls).toHaveLength(1); // same signature → server reused

    await runOpencodeSdk(baseProfile, "p", { env: { [ENV_KEY]: "v2" }, timeoutMs: null });
    expect(calls).toHaveLength(2); // same key, different VALUE → new server
    expect(calls[1].injectedValue).toBe("v2");

    await runOpencodeSdk(baseProfile, "p", { timeoutMs: null });
    expect(calls).toHaveLength(3); // no bindings → the default server, started separately
    expect(calls[2].injectedValue).toBeUndefined();
  });

  test("concurrent callers with the same bindings share one server start", async () => {
    const calls: FactoryCall[] = [];
    const capture: PromptCapture = {};
    __setServerFactory(makeFactory(calls, capture) as never);

    const [a, b] = await Promise.all([
      runOpencodeSdk(baseProfile, "p1", { env: { [ENV_KEY]: "shared" }, timeoutMs: null }),
      runOpencodeSdk(baseProfile, "p2", { env: { [ENV_KEY]: "shared" }, timeoutMs: null }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  // Peer-review regression: closeServer() is wired to `process.once('exit')`,
  // and Bun does NOT drain microtasks scheduled inside 'exit' handlers — a
  // `.then()`-based close never ran there, orphaning every `opencode serve`
  // child (leaked process + port still bound for the next invocation).
  test("closeServer closes started servers SYNCHRONOUSLY (exit-hook safety, no microtask)", async () => {
    let closed = 0;
    const capture: PromptCapture = {};
    __setServerFactory(((_options: { config?: Record<string, unknown> }) => {
      const fake = makeFakeServer(capture).server as { client: unknown; server: { close(): void } };
      return Promise.resolve({
        client: fake.client,
        server: {
          close() {
            closed++;
          },
        },
      });
    }) as never);

    await runOpencodeSdk(baseProfile, "p", { timeoutMs: null }); // default server
    await runOpencodeSdk(baseProfile, "p", { env: { [ENV_KEY]: "v" }, timeoutMs: null }); // env-keyed server

    closeServer();
    // No await between closeServer() and this assertion: both servers must
    // already be closed when the call returns, exactly as the 'exit' hook
    // requires.
    expect(closed).toBe(2);
  });

  // Peer-review regression: createOpencodeServer defaults to a FIXED port
  // (4096), so coexisting registry entries (default + env-keyed — e.g. an
  // improve run's AKM_EVENT_SOURCE binding alongside env-free sdk calls)
  // contended for the same bind and the second start failed spawn_failed.
  test("every registry server gets its own free port", async () => {
    const ports: (number | undefined)[] = [];
    const capture: PromptCapture = {};
    __setServerFactory(((options: { port?: number }) => {
      ports.push(options.port);
      return Promise.resolve(makeFakeServer(capture).server as never);
    }) as never);

    await runOpencodeSdk(baseProfile, "p", { timeoutMs: null }); // default key
    await runOpencodeSdk(baseProfile, "p", { env: { [ENV_KEY]: "a" }, timeoutMs: null });
    await runOpencodeSdk(baseProfile, "p", { env: { [ENV_KEY]: "b" }, timeoutMs: null });

    // Every entry uses an OS-assigned port, never the SDK default and never a
    // port already reserved by another entry in this process.
    expect(typeof ports[0]).toBe("number");
    expect(typeof ports[1]).toBe("number");
    expect(typeof ports[2]).toBe("number");
    expect(ports[0]).not.toBe(4096);
    expect(ports[1]).not.toBe(4096);
    expect(ports[2]).not.toBe(4096);
    expect(ports[0]).not.toBe(ports[1]);
    expect(ports[0]).not.toBe(ports[2]);
    expect(ports[1]).not.toBe(ports[2]);
  });

  test("registry identity includes endpoint, materialized key, bin, provider config, and env", async () => {
    const calls: Array<{ bin?: string; port?: number }> = [];
    __setServerFactory(((options: { bin?: string; port?: number }) => {
      calls.push(options);
      return Promise.resolve(makeFakeServer({}).server as never);
    }) as never);
    const env = { [ENV_KEY]: "same-env" };
    const baseConnection = {
      endpoint: "https://one.test/v1/chat/completions",
      model: "model-a",
      provider: "provider-a",
      apiKey: "materialized-key-a",
    };

    await runOpencodeSdk(baseProfile, "p", { env, timeoutMs: null }, baseConnection);
    await runOpencodeSdk(baseProfile, "p", { env, timeoutMs: null }, baseConnection);
    await runOpencodeSdk(
      baseProfile,
      "p",
      { env, timeoutMs: null },
      { ...baseConnection, apiKey: "materialized-key-b" },
    );
    await runOpencodeSdk(
      baseProfile,
      "p",
      { env, timeoutMs: null },
      {
        ...baseConnection,
        endpoint: "https://two.test/v1/chat/completions",
      },
    );
    await runOpencodeSdk({ ...baseProfile, bin: "other-opencode" }, "p", { env, timeoutMs: null }, baseConnection);
    await runOpencodeSdk(baseProfile, "p", { env: { [ENV_KEY]: "other-env" }, timeoutMs: null }, baseConnection);
    await runOpencodeSdk(baseProfile, "p", { env, timeoutMs: null }, { ...baseConnection, provider: "provider-b" });
    await runOpencodeSdk({ ...baseProfile, model: "model-b" }, "p", { env, timeoutMs: null }, baseConnection);

    expect(calls).toHaveLength(7);
    expect(calls.map((call) => call.bin)).toContain("other-opencode");
    expect(new Set(calls.map((call) => call.port)).size).toBe(7);
  });
});
