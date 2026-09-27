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
import {
  buildExecution,
  buildExecutionFromWire,
  type ResolveExecutionInput,
  resolveExecution,
} from "../../src/integrations/agent/execution";
import { userModelMapPath } from "../../src/integrations/agent/model-map";
import { runExecution } from "../../src/integrations/agent/runner-dispatch";
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
    expect(resolved.request.inference).toEqual({ effort: "high", temperature: 0.2 });
    expect(resolved.provenance["/inference/effort"]).toEqual({
      layer: "current-invocation",
      kind: "current",
      via: "model-alias",
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
    expect(built.notices.map((notice) => notice.field)).toEqual(["inference.vendorKnob", "outputSchema"]);
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
