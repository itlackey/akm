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
import { __setTestServer, runOpencodeSdk } from "../src/integrations/harnesses/opencode-sdk/sdk-runner";

const baseProfile: AgentProfile = {
  name: "opencode-sdk",
  bin: "opencode",
  args: [],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
  sdkMode: true,
};

/** Records the body passed to session.prompt so the test can assert forwarding. */
interface PromptCapture {
  body?: {
    parts: { type: string; text: string }[];
    system?: string;
    tools?: Record<string, boolean>;
  };
}

/**
 * Build a fake SdkServer. `promptImpl` lets a test control resolution (e.g. a
 * never-resolving promise to drive the timeout path). The captured prompt body
 * is recorded into `capture`.
 */
function makeFakeServer(
  capture: PromptCapture,
  promptImpl?: () => Promise<{ data?: { parts?: { type: string; text?: string }[] } }>,
) {
  let deleted = false;
  return {
    deletedRef: () => deleted,
    server: {
      client: {
        session: {
          create: async () => ({ data: { id: "sess-1" } }),
          prompt: async (args: PromptCapture & { path: { id: string } }) => {
            capture.body = args.body;
            if (promptImpl) return promptImpl();
            return { data: { parts: [{ type: "text", text: "ok-response" }] } };
          },
          delete: async () => {
            deleted = true;
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
    const fakeSetTimeout = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
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
});
