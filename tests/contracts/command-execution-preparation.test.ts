// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  type CommandExecutionSourceLoader,
  dispatchPreparedCommandInvocation,
  inspectPreparedCommandInvocation,
  prepareCommandInvocation,
} from "../../src/commands/command/command-execution";
import type { ExecutionSourceLookup } from "../../src/commands/command/execution-source-loader";
import type { AkmConfig } from "../../src/core/config/config-types";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
} from "../../src/execution/resolved-request";
import { type AdapterRenderedExecutionSource, createAdapterRenderedExecutionSource } from "../../src/execution/source";
import type { AgentDispatchRequest } from "../../src/integrations/agent/builder-shared";
import { getCommandBuilder } from "../../src/integrations/agent/builders";
import { lowerResolvedExecutionRequest } from "../../src/integrations/agent/execution-lowering";
import { mergeModelMapLayers, parseModelMapLayer } from "../../src/integrations/agent/model-map";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { withEnv } from "../_helpers/sandbox";

const config: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  defaults: { engine: "reviewer" },
  engines: {
    reviewer: {
      kind: "agent",
      platform: "claude",
      bin: "/bin/true",
      model: "engine-exact",
      timeoutMs: 60_000,
    },
  },
};

const valueStateConfig: AkmConfig = {
  ...config,
  engines: {
    reviewer: { kind: "agent", platform: "claude", bin: "/bin/true" },
  },
};

const modelMap = mergeModelMapLayers(
  parseModelMapLayer(
    JSON.stringify({
      version: 1,
      aliases: {
        balanced: { claude: "claude-balanced-exact" },
        reasoning: { claude: { model: "claude-reasoning-exact", inference: { effort: "high" } } },
      },
    }),
    "command execution fixture",
  ),
);

function rendered(
  kind: "command" | "persona",
  ref: string,
  content: string,
  defaults: Record<string, unknown> = {},
): AdapterRenderedExecutionSource {
  const [bundle = "fixture", concept = ""] = ref.split("//");
  return createAdapterRenderedExecutionSource({
    kind,
    content,
    defaults,
    identity: {
      ref,
      bundle,
      adapter: "akm",
      file: `${concept}.md`,
      hash: "a".repeat(64),
    },
  });
}

function loaderFor(command: AdapterRenderedExecutionSource, persona?: AdapterRenderedExecutionSource) {
  const calls: Array<{ ref: string; kind: string }> = [];
  const loader: CommandExecutionSourceLoader = async (ref, kind) => {
    calls.push({ ref, kind });
    const value = kind === "command" ? command : persona;
    if (!value || value.kind !== kind) throw new Error(`missing ${kind} fixture`);
    return value as never;
  };
  return { calls, loader };
}

function projectedWithoutStoredIdentity(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as { command: { source: unknown }; [key: string]: unknown };
  parsed.command = { ...parsed.command, source: null };
  return parsed;
}

describe("common command invocation preparation", () => {
  test("threads one explicit source lookup through command and persona rendering", async () => {
    const command = rendered("command", "fixture//commands/review", "Review this.", {
      agent: "agents/reviewer",
    });
    const persona = rendered("persona", "fixture//agents/reviewer", "You are a reviewer.");
    const seen: Array<ExecutionSourceLookup | undefined> = [];
    const sourceLookup: ExecutionSourceLookup = async () => null;
    const sourceLoader: CommandExecutionSourceLoader = async (_ref, kind, options) => {
      seen.push(options?.lookup);
      return (kind === "command" ? command : persona) as never;
    };

    await prepareCommandInvocation({
      action: { ref: "fixture//commands/review" },
      config,
      modelMap,
      sourceLoader,
      sourceLookup,
    } as Parameters<typeof prepareCommandInvocation>[0] & { sourceLookup: ExecutionSourceLookup });

    expect(seen).toEqual([sourceLookup, sourceLookup]);
  });

  test("projects a deterministic dry-run envelope without resolved values or unsafe notice fields", async () => {
    expect(typeof inspectPreparedCommandInvocation).toBe("function");

    const command = rendered("command", "fixture//commands/private", "DO-NOT-LEAK command content", {
      model: "reasoning",
      inference: { vendorUnknown: "DO-NOT-LEAK inference value" },
    });
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/private" },
      config,
      modelMap,
      sourceLoader: loaderFor(command).loader,
      current: { workspace: "/DO-NOT-LEAK/workspace" },
    });
    const result = inspectPreparedCommandInvocation(prepared) as unknown as {
      readonly provenance: readonly { field: string; layer: string; kind: string; via: string }[];
      readonly notices: readonly Record<string, unknown>[];
      [key: string]: unknown;
    };

    expect(result).toMatchObject({
      schemaVersion: 1,
      shape: "command-dry-run",
      ok: true,
      dryRun: true,
      engine: "reviewer",
    });
    expect(Object.keys(result).sort()).toEqual(
      ["dryRun", "engine", "notices", "ok", "provenance", "schemaVersion", "shape"].sort(),
    );
    expect(result.provenance.map(({ field }) => field)).toEqual(
      [...result.provenance.map(({ field }) => field)].sort(),
    );
    for (const provenance of result.provenance) {
      expect(Object.keys(provenance).sort()).toEqual(["field", "kind", "layer", "via"]);
    }
    expect(result.notices.length).toBeGreaterThan(0);
    expect(result.notices.map((notice) => JSON.stringify(notice))).toEqual(
      [...result.notices.map((notice) => JSON.stringify(notice))].sort(),
    );
    for (const notice of result.notices) {
      expect(Object.keys(notice).sort()).toEqual(
        [...(notice.field === undefined ? [] : ["field"]), "adapter", "code", "message", "severity"].sort(),
      );
    }
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("DO-NOT-LEAK");
    expect(encoded).not.toContain("claude-reasoning-exact");
  });

  test("loads command/persona through adapters, applies exact arguments, then resolves cascade and authorization", async () => {
    const command = rendered("command", "fixture//commands/review", "Review [$ARGUMENTS].", {
      agent: "agents/reviewer",
      model: "balanced",
      tools: ["read"],
    });
    const persona = rendered("persona", "fixture//agents/reviewer", "You are a reviewer.", {
      model: "balanced",
    });
    const { calls, loader } = loaderFor(command, persona);
    const authorized: unknown[] = [];

    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/review", arguments: "  exact\ninput  " },
      config,
      modelMap,
      sourceLoader: loader,
      current: { model: "reasoning" },
      authorizeTools(input) {
        authorized.push(input);
        return { status: "allowed", policy: "fixture-policy" };
      },
    });

    expect(calls).toEqual([
      { ref: "fixture//commands/review", kind: "command" },
      { ref: "fixture//agents/reviewer", kind: "persona" },
    ]);
    expect(prepared.request.command).toMatchObject({
      template: "Review [$ARGUMENTS].",
      argumentInput: "  exact\ninput  ",
      content: "Review [  exact\ninput  ].",
      source: { ref: "fixture//commands/review" },
    });
    expect(prepared.request.persona).toMatchObject({
      content: "You are a reviewer.",
      source: { ref: "fixture//agents/reviewer" },
    });
    expect(prepared.request.model).toEqual({
      input: "reasoning",
      interpretation: "alias",
      resolved: "claude-reasoning-exact",
    });
    expect(prepared.request.inference).toEqual({ effort: "high" });
    expect(prepared.request.authorization).toMatchObject({ status: "allowed", policy: { id: "fixture-policy" } });
    expect(authorized).toHaveLength(1);
  });

  test("uses the host-local execution allowlist when callers do not inject an authorizer", async () => {
    const allowed = rendered("command", "fixture//commands/allowed", "Read it.", { tools: ["read"] });
    const allowedPrepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/allowed" },
      config: { ...config, execution: { allowedTools: ["read"] } },
      modelMap,
      sourceLoader: loaderFor(allowed).loader,
    });
    expect(allowedPrepared.request.authorization).toMatchObject({
      status: "allowed",
      policy: { id: "config-execution-allowed-tools" },
    });

    const denied = rendered("command", "fixture//commands/denied-by-config", "Run it.", { tools: ["shell"] });
    const deniedPrepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/denied-by-config" },
      config: { ...config, execution: { allowedTools: ["read"] } },
      modelMap,
      sourceLoader: loaderFor(denied).loader,
    });
    expect(deniedPrepared.request.authorization.status).toBe("denied");

    const booleanMap = rendered("command", "fixture//commands/boolean-tools", "Read it.", {
      tools: { read: true, shell: false },
    });
    const booleanMapPrepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/boolean-tools" },
      config: { ...config, execution: { allowedTools: ["read"] } },
      modelMap,
      sourceLoader: loaderFor(booleanMap).loader,
    });
    expect(booleanMapPrepared.request.authorization.status).toBe("allowed");

    const opaquePolicy = rendered("command", "fixture//commands/opaque-tools", "Read it.", {
      tools: { allow: ["read"] },
    });
    const opaquePrepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/opaque-tools" },
      config: { ...config, execution: { allowedTools: ["read"] } },
      modelMap,
      sourceLoader: loaderFor(opaquePolicy).loader,
    });
    expect(opaquePrepared.request.authorization.status).toBe("denied");
  });

  test("stored and inline actions converge when effective inputs match apart from intentional source identity", async () => {
    const command = rendered("command", "fixture//commands/plain", "Review $ARGUMENTS.");
    const { loader } = loaderFor(command);
    const stored = await prepareCommandInvocation({
      action: { ref: "fixture//commands/plain", arguments: "this" },
      config,
      modelMap,
      sourceLoader: loader,
      current: { model: "exact/model" },
    });
    const inline = await prepareCommandInvocation({
      action: { content: "Review $ARGUMENTS.", arguments: "this" },
      config,
      modelMap,
      sourceLoader: loader,
      current: { model: "exact/model" },
    });

    expect(projectedWithoutStoredIdentity(canonicalResolvedExecutionRequest(stored.request))).toEqual(
      projectedWithoutStoredIdentity(canonicalResolvedExecutionRequest(inline.request)),
    );
    expect(stored.request.command.source?.ref).toBe("fixture//commands/plain");
    expect(inline.request.command.source).toBeNull();
  });

  test("enforces one value-state contract across preparation, cascade, durable bytes, and lowering", async () => {
    const invocationKinds = ["direct", "task", "workflow"] as const;
    const cases = [
      { name: "omitted", current: {} },
      { name: "explicit null", current: { model: null, inference: null, outputSchema: null } },
      { name: "explicit empty inference", current: { inference: {} } },
      { name: "resolved alias and authorization", current: { model: "reasoning", tools: ["read"] } },
      {
        name: "explicit false, zero, and empty values",
        current: {
          inference: { enabled: false, temperature: 0, extraParams: {} },
          outputSchema: {},
          tools: [],
          timeout: 0,
          workspace: "",
          environment: {},
          runtime: {},
        },
      },
    ] as const;
    const observed: Array<{
      canonical: string;
      wire: Record<string, unknown>;
      provenance: Readonly<Record<string, unknown>>;
      lowered: ReturnType<typeof lowerResolvedExecutionRequest>;
    }> = [];

    for (const fixture of cases) {
      const prepared = await Promise.all(
        invocationKinds.map((invocationKind) =>
          prepareCommandInvocation({
            action: { content: "Review exactly." },
            config: valueStateConfig,
            modelMap,
            invocationKind,
            current: fixture.current,
            authorizeTools: () => ({ status: "allowed", policy: "fixture-policy" }),
          }),
        ),
      );
      expect(prepared.map(({ plan }) => plan.invocationKind)).toEqual([...invocationKinds]);

      const canonical = prepared.map(({ request }) => canonicalResolvedExecutionRequest(request));
      const [firstCanonical] = canonical;
      const [firstPrepared] = prepared;
      if (!firstCanonical || !firstPrepared) throw new Error("cross-surface fixture produced no request");
      expect(new Set(canonical).size).toBe(1);
      expect(canonicalResolvedExecutionRequest(decodeResolvedExecutionRequest(JSON.parse(firstCanonical)))).toBe(
        firstCanonical,
      );

      const lowered = prepared.map(({ request, config: preparedConfig }) =>
        lowerResolvedExecutionRequest(request, preparedConfig),
      );
      const project = ({ request: _request, ...value }: (typeof lowered)[number]) => JSON.parse(JSON.stringify(value));
      const [firstLowered, ...remainingLowered] = lowered;
      if (!firstLowered) throw new Error("cross-surface fixture produced no lowered request");
      for (const candidate of remainingLowered) expect(project(candidate)).toEqual(project(firstLowered));
      observed.push({
        canonical: firstCanonical,
        wire: JSON.parse(firstCanonical) as Record<string, unknown>,
        provenance: firstPrepared.plan.provenance,
        lowered: firstLowered,
      });
    }

    expect(new Set(observed.map(({ canonical }) => canonical)).size).toBe(cases.length);
    const [omitted, explicitNull, emptyInference, alias, explicitValues] = observed;
    if (!omitted || !explicitNull || !emptyInference || !alias || !explicitValues) {
      throw new Error("cross-surface fixtures were not all observed");
    }
    for (const field of ["agent", "persona", "model", "inference", "outputSchema", "tools"]) {
      expect(Object.hasOwn(omitted.wire, field)).toBe(false);
    }
    for (const field of ["runtime.timeoutMs", "runtime.workspace", "runtime.environment"]) {
      expect(omitted.lowered.translatedFields).not.toContain(field);
    }
    expect(explicitNull.wire).toMatchObject({ model: null, inference: null, outputSchema: null });
    expect(Object.hasOwn(omitted.lowered.request, "model")).toBe(false);
    expect(explicitNull.lowered.request.model).toBeNull();
    expect(emptyInference.wire).toMatchObject({ inference: {} });
    expect(emptyInference.provenance).toHaveProperty("/inference");
    expect(alias.wire).toMatchObject({
      model: { input: "reasoning", interpretation: "alias", resolved: "claude-reasoning-exact" },
      inference: { effort: "high" },
      tools: ["read"],
      authorization: { status: "allowed", policy: { id: "fixture-policy" } },
    });
    expect(explicitValues.wire).toMatchObject({
      inference: { enabled: false, temperature: 0, extraParams: {} },
      outputSchema: {},
      tools: [],
      runtime: { timeoutMs: 0, workspace: "", environment: {}, settings: {} },
    });
    expect(explicitValues.lowered.translatedFields).toEqual(
      expect.arrayContaining(["runtime.timeoutMs", "runtime.workspace", "runtime.environment", "tools"]),
    );
    expect(explicitValues.lowered.options).toMatchObject({
      timeoutMs: 0,
      cwd: "",
      env: {},
    });
  });

  test("native selectors stay native and do not trigger portable persona resolution", async () => {
    const command = rendered("command", "fixture//commands/native", "Review this.", { agent: "native-reviewer" });
    const { calls, loader } = loaderFor(command);
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/native" },
      config,
      modelMap,
      sourceLoader: loader,
    });
    expect(calls).toEqual([{ ref: "fixture//commands/native", kind: "command" }]);
    expect(prepared.request.agent).toBe("native-reviewer");
    expect(prepared.request.persona).toBeNull();
  });

  test("prose resembling a native construct authorizes normally; denied tools fail before runner dispatch", async () => {
    let authorizationCalls = 0;
    let dispatchCalls = 0;
    const prose = rendered("command", "fixture//commands/prose", "Review $1.", { tools: ["shell"] });
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/prose" },
      config,
      modelMap,
      sourceLoader: loaderFor(prose).loader,
      authorizeTools() {
        authorizationCalls += 1;
        return { status: "allowed", policy: "fixture-policy" };
      },
    });
    expect(prepared.request.command.content).toBe("Review $1.");
    expect(authorizationCalls).toBe(1);

    const safe = rendered("command", "fixture//commands/denied", "Review this.", { tools: ["shell"] });
    const denied = await prepareCommandInvocation({
      action: { ref: "fixture//commands/denied" },
      config,
      modelMap,
      sourceLoader: loaderFor(safe).loader,
      authorizeTools() {
        return { status: "denied", policy: "fixture-deny" };
      },
    });
    expect(() => inspectPreparedCommandInvocation(denied)).toThrow(/authorized|policy|selected tools/i);
    await expect(
      dispatchPreparedCommandInvocation(denied, {
        executeRunner: async () => {
          dispatchCalls += 1;
          throw new Error("must not dispatch");
        },
      }),
    ).rejects.toThrow(/authorized|policy|selected tools/i);
    expect(dispatchCalls).toBe(0);
  });

  test("dispatches direct LLM commands with final content and persona messages", async () => {
    const llmConfig: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "engine-model",
        },
      },
    };
    const command = rendered("command", "fixture//commands/llm", "Review $ARGUMENTS.", {
      agent: "agents/reviewer",
    });
    const persona = rendered("persona", "fixture//agents/reviewer", "You are exact.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/llm", arguments: "the target" },
      config: llmConfig,
      modelMap,
      sourceLoader: loaderFor(command, persona).loader,
      current: { model: "provider/exact", timeout: 0 },
    });
    const captures: unknown[] = [];
    const result = await dispatchPreparedCommandInvocation(prepared, {
      chat: async (connection, messages, options) => {
        captures.push({ connection, messages, options });
        return "reviewed";
      },
    });

    expect(result).toMatchObject({ ok: true, engine: "direct", stdout: "reviewed", exitCode: 0 });
    expect(captures).toEqual([
      {
        connection: expect.objectContaining({
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "provider/exact",
        }),
        messages: [
          { role: "system", content: "You are exact." },
          { role: "user", content: "Review the target." },
        ],
        options: { timeoutMs: 0 },
      },
    ]);
  });

  test("explicit null clears configured agent model and workspace before lowering", async () => {
    const configured: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "reviewer" },
      engines: {
        reviewer: {
          kind: "agent",
          platform: "claude",
          bin: "/bin/true",
          model: "configured-model",
          workspace: "/configured/workspace",
        },
      },
    };
    const command = rendered("command", "fixture//commands/clear-agent", "Review this.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/clear-agent" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(command).loader,
      current: { model: null, workspace: null },
    });
    let captured: unknown;
    await dispatchPreparedCommandInvocation(prepared, {
      executeRunner: async (runner) => {
        captured = runner;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    });

    expect(prepared.request.model).toBeNull();
    expect(prepared.request.runtime.workspace).toBeNull();
    expect(captured).toMatchObject({ kind: "agent", profile: { name: "reviewer" } });
    expect((captured as { profile: Record<string, unknown> }).profile).not.toHaveProperty("model");
    expect((captured as { profile: Record<string, unknown> }).profile).not.toHaveProperty("modelIsExact");
    expect((captured as { profile: Record<string, unknown> }).profile).not.toHaveProperty("workspace");
  });

  test("explicit null clears configured LLM model and inference before lowering", async () => {
    const configured: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "configured-model",
          temperature: 0.7,
          extraParams: { configured: true },
        },
      },
    };
    const command = rendered("command", "fixture//commands/clear-llm", "Review this.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/clear-llm" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(command).loader,
      current: { model: null, inference: null },
    });
    let captured: unknown;
    await dispatchPreparedCommandInvocation(prepared, {
      executeRunner: async (runner) => {
        captured = runner;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    });

    expect(prepared.request.model).toBeNull();
    expect(prepared.request.inference).toBeNull();
    const connection = (captured as { connection: Record<string, unknown> }).connection;
    expect(connection.endpoint).toBe("https://fixture.invalid/v1/chat/completions");
    expect(connection).not.toHaveProperty("model");
    expect(connection).not.toHaveProperty("temperature");
    expect(connection).not.toHaveProperty("extraParams");
  });

  test("LLM inference cannot replace the selected model or transport identity", async () => {
    const configured: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "configured-model",
        },
      },
    };
    const command = rendered("command", "fixture//commands/protected-llm", "Review this.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/protected-llm" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(command).loader,
      current: {
        model: "vendor/exact-model",
        inference: {
          endpoint: "https://attacker.invalid/v1/chat/completions",
          provider: "attacker",
          apiKey: "do-not-use",
          model: "attacker-model",
          timeoutMs: 1,
          temperature: 0,
        },
      },
    });
    let captured: unknown;
    await dispatchPreparedCommandInvocation(prepared, {
      executeRunner: async (runner) => {
        captured = runner;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    });

    expect(prepared.request.inference).toMatchObject({ endpoint: "https://attacker.invalid/v1/chat/completions" });
    const connection = (captured as { connection: Record<string, unknown> }).connection;
    expect(connection).toMatchObject({
      endpoint: "https://fixture.invalid/v1/chat/completions",
      provider: "openai-compatible",
      model: "vendor/exact-model",
      temperature: 0,
    });
    expect(connection).not.toHaveProperty("apiKey");
    expect(connection).not.toHaveProperty("timeoutMs");
  });

  test("redacts a materialized credential echoed by a direct LLM provider failure", async () => {
    const secret = "provider-command-secret-987654";
    const configured: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://fixture.invalid/v1/chat/completions",
          model: "configured-model",
          apiKey: "$COMMAND_FAILURE_KEY",
        },
      },
    };
    const prepared = await prepareCommandInvocation({
      action: { content: "Trigger the provider failure." },
      config: configured,
      modelMap,
    });

    const result = await withEnv({ COMMAND_FAILURE_KEY: secret }, () =>
      dispatchPreparedCommandInvocation(prepared, {
        chat: async (connection) => {
          expect(connection.apiKey).toBe(secret);
          throw new Error(`provider echoed ${secret}`);
        },
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "spawn_failed", error: "provider echoed [REDACTED]" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("freezes transport configuration at preparation before caller mutation", async () => {
    const llmConfig: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          provider: "openai-compatible",
          endpoint: "https://safe.invalid/v1/chat/completions",
          model: "safe-model",
          apiKey: "$SAFE_COMMAND_KEY",
        },
      },
    };
    const command = rendered("command", "fixture//commands/frozen-llm", "Review this.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/frozen-llm" },
      config: llmConfig,
      modelMap,
      sourceLoader: loaderFor(command).loader,
    });
    Object.assign(llmConfig.engines?.direct ?? {}, {
      provider: "attacker",
      endpoint: "https://attacker.invalid/v1/chat/completions",
      apiKey: "$ATTACKER_KEY",
    });

    let captured: unknown;
    await dispatchPreparedCommandInvocation(prepared, {
      executeRunner: async (runner) => {
        captured = runner;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    });
    expect(captured).toMatchObject({
      kind: "llm",
      connection: {
        provider: "openai-compatible",
        endpoint: "https://safe.invalid/v1/chat/completions",
      },
      credential: { names: ["SAFE_COMMAND_KEY"], required: true },
    });
    expect(Object.isFrozen(prepared.config)).toBe(true);
    expect(Object.isFrozen(prepared.config.engines?.direct)).toBe(true);

    const agentConfig: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "reviewer" },
      engines: {
        reviewer: { kind: "agent", platform: "claude", bin: "/safe/claude", args: ["--safe"] },
      },
    };
    const preparedAgent = await prepareCommandInvocation({
      action: { ref: "fixture//commands/frozen-agent" },
      config: agentConfig,
      modelMap,
      sourceLoader: loaderFor(rendered("command", "fixture//commands/frozen-agent", "Review.")).loader,
    });
    Object.assign(agentConfig.engines?.reviewer ?? {}, {
      platform: "aider",
      bin: "/attacker/aider",
      args: ["--attacker"],
    });
    let capturedAgent: unknown;
    await dispatchPreparedCommandInvocation(preparedAgent, {
      executeRunner: async (runner) => {
        capturedAgent = runner;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    });
    expect(capturedAgent).toMatchObject({
      kind: "agent",
      profile: { platform: "claude", bin: "/safe/claude", args: ["--safe"] },
    });
  });

  test("ignores inherited LLM transport fields injected after preparation", async () => {
    const llmConfig: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "direct" },
      engines: {
        direct: {
          kind: "llm",
          endpoint: "https://safe.invalid/v1/chat/completions",
          model: "safe-model",
        },
      },
    };
    const llmPrepared = await prepareCommandInvocation({
      action: { content: "Review." },
      config: llmConfig,
      modelMap,
    });
    let capturedLlm: RunnerSpec | undefined;
    let observedLlm: Record<string, unknown> | undefined;
    Object.defineProperties(Object.prototype, {
      provider: { configurable: true, value: "attacker-provider", writable: true },
      apiKey: { configurable: true, value: "$ATTACKER_KEY", writable: true },
    });
    try {
      await dispatchPreparedCommandInvocation(llmPrepared, {
        executeRunner: async (runner) => {
          capturedLlm = runner;
          if (runner.kind !== "llm") throw new Error("expected LLM runner");
          observedLlm = {
            provider: runner.connection.provider,
            providerOwn: Object.hasOwn(runner.connection, "provider"),
            credentialNames: runner.credential?.names,
          };
          return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        },
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "provider");
      Reflect.deleteProperty(Object.prototype, "apiKey");
    }

    expect(capturedLlm).toMatchObject({
      kind: "llm",
      connection: {
        endpoint: "https://safe.invalid/v1/chat/completions",
        model: "safe-model",
      },
      credential: {
        names: ["AKM_ENGINE_DIRECT_API_KEY"],
        required: false,
      },
    });
    expect(observedLlm).toEqual({
      provider: undefined,
      providerOwn: false,
      credentialNames: ["AKM_ENGINE_DIRECT_API_KEY"],
    });
    expect((capturedLlm as Extract<RunnerSpec, { kind: "llm" }>).connection).not.toHaveProperty("provider");
    expect(Object.getPrototypeOf((capturedLlm as Extract<RunnerSpec, { kind: "llm" }>).connection)).toBeNull();
    expect(Object.getPrototypeOf(llmPrepared.config)).toBeNull();
    expect(Object.getPrototypeOf(llmPrepared.config.engines)).toBeNull();
    expect(Object.getPrototypeOf(llmPrepared.config.engines?.direct)).toBeNull();
  });

  test("ignores inherited agent transport fields injected after preparation", async () => {
    const agentConfig: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "reviewer" },
      engines: { reviewer: { kind: "agent", platform: "claude" } },
    };
    const agentPrepared = await prepareCommandInvocation({
      action: { content: "Review." },
      config: agentConfig,
      modelMap,
    });
    let capturedAgent: RunnerSpec | undefined;
    let capturedAgentOptions: Record<string, unknown> | undefined;
    let observedAgent: Record<string, unknown> | undefined;
    Object.defineProperties(Object.prototype, {
      bin: { configurable: true, value: "/attacker/bin", writable: true },
      args: { configurable: true, value: ["--attacker"], writable: true },
      workspace: { configurable: true, value: "/attacker/workspace", writable: true },
      model: { configurable: true, value: "attacker-model", writable: true },
    });
    try {
      await dispatchPreparedCommandInvocation(agentPrepared, {
        executeRunner: async (runner, _prompt, options) => {
          capturedAgent = runner;
          capturedAgentOptions = options as unknown as Record<string, unknown>;
          if (runner.kind !== "agent") throw new Error("expected agent runner");
          observedAgent = {
            bin: runner.profile.bin,
            args: runner.profile.args,
            workspace: runner.profile.workspace,
            model: runner.profile.model,
            cwd: options.cwd,
          };
          return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        },
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "bin");
      Reflect.deleteProperty(Object.prototype, "args");
      Reflect.deleteProperty(Object.prototype, "workspace");
      Reflect.deleteProperty(Object.prototype, "model");
    }

    expect(capturedAgent).toMatchObject({
      kind: "agent",
      profile: { platform: "claude", bin: "claude", args: [] },
    });
    expect(observedAgent).toEqual({
      bin: "claude",
      args: [],
      workspace: undefined,
      model: undefined,
      cwd: undefined,
    });
    const capturedProfile = (capturedAgent as Extract<RunnerSpec, { kind: "agent" }>).profile;
    expect(capturedProfile).not.toHaveProperty("workspace");
    expect(capturedProfile).not.toHaveProperty("model");
    expect(capturedProfile).not.toHaveProperty("modelIsExact");
    expect(capturedAgentOptions).not.toHaveProperty("cwd");
    expect(Object.getPrototypeOf(capturedProfile)).toBeNull();
    expect(Object.getPrototypeOf(capturedAgentOptions)).toBeNull();
    expect(Object.getPrototypeOf(agentPrepared.config.engines?.reviewer)).toBeNull();
  });

  test("routes personas through native channels or the deterministic prompt fallback exactly once", async () => {
    const command = rendered("command", "fixture//commands/persona-route", "Review this.", {
      agent: "agents/reviewer",
    });
    const persona = rendered("persona", "fixture//agents/reviewer", "You are exact.");

    const runFor = async (platform: "aider" | "claude") => {
      const configured: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaults: { engine: "reviewer" },
        engines: { reviewer: { kind: "agent", platform, bin: "/bin/true" } },
      };
      const prepared = await prepareCommandInvocation({
        action: { ref: "fixture//commands/persona-route" },
        config: configured,
        modelMap,
        sourceLoader: loaderFor(command, persona).loader,
      });
      let capture: { prompt?: string; dispatch?: Record<string, unknown>; runner?: RunnerSpec } = {};
      const result = await dispatchPreparedCommandInvocation(prepared, {
        executeRunner: async (runner, prompt, options) => {
          capture = { prompt, dispatch: options.dispatch as unknown as Record<string, unknown>, runner };
          return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        },
      });
      return { capture, result };
    };

    const fallback = await runFor("aider");
    expect(fallback.capture.prompt).toBe("<AKM_PERSONA>\nYou are exact.\n</AKM_PERSONA>\n\nReview this.");
    expect(fallback.capture.dispatch).toMatchObject({ prompt: fallback.capture.prompt });
    expect(fallback.capture.dispatch).not.toHaveProperty("systemPrompt");
    expect(fallback.result.notices).toEqual([
      expect.objectContaining({ code: "persona-prompt-composed", adapter: "aider", field: "persona" }),
    ]);
    if (fallback.capture.runner?.kind !== "agent" || !fallback.capture.dispatch) {
      throw new Error("expected captured Aider agent dispatch");
    }
    const aiderCommand = getCommandBuilder("aider").build(
      fallback.capture.runner.profile,
      fallback.capture.dispatch as unknown as AgentDispatchRequest,
    );
    expect(aiderCommand.argv.join("\n")).toContain(
      "--message=<AKM_PERSONA>\nYou are exact.\n</AKM_PERSONA>\n\nReview this.",
    );
    expect(aiderCommand.argv.join("\n").match(/<AKM_PERSONA>/g)).toHaveLength(1);

    const native = await runFor("claude");
    expect(native.capture.prompt).toBe("Review this.");
    expect(native.capture.dispatch).toMatchObject({ prompt: "Review this.", systemPrompt: "You are exact." });
    expect(native.result.notices).toBeUndefined();
  });
});
