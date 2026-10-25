/**
 * Contract tests for `callStructured` (X2): one model call on any runner kind.
 *
 * A fake chat stands in for the transport (no network), and the observable
 * wiring is pinned:
 *   - the reply text comes back as `{ ok: true, raw }`
 *   - a provider's failure (a thrown transport error, a timeout, an abort, a
 *     harness that exits non-zero) is a failed outcome carrying the dispatch's
 *     own result, the same for every caller; only a configuration failure throws
 *   - the call's settings (retry hook, token cap, thinking, timeout, schema,
 *     model, credentials) reach the transport as resolved
 */

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/core/errors";
import type { LoweringNotice } from "../../src/execution/resolved-request";
import type { ConnectionRunner, HarnessRunner } from "../../src/integrations/agent/runner";
import type { ChatMessage } from "../../src/llm/client";
import { LlmCallError } from "../../src/llm/client";
import { callStructured, resolveStructuredCurrent } from "../../src/llm/structured-call";
import { harnessCalls, writeFakeHarness } from "../_helpers/engine-stubs";
import { makeSandboxDir, mutateScopedEnv, withEnv } from "../_helpers/sandbox";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "usr" },
];

// A connection runner. `chatCompletion` is replaced by the injected fake, so transport fields are irrelevant.
function runner(extra: Partial<ConnectionRunner> = {}): ConnectionRunner {
  return {
    kind: "connection",
    name: "structured-test",
    endpoint: "http://x",
    model: "m",
    request: {},
    timeoutMs: 600_000,
    ...extra,
  };
}

function harness(platform: string, bin: string): HarnessRunner {
  return { kind: "harness", name: `structured-${platform}`, platform, bin, args: [], timeoutMs: 600_000 };
}

describe("callStructured contract", () => {
  test("(0) explicit null inference survives unless request inference intentionally overlays it", () => {
    expect(resolveStructuredCurrent({ inference: null }, undefined)).toEqual({ inference: null });
    expect(resolveStructuredCurrent({ inference: null }, { temperature: 0.25 })).toEqual({
      inference: { temperature: 0.25 },
    });
  });
  test("(1) the reply text comes back as the outcome", async () => {
    const outcome = await callStructured({
      runner: runner(),
      messages: MESSAGES,
      request: { chat: async () => '{"value":42}' },
    });
    expect(outcome).toEqual({ ok: true, raw: '{"value":42}' });
  });

  test("(2) a transport error is a failed outcome with its message and the dispatch's own result", async () => {
    for (const message of ["This model's maximum context length is 4096 tokens", "connection refused"]) {
      const outcome = await callStructured({
        runner: runner(),
        messages: MESSAGES,
        request: {
          chat: async () => {
            throw new Error(message);
          },
        },
      });
      expect(outcome).toMatchObject({ ok: false, reason: "error", error: message, result: { ok: false } });
    }
  });

  test("(3) a provider's own error code stays on the failed dispatch", async () => {
    const outcome = await callStructured({
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw new LlmCallError("provider returned HTML", "provider_html_error");
        },
      },
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: "error",
      error: "provider returned HTML",
      result: { llmErrorCode: "provider_html_error" },
    });
  });

  test("(4) a timeout and an abort are told apart from other failures", async () => {
    const timedOut = await callStructured({
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw new LlmCallError("Request timed out after 50ms", "timeout");
        },
      },
    });
    expect(timedOut).toMatchObject({ ok: false, reason: "timeout" });

    const aborted = await callStructured({
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw new LlmCallError("LLM request aborted", "aborted");
        },
      },
    });
    expect(aborted).toMatchObject({ ok: false, reason: "aborted" });
  });

  test("(5) a configuration failure throws instead of becoming an outcome", async () => {
    await expect(
      callStructured({ runner: harness("no-such-platform", "bin"), messages: MESSAGES }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("(7) onRetryAttempt is forwarded into the chat call options", async () => {
    let forwarded: (() => void) | undefined;
    const onRetryAttempt = () => {};
    await callStructured({
      runner: runner(),
      messages: MESSAGES,
      request: {
        onRetryAttempt,
        chat: async (_config, _messages, options) => {
          forwarded = options?.onRetryAttempt;
          return "ok";
        },
      },
    });
    expect(forwarded).toBe(onRetryAttempt);
  });

  test("(10) maxTokens and enableThinking reach the transport as exact resolved inference", async () => {
    let seenMaxTokens: number | undefined;
    let seenEnableThinking: boolean | undefined;
    await callStructured({
      runner: runner(),
      messages: MESSAGES,
      request: {
        maxTokens: 1234,
        enableThinking: false,
        chat: async (config) => {
          seenMaxTokens = config.inference?.maxTokens;
          seenEnableThinking = config.inference?.enableThinking;
          return "ok";
        },
      },
    });
    expect(seenMaxTokens).toBe(1234);
    expect(seenEnableThinking).toBe(false);
  });

  test("(11) timeoutMs key-presence is preserved: absent takes the runner's own, explicit undefined stays disabled", async () => {
    // Tri-state contract (see CallStructuredRequest doc): absent key = the
    // runner's own timeout; present-but-undefined = explicitly disabled.
    let absentCaseOptions: Record<string, unknown> | undefined;
    await callStructured({
      runner: runner({ timeoutMs: 123_000 }),
      messages: MESSAGES,
      request: {
        chat: async (_config, _messages, options) => {
          absentCaseOptions = options as Record<string, unknown> | undefined;
          return "ok";
        },
      },
    });
    expect(absentCaseOptions?.timeoutMs).toBe(123_000);

    let presentCaseOptions: Record<string, unknown> | undefined;
    await callStructured({
      runner: runner(),
      messages: MESSAGES,
      request: {
        timeoutMs: undefined,
        chat: async (_config, _messages, options) => {
          presentCaseOptions = options as Record<string, unknown> | undefined;
          return "ok";
        },
      },
    });
    expect(presentCaseOptions !== undefined && Object.hasOwn(presentCaseOptions, "timeoutMs")).toBe(true);
    // The canonical request normalizes present-but-undefined to explicit null;
    // both spellings retain the historical "disable timeout" semantics.
    expect(presentCaseOptions?.timeoutMs).toBeNull();
  });

  test("(11b) the request names a timeout only when the caller does; the runner brings its own", () => {
    expect(resolveStructuredCurrent(undefined, undefined)).toBeUndefined();
    expect(resolveStructuredCurrent(undefined, { timeoutMs: 5 })).toEqual({ timeout: 5 });
    expect(resolveStructuredCurrent(undefined, { timeoutMs: undefined })).toEqual({ timeout: null });
    expect(resolveStructuredCurrent({ timeout: 9 }, undefined)).toEqual({ timeout: 9 });
    expect(resolveStructuredCurrent({ timeout: 9 }, { timeoutMs: 5 })).toEqual({ timeout: 5 });
  });

  test("(12) a retired supportsJsonSchema setting is reported untranslated and the schema is still sent", async () => {
    const seenMessages: ChatMessage[][] = [];
    let seenOptions: Record<string, unknown> | undefined;
    let notices: readonly Readonly<LoweringNotice>[] = [];
    const outcome = await callStructured({
      runner: runner(),
      current: { inference: { supportsJsonSchema: false } },
      messages: MESSAGES,
      request: {
        responseSchema: { type: "object" },
        chat: async (_config, messages, options) => {
          seenMessages.push(messages.map((message) => ({ ...message })));
          seenOptions = options as Record<string, unknown> | undefined;
          return "ok";
        },
      },
      onNotices: (value) => {
        notices = value;
      },
    });

    expect(outcome).toEqual({ ok: true, raw: "ok" });
    expect(seenMessages).toEqual([MESSAGES]);
    expect(seenOptions?.responseSchema).toEqual({ type: "object" });
    expect(notices).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        adapter: "connection",
        field: "inference.supportsJsonSchema",
      }),
    ]);
  });

  test("(13) a structured call runs under the model-work tool policy", async () => {
    let chatRan = false;
    const value = await callStructured({
      runner: runner(),
      messages: [{ role: "user", content: "judge this" }],
      request: {
        chat: async () => {
          chatRan = true;
          return "answer";
        },
      },
    });
    expect({ value, chatRan }).toEqual({ value: { ok: true, raw: "answer" }, chatRan: true });

    // A harness that cannot confine the policy runs the call unrestricted, with one notice.
    const bins = makeSandboxDir("akm-structured-bin");
    try {
      const bin = writeFakeHarness(bins.dir, "gemini-stub", ["from gemini"]);
      let notices: readonly { code: string }[] = [];
      const ran = await callStructured({
        runner: harness("gemini", bin),
        messages: [{ role: "user", content: "judge this" }],
        onNotices: (value) => {
          notices = value;
        },
      });
      expect(harnessCalls(bin)).toHaveLength(1);
      expect(ran).toMatchObject({ ok: true, raw: expect.stringContaining("from gemini") });
      expect(notices.map((notice) => notice.code)).toContain("model-work-unrestricted");
    } finally {
      bins.cleanup();
    }
  });

  test("(13b) an agent dispatch gets the caller's environment, and its failure keeps the dispatch's own result", async () => {
    const bins = makeSandboxDir("akm-structured-bin");
    try {
      const bin = writeFakeHarness(bins.dir, "structured-claude", [""], { exitCode: 7, stderr: "boom" });

      const outcome = await callStructured({
        runner: harness("claude", bin),
        current: { environment: { AKM_EVENT_SOURCE: "improve" } },
        messages: [{ role: "user", content: "judge this" }],
      });

      const calls = harnessCalls(bin);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.env).toMatchObject({ AKM_EVENT_SOURCE: "improve" });
      // The outcome carries the dispatch's own result: the exit code and stderr a caller reports.
      expect(outcome).toMatchObject({
        ok: false,
        reason: "error",
        result: { ok: false, reason: "non_zero_exit", exitCode: 7, stderr: "boom" },
      });
    } finally {
      bins.cleanup();
    }
  });

  test("(14) a provider failure is credential-redacted in the outcome", async () => {
    const secret = "structured-secret-sentinel";
    const outcome = await withEnv({ AKM_STRUCTURED_SECRET: secret }, () =>
      callStructured({
        runner: runner({ apiKey: "$AKM_STRUCTURED_SECRET" }),
        messages: [{ role: "user", content: "redact failures" }],
        request: {
          chat: async () => {
            throw new LlmCallError(`provider echoed ${secret}`, "provider_error");
          },
        },
      }),
    );

    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(outcome.ok ? "" : outcome.error).toContain("[REDACTED]");
  });

  test("(15) a key variable that is unset sends the call without a key, and does not fail it", async () => {
    let apiKey: string | undefined = "unset";

    const value = await withEnv({ AKM_STRUCTURED_REQUIRED_SECRET: undefined }, () =>
      callStructured({
        runner: runner({ apiKey: "$AKM_STRUCTURED_REQUIRED_SECRET" }),
        messages: [{ role: "user", content: "no key is sent" }],
        request: {
          chat: async (connection) => {
            apiKey = connection.apiKey;
            return "answered";
          },
        },
      }),
    );

    expect(value).toEqual({ ok: true, raw: "answered" });
    expect(apiKey).toBeUndefined();
  });

  test("(16) one resolved runner serves different messages, models, inference, schemas, and timeouts", async () => {
    const secret = "structured-lease-original-092";
    const replacement = "structured-lease-replacement-092";
    const selectedRunner = runner({ apiKey: "$AKM_STRUCTURED_LEASE_KEY" });
    const observed: Array<{
      apiKey: string | undefined;
      model: string;
      temperature: number | undefined;
      message: string | undefined;
      timeoutMs: number | null | undefined;
      schemaType: unknown;
    }> = [];

    await withEnv({ AKM_STRUCTURED_LEASE_KEY: secret }, async () => {
      // Credentials are read at each dispatch, so a rotated key takes effect.
      mutateScopedEnv("AKM_STRUCTURED_LEASE_KEY", replacement);
      const dispatch = (model: string, message: string, temperature: number, timeoutMs: number) =>
        callStructured({
          runner: selectedRunner,
          current: { model },
          messages: [{ role: "user", content: message }],
          request: {
            temperature,
            timeoutMs,
            responseSchema: { type: "object", properties: { [message]: { type: "string" } } },
            chat: async (connection, messages, options) => {
              observed.push({
                apiKey: connection.apiKey,
                model: connection.model,
                temperature: connection.inference?.temperature,
                message: messages.at(-1)?.content,
                timeoutMs: options?.timeoutMs,
                schemaType: options?.responseSchema?.type,
              });
              return message;
            },
          },
        });

      expect(await dispatch("provider/model-a", "first", 0.1, 10)).toEqual({ ok: true, raw: "first" });
      expect(await dispatch("provider/model-b", "second", 0.9, 20)).toEqual({ ok: true, raw: "second" });
      expect(observed).toEqual([
        {
          apiKey: replacement,
          model: "provider/model-a",
          temperature: 0.1,
          message: "first",
          timeoutMs: 10,
          schemaType: "object",
        },
        {
          apiKey: replacement,
          model: "provider/model-b",
          temperature: 0.9,
          message: "second",
          timeoutMs: 20,
          schemaType: "object",
        },
      ]);
    });
  });
});
