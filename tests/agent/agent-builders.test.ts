/**
 * Tests for the agent command builder feature:
 *   - the opencode and claude builders, reached through the registry
 *
 * Coverage follows v1 spec §12.2 and §12.3.
 */
import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { getHarness } from "../../src/integrations/harnesses";
import type { AgentDispatchRequest } from "../../src/integrations/harnesses/harness";

/** The harness registered under `platform`; there is no builder for anything else. */
function getCommandBuilder(platform: string) {
  const harness = getHarness(platform);
  if (!harness) throw new Error(`Agent platform "${platform}" has no registered command builder.`);
  return harness;
}

// NOTE: this file previously carried a full 13-export mock.module fake of
// src/core/warn. Nothing under test here (builders and profiles)
// imports warn, and the captured `warnings` array was never asserted — the
// fake was dead weight and is gone. If a warn assertion is ever needed, use
// the `_setWarnSinkForTests` seam via tests/_helpers/seams.ts.

// ── Profile helpers ───────────────────────────────────────────────────────────

function makeFakeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "test-agent",
    bin: "test-agent",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

// These cases pin the OpenCode 1 argv (the builder only ever builds that: dispatch sends OpenCode 2 to the embedded OpenCode).
function makeOpencodeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return makeFakeProfile({
    name: "opencode",
    bin: "opencode",
    args: ["run"],
    ...overrides,
  });
}

function makeClaudeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return makeFakeProfile({
    name: "claude",
    bin: "claude",
    args: [],
    ...overrides,
  });
}

// ── builders.ts — opencodeBuilder ────────────────────────────────────────────

describe("opencodeBuilder — basic dispatch", () => {
  test("no agent options: argv = [opencode, run] and the prompt goes on stdin", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work" };
    const cmd = builder.build(profile, req);
    expect(cmd.argv).toEqual(["opencode", "run"]);
    expect(cmd.stdin).toBe("do work");
  });

  test("without a model override, configured model args are preserved", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({ args: ["run", "--model", "openai/gpt-5.4-mini"] });
    const cmd = builder.build(profile, { prompt: "do work" });
    expect(cmd.argv).toEqual(["opencode", "run", "--model", "openai/gpt-5.4-mini"]);
  });

  test("forwards an exact native agent selector through --agent", () => {
    const builder = getCommandBuilder("opencode");
    const req = { prompt: "do work", agent: "Review-Team.Exact" } as AgentDispatchRequest;
    expect(builder.build(makeOpencodeProfile(), req).argv).toEqual(["opencode", "run", "--agent", "Review-Team.Exact"]);
  });

  // `opencode run` 1.18.25 has no --system-prompt: it prints its usage and
  // exits 1. A persona reaches opencode through the prompt instead.
  test("never emits --system-prompt; the persona channel is the prompt", () => {
    const builder = getCommandBuilder("opencode");
    const req: AgentDispatchRequest = { prompt: "do work", systemPrompt: "You are helpful." };
    expect(builder.systemPrompt).toBe(false);
    expect(builder.build(makeOpencodeProfile(), req).argv).toEqual(["opencode", "run"]);
  });

  test("with pre-resolved model: --model flag present", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", model: "opencode/claude-opus-4-7" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("opencode/claude-opus-4-7");
  });

  test('an exact model selector "opus" is forwarded unchanged', () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", model: "opus" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("opus");
  });

  test("the engine's agent default and a model both reach the argv", () => {
    const req: AgentDispatchRequest = { prompt: "p", agent: "planner", model: "lab/m" };
    expect(getCommandBuilder("opencode").build(makeOpencodeProfile(), req).argv).toEqual([
      "opencode",
      "run",
      "--agent",
      "planner",
      "--model",
      "lab/m",
    ]);
  });

  test("a bare exact override replaces the configured model without reinterpretation", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({ args: ["run", "--model", "openai/gpt-5.4-mini"] });
    const cmd = builder.build(profile, { prompt: "do work", model: "gpt-5.6-terra" });
    expect(cmd.argv).toEqual(["opencode", "run", "--model", "gpt-5.6-terra"]);
  });

  test("provider-qualified override replaces the configured model unchanged", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({ args: ["run", "--model=openai/gpt-5.4-mini"] });
    const cmd = builder.build(profile, { prompt: "do work", model: "openai/gpt-5.6-terra" });
    expect(cmd.argv).toEqual(["opencode", "run", "--model", "openai/gpt-5.6-terra"]);
  });

  test("an exact override replaces the configured model without provider rewriting", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({ args: ["run", "--model", "openai/gpt-5.4-mini"] });
    const cmd = builder.build(profile, { prompt: "do work", model: "opus" });
    expect(cmd.argv).toEqual(["opencode", "run", "--model", "opus"]);
  });
});

// ── builders.ts — opencodeBuilder: inference ──────────────────────────────────
//
// The OpenCode 1 CLI translates no inference: it is the user's opencode config's to set.

describe("opencodeBuilder — inference", () => {
  const INFERENCE = { temperature: 0.2, reasoningEffort: "low", maxTokens: 4096, contextLength: 120000 };

  // akm injects nothing, whatever the request carries.
  test("an ordinary dispatch injects nothing: argv and env are the engine's", () => {
    const profile = makeOpencodeProfile({ args: ["run", "--model", "krang/chat/qwen3.8-27b"] });
    for (const inference of [{}, INFERENCE]) {
      const cmd = getCommandBuilder("opencode").build(profile, { prompt: "do work", inference });

      expect(cmd.argv).toEqual(["opencode", "run", "--model", "krang/chat/qwen3.8-27b"]);
      expect(cmd.env).toBeUndefined();
    }
  });
});

// ── builders.ts — claudeBuilder ───────────────────────────────────────────────

describe("claudeBuilder — basic dispatch", () => {
  test("no agent options: argv contains --print and prompt", () => {
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    expect(argv).toContain("--print");
    expect(argv[argv.length - 1]).toBe("do work");
  });

  test("--print is always present", () => {
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    // No extra flags
    const cmd = builder.build(profile, { prompt: "task" });
    expect((cmd.argv as string[]).includes("--print")).toBe(true);
  });

  test("forwards an exact native agent selector through --agent", () => {
    const builder = getCommandBuilder("claude");
    const req = { prompt: "do work", agent: "Review-Team.Exact" } as AgentDispatchRequest;
    expect(builder.build(makeClaudeProfile(), req).argv).toEqual([
      "claude",
      "--agent",
      "Review-Team.Exact",
      "--print",
      "--",
      "do work",
    ]);
  });

  test("with systemPrompt: --system-prompt flag present", () => {
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", systemPrompt: "Be concise." };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("Be concise.");
  });

  test("with model: exact value appears in --model", () => {
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", model: "opus" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("opus");
  });
});

// ── builders.ts — getCommandBuilder ───────────────────────────────────────────

describe("getCommandBuilder — platform routing", () => {
  test('getCommandBuilder("opencode-headless") rejects the retired profile alias', () => {
    expect(() => getCommandBuilder("opencode-headless")).toThrow(/no registered command builder/);
  });

  test('getCommandBuilder("unknown") rejects an unregistered platform', () => {
    expect(() => getCommandBuilder("unknown-platform")).toThrow(/no registered command builder/);
  });
});

// ── builders.ts — argument injection guards (M5) ──────────────────────────────

describe("builders — argument injection guards", () => {
  test("opencodeBuilder: a prompt that looks like a flag goes on stdin, not in argv", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const cmd = builder.build(profile, { prompt: "--do work" });
    expect(cmd.argv).not.toContain("--do work");
    expect(cmd.stdin).toBe("--do work");
  });

  test("claudeBuilder: prompt preceded by '--' end-of-options separator", () => {
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const cmd = builder.build(profile, { prompt: "do work" });
    const argv = cmd.argv as string[];
    const sepIdx = argv.indexOf("--");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(argv[sepIdx + 1]).toBe("do work");
  });

  // "unknown platforms cannot synthesize a generic argv" (D10) removed:
  // identical call and assertion as the "getCommandBuilder — platform
  // routing" describe block's `getCommandBuilder("unknown")` test at :284-287.

  test("opencodeBuilder: a model/systemPrompt starting with '--' is passed through, not rejected", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    expect(() =>
      builder.build(profile, { prompt: "task", model: "--evil-flag", systemPrompt: "--injected-flag value" }),
    ).not.toThrow();
  });

  test("claudeBuilder: a model/systemPrompt starting with '--' is passed through, not rejected", () => {
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    expect(() => builder.build(profile, { prompt: "task", model: "--evil", systemPrompt: "--injected" })).not.toThrow();
  });

  // "unknown platforms fail before accepting model flags" (D10) removed:
  // identical call and assertion as :284-287, and mis-titled — neither this
  // nor the removed :380-383 test asserted anything about argv or model
  // flags despite their names.

  test("valid model and systemPrompt values do not throw", () => {
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    expect(() =>
      builder.build(profile, {
        prompt: "task",
        model: "opencode/claude-sonnet-4-6",
        systemPrompt: "You are a helpful assistant.",
      }),
    ).not.toThrow();
  });
});
