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
