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
import { buildExecution } from "../../src/integrations/agent/execution";
import { mergeModelMapLayers, parseModelMapLayer } from "../../src/integrations/agent/model-map";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { RunAgentOptions } from "../../src/integrations/agent/spawn";
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

const OK = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 } as const;

/** Dispatch through the agent spawn seam and capture what the harness would receive. */
async function captureAgent(prepared: Awaited<ReturnType<typeof prepareCommandInvocation>>) {
  let capture: { profile?: AgentProfile; prompt?: string; options?: RunAgentOptions } = {};
  const result = await dispatchPreparedCommandInvocation(prepared, {
    runAgent: async (profile, prompt, options) => {
      capture = { profile, prompt, options };
      return OK;
    },
  });
  return { capture, result };
}

/** Dispatch through the chat seam and capture the connection a direct LLM call would receive. */
async function captureChat(prepared: Awaited<ReturnType<typeof prepareCommandInvocation>>) {
  let connection: Record<string, unknown> | undefined;
  await dispatchPreparedCommandInvocation(prepared, {
    chat: async (received) => {
      connection = received as unknown as Record<string, unknown>;
      return "";
    },
  });
  if (!connection) throw new Error("the chat transport was not called");
  return connection;
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
    for (const notice of result.notices) {
      expect(Object.keys(notice).sort()).toEqual(
        [...(notice.field === undefined ? [] : ["field"]), "adapter", "code", "message", "severity"].sort(),
      );
    }
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("DO-NOT-LEAK");
    expect(encoded).not.toContain("claude-reasoning-exact");
  });

  test("loads command/persona through adapters, applies exact arguments, then resolves models and tools", async () => {
    const command = rendered("command", "fixture//commands/review", "Review [$ARGUMENTS].", {
      agent: "agents/reviewer",
      model: "balanced",
      tools: ["read"],
    });
    const persona = rendered("persona", "fixture//agents/reviewer", "You are a reviewer.", {
      model: "balanced",
    });
    const { calls, loader } = loaderFor(command, persona);

    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/review", arguments: "  exact\ninput  " },
      config: { ...config, execution: { allowedTools: ["read"] } },
      modelMap,
      sourceLoader: loader,
      current: { model: "reasoning" },
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
    expect(prepared.request.authorization).toMatchObject({
      status: "allowed",
      policy: { id: "config-execution-allowed-tools" },
    });
  });

  test("uses the host-local execution allowlist", async () => {
    const allowlisted = { ...config, execution: { allowedTools: ["read"] } };
    const status = async (ref: string, tools: unknown) =>
      (
        await prepareCommandInvocation({
          action: { ref },
          config: allowlisted,
          modelMap,
          sourceLoader: loaderFor(rendered("command", ref, "Do it.", { tools })).loader,
        })
      ).request.authorization.status;

    expect(await status("fixture//commands/allowed", ["read"])).toBe("allowed");
    expect(await status("fixture//commands/denied", ["shell"])).toBe("denied");
    expect(await status("fixture//commands/boolean-map", { read: true, shell: false })).toBe("allowed");
    expect(await status("fixture//commands/opaque-policy", { allow: ["read"] })).toBe("denied");
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

  test("omitted, explicit null, and explicit empty values stay distinct through durable bytes and dispatch", async () => {
    const prepare = (current: Record<string, unknown>) =>
      prepareCommandInvocation({
        action: { content: "Review exactly." },
        config: { ...valueStateConfig, execution: { allowedTools: ["read"] } },
        modelMap,
        current,
      });
    const wire = async (current: Record<string, unknown>) => {
      const canonical = canonicalResolvedExecutionRequest((await prepare(current)).request);
      expect(canonicalResolvedExecutionRequest(decodeResolvedExecutionRequest(JSON.parse(canonical)))).toBe(canonical);
      return JSON.parse(canonical) as Record<string, unknown>;
    };

    const omitted = await wire({});
    for (const field of ["agent", "persona", "model", "inference", "outputSchema", "tools"]) {
      expect(Object.hasOwn(omitted, field)).toBe(false);
    }
    expect(await wire({ model: null, inference: null, outputSchema: null })).toMatchObject({
      model: null,
      inference: null,
      outputSchema: null,
    });
    expect(await wire({ inference: {} })).toMatchObject({ inference: {} });
    expect(await wire({ model: "reasoning", tools: ["read"] })).toMatchObject({
      model: { input: "reasoning", interpretation: "alias", resolved: "claude-reasoning-exact" },
      inference: { effort: "high" },
      tools: ["read"],
      authorization: { status: "allowed" },
    });
    const explicit = {
      inference: { enabled: false, temperature: 0, extraParams: {} },
      outputSchema: {},
      tools: [],
      timeout: 0,
      workspace: "",
      environment: {},
      runtime: {},
    };
    expect(await wire(explicit)).toMatchObject({
      inference: { enabled: false, temperature: 0, extraParams: {} },
      outputSchema: {},
      tools: [],
      runtime: { timeoutMs: 0, workspace: "", environment: {}, settings: {} },
    });
    const prepared = await prepare(explicit);
    expect(buildExecution(prepared.request, prepared.runner).options).toMatchObject({ timeoutMs: 0, env: {} });
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

  test("prose resembling a native construct runs; denied tools fail before any dispatch", async () => {
    const prose = rendered("command", "fixture//commands/prose", "Review $1.");
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/prose" },
      config,
      modelMap,
      sourceLoader: loaderFor(prose).loader,
    });
    expect(prepared.request.command.content).toBe("Review $1.");

    let dispatchCalls = 0;
    const denied = await prepareCommandInvocation({
      action: { ref: "fixture//commands/denied" },
      config,
      modelMap,
      sourceLoader: loaderFor(rendered("command", "fixture//commands/denied", "Review this.", { tools: ["shell"] }))
        .loader,
    });
    expect(() => inspectPreparedCommandInvocation(denied)).toThrow(/not authorized/i);
    await expect(
      dispatchPreparedCommandInvocation(denied, {
        runAgent: async () => {
          dispatchCalls += 1;
          return OK;
        },
      }),
    ).rejects.toThrow(/not authorized/i);
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

  test("explicit null clears a configured agent model and workspace", async () => {
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
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/clear-agent" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(rendered("command", "fixture//commands/clear-agent", "Review this.")).loader,
      current: { model: null, workspace: null },
    });
    const { capture } = await captureAgent(prepared);

    expect(prepared.request.model).toBeNull();
    expect(prepared.request.runtime.workspace).toBeNull();
    expect(capture.profile?.name).toBe("reviewer");
    expect(capture.profile).not.toHaveProperty("model");
    expect(capture.profile).not.toHaveProperty("workspace");
    expect(capture.options?.dispatch).not.toHaveProperty("model");
    expect(capture.options).not.toHaveProperty("cwd");
  });

  test("explicit null clears a configured LLM model and inference", async () => {
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
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/clear-llm" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(rendered("command", "fixture//commands/clear-llm", "Review this.")).loader,
      current: { model: null, inference: null },
    });
    const connection = await captureChat(prepared);

    expect(prepared.request.model).toBeNull();
    expect(prepared.request.inference).toBeNull();
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
    const prepared = await prepareCommandInvocation({
      action: { ref: "fixture//commands/protected-llm" },
      config: configured,
      modelMap,
      sourceLoader: loaderFor(rendered("command", "fixture//commands/protected-llm", "Review this.")).loader,
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
    const connection = await captureChat(prepared);

    expect(prepared.request.inference).toMatchObject({ endpoint: "https://attacker.invalid/v1/chat/completions" });
    expect(connection).toMatchObject({
      endpoint: "https://fixture.invalid/v1/chat/completions",
      provider: "openai-compatible",
      model: "vendor/exact-model",
      temperature: 0,
    });
    expect(connection).not.toHaveProperty("apiKey");
    expect(connection.timeoutMs).not.toBe(1);
  });

  test("redacts a credential echoed by a direct LLM provider failure", async () => {
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

  test("a config edit after preparation does not change the prepared transport", async () => {
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
    const prepared = await prepareCommandInvocation({
      action: { content: "Review this." },
      config: llmConfig,
      modelMap,
    });
    Object.assign(llmConfig.engines?.direct ?? {}, {
      provider: "attacker",
      endpoint: "https://attacker.invalid/v1/chat/completions",
      apiKey: "$ATTACKER_KEY",
    });
    const connection = await withEnv({ SAFE_COMMAND_KEY: "safe-key", ATTACKER_KEY: "attacker-key" }, () =>
      captureChat(prepared),
    );
    expect(connection).toMatchObject({
      provider: "openai-compatible",
      endpoint: "https://safe.invalid/v1/chat/completions",
      apiKey: "safe-key",
    });

    const agentConfig: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { engine: "reviewer" },
      engines: {
        reviewer: { kind: "agent", platform: "claude", bin: "/safe/claude", args: ["--safe"] },
      },
    };
    const preparedAgent = await prepareCommandInvocation({
      action: { content: "Review." },
      config: agentConfig,
      modelMap,
    });
    Object.assign(agentConfig.engines?.reviewer ?? {}, {
      platform: "aider",
      bin: "/attacker/aider",
      args: ["--attacker"],
    });
    const { capture } = await captureAgent(preparedAgent);
    expect(capture.profile).toMatchObject({ platform: "claude", bin: "/safe/claude", args: ["--safe"] });
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
      return captureAgent(
        await prepareCommandInvocation({
          action: { ref: "fixture//commands/persona-route" },
          config: configured,
          modelMap,
          sourceLoader: loaderFor(command, persona).loader,
        }),
      );
    };

    const fallback = await runFor("aider");
    expect(fallback.capture.prompt).toBe("<AKM_PERSONA>\nYou are exact.\n</AKM_PERSONA>\n\nReview this.");
    expect(fallback.capture.options?.dispatch).toMatchObject({ prompt: fallback.capture.prompt });
    expect(fallback.capture.options?.dispatch).not.toHaveProperty("systemPrompt");
    expect(fallback.result.notices).toEqual([
      expect.objectContaining({ code: "persona-prompt-composed", adapter: "aider", field: "persona" }),
    ]);
    if (!fallback.capture.profile || !fallback.capture.options?.dispatch) {
      throw new Error("expected a captured Aider dispatch");
    }
    const aiderCommand = getCommandBuilder("aider").build(
      fallback.capture.profile,
      fallback.capture.options.dispatch as AgentDispatchRequest,
    );
    expect(aiderCommand.argv.join("\n")).toContain(
      "--message=<AKM_PERSONA>\nYou are exact.\n</AKM_PERSONA>\n\nReview this.",
    );
    expect(aiderCommand.argv.join("\n").match(/<AKM_PERSONA>/g)).toHaveLength(1);

    const native = await runFor("claude");
    expect(native.capture.prompt).toBe("Review this.");
    expect(native.capture.options?.dispatch).toMatchObject({ prompt: "Review this.", systemPrompt: "You are exact." });
    expect(native.result.notices).toBeUndefined();
  });
});
