import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setSecret } from "../../src/commands/env/secret";
import { renderMarkdownExecutionSource } from "../../src/core/adapter/execution-source";
import type { AkmConfig } from "../../src/core/config/config";
import { redactSensitiveText } from "../../src/core/redaction";
import type { SpawnedSubprocess, SpawnFn } from "../../src/core/subprocess";
import type { ExecutionJsonObject } from "../../src/execution/json";
import {
  canonicalResolvedExecutionRequest,
  createInlineResolvedCommand,
  createResolvedExecutionRequest,
  createResolvedPersona,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../src/execution/resolved-request";
import {
  CONVERSATION_FALLBACK_BEGIN,
  CONVERSATION_FALLBACK_END,
} from "../../src/integrations/agent/conversation-fallback";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import {
  acquireLoweredExecutionDispatchLease,
  dispatchLoweredExecutionRequest,
  disposeLoweredExecutionDispatchLease,
  lowerResolvedExecutionRequest,
  lowerResolvedExecutionRequestWithRunner,
  redactWithLoweredExecutionDispatchLease,
} from "../../src/integrations/agent/execution-lowering";
import {
  prepareInlineExecution,
  prepareInlineExecutionWithRunner,
} from "../../src/integrations/agent/inline-execution";
import type { ResolvedModelMapV1 } from "../../src/integrations/agent/model-map";
import { PERSONA_FALLBACK_BEGIN, PERSONA_FALLBACK_END } from "../../src/integrations/agent/persona-fallback";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import {
  acquireRunnerDispatchLease,
  collectDispatchSensitiveValues,
  disposeRunnerDispatchLease,
  executeRunner,
} from "../../src/integrations/agent/runner-dispatch";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import {
  __setServerFactory,
  closeServer as closeOpencodeSdkServer,
} from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { LlmCallError, type LlmCallErrorCode } from "../../src/llm/client";
import { mutateScopedEnv, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

const CLI_HARNESSES = HARNESS_REGISTRY.filter((harness) => harness.agentBuilder).map((harness) => harness.id);

function completedSubprocess(stdout: string, stderr = stdout): SpawnedSubprocess {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  return {
    exitCode: 0,
    exited: Promise.resolve(0),
    stdout: stream(stdout),
    stderr: stream(stderr),
    stdin: null,
    kill() {},
  };
}

function configFor(platform: string, kind: "agent" | "llm" = "agent"): AkmConfig {
  const engine =
    kind === "llm"
      ? {
          kind: "llm" as const,
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "configured/model-must-not-win",
          apiKey: "$AKM_WP5_FIXTURE_KEY",
          supportsJsonSchema: true,
        }
      : {
          kind: "agent" as const,
          platform,
          model: "configured/model-must-not-win",
          args: [],
        };
  return {
    engines: { fixture: engine },
    defaults: { engine: "fixture", ...(kind === "llm" ? { llmEngine: "fixture" } : {}) },
  } as unknown as AkmConfig;
}

function persona() {
  return createResolvedPersona(
    renderMarkdownExecutionSource({
      kind: "persona",
      raw: "---\ndescription: fixture\n---\nYou are the exact persona.\n",
      identity: {
        ref: "fixture//agents/reviewer",
        bundle: "fixture",
        adapter: "akm",
        file: "agents/reviewer.md",
      },
      defaults: {},
    }),
  );
}

function requestFor(
  platform: string,
  kind: "agent" | "sdk" | "llm" = platform === "opencode-sdk" ? "sdk" : "agent",
  overrides: Partial<ResolvedExecutionRequestV1> = {},
): ResolvedExecutionRequestV1 {
  return createResolvedExecutionRequest({
    command: createInlineResolvedCommand({
      template: "Review the exact target.",
      argumentInput: "",
      content: "Review the exact target.",
    }),
    agent: "fixture//agents/reviewer",
    persona: persona(),
    engine: { name: "fixture", kind, platform: kind === "llm" ? "openai-compatible" : platform },
    model: { input: "balanced", interpretation: "alias", resolved: "provider/exact-model" },
    inference: { effort: "high", temperature: 0, extraParams: {}, supportsJsonSchema: true },
    outputSchema: { type: "object", properties: {}, additionalProperties: false },
    tools: ["Read", "Grep"],
    authorization: { status: "allowed", policy: { id: "fixture-policy" } },
    runtime: { timeoutMs: 0, workspace: "/fixture/workspace", environment: {} },
    notices: [],
    ...overrides,
  });
}

describe("resolved execution lowerer registry", () => {
  test("an opaque dispatch lease snapshots a required credential once and is invalid after disposal", async () => {
    const secret = "lease-original-secret-092";
    const replacement = "lease-replacement-secret-092";
    const runner: RunnerSpec = {
      kind: "llm",
      engine: "fixture",
      connection: {
        provider: "openai-compatible",
        endpoint: "https://fixture.invalid/v1/chat/completions",
        model: "provider/exact-model",
      },
      credential: { names: ["AKM_WP5_LEASE_KEY"], required: true },
    };
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } }),
      runner,
    );

    await withEnv({ AKM_WP5_LEASE_KEY: secret }, async () => {
      const lease = await acquireLoweredExecutionDispatchLease(lowered);
      expect(Object.keys(lease)).toEqual([]);
      expect(Reflect.ownKeys(lease)).toEqual(["toJSON"]);
      expect(Object.getPrototypeOf(lease)).toBeNull();
      expect(Object.isFrozen(lease)).toBe(true);
      expect(() => JSON.stringify(lease)).toThrow(/dispatch lease.*serializ/i);

      mutateScopedEnv("AKM_WP5_LEASE_KEY", replacement);
      const observed: Array<string | undefined> = [];
      const run = () =>
        dispatchLoweredExecutionRequest(lowered, {
          lease,
          chat: async (connection) => {
            observed.push(connection.apiKey);
            return secret;
          },
        });
      const firstResult = await run();
      expect(JSON.stringify(firstResult)).not.toContain(secret);
      expect(firstResult.stdout).toContain("[REDACTED]");
      mutateScopedEnv("AKM_WP5_LEASE_KEY", undefined);
      await run();
      expect(observed).toEqual([secret, secret]);

      disposeLoweredExecutionDispatchLease(lease);
      await expect(run()).rejects.toThrow(/dispatch lease.*disposed|invalid dispatch lease/i);
      disposeLoweredExecutionDispatchLease(lease);
    });
  });

  test("lease acquisition validates lowered provenance before touching an accessor-backed environment", () => {
    const runner: RunnerSpec = {
      kind: "llm",
      engine: "fixture",
      connection: {
        provider: "openai-compatible",
        endpoint: "https://fixture.invalid/v1/chat/completions",
        model: "provider/exact-model",
      },
      credential: { names: ["AKM_WP5_ACCESSOR_KEY"], required: true },
    };
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } }),
      runner,
    );
    let reads = 0;
    const envSource = new Proxy(Object.create(null) as NodeJS.ProcessEnv, {
      get() {
        reads += 1;
        throw new Error("environment accessor must not run");
      },
    });
    const forged = Object.freeze({ ...lowered });

    expect(() => acquireLoweredExecutionDispatchLease(forged as typeof lowered, { envSource })).toThrow(
      /produced by the engine lowerer registry/i,
    );
    expect(reads).toBe(0);
  });

  test("a genuine lease reads only the selected credential once and never re-reads it at dispatch", async () => {
    const secret = "accessor-credential-original-092";
    const runner: RunnerSpec = {
      kind: "llm",
      engine: "fixture",
      connection: {
        provider: "openai-compatible",
        endpoint: "https://fixture.invalid/v1/chat/completions",
        model: "provider/exact-model",
      },
      credential: { names: ["AKM_WP5_ACCESSOR_KEY", "AKM_WP5_UNUSED_KEY"], required: true },
    };
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } }),
      runner,
    );
    let selectedReads = 0;
    let unusedReads = 0;
    const envSource = Object.create(null) as NodeJS.ProcessEnv;
    Object.defineProperties(envSource, {
      AKM_WP5_ACCESSOR_KEY: {
        enumerable: true,
        get() {
          selectedReads += 1;
          return secret;
        },
      },
      AKM_WP5_UNUSED_KEY: {
        enumerable: true,
        get() {
          unusedReads += 1;
          throw new Error("fallback credential accessor must not run");
        },
      },
    });

    const lease = acquireLoweredExecutionDispatchLease(lowered, { envSource });
    try {
      let observed: string | undefined;
      await dispatchLoweredExecutionRequest(lowered, {
        lease,
        chat: async (connection) => {
          observed = connection.apiKey;
          return "ok";
        },
      });
      expect(observed).toBe(secret);
      expect(selectedReads).toBe(1);
      expect(unusedReads).toBe(0);
    } finally {
      disposeLoweredExecutionDispatchLease(lease);
    }
  });

  test.each([
    { kind: "agent" as const, mutation: "deletion", replacement: undefined },
    { kind: "agent" as const, mutation: "replacement", replacement: "agent-passthrough-replacement" },
    { kind: "sdk" as const, mutation: "deletion", replacement: undefined },
    { kind: "sdk" as const, mutation: "replacement", replacement: "sdk-passthrough-replacement" },
  ])("$kind lease redacts its acquired envPassthrough snapshot after ambient $mutation", async ({
    kind,
    replacement,
  }) => {
    const secret = `${kind}-passthrough-original-secret`;
    const profileSecret = `${kind}-profile-original-secret`;
    const profileEnv = { AKM_WP5_PROFILE_SECRET: profileSecret };
    const profile = {
      name: `fixture-${kind}`,
      platform: kind === "sdk" ? "opencode-sdk" : "opencode",
      personaChannel: kind === "sdk" ? ("native" as const) : ("prompt" as const),
      bin: "fixture-agent",
      args: [],
      stdio: "captured" as const,
      env: profileEnv,
      envPassthrough: ["AKM_WP5_PASSTHROUGH_SECRET"],
      parseOutput: "text" as const,
    };
    const runner: RunnerSpec = { kind, engine: "fixture", profile };
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor(kind === "sdk" ? "opencode-sdk" : "opencode", kind),
      runner,
    );
    let current: string | undefined = secret;
    let reads = 0;
    const envSource = new Proxy(Object.create(null) as NodeJS.ProcessEnv, {
      get(_target, property) {
        if (property === "AKM_WP5_PASSTHROUGH_SECRET") {
          reads += 1;
          return current;
        }
        return undefined;
      },
    });
    const lease = acquireLoweredExecutionDispatchLease(lowered, { envSource });
    try {
      const mutateAndEcho = async () => {
        current = replacement;
        profileEnv.AKM_WP5_PROFILE_SECRET = replacement ?? "";
        return {
          ok: true as const,
          stdout: `${secret} ${profileSecret}`,
          stderr: `${secret} ${profileSecret}`,
          exitCode: 0,
          durationMs: 0,
        };
      };
      const result = await dispatchLoweredExecutionRequest(lowered, {
        lease,
        runOptions: { envSource },
        ...(kind === "sdk" ? { runSdk: mutateAndEcho } : { runAgent: mutateAndEcho }),
      });

      expect(reads).toBe(1);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(profileSecret);
      expect(Object.keys(lease)).toEqual([]);
      expect(Reflect.ownKeys(lease)).toEqual(["toJSON"]);
      expect(() => JSON.stringify(lease)).toThrow(/dispatch lease.*serializ/i);
    } finally {
      disposeLoweredExecutionDispatchLease(lease);
    }
    expect(() => redactWithLoweredExecutionDispatchLease(lease, secret)).toThrow(/disposed|invalid dispatch lease/i);
  });

  test("an agent lease drives the real child env from its immutable passthrough snapshot", async () => {
    const name = "AKM_WP5_AGENT_IMMUTABLE_PASSTHROUGH";
    const original = "agent-immutable-original-secret";
    const replacement = "agent-live-replacement-secret";
    const profile = {
      name: "fixture-agent-immutable-env",
      platform: "opencode",
      personaChannel: "prompt" as const,
      bin: "fixture-agent",
      args: [],
      stdio: "captured" as const,
      envPassthrough: [name],
      parseOutput: "text" as const,
    };
    const runner: RunnerSpec = { kind: "agent", engine: "fixture", profile };
    const lowered = lowerResolvedExecutionRequestWithRunner(requestFor("opencode", "agent"), runner);
    let current = original;
    let ambientReads = 0;
    let passthroughReads = 0;
    const envSource = new Proxy(Object.create(null) as NodeJS.ProcessEnv, {
      get(_target, property) {
        ambientReads += 1;
        if (property !== name) return undefined;
        passthroughReads += 1;
        return current;
      },
    });
    let childValue: string | undefined;
    const spawn: SpawnFn = (_argv, options) => {
      childValue = options.env?.[name];
      return completedSubprocess(childValue ?? "");
    };

    const lease = acquireLoweredExecutionDispatchLease(lowered, { envSource });
    const readsAfterAcquire = ambientReads;
    try {
      current = replacement;
      const result = await dispatchLoweredExecutionRequest(lowered, {
        lease,
        runOptions: { envSource, spawn, timeoutMs: null },
      });
      expect(ambientReads).toBe(readsAfterAcquire);
      expect(passthroughReads).toBe(1);
      expect(childValue).toBe(original);
      expect(result.stdout).toContain("[REDACTED]");
      expect(result.stderr).toContain("[REDACTED]");
      expect(JSON.stringify(result)).not.toContain(original);
      expect(JSON.stringify(result)).not.toContain(replacement);
    } finally {
      disposeLoweredExecutionDispatchLease(lease);
    }

    const unleased = await executeRunner(runner, "prompt", { envSource, spawn, timeoutMs: null });
    expect(childValue).toBe(replacement);
    expect(unleased.stdout).toContain("[REDACTED]");
    expect(JSON.stringify(unleased)).not.toContain(replacement);
  });

  test("an SDK lease drives the real server env from its immutable passthrough snapshot", async () => {
    const name = "AKM_WP5_SDK_IMMUTABLE_PASSTHROUGH";
    const original = "sdk-immutable-original-secret";
    const replacement = "sdk-live-replacement-secret";
    const profile = {
      name: "fixture-sdk-immutable-env",
      platform: "opencode-sdk",
      personaChannel: "native" as const,
      bin: "fixture-opencode",
      args: [],
      stdio: "captured" as const,
      envPassthrough: [name],
      parseOutput: "text" as const,
    };
    const runner: RunnerSpec = { kind: "sdk", engine: "fixture", profile };
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("opencode-sdk", "sdk", {
        runtime: { timeoutMs: null, workspace: "/fixture/workspace", environment: {} },
      }),
      runner,
    );
    let current = original;
    let ambientReads = 0;
    let passthroughReads = 0;
    const envSource = new Proxy(Object.create(null) as NodeJS.ProcessEnv, {
      get(_target, property) {
        ambientReads += 1;
        if (property !== name) return undefined;
        passthroughReads += 1;
        return current;
      },
    });
    let serverValue: string | undefined;
    __setServerFactory(((options: { env: Record<string, string> }) => {
      serverValue = options.env[name];
      return Promise.resolve({
        client: {
          session: {
            create: async () => ({ data: { id: "lease-env-session" } }),
            prompt: async () => ({ data: { parts: [{ type: "text", text: serverValue }] } }),
            delete: async () => ({}),
          },
        },
        server: { close() {} },
      });
    }) as never);

    const lease = acquireLoweredExecutionDispatchLease(lowered, { envSource });
    const readsAfterAcquire = ambientReads;
    try {
      current = replacement;
      const result = await dispatchLoweredExecutionRequest(lowered, {
        lease,
        runOptions: { envSource, timeoutMs: null },
      });
      expect(ambientReads).toBe(readsAfterAcquire);
      expect(passthroughReads).toBe(1);
      expect(serverValue).toBe(original);
      expect(result.stdout).toContain("[REDACTED]");
      expect(JSON.stringify(result)).not.toContain(original);
      expect(JSON.stringify(result)).not.toContain(replacement);

      const unleased = await executeRunner(runner, "prompt", { envSource, timeoutMs: null });
      expect(serverValue).toBe(replacement);
      expect(unleased.stdout).toContain("[REDACTED]");
      expect(JSON.stringify(unleased)).not.toContain(replacement);
    } finally {
      disposeLoweredExecutionDispatchLease(lease);
      __setServerFactory(null);
      await closeOpencodeSdkServer();
    }
  });

  test("executeRunner snapshots mutable profile and per-dispatch env before awaiting the runner", async () => {
    const profileSecret = "mutable-profile-original-secret";
    const optionSecret = "mutable-option-original-secret";
    const runner: RunnerSpec = {
      kind: "agent",
      engine: "fixture",
      profile: {
        name: "mutable-sensitive-inputs",
        platform: "opencode",
        personaChannel: "prompt",
        bin: "fixture-agent",
        args: [],
        stdio: "captured",
        env: { AKM_WP5_PROFILE_SECRET: profileSecret },
        envPassthrough: [],
        parseOutput: "text",
      },
    };
    const runOptions = { env: { AKM_WP5_OPTION_SECRET: optionSecret } };
    const lease = acquireRunnerDispatchLease(runner, Object.create(null) as NodeJS.ProcessEnv);
    try {
      const result = await executeRunner(
        runner,
        "prompt",
        runOptions,
        {
          runAgent: async () => {
            if (runner.kind !== "agent") throw new Error("fixture runner changed kind");
            if (runner.profile.env) {
              (runner.profile.env as Record<string, string>).AKM_WP5_PROFILE_SECRET = "replacement";
            }
            if (runOptions.env) runOptions.env.AKM_WP5_OPTION_SECRET = "replacement";
            return {
              ok: true,
              stdout: `${profileSecret} ${optionSecret}`,
              stderr: `${profileSecret} ${optionSecret}`,
              exitCode: 0,
              durationMs: 0,
            };
          },
        },
        lease,
      );
      expect(JSON.stringify(result)).not.toContain(profileSecret);
      expect(JSON.stringify(result)).not.toContain(optionSecret);
    } finally {
      disposeRunnerDispatchLease(lease);
    }
  });

  test("forged and mismatched primary transport leases are rejected before provider dispatch", async () => {
    const baseRunner: RunnerSpec = {
      kind: "llm",
      engine: "fixture",
      connection: {
        provider: "openai-compatible",
        endpoint: "https://one.invalid/v1/chat/completions",
        model: "provider/model-one",
      },
    };
    const otherRunner: RunnerSpec = {
      ...baseRunner,
      connection: {
        provider: "openai-compatible",
        endpoint: "https://two.invalid/v1/chat/completions",
        model: "provider/model-two",
      },
    };
    const request = requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } });
    const base = lowerResolvedExecutionRequestWithRunner(request, baseRunner);
    const other = lowerResolvedExecutionRequestWithRunner(request, otherRunner);
    const lease = acquireLoweredExecutionDispatchLease(base);
    const forgedLease = Object.freeze(Object.create(null)) as typeof lease;
    let chatRan = false;
    try {
      await expect(
        dispatchLoweredExecutionRequest(other, {
          lease,
          chat: async () => {
            chatRan = true;
            return "wrong";
          },
        }),
      ).rejects.toThrow(/lease.*does not match|transport/i);
      await expect(
        dispatchLoweredExecutionRequest(base, {
          lease: forgedLease,
          chat: async () => "wrong",
        }),
      ).rejects.toThrow(/invalid dispatch lease/i);
      expect(() => disposeLoweredExecutionDispatchLease(forgedLease)).toThrow(/invalid dispatch lease/i);
      expect(chatRan).toBe(false);
    } finally {
      disposeLoweredExecutionDispatchLease(lease);
    }
  });

  test("an operation lease snapshots the SDK fallback credential without exposing it", async () => {
    const secret = "sdk-fallback-lease-secret-092";
    const runner: RunnerSpec = {
      kind: "sdk",
      engine: "fixture",
      profile: {
        name: "fixture-sdk",
        platform: "opencode-sdk",
        personaChannel: "native",
        bin: "opencode",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
      fallbackConnection: {
        provider: "openai-compatible",
        endpoint: "https://fallback.invalid/v1/chat/completions",
        model: "provider/fallback-model",
      },
      fallbackCredential: { names: ["AKM_WP5_SDK_FALLBACK_KEY"], required: true },
    };
    const lowered = lowerResolvedExecutionRequestWithRunner(requestFor("opencode-sdk", "sdk"), runner);

    await withEnv({ AKM_WP5_SDK_FALLBACK_KEY: secret }, async () => {
      const lease = await acquireLoweredExecutionDispatchLease(lowered);
      mutateScopedEnv("AKM_WP5_SDK_FALLBACK_KEY", undefined);
      let captured: string | undefined;
      await dispatchLoweredExecutionRequest(lowered, {
        lease,
        runSdk: async (_profile, _prompt, _options, fallbackConnection) => {
          captured = fallbackConnection?.apiKey;
          return { ok: true, stdout: secret, stderr: secret, exitCode: 0, durationMs: 0 };
        },
      });
      expect(captured).toBe(secret);
      const result = await dispatchLoweredExecutionRequest(lowered, {
        lease,
        runSdk: async () => ({ ok: true, stdout: secret, stderr: "", exitCode: 0, durationMs: 0 }),
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(() => JSON.stringify(lease)).toThrow(/dispatch lease.*serializ/i);
      disposeLoweredExecutionDispatchLease(lease);
    });
  });

  test("an SDK fallback lease cannot cross to a different fallback transport", async () => {
    const sdkRunner = (endpoint: string): RunnerSpec => ({
      kind: "sdk",
      engine: "fixture",
      profile: {
        name: "fixture-sdk",
        platform: "opencode-sdk",
        personaChannel: "native",
        bin: "opencode",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
      fallbackConnection: { endpoint, model: "provider/fallback" },
    });
    const request = requestFor("opencode-sdk", "sdk");
    const first = lowerResolvedExecutionRequestWithRunner(
      request,
      sdkRunner("https://one.invalid/v1/chat/completions"),
    );
    const second = lowerResolvedExecutionRequestWithRunner(
      request,
      sdkRunner("https://two.invalid/v1/chat/completions"),
    );
    const lease = acquireLoweredExecutionDispatchLease(first);
    let sdkRan = false;
    try {
      await expect(
        dispatchLoweredExecutionRequest(second, {
          lease,
          runSdk: async () => {
            sdkRan = true;
            return { ok: true, stdout: "wrong", stderr: "", exitCode: 0, durationMs: 0 };
          },
        }),
      ).rejects.toThrow(/lease.*does not match|transport/i);
      expect(sdkRan).toBe(false);
    } finally {
      disposeLoweredExecutionDispatchLease(lease);
    }
  });

  test.each([
    "agent" as const,
    "sdk" as const,
  ])("%s lease cannot cross to a profile with different passthrough sources", async (kind) => {
    const profile = (envPassthrough: string[]) => ({
      name: `fixture-${kind}`,
      platform: kind === "sdk" ? "opencode-sdk" : "opencode",
      personaChannel: kind === "sdk" ? ("native" as const) : ("prompt" as const),
      bin: "fixture-agent",
      args: [],
      stdio: "captured" as const,
      envPassthrough,
      parseOutput: "text" as const,
    });
    const request = requestFor(kind === "sdk" ? "opencode-sdk" : "opencode", kind);
    const first = lowerResolvedExecutionRequestWithRunner(request, {
      kind,
      engine: "fixture",
      profile: profile([]),
    });
    const second = lowerResolvedExecutionRequestWithRunner(request, {
      kind,
      engine: "fixture",
      profile: profile(["AKM_WP5_NEW_PASSTHROUGH"]),
    });
    const lease = acquireLoweredExecutionDispatchLease(first);
    let runnerCalled = false;
    try {
      await expect(
        dispatchLoweredExecutionRequest(second, {
          lease,
          ...(kind === "sdk"
            ? {
                runSdk: async () => {
                  runnerCalled = true;
                  return { ok: true as const, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
                },
              }
            : {
                runAgent: async () => {
                  runnerCalled = true;
                  return { ok: true as const, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
                },
              }),
        }),
      ).rejects.toThrow(/lease.*does not match|transport/i);
      expect(runnerCalled).toBe(false);
    } finally {
      disposeLoweredExecutionDispatchLease(lease);
    }
  });

  test.each([
    ...CLI_HARNESSES,
    "opencode-sdk",
  ])("%s receives the exact resolved model, command, persona, and selected fields", (platform) => {
    const request = requestFor(platform);
    const lowered = lowerResolvedExecutionRequest(request, configFor(platform));

    expect(lowered.adapter).toBe(platform);
    expect(lowered.runner.kind).toBe(platform === "opencode-sdk" ? "sdk" : "agent");
    if (lowered.runner.kind === "llm") throw new Error("fixture must lower to an agent transport");
    if (!("dispatch" in lowered)) throw new Error("fixture must use an agent lowerer");
    expect(lowered.runner.profile.model).toBe("provider/exact-model");
    expect(lowered.options.timeoutMs).toBe(0);
    expect(lowered.options.cwd).toBe("/fixture/workspace");
    expect(lowered.options.env).toEqual({});
    expect(lowered.dispatch.model).toBe("provider/exact-model");
    expect(lowered.dispatch.inference).toEqual({
      effort: "high",
      temperature: 0,
      extraParams: {},
      supportsJsonSchema: true,
    });
    expect(lowered.dispatch.tools).toEqual(["Read", "Grep"]);
    expect(lowered.dispatch.schema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });

    const nativePersona =
      platform === "opencode" || platform === "claude" || platform === "pi" || platform === "opencode-sdk";
    if (nativePersona) {
      expect(lowered.prompt).toBe("Review the exact target.");
      expect(lowered.dispatch.systemPrompt).toBe("You are the exact persona.\n");
    } else {
      expect(lowered.dispatch.systemPrompt).toBeUndefined();
      expect(lowered.prompt).toBe(
        `${PERSONA_FALLBACK_BEGIN}\nYou are the exact persona.\n${PERSONA_FALLBACK_END}\n\nReview the exact target.`,
      );
    }
    expect(lowered.translatedFields).toContain("model");
    expect(lowered.translatedFields).toContain("command.content");
    expect(lowered.notices.every((notice) => !JSON.stringify(notice).includes("Review the exact target"))).toBe(true);
  });

  test("direct LLM lowers exact transport values and reports untranslated tools optimistically", () => {
    const lowered = lowerResolvedExecutionRequest(
      requestFor("fixture-llm", "llm", {
        inference: { effort: "high", temperature: 0, contextLength: 4096, supportsJsonSchema: true },
      }),
      configFor("fixture-llm", "llm"),
    );
    expect(lowered.runner.kind).toBe("llm");
    if (lowered.runner.kind !== "llm") throw new Error("fixture must lower to LLM");
    if (!("messages" in lowered)) throw new Error("fixture must use the LLM lowerer");
    expect(lowered.runner.connection.model).toBe("provider/exact-model");
    expect(lowered.runner.connection.temperature).toBe(0);
    expect(lowered.runner.connection.contextLength).toBe(4096);
    expect(lowered.messages).toEqual([
      { role: "system", content: "You are the exact persona.\n" },
      { role: "user", content: "Review the exact target." },
    ]);
    expect(lowered.chatOptions).toMatchObject({
      timeoutMs: 0,
      responseSchema: { type: "object", properties: {}, additionalProperties: false },
    });
    expect(lowered.untranslatedFields).toContain("tools");
    expect(lowered.notices.some((notice) => notice.field === "tools")).toBe(true);
  });

  test.each([
    "direct",
    "task",
    "workflow",
  ] as const)("%s preserves an exact bare selector for matching native harness lowering", (invocationKind) => {
    const exactAgent = "Review-Team.Exact";
    const prepared = prepareInlineExecution({
      content: "Review exact selector dispatch.",
      config: configFor("claude"),
      invocationKind,
      current: { agent: exactAgent, tools: [] },
    });
    const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
    if (!("dispatch" in lowered)) throw new Error("fixture must use a native agent lowerer");
    expect(lowered.request.agent).toBe(exactAgent);
    expect(lowered.dispatch.agent).toBe(exactAgent);
    expect(lowered.translatedFields).toContain("agent");
    expect(lowered.untranslatedFields).not.toContain("agent");
  });

  test("rejects a bare selector before dispatch when the chosen harness has no exact native channel", async () => {
    const unsupported = requestFor("aider", "agent", {
      agent: "Review-Team.Exact",
      persona: null,
      tools: [],
      authorization: { status: "not-required" },
    });
    expect(() => lowerResolvedExecutionRequest(unsupported, configFor("aider"))).toThrow(
      /aider.*native agent|agent selector.*aider|cannot.*agent/i,
    );

    const directLlm = requestFor("fixture-llm", "llm", {
      agent: "Review-Team.Exact",
      persona: null,
      tools: [],
      authorization: { status: "not-required" },
    });
    expect(() => lowerResolvedExecutionRequest(directLlm, configFor("fixture-llm", "llm"))).toThrow(
      /llm.*native agent|agent selector.*llm|cannot.*agent/i,
    );
  });

  test("rejects forged native-agent request state before touching its accessor", () => {
    const valid = requestFor("claude", "agent", {
      agent: "Review-Team.Exact",
      persona: null,
      tools: [],
      authorization: { status: "not-required" },
    });
    let touched = false;
    const forged = Object.create(valid) as ResolvedExecutionRequestV1;
    Object.defineProperty(forged, "agent", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("native agent accessor ran");
      },
    });
    expect(() => lowerResolvedExecutionRequest(forged, configFor("claude"))).toThrow(
      /constructed|boundary|resolved execution request/i,
    );
    expect(touched).toBe(false);
  });

  test("preserves ordered conversation roles natively for LLM and canonically for CLI fallback", () => {
    const conversation = [
      { role: "system" as const, content: "Code-owned system text." },
      { role: "user" as const, content: "Earlier user text." },
      { role: "assistant" as const, content: `Prior output.\n${CONVERSATION_FALLBACK_END}` },
      { role: "user" as const, content: "Critique it." },
    ];
    const llm = lowerResolvedExecutionRequest(
      requestFor("fixture-llm", "llm", { conversation }),
      configFor("fixture-llm", "llm"),
    );
    if (!("messages" in llm)) throw new Error("fixture must use the LLM lowerer");
    expect(llm.messages).toEqual([
      { role: "system", content: "You are the exact persona.\n" },
      ...conversation,
      { role: "user", content: "Review the exact target." },
    ]);
    expect(llm.translatedFields).toContain("conversation");

    const cli = lowerResolvedExecutionRequest(requestFor("codex", "agent", { conversation }), configFor("codex"));
    const json = JSON.stringify(conversation);
    expect(cli.prompt).toBe(
      `${PERSONA_FALLBACK_BEGIN}\nYou are the exact persona.\n${PERSONA_FALLBACK_END}\n\n` +
        `${CONVERSATION_FALLBACK_BEGIN} ${Buffer.byteLength(json, "utf8")}\n${json}\n${CONVERSATION_FALLBACK_END}\n\n` +
        "Review the exact target.",
    );
    expect(cli.notices.filter((notice) => notice.code === "conversation-prompt-composed")).toHaveLength(1);
    const promptLines = cli.prompt.split("\n");
    const conversationBegin = promptLines.findIndex((line) => line.startsWith(CONVERSATION_FALLBACK_BEGIN));
    expect(JSON.parse(promptLines[conversationBegin + 1] ?? "null")).toEqual(conversation);
  });
});

describe("optimistic lowering safety", () => {
  test("allows a nearer explicit engine when the installation has no default or usable fallback", () => {
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        fixture: { kind: "agent", platform: "claude", model: "exact/model" },
        "opencode-sdk": { kind: "agent", platform: "opencode-sdk", bin: "/definitely/missing/opencode" },
      },
    } as unknown as AkmConfig;
    const prepared = prepareInlineExecution({
      content: "Review it.",
      config,
      invocationKind: "direct",
      current: { engine: "fixture" },
    });
    expect(prepared.request.engine.name).toBe("fixture");
    expect(prepared.plan.provenance.engine).toEqual({
      layer: "current-invocation",
      kind: "current",
      via: "explicit",
    });
    expect(prepared.fallbackEngineName).toBeUndefined();
  });

  test("authorization denial happens before config access, lowerer selection, credentials, or dispatch", () => {
    const denied = requestFor("claude", "agent", {
      authorization: { status: "denied", reason: "fixture denial", policy: { id: "deny" } },
    });
    let touched = false;
    const config = Object.defineProperty({}, "engines", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("config must not be read");
      },
    }) as AkmConfig;
    expect(() => lowerResolvedExecutionRequest(denied, config)).toThrow(/fixture denial/);
    expect(touched).toBe(false);
  });

  test("lowers from symbolic frozen runner material without live config or credential reads", () => {
    const request = requestFor("fixture-llm", "llm", {
      tools: [],
      authorization: { status: "not-required" },
    });
    const connection = {
      provider: "openai-compatible",
      endpoint: "https://frozen.invalid/v1/chat/completions",
      model: "frozen/base-must-not-win",
      supportsJsonSchema: true,
      providerOptions: { nested: { retained: true } },
    };
    const runner = {
      kind: "llm" as const,
      engine: "fixture",
      connection,
      credential: { names: ["AKM_WP5_MISSING_CREDENTIAL"] as [string], required: true },
      timeoutMs: 99,
    };

    delete process.env.AKM_WP5_MISSING_CREDENTIAL;
    const lowered = lowerResolvedExecutionRequestWithRunner(request, runner);
    if (lowered.runner.kind !== "llm") throw new Error("fixture must use LLM runner material");
    expect(lowered.runner.connection.model).toBe("provider/exact-model");
    expect(lowered.runner.timeoutMs).toBe(0);
    expect(Object.isFrozen(lowered.runner)).toBe(true);
    expect(Object.isFrozen(lowered.runner.connection)).toBe(true);
    expect(Object.isFrozen(lowered.runner.connection.providerOptions)).toBe(true);
    expect(Object.isFrozen(lowered.runner.credential)).toBe(true);
    connection.providerOptions.nested.retained = false;
    expect(lowered.runner.connection.providerOptions).toEqual({ nested: { retained: true } });
  });

  test("prepares an authorized conversation request from config-free frozen runner material", () => {
    const runner = {
      kind: "llm" as const,
      engine: "frozen-judge",
      connection: {
        endpoint: "https://frozen.invalid/v1/chat/completions",
        model: "balanced",
        temperature: 0,
      },
      credential: { names: ["AKM_FROZEN_JUDGE_KEY"] as [string], required: false },
      timeoutMs: 0,
    };
    const conversation = [
      { role: "system" as const, content: "Judge against the code-owned rubric." },
      { role: "assistant" as const, content: "Prior candidate." },
    ];
    const prepared = prepareInlineExecutionWithRunner({
      content: "Repair it.",
      conversation,
      runner,
      invocationKind: "direct",
    });
    expect(prepared.request.model).toEqual({
      input: "balanced",
      interpretation: "exact",
      resolved: "balanced",
    });
    expect(prepared.request.conversation).toEqual(conversation);
    const lowered = lowerResolvedExecutionRequestWithRunner(prepared.request, prepared.runner);
    if (!("messages" in lowered)) throw new Error("fixture must use direct LLM lowering");
    expect(lowered.messages).toEqual([...conversation, { role: "user", content: "Repair it." }]);
  });

  test.each([
    "direct",
    "task",
    "workflow",
  ] as const)("freezes an SDK fallback model-map selection and structured inference during %s preparation", (invocationKind) => {
    const config = {
      engines: {
        fixture: {
          kind: "agent",
          platform: "opencode-sdk",
          llmEngine: "fallback",
        },
        fallback: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fallback.invalid/v1/chat/completions",
          model: "fast",
          temperature: 0.25,
        },
      },
      defaults: { engine: "fixture", llmEngine: "fallback" },
    } as unknown as AkmConfig;
    const modelMap = {
      version: 1,
      aliases: {
        fast: {
          fallback: {
            model: "provider/exact-fallback-model",
            inference: { maxTokens: 321, enableThinking: true },
          },
        },
      },
    } as const satisfies ResolvedModelMapV1;
    const prepared = prepareInlineExecution({
      content: "Use the frozen fallback.",
      config,
      modelMap,
      invocationKind,
      current: { tools: [] },
    });

    expect(prepared.request.model).toEqual({
      input: "fast",
      interpretation: "alias",
      resolved: "provider/exact-fallback-model",
    });
    expect(prepared.request.inference).toEqual({
      maxTokens: 321,
      enableThinking: true,
      temperature: 0.25,
    });
    expect(prepared.request.engine.settings).toMatchObject({ sdkFallbackModelFromRequest: true });

    // Lowering must consume only the canonical request selection. Neither a
    // later config edit nor a changed model map can reinterpret the frozen
    // fallback identity.
    const mutableEngines = config.engines as Record<string, { llmEngine?: string }>;
    (mutableEngines.fixture as { llmEngine: string }).llmEngine = "changed-after-preparation";
    (modelMap.aliases.fast.fallback as { model: string }).model = "changed-after-preparation";
    const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
    expect(lowered.runner.kind).toBe("sdk");
    if (lowered.runner.kind !== "sdk") throw new Error("fixture must use SDK lowering");
    expect(lowered.runner.profile.model).toBe("provider/exact-fallback-model");
    expect(lowered.runner.fallbackConnection).toMatchObject({
      model: "provider/exact-fallback-model",
      maxTokens: 321,
      enableThinking: true,
      temperature: 0.25,
    });
  });

  test("does not re-alias an explicit SDK primary model while freezing fallback transport", () => {
    const config = {
      engines: {
        fixture: {
          kind: "agent",
          platform: "opencode-sdk",
          model: "configured-primary-must-not-win",
          llmEngine: "fallback",
        },
        fallback: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fallback.invalid/v1/chat/completions",
          model: "fast",
        },
      },
      defaults: { engine: "fixture", llmEngine: "fallback" },
    } as unknown as AkmConfig;
    const modelMap = {
      version: 1,
      aliases: {
        primary: {
          "opencode-sdk": { model: "provider/exact-primary-model" },
        },
      },
    } as const satisfies ResolvedModelMapV1;
    const prepared = prepareInlineExecution({
      content: "Keep the primary exact.",
      config,
      modelMap,
      invocationKind: "direct",
      current: {
        model: "primary",
        tools: [],
      },
    });
    const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
    expect(lowered.runner.kind).toBe("sdk");
    if (lowered.runner.kind !== "sdk") throw new Error("fixture must use SDK lowering");
    expect(lowered.runner.profile.model).toBe("provider/exact-primary-model");
    expect(lowered.runner.fallbackConnection?.model).toBe("fast");
  });

  test.each([
    "direct",
    "task",
    "workflow",
  ] as const)("keeps live and frozen SDK primary/fallback projection byte-exact for %s", (invocationKind) => {
    const config = {
      engines: {
        fixture: {
          kind: "agent",
          platform: "opencode-sdk",
          model: "provider/configured-primary",
          llmEngine: "fallback",
        },
        fallback: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fallback.invalid/v1/chat/completions",
          model: "provider/configured-fallback",
          temperature: 0.25,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true } },
          contextLength: 8_192,
          enableThinking: false,
          timeoutMs: 12_345,
        },
      },
      defaults: { engine: "fixture", llmEngine: "fallback" },
    } as unknown as AkmConfig;
    const frozenRunner = resolveEngine("fixture", config);
    expect(frozenRunner.kind).toBe("sdk");

    const cases: readonly {
      readonly name: string;
      readonly current: Record<string, unknown>;
      readonly expectedProfileModel: string | undefined;
      readonly expectedFallbackModel: string | undefined;
      readonly expectedInference: ExecutionJsonObject | null;
      readonly expectedTimeout: number | null;
    }[] = [
      {
        name: "omitted model, inference, and timeout",
        current: { tools: [] },
        expectedProfileModel: "provider/configured-primary",
        expectedFallbackModel: "provider/configured-fallback",
        expectedInference: {
          temperature: 0.25,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true } },
          contextLength: 8_192,
          enableThinking: false,
        },
        expectedTimeout: 12_345,
      },
      {
        name: "explicit primary model",
        current: { model: "provider/operator-primary", tools: [] },
        expectedProfileModel: "provider/operator-primary",
        expectedFallbackModel: "provider/configured-fallback",
        expectedInference: {
          temperature: 0.25,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true } },
          contextLength: 8_192,
          enableThinking: false,
        },
        expectedTimeout: 12_345,
      },
      {
        name: "explicit null model",
        current: { model: null, tools: [] },
        expectedProfileModel: undefined,
        expectedFallbackModel: undefined,
        expectedInference: {
          temperature: 0.25,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true } },
          contextLength: 8_192,
          enableThinking: false,
        },
        expectedTimeout: 12_345,
      },
      {
        name: "explicit inference object",
        current: {
          inference: { temperature: 0, extraParams: { nested: { invocation: true } } },
          tools: [],
        },
        expectedProfileModel: "provider/configured-primary",
        expectedFallbackModel: "provider/configured-fallback",
        expectedInference: {
          temperature: 0,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true, invocation: true } },
          contextLength: 8_192,
          enableThinking: false,
        },
        expectedTimeout: 12_345,
      },
      {
        name: "explicit null inference",
        current: { inference: null, tools: [] },
        expectedProfileModel: "provider/configured-primary",
        expectedFallbackModel: "provider/configured-fallback",
        expectedInference: null,
        expectedTimeout: 12_345,
      },
      {
        name: "explicit zero timeout",
        current: { timeout: 0, tools: [] },
        expectedProfileModel: "provider/configured-primary",
        expectedFallbackModel: "provider/configured-fallback",
        expectedInference: {
          temperature: 0.25,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true } },
          contextLength: 8_192,
          enableThinking: false,
        },
        expectedTimeout: 0,
      },
      {
        name: "explicit null timeout",
        current: { timeout: null, tools: [] },
        expectedProfileModel: "provider/configured-primary",
        expectedFallbackModel: "provider/configured-fallback",
        expectedInference: {
          temperature: 0.25,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true } },
          contextLength: 8_192,
          enableThinking: false,
        },
        expectedTimeout: null,
      },
      {
        name: "explicit finite timeout",
        current: { timeout: 7_777, tools: [] },
        expectedProfileModel: "provider/configured-primary",
        expectedFallbackModel: "provider/configured-fallback",
        expectedInference: {
          temperature: 0.25,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true } },
          contextLength: 8_192,
          enableThinking: false,
        },
        expectedTimeout: 7_777,
      },
    ];

    for (const fixture of cases) {
      const current = fixture.current as import("../../src/execution/source").UnresolvedExecutionDefaults;
      const live = prepareInlineExecution({
        content: `Exercise ${fixture.name}.`,
        config,
        invocationKind,
        current,
      });
      const frozen = prepareInlineExecutionWithRunner({
        content: `Exercise ${fixture.name}.`,
        runner: frozenRunner,
        invocationKind,
        current,
      });

      expect(canonicalResolvedExecutionRequest(live.request)).toBe(canonicalResolvedExecutionRequest(frozen.request));
      expect(live.request.notices).toEqual(frozen.request.notices);
      expect(live.request.inference).toEqual(fixture.expectedInference);
      expect(live.request.runtime.timeoutMs).toBe(fixture.expectedTimeout);

      const liveLowered = lowerResolvedExecutionRequest(live.request, live.config);
      const frozenLowered = lowerResolvedExecutionRequestWithRunner(frozen.request, frozen.runner);
      expect(liveLowered).toEqual(frozenLowered);
      expect(liveLowered.runner).toEqual(frozenLowered.runner);
      expect(liveLowered.runner.kind).toBe("sdk");
      if (liveLowered.runner.kind !== "sdk") throw new Error("fixture must lower to SDK");
      expect(liveLowered.runner.profile.model).toBe(fixture.expectedProfileModel);
      expect(liveLowered.runner.fallbackConnection?.model).toBe(fixture.expectedFallbackModel);
      for (const key of [
        "temperature",
        "maxTokens",
        "supportsJsonSchema",
        "extraParams",
        "contextLength",
        "enableThinking",
      ] as const) {
        expect(liveLowered.runner.fallbackConnection?.[key] as unknown).toEqual(
          fixture.expectedInference?.[key] as unknown,
        );
      }
      expect(liveLowered.runner.timeoutMs).toBe(fixture.expectedTimeout);
      expect(liveLowered.runner.fallbackTimeoutMs).toBe(12_345);
    }
  });

  test("keeps an SDK agent-owned timeout distinct from the fallback transport timeout", () => {
    const config = {
      engines: {
        fixture: {
          kind: "agent",
          platform: "opencode-sdk",
          model: "provider/primary",
          llmEngine: "fallback",
          timeoutMs: 6_789,
        },
        fallback: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fallback.invalid/v1/chat/completions",
          model: "provider/fallback",
          timeoutMs: 12_345,
        },
      },
      defaults: { engine: "fixture", llmEngine: "fallback" },
    } as unknown as AkmConfig;
    const runner = resolveEngine("fixture", config);
    const live = prepareInlineExecution({
      content: "Keep timeout layers distinct.",
      config,
      invocationKind: "direct",
      current: { tools: [] },
    });
    const frozen = prepareInlineExecutionWithRunner({
      content: "Keep timeout layers distinct.",
      runner,
      invocationKind: "direct",
      current: { tools: [] },
    });
    expect(live.request.runtime.timeoutMs).toBe(6_789);
    expect(frozen.request.runtime.timeoutMs).toBe(6_789);
    expect(canonicalResolvedExecutionRequest(live.request)).toBe(canonicalResolvedExecutionRequest(frozen.request));
    expect(live.request.notices).toEqual(frozen.request.notices);
    const liveLowered = lowerResolvedExecutionRequest(live.request, live.config);
    const frozenLowered = lowerResolvedExecutionRequestWithRunner(frozen.request, frozen.runner);
    expect(liveLowered).toEqual(frozenLowered);
    expect(liveLowered.runner).toEqual(frozenLowered.runner);
    expect(liveLowered.runner).toMatchObject({
      kind: "sdk",
      timeoutMs: 6_789,
      fallbackTimeoutMs: 12_345,
    });
  });

  test.each([
    "direct",
    "task",
    "workflow",
  ] as const)("keeps fallback-derived SDK projection byte-exact for %s", (invocationKind) => {
    const config = {
      engines: {
        fixture: { kind: "agent", platform: "opencode-sdk", llmEngine: "fallback" },
        fallback: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fallback.invalid/v1/chat/completions",
          model: "provider/configured-fallback",
          temperature: 0.25,
          maxTokens: 512,
          supportsJsonSchema: false,
          extraParams: { seed: 3, nested: { base: true } },
          contextLength: 8_192,
          enableThinking: false,
          timeoutMs: 12_345,
        },
      },
      defaults: { engine: "fixture", llmEngine: "fallback" },
    } as unknown as AkmConfig;
    const frozenRunner = resolveEngine("fixture", config);
    const baseInference: ExecutionJsonObject = {
      temperature: 0.25,
      maxTokens: 512,
      supportsJsonSchema: false,
      extraParams: { seed: 3, nested: { base: true } },
      contextLength: 8_192,
      enableThinking: false,
    };
    const cases: readonly {
      readonly name: string;
      readonly current: import("../../src/execution/source").UnresolvedExecutionDefaults;
      readonly expectedModel: string | undefined;
      readonly expectedInference: ExecutionJsonObject | null;
      readonly expectedTimeout: number | null;
    }[] = [
      {
        name: "omitted model, inference, and timeout",
        current: { tools: [] },
        expectedModel: "provider/configured-fallback",
        expectedInference: baseInference,
        expectedTimeout: 12_345,
      },
      {
        name: "explicit model",
        current: { model: "provider/operator-model", tools: [] },
        expectedModel: "provider/operator-model",
        expectedInference: baseInference,
        expectedTimeout: 12_345,
      },
      {
        name: "null model",
        current: { model: null, tools: [] },
        expectedModel: undefined,
        expectedInference: baseInference,
        expectedTimeout: 12_345,
      },
      {
        name: "inference object",
        current: {
          inference: { temperature: 0, extraParams: { nested: { invocation: true } } },
          tools: [],
        },
        expectedModel: "provider/configured-fallback",
        expectedInference: {
          ...baseInference,
          temperature: 0,
          extraParams: { seed: 3, nested: { base: true, invocation: true } },
        },
        expectedTimeout: 12_345,
      },
      {
        name: "null inference",
        current: { inference: null, tools: [] },
        expectedModel: "provider/configured-fallback",
        expectedInference: null,
        expectedTimeout: 12_345,
      },
      {
        name: "zero timeout",
        current: { timeout: 0, tools: [] },
        expectedModel: "provider/configured-fallback",
        expectedInference: baseInference,
        expectedTimeout: 0,
      },
      {
        name: "null timeout",
        current: { timeout: null, tools: [] },
        expectedModel: "provider/configured-fallback",
        expectedInference: baseInference,
        expectedTimeout: null,
      },
      {
        name: "finite timeout",
        current: { timeout: 7_777, tools: [] },
        expectedModel: "provider/configured-fallback",
        expectedInference: baseInference,
        expectedTimeout: 7_777,
      },
    ];

    for (const fixture of cases) {
      const content = `Exercise fallback-derived ${fixture.name}.`;
      const live = prepareInlineExecution({ content, config, invocationKind, current: fixture.current });
      const frozen = prepareInlineExecutionWithRunner({
        content,
        runner: frozenRunner,
        invocationKind,
        current: fixture.current,
      });
      expect(live.request.engine.settings).toMatchObject({ sdkFallbackModelFromRequest: true });
      expect(canonicalResolvedExecutionRequest(live.request)).toBe(canonicalResolvedExecutionRequest(frozen.request));
      expect(live.request.notices).toEqual(frozen.request.notices);
      expect(live.request.inference).toEqual(fixture.expectedInference);
      expect(live.request.runtime.timeoutMs).toBe(fixture.expectedTimeout);

      const liveLowered = lowerResolvedExecutionRequest(live.request, live.config);
      const frozenLowered = lowerResolvedExecutionRequestWithRunner(frozen.request, frozen.runner);
      expect(liveLowered).toEqual(frozenLowered);
      expect(liveLowered.runner.kind).toBe("sdk");
      if (liveLowered.runner.kind !== "sdk") throw new Error("fixture must lower to SDK");
      expect(liveLowered.runner.profile.model).toBe(fixture.expectedModel);
      expect(liveLowered.runner.fallbackConnection?.model).toBe(fixture.expectedModel);
      for (const key of [
        "temperature",
        "maxTokens",
        "supportsJsonSchema",
        "extraParams",
        "contextLength",
        "enableThinking",
      ] as const) {
        expect(liveLowered.runner.fallbackConnection?.[key] as unknown).toEqual(
          fixture.expectedInference?.[key] as unknown,
        );
      }
      expect(liveLowered.runner.timeoutMs).toBe(fixture.expectedTimeout);
      expect(liveLowered.runner.fallbackTimeoutMs).toBe(12_345);
    }
  });

  test.each([
    "direct",
    "task",
    "workflow",
  ] as const)("keeps SDK preparation byte-exact without a primary model or fallback for %s", (invocationKind) => {
    const config = {
      engines: { fixture: { kind: "agent", platform: "opencode-sdk" } },
      defaults: { engine: "fixture" },
    } as unknown as AkmConfig;
    const frozenRunner = resolveEngine("fixture", config);
    const cases: readonly {
      readonly current: import("../../src/execution/source").UnresolvedExecutionDefaults;
      readonly expectedModel?: string;
      readonly expectedInference?: ExecutionJsonObject | null;
      readonly expectedTimeout: number | null;
    }[] = [
      { current: { tools: [] }, expectedTimeout: null },
      {
        current: { model: "provider/operator-model", tools: [] },
        expectedModel: "provider/operator-model",
        expectedTimeout: null,
      },
      { current: { model: null, tools: [] }, expectedTimeout: null },
      {
        current: { inference: { temperature: 0 }, tools: [] },
        expectedInference: { temperature: 0 },
        expectedTimeout: null,
      },
      { current: { inference: null, tools: [] }, expectedInference: null, expectedTimeout: null },
      { current: { timeout: 0, tools: [] }, expectedTimeout: 0 },
      { current: { timeout: null, tools: [] }, expectedTimeout: null },
      { current: { timeout: 7_777, tools: [] }, expectedTimeout: 7_777 },
    ];

    for (const [index, fixture] of cases.entries()) {
      const content = `Exercise standalone SDK case ${index}.`;
      const live = prepareInlineExecution({ content, config, invocationKind, current: fixture.current });
      const frozen = prepareInlineExecutionWithRunner({
        content,
        runner: frozenRunner,
        invocationKind,
        current: fixture.current,
      });
      expect(canonicalResolvedExecutionRequest(live.request)).toBe(canonicalResolvedExecutionRequest(frozen.request));
      expect(live.request.notices).toEqual(frozen.request.notices);
      expect(live.request.inference).toEqual(fixture.expectedInference);
      expect(Object.hasOwn(live.request.runtime, "timeoutMs")).toBe(true);
      expect(live.request.runtime.timeoutMs).toBe(fixture.expectedTimeout);

      const liveLowered = lowerResolvedExecutionRequest(live.request, live.config);
      const frozenLowered = lowerResolvedExecutionRequestWithRunner(frozen.request, frozen.runner);
      expect(liveLowered).toEqual(frozenLowered);
      expect(liveLowered.runner.kind).toBe("sdk");
      if (liveLowered.runner.kind !== "sdk") throw new Error("fixture must lower to SDK");
      expect(liveLowered.runner.profile.model).toBe(fixture.expectedModel);
      expect(liveLowered.runner.fallbackConnection).toBeUndefined();
      expect(liveLowered.runner.timeoutMs).toBe(fixture.expectedTimeout);
    }
  });

  test.each([
    ["operator/exact-model", "operator/exact-model"],
    [null, undefined],
  ] as const)("projects an SDK model override %p onto primary and fallback transport", (model, expected) => {
    const config = {
      engines: {
        fixture: { kind: "agent", platform: "opencode-sdk", llmEngine: "fallback" },
        fallback: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fallback.invalid/v1/chat/completions",
          model: "provider/configured-fallback",
        },
      },
      defaults: { engine: "fixture", llmEngine: "fallback" },
    } as unknown as AkmConfig;
    const prepared = prepareInlineExecution({
      content: "Use the selected SDK model.",
      config,
      invocationKind: "direct",
      current: { model, tools: [] },
    });
    const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
    expect(lowered.runner.kind).toBe("sdk");
    if (lowered.runner.kind !== "sdk") throw new Error("fixture must use SDK lowering");
    expect(lowered.runner.profile.model).toBe(expected);
    expect(lowered.runner.fallbackConnection?.model).toBe(expected);
  });

  test("preserves an SDK fallback-derived whole-run timeout unless request runtime explicitly overrides it", () => {
    const config = {
      engines: {
        fixture: { kind: "agent", platform: "opencode-sdk", llmEngine: "fallback" },
        fallback: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fallback.invalid/v1/chat/completions",
          model: "provider/fallback",
          timeoutMs: 12_345,
        },
      },
      defaults: { engine: "fixture", llmEngine: "fallback" },
    } as unknown as AkmConfig;
    const legacy = resolveEngine("fixture", config);
    expect(legacy.kind).toBe("sdk");
    if (legacy.kind !== "sdk") throw new Error("fixture must resolve to SDK");
    expect(legacy.timeoutMs).toBe(12_345);
    expect(legacy.fallbackTimeoutMs).toBe(12_345);

    const prepared = prepareInlineExecution({
      content: "Preserve SDK timeout.",
      config,
      invocationKind: "direct",
      current: { tools: [] },
    });
    const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
    expect(lowered.runner.kind).toBe("sdk");
    if (lowered.runner.kind !== "sdk") throw new Error("fixture must lower to SDK");
    expect(lowered.runner.timeoutMs).toBe(legacy.timeoutMs);
    expect(lowered.runner.fallbackTimeoutMs).toBe(legacy.fallbackTimeoutMs);

    const explicit = lowerResolvedExecutionRequest(
      requestFor("opencode-sdk", "sdk", { runtime: { timeoutMs: null } }),
      config,
    );
    expect(explicit.runner.kind).toBe("sdk");
    if (explicit.runner.kind !== "sdk") throw new Error("fixture must lower to SDK");
    expect(explicit.runner.timeoutMs).toBeNull();
    expect(explicit.runner.fallbackTimeoutMs).toBe(12_345);
  });

  test("frozen-runner lowering validates authorization before touching hostile runner material", () => {
    const denied = requestFor("claude", "agent", {
      authorization: { status: "denied", reason: "runner must stay untouched", policy: { id: "deny" } },
    });
    let touched = false;
    const runner = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("runner accessor must not run");
      },
    });
    expect(() => lowerResolvedExecutionRequestWithRunner(denied, runner as never)).toThrow(
      /runner must stay untouched/,
    );
    expect(touched).toBe(false);
  });

  test("binds config-free lowering to the resolved engine name and LLM provider", () => {
    const request = requestFor("openai-compatible", "llm", {
      tools: [],
      authorization: { status: "not-required" },
    });
    const base = {
      kind: "llm" as const,
      engine: "fixture",
      connection: {
        provider: "openai-compatible",
        endpoint: "https://frozen.invalid/v1/chat/completions",
        model: "frozen/base",
      },
    };
    expect(() => lowerResolvedExecutionRequestWithRunner(request, { ...base, engine: "different-engine" })).toThrow(
      /engine.*name|identity|different-engine/i,
    );
    expect(() =>
      lowerResolvedExecutionRequestWithRunner(request, {
        ...base,
        connection: { ...base.connection, provider: "different-provider" },
      }),
    ).toThrow(/provider|platform/i);
  });

  test("unsupported fields produce deterministic secret-free notices and runtime rejection still dispatches", async () => {
    process.env.AKM_WP5_FIXTURE_KEY = "wp5-super-secret";
    try {
      const request = requestFor("fixture-llm", "llm", {
        inference: { vendorUnknown: { enabled: true } },
        tools: { allow: ["Read"] },
      });
      const lowered = lowerResolvedExecutionRequest(request, configFor("fixture-llm", "llm"));
      expect(lowered.untranslatedFields).toContain("inference.vendorUnknown");
      expect(lowered.untranslatedFields).toContain("tools");
      expect(JSON.stringify(lowered.notices)).not.toContain("wp5-super-secret");

      let calls = 0;
      const result = await dispatchLoweredExecutionRequest(lowered, {
        chat: async () => {
          calls += 1;
          throw new Error("provider rejected fixture option with wp5-super-secret");
        },
      });
      expect(result).toMatchObject({
        ok: false,
        reason: "spawn_failed",
        error: "provider rejected fixture option with [REDACTED]",
      });
      expect(Object.hasOwn(result, "llmErrorCode")).toBe(false);
      expect(JSON.stringify(result)).not.toContain("wp5-super-secret");
      expect(calls).toBe(1);
    } finally {
      delete process.env.AKM_WP5_FIXTURE_KEY;
    }
  });

  test("reconstructs durable request notices from a fixed safe vocabulary", () => {
    const sentinel = "DO-NOT-LEAK-request-notice";
    for (const [platform, kind, config] of [
      ["claude", "agent", configFor("claude")],
      ["fixture-llm", "llm", configFor("fixture-llm", "llm")],
    ] as const) {
      const request = requestFor(platform, kind, {
        notices: [
          {
            code: "engine-fallback",
            severity: "warning",
            adapter: sentinel,
            field: sentinel,
            message: sentinel,
            details: { sentinel },
          },
          {
            code: "unknown-provider-body",
            severity: "warning",
            adapter: sentinel,
            message: sentinel,
            details: { nested: sentinel },
          },
          {
            code: "second-unknown-provider-body",
            severity: "info",
            adapter: sentinel,
            message: sentinel,
          },
        ],
      });
      const resumed = decodeResolvedExecutionRequest(JSON.parse(canonicalResolvedExecutionRequest(request)));
      const lowered = lowerResolvedExecutionRequest(resumed, config);
      expect(JSON.stringify(lowered.notices)).not.toContain(sentinel);
      expect(lowered.notices.filter((notice) => notice.code === "engine-fallback")).toEqual([
        {
          code: "engine-fallback",
          severity: "info",
          adapter: "akm",
          field: "engine",
          message: "No engine was selected; using the fixed opencode-sdk fallback.",
        },
      ]);
      expect(lowered.notices.filter((notice) => notice.code === "unrecognized-request-notice")).toEqual([
        {
          code: "unrecognized-request-notice",
          severity: "warning",
          adapter: "akm",
          message: "An unrecognized durable execution notice was omitted at the engine lowering boundary.",
        },
      ]);
    }
  });

  test("collects symbolic primary and SDK fallback credentials for result and out-of-band redaction", async () => {
    const primarySecret = "primary-symbolic-secret";
    const fallbackSecret = "fallback-symbolic-secret";
    const envSource = {
      PRIMARY_SYMBOLIC_KEY: primarySecret,
      FALLBACK_SYMBOLIC_KEY: fallbackSecret,
    } as NodeJS.ProcessEnv;
    const primary: RunnerSpec = {
      kind: "llm",
      engine: "primary",
      connection: {
        provider: "openai-compatible",
        endpoint: "https://primary.invalid/v1/chat/completions",
        model: "primary",
      },
      credential: { names: ["PRIMARY_SYMBOLIC_KEY"], required: true },
    };
    const sdk: RunnerSpec = {
      kind: "sdk",
      engine: "sdk",
      profile: {
        name: "sdk",
        platform: "opencode-sdk",
        bin: "opencode",
        args: [],
        stdio: "captured",
        envPassthrough: [],
        parseOutput: "text",
      },
      fallbackConnection: {
        provider: "openai-compatible",
        endpoint: "https://fallback.invalid/v1/chat/completions",
        model: "fallback",
      },
      fallbackCredential: { names: ["FALLBACK_SYMBOLIC_KEY"], required: true },
    };

    expect(collectDispatchSensitiveValues(primary, { envSource }, envSource)).toContain(primarySecret);
    const sensitive = collectDispatchSensitiveValues(sdk, { envSource }, envSource);
    expect(sensitive).toContain(fallbackSecret);
    expect(redactSensitiveText(`draft=${fallbackSecret}`, sensitive)).toBe("draft=[REDACTED]");

    // #905: a file-backed credential is read at dispatch, so the scrub set
    // must carry it exactly like the env-backed one.
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-apikeyfile-"));
    const fileSecret = "file-secret-value-3f9a";
    const apiKeyFile = path.join(keyDir, "key");
    fs.writeFileSync(apiKeyFile, `${fileSecret}\n`);
    try {
      const fromFile: RunnerSpec = { ...primary, credential: undefined, apiKeyFile };
      expect(collectDispatchSensitiveValues(fromFile, { envSource }, envSource)).toContain(fileSecret);
      const sdkFromFile: RunnerSpec = { ...sdk, fallbackCredential: undefined, fallbackApiKeyFile: apiKeyFile };
      expect(collectDispatchSensitiveValues(sdkFromFile, { envSource }, envSource)).toContain(fileSecret);
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
    }

    // #953: a secret-store-backed credential is also read at dispatch, so the
    // scrub set must carry it exactly like the env- and file-backed ones.
    const storage = withIsolatedAkmStorage();
    try {
      const primaryStoreSecret = "primary-store-secret-a1b2";
      const fallbackStoreSecret = "fallback-store-secret-c3d4";
      setSecret(path.join(storage.stashDir, "secrets", "primary-key"), Buffer.from(primaryStoreSecret));
      setSecret(path.join(storage.stashDir, "secrets", "fallback-key"), Buffer.from(fallbackStoreSecret));
      const primaryFromStore: RunnerSpec = {
        ...primary,
        credential: undefined,
        apiKeySecretRef: "secret://primary-key",
      };
      expect(collectDispatchSensitiveValues(primaryFromStore, { envSource }, envSource)).toContain(primaryStoreSecret);
      const sdkFromStore: RunnerSpec = {
        ...sdk,
        fallbackCredential: undefined,
        fallbackApiKeySecretRef: "secret://fallback-key",
      };
      expect(collectDispatchSensitiveValues(sdkFromStore, { envSource }, envSource)).toContain(fallbackStoreSecret);
    } finally {
      storage.cleanup();
    }

    const result = await withEnv({ PRIMARY_SYMBOLIC_KEY: primarySecret, FALLBACK_SYMBOLIC_KEY: fallbackSecret }, () =>
      executeRunner(
        sdk,
        "run",
        {},
        {
          runSdk: async (_profile, _prompt, _options, fallback) => {
            expect(fallback?.apiKey).toBe(fallbackSecret);
            return {
              ok: false,
              exitCode: 1,
              stdout: `OPENCODE_CONFIG_CONTENT=${JSON.stringify({ key: fallbackSecret })}`,
              stderr: fallbackSecret,
              durationMs: 1,
              error: `provider echoed ${fallbackSecret}`,
              parsed: { body: fallbackSecret },
              reason: "spawn_failed",
            };
          },
        },
      ),
    );
    expect(JSON.stringify(result)).not.toContain(fallbackSecret);
    expect(result).toMatchObject({
      stdout: 'OPENCODE_CONFIG_CONTENT={"key":"[REDACTED]"}',
      stderr: "[REDACTED]",
      error: "provider echoed [REDACTED]",
      parsed: { body: "[REDACTED]" },
    });
  });

  test.each([
    ["aborted", "aborted"],
    ["timeout", "timeout"],
    ["rate_limited", "llm_rate_limit"],
    ["parse_error", "parse_error"],
    ["provider_html_error", "parse_error"],
    ["network_error", "spawn_failed"],
    ["provider_error", "spawn_failed"],
  ] as const)("preserves direct LLM %s failure taxonomy as %s", async (code, reason) => {
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("openai-compatible", "llm", { tools: [], authorization: { status: "not-required" } }),
      {
        kind: "llm",
        engine: "fixture",
        connection: {
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "provider/exact-model",
        },
      },
    );
    const result = await dispatchLoweredExecutionRequest(lowered, {
      chat: async () => {
        throw new LlmCallError(`typed ${code} failure`, code satisfies LlmCallErrorCode);
      },
    });
    expect(result).toMatchObject({ ok: false, reason, error: `typed ${code} failure`, llmErrorCode: code });
  });

  test("preserves a safe LLM error code while redacting a typed provider body", async () => {
    const secret = "typed-provider-secret";
    await withEnv({ AKM_WP5_FIXTURE_KEY: secret }, async () => {
      const lowered = lowerResolvedExecutionRequest(
        requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } }),
        configFor("fixture-llm", "llm"),
      );
      const result = await dispatchLoweredExecutionRequest(lowered, {
        chat: async () => {
          throw new LlmCallError(`<html>provider echoed ${secret}</html>`, "provider_html_error");
        },
      });
      expect(result).toMatchObject({
        ok: false,
        reason: "parse_error",
        llmErrorCode: "provider_html_error",
        error: "<html>provider echoed [REDACTED]</html>",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  });

  test("does not invoke an accessor-backed LLM error discriminator", async () => {
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } }),
      {
        kind: "llm",
        engine: "fixture",
        connection: {
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "provider/exact-model",
        },
      },
    );
    let touched = false;
    const hostile = Object.create(LlmCallError.prototype) as LlmCallError;
    Object.defineProperty(hostile, "message", { value: "safe hostile failure" });
    Object.defineProperty(hostile, "code", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("error-code accessor ran");
      },
    });
    const result = await dispatchLoweredExecutionRequest(lowered, {
      chat: async () => {
        throw hostile;
      },
    });
    expect(touched).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: "spawn_failed", error: "safe hostile failure" });
    expect(Object.hasOwn(result, "llmErrorCode")).toBe(false);
  });

  test("persona fallback is byte-exact and applied once across durable resume", () => {
    const request = requestFor("codex");
    const first = lowerResolvedExecutionRequest(request, configFor("codex"));
    const resumed = decodeResolvedExecutionRequest(JSON.parse(canonicalResolvedExecutionRequest(request)));
    const second = lowerResolvedExecutionRequest(resumed, configFor("codex"));
    expect(second.prompt).toBe(first.prompt);
    expect(second.prompt.match(/<AKM_PERSONA>/g)).toHaveLength(1);
    expect(second.notices.filter((notice) => notice.code === "persona-prompt-composed")).toHaveLength(1);
  });

  test("only branded prototype-safe requests cross the registry boundary", () => {
    const valid = requestFor("claude");
    expect(() =>
      lowerResolvedExecutionRequest({ ...valid } as ResolvedExecutionRequestV1, configFor("claude")),
    ).toThrow(/constructed|boundary|resolved execution request/i);
    const accessor = Object.defineProperty({}, "authorization", {
      enumerable: true,
      get() {
        throw new Error("accessor ran");
      },
    });
    expect(() => lowerResolvedExecutionRequest(accessor as ResolvedExecutionRequestV1, configFor("claude"))).toThrow(
      /constructed|boundary|resolved execution request/i,
    );
  });

  test("dispatch accepts only registry-produced lowered objects", async () => {
    const lowered = lowerResolvedExecutionRequest(requestFor("claude"), configFor("claude"));
    const forged = { ...lowered } as typeof lowered;
    let dispatched = false;
    await expect(
      dispatchLoweredExecutionRequest(forged, {
        executeRunner: async () => {
          dispatched = true;
          return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
        },
      }),
    ).rejects.toThrow(/lowered execution request.*registry|provenance/i);
    expect(dispatched).toBe(false);
  });

  test("permits only operational runner overrides while resolved runtime fields remain authoritative", async () => {
    const lowered = lowerResolvedExecutionRequest(requestFor("claude"), configFor("claude"));
    let captured: unknown;
    await dispatchLoweredExecutionRequest(lowered, {
      runOptions: {
        stdio: "interactive",
        parseOutput: "json",
        timeoutMs: 99_999,
        cwd: "/must-not-win",
        env: { MUST_NOT_WIN: "true" },
      },
      executeRunner: async (_runner, _prompt, options) => {
        captured = options;
        return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
      },
    });
    expect(captured).toMatchObject({
      stdio: "interactive",
      parseOutput: "json",
      timeoutMs: 0,
      cwd: "/fixture/workspace",
      env: {},
    });
  });

  test("propagates the operational abort signal into direct LLM transport options", async () => {
    const lowered = lowerResolvedExecutionRequest(
      requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } }),
      configFor("fixture-llm", "llm"),
    );
    const controller = new AbortController();
    let captured: unknown;
    await dispatchLoweredExecutionRequest(lowered, {
      runOptions: { signal: controller.signal },
      executeRunner: async (runner, prompt, options, seams) => {
        if (runner.kind !== "llm" || !seams?.llm) throw new Error("fixture must expose the direct LLM seam");
        return seams.llm(runner, prompt, options);
      },
      chat: async (_connection, _messages, options) => {
        captured = options;
        return "done";
      },
    });
    expect(captured).toMatchObject({ timeoutMs: 0, signal: controller.signal });
  });

  test("propagates retry telemetry only into direct LLM chat options", async () => {
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } }),
      {
        kind: "llm",
        engine: "fixture",
        connection: {
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "provider/exact-model",
        },
      },
    );
    const onRetryAttempt = () => {};
    let captured: unknown;
    await dispatchLoweredExecutionRequest(lowered, {
      onRetryAttempt,
      chat: async (_connection, _messages, options) => {
        captured = options;
        return "done";
      },
    } as Parameters<typeof dispatchLoweredExecutionRequest>[1]);
    expect(captured).toMatchObject({ timeoutMs: 0, onRetryAttempt });

    for (const platform of ["claude", "opencode-sdk"] as const) {
      const native = lowerResolvedExecutionRequest(requestFor(platform), configFor(platform));
      let capturedRunOptions: unknown;
      const nativeResult = await dispatchLoweredExecutionRequest(native, {
        onRetryAttempt,
        executeRunner: async (_runner, _prompt, options) => {
          capturedRunOptions = options;
          return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
        },
      } as Parameters<typeof dispatchLoweredExecutionRequest>[1]);
      expect(Object.hasOwn(capturedRunOptions as object, "onRetryAttempt")).toBe(false);
      expect(Object.hasOwn(nativeResult, "llmErrorCode")).toBe(false);
    }
  });

  test("rejects hostile retry telemetry descriptors without invoking accessors", async () => {
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("fixture-llm", "llm", { tools: [], authorization: { status: "not-required" } }),
      {
        kind: "llm",
        engine: "fixture",
        connection: {
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "provider/exact-model",
        },
      },
    );
    let touched = false;
    const accessor = Object.defineProperty({}, "onRetryAttempt", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("retry accessor ran");
      },
    });
    await expect(
      dispatchLoweredExecutionRequest(lowered, accessor as Parameters<typeof dispatchLoweredExecutionRequest>[1]),
    ).rejects.toThrow(/accessor|data property/i);
    expect(touched).toBe(false);

    const inherited = Object.create({ onRetryAttempt() {} }) as Parameters<typeof dispatchLoweredExecutionRequest>[1];
    await expect(dispatchLoweredExecutionRequest(lowered, inherited)).rejects.toThrow(/plain|null prototype/i);
    await expect(
      dispatchLoweredExecutionRequest(lowered, {
        onRetryAttempt: "not-a-function",
      } as unknown as Parameters<typeof dispatchLoweredExecutionRequest>[1]),
    ).rejects.toThrow(/onRetryAttempt.*function/i);
  });

  test("uses the frozen runner timeout when request runtime omits timeout", async () => {
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("fixture-llm", "llm", {
        tools: [],
        authorization: { status: "not-required" },
        runtime: {},
      }),
      {
        kind: "llm",
        engine: "fixture",
        connection: {
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "provider/exact-model",
        },
        timeoutMs: 4_321,
      },
    );
    let captured: unknown;
    await dispatchLoweredExecutionRequest(lowered, {
      runOptions: { timeoutMs: 99_999 },
      chat: async (_connection, _messages, options) => {
        captured = options;
        return "done";
      },
    });
    expect(captured).toMatchObject({ timeoutMs: 4_321 });
  });

  test.each([null, 0] as const)("preserves explicit request timeout %s over runner defaults", async (timeoutMs) => {
    const lowered = lowerResolvedExecutionRequestWithRunner(
      requestFor("fixture-llm", "llm", {
        tools: [],
        authorization: { status: "not-required" },
        runtime: { timeoutMs },
      }),
      {
        kind: "llm",
        engine: "fixture",
        connection: {
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "provider/exact-model",
        },
        timeoutMs: 4_321,
      },
    );
    let captured: unknown;
    await dispatchLoweredExecutionRequest(lowered, {
      runOptions: { timeoutMs: 99_999 },
      chat: async (_connection, _messages, options) => {
        captured = options;
        return "done";
      },
    });
    expect(captured).toMatchObject({ timeoutMs });
  });

  test("rejects accessor-backed operational options without invoking them", async () => {
    const lowered = lowerResolvedExecutionRequest(requestFor("claude"), configFor("claude"));
    let touched = false;
    const runOptions = Object.defineProperty({}, "stdio", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("operational accessor ran");
      },
    });
    await expect(dispatchLoweredExecutionRequest(lowered, { runOptions })).rejects.toThrow(/accessor|data property/i);
    expect(touched).toBe(false);
  });
});
