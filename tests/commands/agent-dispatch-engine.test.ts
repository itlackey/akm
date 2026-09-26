// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { renderUsage } from "citty";
import { akmAgentDispatch } from "../../src/commands/agent/agent-dispatch";
import { agentCommand } from "../../src/commands/agent/contribute-cli";
import type { AkmConfig } from "../../src/core/config/config-types";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { FALLBACK_ANNOUNCEMENT } from "../../src/integrations/agent/engine-fallback";
import { executeInteractiveAgentInvocation } from "../../src/integrations/agent/runner-dispatch";
import { withEnv } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

describe("akm agent CLI help", () => {
  test("does not expose workflow flattening or present asset tool requests as authorization", async () => {
    const usage = await renderUsage(agentCommand as Parameters<typeof renderUsage>[0]);

    expect(usage).not.toContain("--workflow");
    expect(usage).toContain("separate operator authorization");
    expect(usage).toContain("rejected by the current CLI");
    expect(usage).not.toContain("provides the system prompt, model, and tool policy");
    expect(usage).not.toContain("Load prompt from a workflow asset");
  });
});

describe("akmAgentDispatch engine capability", () => {
  test("shared prompt-free lowering preserves native TTY options and redacts passthrough credentials", async () => {
    const secret = "sk-interactive-boundary-secret-123456";
    const calls: unknown[] = [];
    const execution = await withEnv({ ANTHROPIC_API_KEY: secret }, () =>
      executeInteractiveAgentInvocation(
        {
          config: {
            configVersion: "0.9.0",
            semanticSearchMode: "off",
            engines: { native: { kind: "agent", platform: "claude", bin: "/bin/true" } },
          },
          engine: "native",
          timeoutMs: 0,
          cwd: "/fixture/workspace",
        },
        {
          runAgent: async (profile, prompt, options) => {
            calls.push({ profile: profile.name, prompt, options });
            return {
              ok: false,
              exitCode: 1,
              stdout: `stdout ${secret}`,
              stderr: `stderr ${secret}`,
              error: `error ${secret}`,
              reason: "non_zero_exit",
              durationMs: 1,
            };
          },
        },
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      profile: "native",
      prompt: "",
      options: {
        stdio: "interactive",
        parseOutput: "text",
        timeoutMs: 0,
        cwd: "/fixture/workspace",
      },
    });
    const nativeOptions = (calls[0] as { options: Record<string, unknown> }).options;
    for (const field of ["env", "args", "stdin", "dispatch", "builderRegistry", "signal"]) {
      expect(Object.hasOwn(nativeOptions, field)).toBe(false);
    }
    for (const field of [execution.result.stdout, execution.result.stderr, execution.result.error]) {
      expect(field).not.toContain(secret);
    }
  });

  test("shared prompt-free lowering preserves the SDK profile stdio and rejects LLM engines before dispatch", async () => {
    const sdkCalls: unknown[] = [];
    await executeInteractiveAgentInvocation(
      {
        config: {
          configVersion: "0.9.0",
          semanticSearchMode: "off",
          engines: { sdk: { kind: "agent", platform: "opencode-sdk", bin: "/bin/true" } },
        },
        engine: "sdk",
      },
      {
        runSdk: async (profile, prompt, options) => {
          sdkCalls.push({ profile: profile.name, prompt, options });
          return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
        },
      },
    );
    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0]).toMatchObject({
      profile: "sdk",
      prompt: "",
      options: { stdio: "captured", parseOutput: "text" },
    });

    let dispatches = 0;
    await expect(
      executeInteractiveAgentInvocation(
        {
          config: {
            configVersion: "0.9.0",
            semanticSearchMode: "off",
            engines: {
              llm: { kind: "llm", endpoint: "https://example.invalid/v1/chat/completions", model: "fixture" },
            },
          },
          engine: "llm",
        },
        {
          runAgent: async () => {
            dispatches += 1;
            return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
          },
        },
      ),
    ).rejects.toThrow(/LLM engine.*requires an agent engine/i);
    expect(dispatches).toBe(0);
  });

  test("delegates prompt-free native launch through the shared interactive execution boundary", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        native: { kind: "agent", platform: "claude", bin: "/bin/true" },
      },
      defaults: { engine: "native" },
    };
    const calls: unknown[] = [];
    const result = await akmAgentDispatch(
      { agentConfig: config, engine: "native", timeoutMs: 0, cwd: "" },
      {
        executeInteractive: async (input) => {
          calls.push(input);
          return {
            engine: "native",
            result: {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
              durationMs: 1,
            },
          };
        },
      },
    );

    expect(calls).toEqual([{ config, engine: "native", timeoutMs: 0, cwd: "" }]);
    expect(result).toMatchObject({ ok: true, engine: "native", exitCode: 0 });
  });

  test("delegates noninteractive prompt/persona work through the same canonical invocation", async () => {
    const calls: unknown[] = [];
    const result = await akmAgentDispatch(
      {
        prompt: "Review exactly this.",
        agentRef: "fixture//agents/reviewer",
        engine: "reviewer",
        timeoutMs: 0,
        cwd: "",
        selection: {
          model: "balanced",
          inference: { effort: "high", temperature: 0 },
          tools: [],
          outputSchema: { type: "object" },
        },
        agentConfig: { configVersion: "0.9.0", semanticSearchMode: "off" },
      },
      {
        executeCommand: async (input) => {
          calls.push(input);
          return {
            schemaVersion: 2,
            ok: true,
            shape: "agent-result",
            engine: "reviewer",
            exitCode: 0,
            stdout: "done",
            stderr: "",
            durationMs: 1,
            notices: [],
          };
        },
      },
    );

    expect(result.stdout).toBe("done");
    expect(calls).toEqual([
      {
        action: { content: "Review exactly this." },
        // A prompt is free text: sent verbatim, never parsed as a template.
        inlineContentMode: "literal",
        config: { configVersion: "0.9.0", semanticSearchMode: "off" },
        current: {
          agent: "fixture//agents/reviewer",
          engine: "reviewer",
          model: "balanced",
          inference: { effort: "high", temperature: 0 },
          outputSchema: { type: "object" },
          tools: [],
          timeout: 0,
          workspace: "",
        },
      },
    ]);
  });

  test("rejects persona or model metadata without explicit work instead of fabricating an empty command", async () => {
    let calls = 0;
    const executeCommand = async () => {
      calls += 1;
      throw new Error("must not delegate");
    };
    const agentConfig = { configVersion: "0.9.0", semanticSearchMode: "off" } as const;

    await expect(
      akmAgentDispatch({ agentRef: "fixture//agents/reviewer", agentConfig }, { executeCommand }),
    ).rejects.toThrow(/--prompt|explicit task/i);
    await expect(
      akmAgentDispatch({ selection: { model: "balanced" }, agentConfig }, { executeCommand }),
    ).rejects.toThrow(/--prompt|explicit task/i);
    expect(calls).toBe(0);
  });

  test("rejects a non-agent positional ref before canonical command delegation", async () => {
    let calls = 0;
    await expect(
      akmAgentDispatch(
        {
          agentRef: "knowledge/guide",
          prompt: "Review exactly this.",
          agentConfig: { configVersion: "0.9.0", semanticSearchMode: "off" },
        },
        {
          executeCommand: async () => {
            calls += 1;
            throw new Error("must not delegate");
          },
        },
      ),
    ).rejects.toThrow(/agent asset ref|agents\//i);
    expect(calls).toBe(0);
  });

  test("returns the exact v2 public result envelope", async () => {
    const result = await akmAgentDispatch({
      engine: "test-agent",
      prompt: "hello",
      agentConfig: {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: {
          "test-agent": { kind: "agent", platform: "aider", bin: "/bin/true" },
        },
        defaults: { engine: "test-agent" },
      },
    });
    expect(result).toEqual({
      schemaVersion: 2,
      ok: true,
      shape: "agent-result",
      engine: "test-agent",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: expect.any(Number),
    });
  });

  test("delegates direct LLM prompt work instead of applying an agent-only capability gate", async () => {
    const calls: unknown[] = [];
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto" as const,
      engines: {
        fast: {
          kind: "llm" as const,
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
        },
      },
      defaults: { engine: "fast" },
    };
    const result = await akmAgentDispatch(
      { engine: "fast", prompt: "hello", agentConfig: config },
      {
        executeCommand: async (input) => {
          calls.push(input);
          return {
            schemaVersion: 2,
            ok: true,
            shape: "agent-result",
            engine: "fast",
            exitCode: 0,
            stdout: "llm output",
            stderr: "",
            durationMs: 1,
          };
        },
      },
    );
    expect(result.stdout).toBe("llm output");
    expect(calls).toEqual([
      { action: { content: "hello" }, inlineContentMode: "literal", config, current: { engine: "fast" } },
    ]);
  });

  test("returns one structured envelope for a normal runner failure", async () => {
    const result = await akmAgentDispatch({
      engine: "test-agent",
      prompt: "hello",
      agentConfig: {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        engines: {
          "test-agent": { kind: "agent", platform: "aider", bin: "/bin/false" },
        },
        defaults: { engine: "test-agent" },
      },
    });

    const parsed = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(parsed).toMatchObject({ schemaVersion: 2, ok: false, shape: "agent-result" });
    expect(result).toMatchObject({ schemaVersion: 2, ok: false, shape: "agent-result", exitCode: 1 });
  });

  test("the implicit engine fallback is announced, never silent — result warnings + warn()", async () => {
    const warned: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warned.push(args.map(String).join(" "));
    });

    const result = await akmAgentDispatch({
      prompt: "hello",
      agentConfig: {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        // No defaults.engine: withEngineFallback must select the opencode-sdk
        // entry. Operator-configured wins over synthesis, and the pinned
        // absolute bin keeps the probe (and the dispatch) off the real
        // opencode binary and PATH.
        engines: {
          "opencode-sdk": { kind: "agent", platform: "aider", bin: "/bin/true" },
        },
      },
    });

    expect(result.engine).toBe("opencode-sdk");
    expect(result.warnings).toEqual([FALLBACK_ANNOUNCEMENT]);
    expect(warned).toContain(FALLBACK_ANNOUNCEMENT);
  });
});

describe("akm agent --prompt is free text, not a template", () => {
  const agentConfig = {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    engines: { native: { kind: "agent", platform: "claude", bin: "/bin/true" } },
  } as unknown as AkmConfig;

  // A prompt is a person's prose. akm substitutes nothing in it, so the
  // portable command-template language must not be applied to it: a compact
  // JSON example ends in `}}`, a shell snippet carries `$(` and `$VAR`, and a
  // path reference carries `@src/...`. Every one of those used to be rejected
  // with "unsupported portable template construct" before the agent started.
  const promptsThatUsedToBeRejected = [
    'Summarise this payload: {"outer":{"inner":1}}',
    "Explain what $HOME and ${EDITOR} do in this snippet",
    "Why does $(git rev-parse HEAD) differ here?",
    "Review @src/core/state-db.ts for me",
    "Run !`date` in your head and tell me the format",
    "Interpolate $1 and $ARGUMENTS_SUFFIX literally",
  ];

  for (const prompt of promptsThatUsedToBeRejected) {
    test(`passes through verbatim: ${JSON.stringify(prompt.slice(0, 32))}...`, async () => {
      const seen: Array<{ content?: string; mode?: string }> = [];
      const result = await akmAgentDispatch(
        { prompt, agentConfig, engine: "native" },
        {
          executeCommand: async (options) => {
            seen.push({
              content: (options.action as { content?: string }).content,
              mode: options.inlineContentMode,
            });
            return {
              schemaVersion: 2,
              ok: true,
              shape: "agent-result",
              engine: "native",
              exitCode: 0,
              stdout: "",
              stderr: "",
            } as Awaited<ReturnType<typeof akmAgentDispatch>>;
          },
        },
      );

      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      // Verbatim: not masked, not escaped, not substituted.
      expect(seen[0]?.content).toBe(prompt);
      expect(seen[0]?.mode).toBe("literal");
    });
  }
});
