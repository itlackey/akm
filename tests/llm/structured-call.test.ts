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
import { ConfigError } from "../../src/core/errors";
import type { SpawnedSubprocess } from "../../src/core/subprocess";
import type { LoweringNotice } from "../../src/execution/resolved-request";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { assertRunnerCredentials } from "../../src/integrations/agent/runner-dispatch";
import type { ChatCompletionConfig, ChatMessage } from "../../src/llm/client";
import { LlmCallError } from "../../src/llm/client";
import {
  callStructured,
  dispatchFailureResult,
  type LlmErrorClass,
  resolveStructuredCurrent,
} from "../../src/llm/structured-call";
import { mutateScopedEnv, withEnv } from "../_helpers/sandbox";

// Minimal LLM profile config. `chatCompletion` is replaced by the injected
// fake, so transport fields are irrelevant.
const PROFILE: ChatCompletionConfig = { endpoint: "http://x", model: "m" };

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "usr" },
];

// A config object whose mere existence enables the `memory_inference` gate
// (FEATURE_LOCATION default is `?? true`). Used as the GATED akmConfig.
const GATED: AkmConfig = {} as AkmConfig;

function runner(
  connection: ChatCompletionConfig = PROFILE,
  extra: Partial<Extract<RunnerSpec, { kind: "llm" }>> = {},
): Extract<RunnerSpec, { kind: "llm" }> {
  return { kind: "llm", engine: "structured-test", connection, ...extra };
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
          seenMaxTokens = config.maxTokens;
          seenEnableThinking = config.enableThinking;
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

  test("(11b) model work is bounded: a runner with no timeout of its own gets 600 s, whatever its kind", () => {
    const agent: RunnerSpec = {
      kind: "agent",
      engine: "structured-agent",
      profile: {
        name: "structured-agent",
        platform: "opencode",
        bin: "opencode",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
    };
    expect(resolveStructuredCurrent(undefined, undefined, agent)).toEqual({ timeout: 600_000 });
    expect(resolveStructuredCurrent(undefined, undefined, runner())).toEqual({ timeout: 600_000 });
    expect(resolveStructuredCurrent(undefined, undefined, { ...agent, timeoutMs: 1_234 })).toBeUndefined();
    expect(resolveStructuredCurrent(undefined, undefined, { ...agent, timeoutMs: null })).toBeUndefined();
    expect(resolveStructuredCurrent(undefined, { timeoutMs: 5 }, agent)).toEqual({ timeout: 5 });
    expect(resolveStructuredCurrent({ timeout: 9 }, undefined, agent)).toEqual({ timeout: 9 });
  });

  test("(11b') a configured agent or SDK engine that sets no timeoutMs gets the 600 s bound too", () => {
    const config = {
      configVersion: "0.9.0",
      engines: {
        cc: { kind: "agent", platform: "claude" },
        sdk: { kind: "agent", platform: "opencode-sdk" },
        unbounded: { kind: "agent", platform: "claude", timeoutMs: null },
      },
    } as unknown as AkmConfig;
    expect(resolveStructuredCurrent(undefined, undefined, resolveEngine("cc", config))).toEqual({ timeout: 600_000 });
    expect(resolveStructuredCurrent(undefined, undefined, resolveEngine("sdk", config))).toEqual({ timeout: 600_000 });
    // An engine's own timeoutMs, null included, still applies.
    expect(resolveStructuredCurrent(undefined, undefined, resolveEngine("unbounded", config))).toBeUndefined();
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

  test("(12) unsupported schema lowers optimistically, emits a structured notice, and preserves messages", async () => {
    const seenMessages: ChatMessage[][] = [];
    let seenOptions: Record<string, unknown> | undefined;
    let notices: readonly Readonly<LoweringNotice>[] = [];
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner({ ...PROFILE, supportsJsonSchema: false }),
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
    expect(seenOptions && Object.hasOwn(seenOptions, "responseSchema")).toBe(false);
    expect(notices).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        adapter: "llm",
        field: "outputSchema",
      }),
    ]);
  });

  test("(13) a structured call runs under the model-work tool policy, whatever tools the caller selects", async () => {
    // The caller's own selection would be denied (no execution.allowedTools on a
    // runner-only resolution); it is replaced, so the LLM call goes ahead.
    let chatRan = false;
    const value = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: runner(),
      current: { tools: ["shell"] },
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

    // An agent engine that cannot confine the policy is refused before anything runs.
    const codex: RunnerSpec = {
      kind: "agent",
      engine: "structured-codex",
      profile: {
        name: "structured-codex",
        platform: "codex",
        bin: "codex-must-not-run",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
    };
    const refused = callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      runner: codex,
      messages: [{ role: "user", content: "judge this" }],
      parse: (raw) => raw ?? "",
      onError: () => "ERR",
      fallback: "FB",
    });
    await expect(refused).rejects.toThrow(/cannot enforce the model-work tool policy/);
  });

  test("(13b) an agent dispatch gets the caller's environment and spawn seam, and its failure keeps the dispatch's own result", async () => {
    const opencode: RunnerSpec = {
      kind: "agent",
      engine: "structured-opencode",
      profile: {
        name: "structured-opencode",
        platform: "opencode",
        // Never run: the spawn seam stands in for it.
        bin: "/nonexistent/structured-opencode",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
    };
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
      runner: opencode,
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

  test("(13c) an SDK dispatch runs through the runSdk seam", async () => {
    const sdk: RunnerSpec = {
      kind: "sdk",
      engine: "structured-sdk",
      profile: {
        name: "structured-sdk",
        platform: "opencode-sdk",
        // Never run: the runSdk seam stands in for it.
        bin: "/nonexistent/structured-sdk",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
    };
    const prompts: string[] = [];
    const value = await callStructured<string>({
      feature: "memory_inference",
      runner: sdk,
      messages: [{ role: "user", content: "judge this" }],
      request: {
        runSdk: async (_profile, prompt) => {
          prompts.push(prompt);
          return { ok: true, exitCode: 0, stdout: "answer", stderr: "", durationMs: 1 };
        },
      },
      parse: (raw) => raw ?? "",
      onError: () => "ERR",
      fallback: "FB",
    });

    expect(value).toBe("answer");
    expect(prompts).toEqual(["judge this"]);
  });

  test("(14) a provider failure is credential-redacted before ungated propagation", async () => {
    const secret = "structured-secret-sentinel";
    let thrown: unknown;
    await withEnv({ AKM_STRUCTURED_SECRET: secret }, async () => {
      try {
        await callStructured<string>({
          feature: "memory_inference",
          runner: runner(PROFILE, { credential: { names: ["AKM_STRUCTURED_SECRET"], required: true } }),
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

  test("(15) a missing required symbolic credential remains a hard config failure", async () => {
    let chatRan = false;
    let onErrorCalls = 0;
    let onFallbackCalls = 0;
    let thrown: unknown;

    await withEnv({ AKM_STRUCTURED_REQUIRED_SECRET: undefined }, async () => {
      try {
        await callStructured<string>({
          feature: "memory_inference",
          akmConfig: GATED,
          runner: runner(PROFILE, {
            credential: { names: ["AKM_STRUCTURED_REQUIRED_SECRET"], required: true },
          }),
          messages: [{ role: "user", content: "must fail before provider dispatch" }],
          request: {
            chat: async () => {
              chatRan = true;
              return "wrong";
            },
          },
          parse: (raw) => raw ?? "",
          onError: () => {
            onErrorCalls += 1;
            return "SWALLOWED";
          },
          fallback: "FB",
          onFallback: () => {
            onFallbackCalls += 1;
          },
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).code).toBe("INVALID_CONFIG_FILE");
    expect((thrown as ConfigError).message).toBe(
      "Required engine credential AKM_STRUCTURED_REQUIRED_SECRET is not set.",
    );
    expect(chatRan).toBe(false);
    expect(onErrorCalls).toBe(0);
    expect(onFallbackCalls).toBe(0);
  });

  test("(16) one preflighted runner serves different messages, models, inference, schemas, and timeouts", async () => {
    const secret = "structured-lease-original-092";
    const replacement = "structured-lease-replacement-092";
    const selectedRunner = runner(
      { ...PROFILE, supportsJsonSchema: true },
      {
        credential: { names: ["AKM_STRUCTURED_LEASE_KEY"], required: true },
      },
    );
    const observed: Array<{
      apiKey: string | undefined;
      model: string;
      temperature: number | undefined;
      message: string | undefined;
      timeoutMs: number | null | undefined;
      schemaType: unknown;
    }> = [];

    await withEnv({ AKM_STRUCTURED_LEASE_KEY: secret }, async () => {
      assertRunnerCredentials(selectedRunner);
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
                temperature: connection.temperature,
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
