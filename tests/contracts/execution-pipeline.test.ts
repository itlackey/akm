// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The execution pipeline end to end, through its observable edges: the argv a
 * harness receives, the connection a direct LLM call receives, and the
 * request/runner a workflow journals.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderMarkdownExecutionSource } from "../../src/core/adapter/execution-source";
import type { AkmConfig } from "../../src/core/config/config";
import type { SpawnedSubprocess, SpawnFn } from "../../src/core/subprocess";
import { canonicalResolvedExecutionRequest, createResolvedPersona } from "../../src/execution/resolved-request";
import { MODEL_WORK_FINAL_TURN } from "../../src/execution/source";
import type { AgentDispatchRequest } from "../../src/integrations/agent/builder-shared";
import {
  buildExecution,
  buildExecutionFromWire,
  type ResolveExecutionInput,
  resolveExecution,
} from "../../src/integrations/agent/execution";
import { userModelMapPath } from "../../src/integrations/agent/model-map";
import { runExecution } from "../../src/integrations/agent/runner-dispatch";
import type { AgentRunResult, RunAgentOptions } from "../../src/integrations/agent/spawn";
import { withEnv } from "../_helpers/sandbox";

function exitedWith(stdout: string): SpawnedSubprocess {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  return { exitCode: 0, exited: Promise.resolve(0), stdout: stream(stdout), stderr: stream(""), kill() {} };
}

/** Resolve, build and run one execution, returning the argv and env the child would get. */
async function spawnedFor(input: ResolveExecutionInput): Promise<{ argv: string[]; env: Record<string, string> }> {
  const resolved = resolveExecution(input);
  let argv: string[] = [];
  let env: Record<string, string> = {};
  const spawn: SpawnFn = (cmd, options) => {
    argv = cmd;
    env = options.env ?? {};
    return exitedWith("done");
  };
  const result = await runExecution(buildExecution(resolved.request, resolved.runner), { runOptions: { spawn } });
  expect(result.ok).toBe(true);
  return { argv, env };
}

function config(partial: Record<string, unknown>): AkmConfig {
  return { configVersion: "0.9.0", ...partial } as unknown as AkmConfig;
}

const LLM_ENGINE = {
  kind: "llm",
  provider: "openai-compatible",
  endpoint: "https://llm.invalid/v1/chat/completions",
  model: "local/qwen",
  apiKey: "$AKM_PIPELINE_TEST_KEY",
  supportsJsonSchema: true,
};

function reviewer() {
  return createResolvedPersona(
    renderMarkdownExecutionSource({
      kind: "persona",
      raw: "---\ndescription: reviewer\n---\nYou review carefully.\n",
      identity: { ref: "fixture//agents/reviewer", bundle: "fixture", adapter: "akm", file: "agents/reviewer.md" },
      defaults: {},
    }),
  );
}

describe("agent engines: config engine → argv", () => {
  test("claude gets the alias-resolved model, the persona as its system prompt, and the prompt", async () => {
    const { argv } = await spawnedFor({
      content: "Review the diff.",
      config: config({ engines: { claude: { kind: "agent", platform: "claude" } }, defaults: { engine: "claude" } }),
      persona: reviewer(),
      current: { model: "fast" },
    });
    expect(argv).toEqual([
      "claude",
      "--system-prompt",
      "You review carefully.\n",
      "--model",
      "claude-haiku-4-5-20251001",
      "--print",
      "--",
      "Review the diff.",
    ]);
  });

  test("opencode gets the persona composed into its prompt, since `opencode run` has no --system-prompt", async () => {
    const { argv } = await spawnedFor({
      content: "Review the diff.",
      config: config({ engines: { oc: { kind: "agent", platform: "opencode" } }, defaults: { engine: "oc" } }),
      persona: reviewer(),
    });
    expect(argv).toEqual([
      "opencode",
      "run",
      "--",
      "<AKM_PERSONA>\nYou review carefully.\n</AKM_PERSONA>\n\nReview the diff.",
    ]);
  });

  test("opencode replaces its profile model flag with the resolved one", async () => {
    const { argv } = await spawnedFor({
      content: "Summarise.",
      config: config({
        engines: { oc: { kind: "agent", platform: "opencode", model: "balanced" } },
        defaults: { engine: "oc" },
      }),
    });
    expect(argv).toEqual(["opencode", "run", "--model", "opencode/claude-sonnet-4-6", "--", "Summarise."]);
  });

  test("pi passes an exact model through untouched and composes nothing it has no channel for", async () => {
    const { argv } = await spawnedFor({
      content: "Plan it.",
      config: config({ engines: { pi: { kind: "agent", platform: "pi", model: "provider/exact" } } }),
      current: { engine: "pi" },
    });
    expect(argv).toEqual(["pi", "--model", "provider/exact", "-p", "--", "Plan it."]);
  });

  test("an alias's inference applies under the selecting layer's own inference", () => {
    const resolved = resolveExecution({
      content: "Think.",
      config: config({ engines: { claude: { kind: "agent", platform: "claude" } }, defaults: { engine: "claude" } }),
      current: { model: "reasoning", inference: { temperature: 0.2 } },
    });
    expect(resolved.request.model).toEqual({
      input: "reasoning",
      interpretation: "alias",
      resolved: "claude-opus-4-7",
    });
    expect(resolved.request.inference).toEqual({ reasoningEffort: "high", temperature: 0.2 });
    expect(resolved.provenance["/inference/reasoningEffort"]).toEqual({
      layer: "current-invocation",
      kind: "current",
      via: "model-alias",
    });
  });

  // `effort` (a models.json alias, `effort:` frontmatter) and `reasoningEffort`
  // (an engine, opencode, the LLM request) are one setting, with one word in
  // the request: the nearest layer wins whichever word it used.
  describe("one word for reasoning effort", () => {
    const engine = { engines: { oc: { kind: "agent", platform: "opencode" } } };

    test("an alias's effort is the request's reasoningEffort", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config({ ...engine, defaults: { engine: "oc" } }),
        current: { model: "reasoning" },
      });

      expect(resolved.request.inference).toEqual({ reasoningEffort: "high" });
    });

    test("a nearer reasoningEffort overrides a farther effort", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config({ ...engine, defaults: { engine: "oc" } }),
        commandLayer: { id: "command", values: { inference: { effort: "high" } } },
        current: { inference: { reasoningEffort: "low" } },
      });

      expect(resolved.request.inference).toEqual({ reasoningEffort: "low" });
    });

    test("in one inference object reasoningEffort wins over effort", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config({ ...engine, defaults: { engine: "oc" } }),
        current: { inference: { effort: "high", reasoningEffort: "low" } },
      });

      expect(resolved.request.inference).toEqual({ reasoningEffort: "low" });
    });

    test("an explicit null effort is a null reasoningEffort", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config({ ...engine, defaults: { engine: "oc" } }),
        current: { inference: { effort: null } },
      });

      expect(resolved.request.inference).toEqual({ reasoningEffort: null });
    });

    test("the request never carries the other word", () => {
      const resolved = resolveExecution({
        content: "Think.",
        config: config({ ...engine, defaults: { engine: "oc" } }),
        current: { inference: { effort: "high", temperature: 0 } },
      });

      expect(resolved.request.inference).not.toHaveProperty("effort");
      expect(Object.keys(resolved.provenance).filter((key) => key.endsWith("/effort"))).toEqual([]);
    });
  });

  test("#946: a models.json column may borrow a configured engine's own model", async () => {
    fs.mkdirSync(path.dirname(userModelMapPath()), { recursive: true });
    fs.writeFileSync(
      userModelMapPath(),
      JSON.stringify({ version: 1, aliases: { fast: { opencode: { engine: "local-fast" } } } }),
    );
    try {
      const resolved = resolveExecution({
        content: "Go.",
        config: config({
          engines: { "local-fast": { kind: "agent", platform: "opencode", model: "krang/qwen3.5-9b" } },
        }),
        current: { engine: "local-fast", model: "fast" },
      });
      expect(resolved.request.model?.resolved).toBe("krang/qwen3.5-9b");
      expect(resolved.runner.kind === "agent" && resolved.runner.profile.model).toBe("krang/qwen3.5-9b");
    } finally {
      fs.rmSync(userModelMapPath(), { force: true });
    }
  });
});

describe("opencode-sdk engines", () => {
  test("without its own model an SDK engine runs its LLM fallback's model, timeout and credential", async () => {
    const resolved = resolveExecution({
      content: "Draft it.",
      config: config({
        engines: {
          sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "local" },
          local: { ...LLM_ENGINE, timeoutMs: 90_000 },
        },
        defaults: { engine: "sdk" },
      }),
    });
    expect(resolved.request.engine).toEqual({ name: "sdk", kind: "sdk", platform: "opencode-sdk" });
    expect(resolved.request.model?.resolved).toBe("local/qwen");
    expect(resolved.runner.timeoutMs).toBe(90_000);

    await withEnv({ AKM_PIPELINE_TEST_KEY: "sk-sdk-fallback" }, async () => {
      let seen: { model?: string; fallback?: { apiKey?: string; endpoint?: string } } = {};
      const result = await runExecution(buildExecution(resolved.request, resolved.runner), {
        runSdk: async (profile, _prompt, _opts, fallback) => {
          seen = { model: profile.model, fallback };
          return { ok: true, exitCode: 0, stdout: `used ${fallback?.apiKey}`, stderr: "", durationMs: 1 };
        },
      });
      expect(seen.model).toBe("local/qwen");
      expect(seen.fallback).toMatchObject({ apiKey: "sk-sdk-fallback", endpoint: LLM_ENGINE.endpoint });
      expect(result.stdout).toBe("used [REDACTED]");
    });
  });

  test("an SDK engine with no llmEngine of its own borrows nothing from defaults.llmEngine", async () => {
    const resolved = resolveExecution({
      content: "Draft it.",
      config: config({
        engines: {
          sdk: { kind: "agent", platform: "opencode-sdk" },
          local: { ...LLM_ENGINE, timeoutMs: 90_000 },
        },
        defaults: { engine: "sdk", llmEngine: "local" },
      }),
    });
    expect(resolved.request.engine).toEqual({ name: "sdk", kind: "sdk", platform: "opencode-sdk" });
    // No model, no timeout and no connection: opencode picks its own.
    expect(resolved.request.model).toBeUndefined();
    expect(Object.hasOwn(resolved.request.runtime, "timeoutMs")).toBe(false);
    expect(resolved.runner.timeoutMs).toBeUndefined();
    expect(resolved.provenance.model).toBeUndefined();

    await withEnv({ AKM_PIPELINE_TEST_KEY: "sk-must-not-reach-the-sdk" }, async () => {
      let seen: { model?: string; fallback?: unknown } | undefined;
      const result = await runExecution(buildExecution(resolved.request, resolved.runner), {
        runSdk: async (profile, _prompt, _opts, fallback) => {
          seen = { model: profile.model, fallback };
          return { ok: true, exitCode: 0, stdout: "done", stderr: "", durationMs: 1 };
        },
      });
      expect(result.ok).toBe(true);
      expect(seen).toEqual({ model: undefined, fallback: undefined });
    });
  });

  test("a conversation prefix is composed into one prompt block for CLI harnesses", () => {
    const resolved = resolveExecution({
      content: "Now finish.",
      config: config({ engines: { pi: { kind: "agent", platform: "pi" } }, defaults: { engine: "pi" } }),
      conversation: [{ role: "assistant", content: "First draft." }],
    });
    const built = buildExecution(resolved.request, resolved.runner);
    expect(built.prompt).toContain("First draft.");
    expect(built.prompt.endsWith("\n\nNow finish.")).toBe(true);
    expect(built.notices.map((notice) => notice.code)).toEqual(["conversation-prompt-composed"]);
  });
});

describe("engine selection is an ordered list", () => {
  const engines = {
    claude: { kind: "agent", platform: "claude" },
    pi: { kind: "agent", platform: "pi" },
  };

  test("the nearest layer that names an engine wins, then defaults.engine", () => {
    const base = { content: "x", config: config({ engines, defaults: { engine: "claude" } }) };
    expect(resolveExecution(base).request.engine.name).toBe("claude");
    expect(
      resolveExecution({ ...base, commandLayer: { id: "cmd", values: { engine: "pi" } } }).request.engine.name,
    ).toBe("pi");
    expect(
      resolveExecution({
        ...base,
        commandLayer: { id: "cmd", values: { engine: "pi" } },
        current: { engine: "claude" },
      }).provenance.engine,
    ).toEqual({ layer: "current-invocation", kind: "current", via: "explicit" });
  });

  test("a named but unconfigured engine is an error, never rescued by a fallback", () => {
    expect(() => resolveExecution({ content: "x", config: config({ engines }), current: { engine: "codex" } })).toThrow(
      'Engine "codex" is not configured.',
    );
  });

  test("with no selection, opencode-sdk runs when its binary is present", async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "akm-opencode-bin-"));
    fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
    try {
      await withEnv({ PATH: bin }, () => {
        const resolved = resolveExecution({ content: "x", config: config({ engines }) });
        expect(resolved.request.engine).toEqual({ name: "opencode-sdk", kind: "sdk", platform: "opencode-sdk" });
        expect(resolved.fallbackEngineName).toBe("opencode-sdk");
        expect(resolved.provenance.engine).toEqual({ layer: "opencode-sdk", kind: "fallback", via: "fallback" });
      });
      await withEnv({ PATH: path.join(bin, "missing") }, () => {
        expect(() => resolveExecution({ content: "x", config: config({ engines }) })).toThrow(
          /no usable `opencode` binary/,
        );
      });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("direct LLM engines: config engine → chat call", () => {
  test("the credential is read at dispatch, never frozen into the resolved runner", async () => {
    await withEnv({ AKM_PIPELINE_TEST_KEY: "sk-resolve-time" }, async () => {
      const resolved = resolveExecution({
        content: "Classify this.",
        config: config({ engines: { local: LLM_ENGINE }, defaults: { llmEngine: "local" } }),
        current: { engine: "local", outputSchema: { type: "object" }, timeout: "2m" },
        conversation: [{ role: "assistant", content: "Earlier draft." }],
        persona: reviewer(),
      });
      expect(JSON.stringify(resolved)).not.toContain("sk-");
      const built = buildExecution(resolved.request, resolved.runner);
      process.env.AKM_PIPELINE_TEST_KEY = "sk-dispatch-time";
      let seen: { apiKey?: string; messages: unknown; responseSchema?: unknown; timeoutMs?: unknown } | undefined;
      const result = await runExecution(built, {
        chat: async (connection, messages, options) => {
          seen = { apiKey: connection.apiKey, messages, ...options };
          return `echo ${connection.apiKey}`;
        },
      });
      expect(seen?.apiKey).toBe("sk-dispatch-time");
      expect(seen?.messages).toEqual([
        { role: "system", content: "You review carefully.\n" },
        { role: "assistant", content: "Earlier draft." },
        { role: "user", content: "Classify this." },
      ]);
      expect(seen?.responseSchema).toEqual({ type: "object" });
      expect(seen?.timeoutMs).toBe(120_000);
      expect(result.stdout).toBe("echo [REDACTED]");
    });
  });

  test("a missing required credential fails at dispatch with the variable named", async () => {
    await withEnv({ AKM_PIPELINE_TEST_KEY: undefined }, async () => {
      const resolved = resolveExecution({
        content: "x",
        config: config({ engines: { local: LLM_ENGINE } }),
        current: { engine: "local" },
      });
      const built = buildExecution(resolved.request, resolved.runner);
      await expect(runExecution(built, { chat: async () => "unused" })).rejects.toThrow(/AKM_PIPELINE_TEST_KEY/);
    });
  });

  test("the direct LLM transport refuses a tool selection it cannot enforce", () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({ engines: { local: LLM_ENGINE }, execution: { allowedTools: ["read"] } }),
      current: { engine: "local", tools: ["read"] },
    });
    expect(() => buildExecution(resolved.request, resolved.runner)).toThrow(/cannot enforce/);
  });
});

describe("tool authorization is capped by execution.allowedTools", () => {
  const engines = { claude: { kind: "agent", platform: "claude" } };

  test("an allowed selection reaches the harness; a denied one stops at build", async () => {
    const allowed = config({ engines, defaults: { engine: "claude" }, execution: { allowedTools: ["Read", "Grep"] } });
    const { argv } = await spawnedFor({ content: "x", config: allowed, current: { tools: ["Read"] } });
    expect(argv).toContain("--allowedTools");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read");

    const denied = resolveExecution({ content: "x", config: allowed, current: { tools: ["Bash"] } });
    expect(denied.request.authorization.status).toBe("denied");
    expect(() => buildExecution(denied.request, denied.runner)).toThrow(/not authorized/);
  });

  test("a runner-only resolution has no allowlist, so any tool selection is denied", () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({ engines, defaults: { engine: "claude" }, execution: { allowedTools: ["*"] } }),
    });
    const again = resolveExecution({ content: "y", runner: resolved.runner, current: { tools: ["Read"] } });
    expect(again.request.authorization).toMatchObject({ status: "denied", policy: { id: "unconfigured" } });
  });
});

describe("provenance and notices", () => {
  test("each field names the layer that set it", () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({
        engines: { local: { ...LLM_ENGINE, timeoutMs: 1000, temperature: 0.5 } },
        defaults: { engine: "local" },
      }),
      commandLayer: { id: "fixture//commands/review", values: { model: "exact/model" } },
      current: { timeout: 5000 },
    });
    expect(resolved.provenance).toMatchObject({
      engine: { layer: "installation-defaults", kind: "installation", via: "explicit" },
      model: { layer: "fixture//commands/review", kind: "command", via: "explicit" },
      "runtime.timeoutMs": { layer: "current-invocation", kind: "current", via: "explicit" },
      "/inference/temperature": { layer: "local", kind: "engine", via: "explicit" },
      authorization: { layer: "not-required", kind: "authorization", via: "policy" },
    });
    expect(resolved.runner.timeoutMs).toBe(5000);
  });

  test("a field a transport cannot carry is noted, not refused", () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({ engines: { oc: { kind: "agent", platform: "opencode" } }, defaults: { engine: "oc" } }),
      current: { outputSchema: { type: "object" }, inference: { vendorKnob: 1 } },
    });
    const built = buildExecution(resolved.request, resolved.runner);
    // The schema travels as the prompt instruction, so only the inference knob is noted.
    expect(built.notices.map((notice) => notice.field)).toEqual(["inference.vendorKnob"]);
  });
});

describe("resume from the journaled wire form", () => {
  test("a config edit after the freeze does not change what a resumed unit runs", async () => {
    const live = config({
      engines: { oc: { kind: "agent", platform: "opencode", model: "provider/frozen", bin: "opencode-frozen" } },
      defaults: { engine: "oc" },
    });
    const resolved = resolveExecution({ content: "Resume me.", config: live });
    const frozen = buildExecution(resolved.request, resolved.runner);
    const wire = JSON.parse(
      JSON.stringify({ request: JSON.parse(canonicalResolvedExecutionRequest(frozen.request)), runner: frozen.runner }),
    );

    // The operator repoints the engine after the freeze.
    (live.engines as Record<string, unknown>).oc = { kind: "agent", platform: "claude", model: "provider/new" };

    const resumed = buildExecutionFromWire(wire);
    let argv: string[] = [];
    await runExecution(resumed, {
      runOptions: {
        spawn: (cmd) => {
          argv = cmd;
          return exitedWith("ok");
        },
      },
    });
    expect(argv).toEqual(["opencode-frozen", "run", "--model", "provider/frozen", "--", "Resume me."]);
  });

  test("the wire decoder tolerates unknown keys and fills missing profile defaults", () => {
    const built = buildExecutionFromWire({
      request: {
        ...JSON.parse(
          canonicalResolvedExecutionRequest(
            resolveExecution({
              content: "x",
              config: config({ engines: { pi: { kind: "agent", platform: "pi" } }, defaults: { engine: "pi" } }),
            }).request,
          ),
        ),
        addedByANewerRelease: true,
      },
      runner: { kind: "agent", engine: "pi", profile: { name: "pi", platform: "pi", bin: "pi" }, legacyField: 1 },
    });
    expect(built.runner.kind === "agent" && built.runner.profile.envPassthrough).toEqual([]);
    expect(built.prompt).toBe("x");
  });
});

describe("dispatch options", () => {
  test("only operational run options apply; eventSource stamps AKM_EVENT_SOURCE", async () => {
    const resolved = resolveExecution({
      content: "x",
      config: config({ engines: { pi: { kind: "agent", platform: "pi" } }, defaults: { engine: "pi" } }),
      current: { environment: { KEEP: "request-value" }, timeout: 1000 },
    });
    let env: Record<string, string> = {};
    let cwd: string | undefined;
    await runExecution(buildExecution(resolved.request, resolved.runner), {
      eventSource: "task",
      runOptions: {
        env: { KEEP: "caller-override" },
        cwd: "/ignored",
        spawn: (_cmd, options) => {
          env = options.env ?? {};
          cwd = options.cwd;
          return exitedWith("ok");
        },
      },
    });
    expect(env.KEEP).toBe("request-value");
    expect(env.AKM_EVENT_SOURCE).toBe("task");
    expect(cwd).toBeUndefined();
  });
});

describe("the model-work tool policy", () => {
  const engines = { claude: { kind: "agent", platform: "claude", workspace: "/configured/workspace" } };
  const modelWork = config({ engines, defaults: { engine: "claude" } });

  test("is akm's own: allowed without execution.allowedTools, on a runner-only resolution too", () => {
    const { runner } = resolveExecution({ content: "x", config: modelWork });
    const again = resolveExecution({ content: "y", runner, modelWork: true });
    expect(again.request.authorization).toMatchObject({ status: "allowed", policy: { id: "model-work" } });
    expect(() => buildExecution(again.request, again.runner)).not.toThrow();
  });

  // The caller asks for the policy; no `tools` value names it. An asset's or a task's own `tools:`, even the
  // exact tools the policy allows, is ordinary tools: the operator's `execution.allowedTools` decides.
  test("an asset's or a task's own tools, the policy's four included, are denied without execution.allowedTools", () => {
    const tools = ["read", "edit", "akm search", "akm show"];
    const layers = [
      { agentLayer: { id: "agents/a", values: { tools } } },
      { commandLayer: { id: "commands/c", values: { tools } } },
      { current: { tools } },
    ];
    for (const layer of layers) {
      const { request } = resolveExecution({ content: "x", config: modelWork, ...layer });

      expect(request.authorization).toMatchObject({
        status: "denied",
        policy: { id: "config-execution-allowed-tools" },
      });
    }
  });

  test("cannot run a native agent, which would replace the confined one", () => {
    const resolved = resolveExecution({
      content: "x",
      config: modelWork,
      current: { agent: "reviewer" },
      modelWork: true,
    });
    expect(() => buildExecution(resolved.request, resolved.runner)).toThrow(
      /native agent "reviewer" under the model-work tool policy/,
    );
  });

  test("an agent runs in a fresh scratch directory, removed afterwards even when the dispatch throws", async () => {
    const resolved = resolveExecution({ content: "x", config: modelWork, modelWork: true });
    const built = buildExecution(resolved.request, resolved.runner);
    const seen: string[] = [];
    const runAgent = async (_profile: unknown, _prompt: string, opts: { cwd?: string }) => {
      seen.push(opts.cwd ?? "");
      if (seen.length === 2) throw new Error("dispatch exploded");
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    };
    await runExecution(built, { runAgent });
    await expect(runExecution(built, { runAgent })).rejects.toThrow("dispatch exploded");

    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    for (const cwd of seen) {
      // Not the engine's configured workspace, which could be the stash.
      expect(path.basename(cwd)).toStartWith("akm-model-work-");
      expect(fs.existsSync(cwd)).toBe(false);
    }
  });

  test("an agent that ends with no answer has failed with parse_error; other work keeps its empty reply", async () => {
    const runAgent = async () => ({ ok: true, exitCode: 0, stdout: "  \n", stderr: "", durationMs: 1 });
    const run = (isModelWork: boolean) => {
      const resolved = resolveExecution({ content: "x", config: modelWork, modelWork: isModelWork });
      return runExecution(buildExecution(resolved.request, resolved.runner), { runAgent });
    };

    expect(await run(true)).toMatchObject({
      ok: false,
      reason: "parse_error",
      error: 'Engine "claude" returned no answer.',
    });
    expect(await run(false)).toMatchObject({ ok: true, stdout: "  \n" });
  });

  // opencode ends a run at its step limit with no answer. It is asked once more: in the dispatch's own scratch
  // directory (its session is scoped to it), with the question alone, within what is left of the timeout.
  describe("opencode ends a run with no answer", () => {
    /** One dispatch whose runs end as `replies` say: "" is no answer, "fail" a failed run. */
    async function dispatched(
      platform: string,
      replies: string[],
      { isModelWork = true, timeoutMs = 10_000 as number | null } = {},
    ) {
      const calls: { dispatch?: AgentDispatchRequest; cwd?: string; timeoutMs?: number | null }[] = [];
      const runAgent = async (_profile: unknown, _prompt: string, opts: RunAgentOptions): Promise<AgentRunResult> => {
        calls.push({ dispatch: opts.dispatch, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
        const reply = replies[calls.length - 1] ?? "an unexpected extra run";
        if (reply !== "fail") return { ok: true, exitCode: 0, stdout: reply, stderr: "", durationMs: 40 };
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "",
          durationMs: 40,
          reason: "non_zero_exit",
          error: "failed",
        };
      };
      const resolved = resolveExecution({
        content: "judge this",
        config: config({ engines: { e: { kind: "agent", platform, timeoutMs } } }),
        current: { engine: "e" },
        modelWork: isModelWork,
      });
      const result = await runExecution(buildExecution(resolved.request, resolved.runner), { runAgent });
      return { calls, result };
    }

    test("the extra turn runs in the same scratch directory, the question alone, within the engine's timeout", async () => {
      const { calls, result } = await dispatched("opencode", ["  \n", '{"verdict":"ok"}']);

      expect(result).toMatchObject({ ok: true, stdout: '{"verdict":"ok"}', durationMs: 80 });
      const [first, final] = calls;
      expect(first?.dispatch).toMatchObject({ modelWork: true });
      expect(first?.dispatch?.finalTurn).toBeUndefined();
      expect(final?.dispatch).toMatchObject({ modelWork: true, prompt: MODEL_WORK_FINAL_TURN, finalTurn: true });
      expect(final?.cwd).toBe(first?.cwd);
      expect(path.basename(first?.cwd ?? "")).toStartWith("akm-model-work-");
      expect(fs.existsSync(first?.cwd ?? "")).toBe(false);
      expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 9_960]);
      // An engine with no timeout gives the extra turn none either.
      const untimed = await dispatched("opencode", ["", "answer"], { timeoutMs: null });
      expect(untimed.calls.map((call) => call.timeoutMs)).toEqual([null, null]);
    });

    test("it asks once, and only of opencode: every other ending is what it was", async () => {
      const outcome = async (...args: Parameters<typeof dispatched>) => {
        const { calls, result } = await dispatched(...args);
        return [calls.length, result.ok, result.reason];
      };

      expect(await outcome("opencode", ["", " "])).toEqual([2, false, "parse_error"]);
      expect(await outcome("opencode", ["", "fail"])).toEqual([2, false, "non_zero_exit"]);
      expect(await outcome("opencode", ["an answer"])).toEqual([1, true, undefined]);
      expect(await outcome("opencode", ["fail"])).toEqual([1, false, "non_zero_exit"]);
      // Another harness cannot continue a session, so it would only run the task again; other work keeps its reply.
      expect(await outcome("claude", [""])).toEqual([1, false, "parse_error"]);
      expect(await outcome("opencode", [""], { isModelWork: false })).toEqual([1, true, undefined]);
    });
  });

  // The owner's opencode engines name their model only in `args`, which model work otherwise leaves out.
  test.each([
    ["opencode", ["run", "--model", "openai/gpt-5.6-terra"], "openai/gpt-5.6-terra"],
    ["claude", ["--verbose", "--model=claude-args-model"], "claude-args-model"],
  ])("%s: a model named only in the engine's args reaches the model-work argv", async (platform, args, model) => {
    const engines = { argsonly: { kind: "agent", platform, args } };
    const { argv } = await spawnedFor({
      content: "x",
      config: config({ engines }),
      current: { engine: "argsonly" },
      modelWork: true,
    });
    expect(argv[argv.indexOf("--model") + 1]).toBe(model);
    // The rest of the engine's args stay out of model work.
    expect(argv).not.toContain("--verbose");
  });
});
