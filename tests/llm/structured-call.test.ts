/**
 * Contract tests for the `callStructured<T>()` seam (X2).
 *
 * `callStructured` centralizes the replicated
 *   `tryLlmFeature -> chatCompletion -> classify(context/html/other) ->
 *    parse/validate -> fallback/telemetry`
 * scaffold used by memory-infer.
 *
 * These tests pin the seam CONTRACT by injecting a fake chat (so no real
 * network call happens) and asserting the observable wiring:
 *   1. gated success    -> `parse` runs on the raw string, return value flows out
 *   2. gated bad/empty  -> `parse` returns the caller's fallback itself
 *   3. gated throw w/ context-size message -> onError("context_limit", err)
 *   4. gated throw LlmCallError("provider_html_error") -> onError("html", err)
 *   5. gated throw generic                  -> onError("other", err)
 *   6. UNGATED (akmConfig === undefined) throw -> error PROPAGATES (rejects)
 *   7. `onRetryAttempt` is forwarded into the chat call options
 *
 * Verifies the callStructured seam's observable wiring (gated success/failure,
 * context-size + html error handling, ungated propagation, retry forwarding).
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import type { SpawnedSubprocess } from "../../src/core/subprocess";
import type { LoweringNotice } from "../../src/execution/resolved-request";
import type { ConnectionRunner, HarnessRunner } from "../../src/integrations/agent/runner";
import type { ChatMessage } from "../../src/llm/client";
import { LlmCallError } from "../../src/llm/client";
import {
  callStructured,
  dispatchFailureResult,
  type LlmErrorClass,
  resolveStructuredCurrent,
} from "../../src/llm/structured-call";
import { mutateScopedEnv, withEnv } from "../_helpers/sandbox";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "usr" },
];

// A config object whose mere existence enables the `memory_inference` gate
// (FEATURE_LOCATION default is `?? true`). Used as the GATED akmConfig.
const GATED: AkmConfig = {} as AkmConfig;

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
  test("(1) gated success -> parse runs on raw, returns T", async () => {
    let parsedRaw: string | undefined = "UNSET";
    const result = await callStructured<{ ok: boolean; raw?: string }>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: { chat: async () => '{"value":42}' },
      parse: (raw) => {
        parsedRaw = raw;
        return { ok: true, raw };
      },
      onError: () => ({ ok: false }),
      fallback: { ok: false },
    });
    expect(parsedRaw).toBe('{"value":42}');
    expect(result).toEqual({ ok: true, raw: '{"value":42}' });
  });

  test("(2) gated empty/bad raw -> parse returns the caller fallback itself", async () => {
    const FALLBACK = { ok: false as const };
    const result = await callStructured<{ ok: boolean }>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      // Fake chat yields an empty string; `parse` owns the `!raw` decision and
      // returns the fallback.
      request: { chat: async () => "" },
      parse: (raw) => (raw ? { ok: true } : FALLBACK),
      onError: () => ({ ok: true }), // must NOT be called on a parse-fallback
      fallback: FALLBACK,
    });
    expect(result).toBe(FALLBACK);
  });

  test("(3) gated throw w/ context-size message -> onError('context_limit')", async () => {
    let seen: LlmErrorClass | undefined;
    let seenErr: unknown;
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw new Error("This model's maximum context length is 4096 tokens");
        },
      },
      parse: () => "PARSED",
      onError: (cls, err) => {
        seen = cls;
        seenErr = err;
        return "CTX";
      },
      fallback: "FB",
    });
    expect(seen).toBe("context_limit");
    expect(seenErr).toBeInstanceOf(Error);
    expect(result).toBe("CTX");
  });

  test("(4) gated throw LlmCallError(provider_html_error) -> onError('html')", async () => {
    let seen: LlmErrorClass | undefined;
    const htmlErr = new LlmCallError("provider returned HTML", "provider_html_error");
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw htmlErr;
        },
      },
      parse: () => "PARSED",
      onError: (cls, err) => {
        seen = cls;
        expect(err).toBeInstanceOf(LlmCallError);
        expect((err as LlmCallError).code).toBe("provider_html_error");
        expect((err as Error).message).toBe(htmlErr.message);
        return "HTML";
      },
      fallback: "FB",
    });
    expect(seen).toBe("html");
    expect(result).toBe("HTML");
  });

  test("(5) gated throw generic -> onError('other')", async () => {
    let seen: LlmErrorClass | undefined;
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw new Error("connection refused");
        },
      },
      parse: () => "PARSED",
      onError: (cls) => {
        seen = cls;
        return "OTHER";
      },
      fallback: "FB",
    });
    expect(seen).toBe("other");
    expect(result).toBe("OTHER");
  });

  test("(6) UNGATED (akmConfig undefined) throw -> error PROPAGATES", async () => {
    const boom = new Error("ungated propagation");
    const onErrorCalls: LlmErrorClass[] = [];
    const promise = callStructured<string>({
      feature: "memory_inference",
      akmConfig: undefined, // UNGATED: run directly, propagate errors
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw boom;
        },
      },
      parse: () => "PARSED",
      onError: (cls) => {
        onErrorCalls.push(cls);
        return "SWALLOWED";
      },
      fallback: "FB",
    });
    await expect(promise).rejects.toThrow("ungated propagation");
    // The error must NOT be funneled through onError on the ungated path.
    expect(onErrorCalls).toEqual([]);
  });

  test("(7) onRetryAttempt is forwarded into the chat call options", async () => {
    let forwarded: (() => void) | undefined;
    const onRetryAttempt = () => {};
    await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: {
        onRetryAttempt,
        chat: async (_config, _messages, options) => {
          forwarded = options?.onRetryAttempt;
          return "ok";
        },
      },
      parse: () => "PARSED",
      onError: () => "ERR",
      fallback: "FB",
    });
    expect(forwarded).toBe(onRetryAttempt);
  });

  test("(8) enabled:true opens a gate whose feature key has no config resolver", async () => {
    // `distill` has no FEATURE_LOCATION resolver: without the enabled override
    // the gate is hard-closed. The override is how improve-owned features
    // (distill/consolidation/contradiction) migrate onto the seam.
    let chatRan = false;
    const result = await callStructured<string>({
      feature: "distill",
      akmConfig: GATED,
      enabled: true,
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          chatRan = true;
          return "raw";
        },
      },
      parse: (raw) => raw ?? "",
      onError: () => "ERR",
      fallback: "FB",
    });
    expect(chatRan).toBe(true);
    expect(result).toBe("raw");
  });

  test("(9) resolver-less feature WITHOUT enabled override -> gate closed, fallback + onFallback('disabled')", async () => {
    let chatRan = false;
    const reasons: string[] = [];
    const result = await callStructured<string>({
      feature: "distill",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async () => {
          chatRan = true;
          return "raw";
        },
      },
      parse: (raw) => raw ?? "",
      onError: () => "ERR",
      fallback: "FB",
      onFallback: (evt) => {
        reasons.push(evt.reason);
      },
    });
    expect(chatRan).toBe(false);
    expect(result).toBe("FB");
    expect(reasons).toEqual(["disabled"]);
  });

  test("(9b) a disabled gate needs no runner, messages, preparation, or provider", async () => {
    let chatRan = false;
    const reasons: string[] = [];
    const result = await callStructured<string>({
      feature: "distill",
      akmConfig: GATED,
      enabled: false,
      messages: [],
      request: {
        chat: async () => {
          chatRan = true;
          return "wrong";
        },
      },
      parse: () => "PARSED",
      onError: () => "ERR",
      fallback: "FB",
      onFallback: (evt) => {
        reasons.push(evt.reason);
      },
    });

    expect(result).toBe("FB");
    expect(reasons).toEqual(["disabled"]);
    expect(chatRan).toBe(false);
  });

  test("(10) maxTokens and enableThinking reach the transport as exact resolved inference", async () => {
    let seenMaxTokens: number | undefined;
    let seenEnableThinking: boolean | undefined;
    await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
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
      parse: () => "PARSED",
      onError: () => "ERR",
      fallback: "FB",
    });
    expect(seenMaxTokens).toBe(1234);
    expect(seenEnableThinking).toBe(false);
  });

  test("(11) timeoutMs key-presence is preserved: absent takes the default, explicit undefined stays disabled", async () => {
    // Tri-state contract (see CallStructuredRequest doc): absent key = the
    // runner's own timeout, else the 600 s model-work default;
    // present-but-undefined = explicitly disabled.
    let absentCaseOptions: Record<string, unknown> | undefined;
    await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: {
        chat: async (_config, _messages, options) => {
          absentCaseOptions = options as Record<string, unknown> | undefined;
          return "ok";
        },
      },
      parse: () => "PARSED",
      onError: () => "ERR",
      fallback: "FB",
    });
    expect(absentCaseOptions?.timeoutMs).toBe(600_000);

    let presentCaseOptions: Record<string, unknown> | undefined;
    await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: {
        timeoutMs: undefined,
        chat: async (_config, _messages, options) => {
          presentCaseOptions = options as Record<string, unknown> | undefined;
          return "ok";
        },
      },
      parse: () => "PARSED",
      onError: () => "ERR",
      fallback: "FB",
    });
    expect(presentCaseOptions !== undefined && Object.hasOwn(presentCaseOptions, "timeoutMs")).toBe(true);
    // The canonical request normalizes present-but-undefined to explicit null;
    // both spellings retain the historical "disable timeout" semantics.
    expect(presentCaseOptions?.timeoutMs).toBeNull();
  });

  test("(11b) the request names a timeout only when the caller does; the runner brings the 600 s default itself", () => {
    expect(resolveStructuredCurrent(undefined, undefined)).toBeUndefined();
    expect(resolveStructuredCurrent(undefined, { timeoutMs: 5 })).toEqual({ timeout: 5 });
    expect(resolveStructuredCurrent(undefined, { timeoutMs: undefined })).toEqual({ timeout: null });
    expect(resolveStructuredCurrent({ timeout: 9 }, undefined)).toEqual({ timeout: 9 });
    expect(resolveStructuredCurrent({ timeout: 9 }, { timeoutMs: 5 })).toEqual({ timeout: 5 });
  });

  test("(11c) the feature gate's timeout aborts the dispatch it bounds", async () => {
    let seen: AbortSignal | undefined;
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: MESSAGES,
      request: {
        timeoutMs: 50,
        // Settles only when aborted (or long after the gate gave up).
        chat: (_config, _messages, options) =>
          new Promise<string>((resolve) => {
            seen = options?.signal;
            const late = setTimeout(() => resolve("late"), 2_000);
            options?.signal?.addEventListener("abort", () => {
              clearTimeout(late);
              resolve("aborted");
            });
          }),
      },
      parse: (raw) => raw ?? "",
      onError: () => "error",
      fallback: "fallback",
    });

    expect(result).toBe("fallback");
    expect(seen?.aborted).toBe(true);
  });

  test("(12) a retired supportsJsonSchema setting is reported untranslated and the schema is still sent", async () => {
    const seenMessages: ChatMessage[][] = [];
    let seenOptions: Record<string, unknown> | undefined;
    let notices: readonly Readonly<LoweringNotice>[] = [];
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
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
      parse: (raw) => raw ?? "",
      onError: () => "ERR",
      fallback: "FB",
    });

    expect(result).toBe("ok");
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
    const value = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      messages: [{ role: "user", content: "judge this" }],
      request: {
        chat: async () => {
          chatRan = true;
          return "answer";
        },
      },
      parse: (raw) => raw ?? "",
      onError: () => "ERR",
      fallback: "FB",
    });
    expect({ value, chatRan }).toEqual({ value: "answer", chatRan: true });

    // A harness that cannot confine the policy runs the call unrestricted, with one notice.
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("from gemini"));
        controller.close();
      },
    });
    let spawned = 0;
    let notices: readonly { code: string }[] = [];
    const ran = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: harness("gemini", "gemini-stub"),
      messages: [{ role: "user", content: "judge this" }],
      request: {
        runOptions: {
          spawn: (): SpawnedSubprocess => {
            spawned += 1;
            return {
              exitCode: 0,
              exited: Promise.resolve(0),
              stdout,
              stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
              stdin: null,
              kill: () => {},
            };
          },
        },
      },
      onNotices: (value) => {
        notices = value;
      },
      parse: (raw) => raw ?? "",
      onError: () => "ERR",
      fallback: "FB",
    });
    expect(spawned).toBe(1);
    expect(ran).toContain("from gemini");
    expect(notices.map((notice) => notice.code)).toContain("model-work-unrestricted");
  });

  test("(13b) an agent dispatch gets the caller's environment and spawn seam, and its failure keeps the dispatch's own result", async () => {
    // Never run: the spawn seam stands in for it.
    const claude = harness("claude", "/nonexistent/structured-claude");
    const text = (value: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(value));
          controller.close();
        },
      });
    const spawned: Array<Record<string, string> | undefined> = [];
    const spawn = (_cmd: string[], opts: { env?: Record<string, string> }): SpawnedSubprocess => {
      spawned.push(opts.env);
      return {
        exitCode: 7,
        exited: Promise.resolve(7),
        stdout: text(""),
        stderr: text("boom"),
        stdin: null,
        kill: () => {},
      };
    };

    const thrown = await callStructured<string>({
      feature: "memory_inference",
      runner: claude,
      current: { environment: { AKM_EVENT_SOURCE: "improve" } },
      messages: [{ role: "user", content: "judge this" }],
      request: { runOptions: { spawn } },
      parse: (raw) => raw ?? "",
      onError: () => "ERR",
      fallback: "FB",
    }).catch((error: unknown) => error);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ AKM_EVENT_SOURCE: "improve" });
    // The error carries the dispatch's own result: the exit code and stderr a caller reports.
    expect(dispatchFailureResult(thrown)).toMatchObject({
      ok: false,
      reason: "non_zero_exit",
      exitCode: 7,
      stderr: "boom",
    });
  });

  test("(14) a provider failure is credential-redacted before ungated propagation", async () => {
    const secret = "structured-secret-sentinel";
    let thrown: unknown;
    await withEnv({ AKM_STRUCTURED_SECRET: secret }, async () => {
      try {
        await callStructured<string>({
          feature: "memory_inference",
          runner: runner({ apiKey: "$AKM_STRUCTURED_SECRET" }),
          messages: [{ role: "user", content: "redact failures" }],
          request: {
            chat: async () => {
              throw new LlmCallError(`provider echoed ${secret}`, "provider_error");
            },
          },
          parse: (raw) => raw ?? "",
          onError: () => "SWALLOWED",
          fallback: "FB",
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(secret);
    expect(String(thrown)).toContain("[REDACTED]");
  });

  test("(15) a key variable that is unset sends the call without a key, and does not fail it", async () => {
    let apiKey: string | undefined = "unset";
    let onErrorCalls = 0;

    const value = await withEnv({ AKM_STRUCTURED_REQUIRED_SECRET: undefined }, () =>
      callStructured<string>({
        feature: "memory_inference",
        akmConfig: GATED,
        runner: runner({ apiKey: "$AKM_STRUCTURED_REQUIRED_SECRET" }),
        messages: [{ role: "user", content: "no key is sent" }],
        request: {
          chat: async (connection) => {
            apiKey = connection.apiKey;
            return "answered";
          },
        },
        parse: (raw) => raw ?? "",
        onError: () => {
          onErrorCalls += 1;
          return "SWALLOWED";
        },
        fallback: "FB",
      }),
    );

    expect(value).toBe("answered");
    expect(apiKey).toBeUndefined();
    expect(onErrorCalls).toBe(0);
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
        callStructured<string>({
          feature: "distill",
          akmConfig: GATED,
          enabled: true,
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
          parse: (raw) => raw ?? "",
          onError: () => "error",
          fallback: "fallback",
        });

      expect(await dispatch("provider/model-a", "first", 0.1, 10)).toBe("first");
      expect(await dispatch("provider/model-b", "second", 0.9, 20)).toBe("second");
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
