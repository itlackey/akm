/**
 * Tests for the agent command builder feature:
 *   - builders.ts: opencodeBuilder, claudeBuilder, getCommandBuilder
 *
 * Coverage follows v1 spec §12.2 and §12.3.
 */
import { describe, expect, test } from "bun:test";
import type { AgentCommandBuilder, AgentDispatchRequest } from "../../src/integrations/agent/builder-shared";
import type { AgentProfile } from "../../src/integrations/agent/profiles";

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

function makeOpencodeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return makeFakeProfile({
    name: "opencode",
    bin: "opencode",
    args: ["run"],
    opencodeVersion: 1,
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
  test("no agent options: argv = [opencode, run, --, <prompt>]", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work" };
    const cmd = builder.build(profile, req);
    expect(cmd.argv).toEqual(["opencode", "run", "--", "do work"]);
  });

  test("without a model override, configured model args are preserved", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({ args: ["run", "--model", "openai/gpt-5.4-mini"] });
    const cmd = builder.build(profile, { prompt: "do work" });
    expect(cmd.argv).toEqual(["opencode", "run", "--model", "openai/gpt-5.4-mini", "--", "do work"]);
  });

  test("forwards an exact native agent selector through --agent", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const req = { prompt: "do work", agent: "Review-Team.Exact" } as AgentDispatchRequest;
    expect(builder.build(makeOpencodeProfile(), req).argv).toEqual([
      "opencode",
      "run",
      "--agent",
      "Review-Team.Exact",
      "--",
      "do work",
    ]);
  });

  // `opencode run` 1.18.25 has no --system-prompt: it prints its usage and
  // exits 1. A persona reaches opencode through the prompt instead.
  test("never emits --system-prompt; the persona channel is the prompt", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const req: AgentDispatchRequest = { prompt: "do work", systemPrompt: "You are helpful." };
    expect(builder.personaChannel).toBe("prompt");
    expect(builder.build(makeOpencodeProfile(), req).argv).toEqual(["opencode", "run", "--", "do work"]);
  });

  test("with pre-resolved model: --model flag present", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", model: "opencode/claude-opus-4-7" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("opencode/claude-opus-4-7");
  });

  test('an exact model selector "opus" is forwarded unchanged', async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", model: "opus" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("opus");
  });

  test("a bare exact override replaces the configured model without reinterpretation", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({ args: ["run", "--model", "openai/gpt-5.4-mini"] });
    const cmd = builder.build(profile, { prompt: "do work", model: "gpt-5.6-terra" });
    expect(cmd.argv).toEqual(["opencode", "run", "--model", "gpt-5.6-terra", "--", "do work"]);
  });

  test("provider-qualified override replaces the configured model unchanged", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({ args: ["run", "--model=openai/gpt-5.4-mini"] });
    const cmd = builder.build(profile, { prompt: "do work", model: "openai/gpt-5.6-terra" });
    expect(cmd.argv).toEqual(["opencode", "run", "--model", "openai/gpt-5.6-terra", "--", "do work"]);
  });

  test("an exact override replaces the configured model without provider rewriting", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({ args: ["run", "--model", "openai/gpt-5.4-mini"] });
    const cmd = builder.build(profile, { prompt: "do work", model: "opus" });
    expect(cmd.argv).toEqual(["opencode", "run", "--model", "opus", "--", "do work"]);
  });

  test("tool policy is NOT emitted (opencode ignores toolPolicy)", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", tools: "read,write" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    expect(argv.includes("--allowedTools")).toBe(false);
    expect(argv.join(" ")).not.toContain("read,write");
  });
});

// ── builders.ts — opencodeBuilder: inference ──────────────────────────────────
//
// Inference reaches opencode only in the config akm injects for model work
// (`OPENCODE_CONFIG_CONTENT`; see `harnesses/opencode/model-config.ts`).

describe("opencodeBuilder — inference", () => {
  const INFERENCE = { temperature: 0.2, reasoningEffort: "low", maxTokens: 4096, contextLength: 120000 };

  // Inference for an ordinary dispatch is the user's opencode config's to set, so akm injects nothing, whatever the request carries.
  test("an ordinary dispatch injects nothing: argv and env are the engine's", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const profile = makeOpencodeProfile({ args: ["run", "--model", "krang/chat/qwen3.8-27b"] });
    for (const inference of [{}, INFERENCE]) {
      const cmd = getCommandBuilder("opencode").build(profile, { prompt: "do work", inference });

      expect(cmd.argv).toEqual(["opencode", "run", "--model", "krang/chat/qwen3.8-27b", "--", "do work"]);
      expect(cmd.env).toBeUndefined();
    }
  });

  test("model work with no inference defines the agent and nothing else, as before", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const cmd = getCommandBuilder("opencode").build(makeOpencodeProfile(), {
      prompt: "judge it",
      model: "krang/m",
      modelWork: true,
    });
    const config = JSON.parse(cmd.env?.OPENCODE_CONFIG_CONTENT ?? "null");

    expect(Object.keys(config).sort()).toEqual(["agent", "compaction", "permission"]);
    expect(config.agent["akm-model-work"]).not.toHaveProperty("options");
  });
});

// ── builders.ts — claudeBuilder ───────────────────────────────────────────────

describe("claudeBuilder — basic dispatch", () => {
  test("no agent options: argv contains --print and prompt", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    expect(argv).toContain("--print");
    expect(argv[argv.length - 1]).toBe("do work");
  });

  test("--print is always present", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    // No extra flags
    const cmd = builder.build(profile, { prompt: "task" });
    expect((cmd.argv as string[]).includes("--print")).toBe(true);
  });

  test("forwards an exact native agent selector through --agent", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
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

  test("with systemPrompt: --system-prompt flag present", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", systemPrompt: "Be concise." };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("Be concise.");
  });

  test("with model: exact value appears in --model", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", model: "opus" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("opus");
  });

  test("with tools string: --allowedTools flag present with value", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", tools: "read,edit" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("read,edit");
  });

  test("with tools array: --allowedTools joined with comma", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", tools: ["read", "edit"] };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("read,edit");
  });

  test("without tools: no --allowedTools flag emitted", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work" };
    const cmd = builder.build(profile, req);
    expect((cmd.argv as string[]).includes("--allowedTools")).toBe(false);
  });
});

// ── builders.ts — getCommandBuilder ───────────────────────────────────────────

describe("getCommandBuilder — platform routing", () => {
  test('getCommandBuilder("opencode") returns opencode builder (platform === "opencode")', async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    expect(builder.platform).toBe("opencode");
  });

  test('getCommandBuilder("claude") returns claude builder (platform === "claude")', async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    expect(builder.platform).toBe("claude");
  });

  test('getCommandBuilder("opencode-headless") rejects the retired profile alias', async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    expect(() => getCommandBuilder("opencode-headless")).toThrow(/no registered command builder/);
  });

  test('getCommandBuilder("unknown") rejects an unregistered platform', async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    expect(() => getCommandBuilder("unknown-platform")).toThrow(/no registered command builder/);
  });

  test("custom registry: getCommandBuilder returns custom builder when platform matches", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const myBuilder: AgentCommandBuilder = {
      platform: "my-platform",
      personaChannel: "prompt",
      build(_profile, req) {
        return { argv: ["my-cli", req.prompt] };
      },
    };
    const builder = getCommandBuilder("my-platform", { "my-platform": myBuilder });
    expect(builder).toBe(myBuilder);
    expect(builder.platform).toBe("my-platform");
  });

  test("custom registry: unknown key is still rejected", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const myBuilder: AgentCommandBuilder = {
      platform: "my-platform",
      personaChannel: "prompt",
      build(_profile, req) {
        return { argv: ["my-cli", req.prompt] };
      },
    };
    expect(() => getCommandBuilder("other", { "my-platform": myBuilder })).toThrow(/no registered command builder/);
  });
});

// ── builders.ts — argument injection guards (M5) ──────────────────────────────

describe("builders — argument injection guards", () => {
  test("opencodeBuilder: prompt preceded by '--' end-of-options separator", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const cmd = builder.build(profile, { prompt: "do work" });
    const argv = cmd.argv as string[];
    const sepIdx = argv.indexOf("--");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(argv[sepIdx + 1]).toBe("do work");
  });

  test("claudeBuilder: prompt preceded by '--' end-of-options separator", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
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

  test("opencodeBuilder: a model/systemPrompt starting with '--' is passed through, not rejected", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    expect(() =>
      builder.build(profile, { prompt: "task", model: "--evil-flag", systemPrompt: "--injected-flag value" }),
    ).not.toThrow();
  });

  test("claudeBuilder: a model/systemPrompt starting with '--' is passed through, not rejected", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    expect(() => builder.build(profile, { prompt: "task", model: "--evil", systemPrompt: "--injected" })).not.toThrow();
  });

  // "unknown platforms fail before accepting model flags" (D10) removed:
  // identical call and assertion as :284-287, and mis-titled — neither this
  // nor the removed :380-383 test asserted anything about argv or model
  // flags despite their names.

  test("valid model and systemPrompt values do not throw", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
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

// ── Registry-derived builders + missing-builder error (P0.5 drift fix) ────────

describe("getCommandBuilder — derived from HARNESS_REGISTRY", () => {
  test("canonical ids resolve while profile and harness aliases are rejected", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    expect(getCommandBuilder("opencode").platform).toBe("opencode");
    expect(getCommandBuilder("claude").platform).toBe("claude");
    expect(() => getCommandBuilder("opencode-headless")).toThrow();
    expect(() => getCommandBuilder("claude-code")).toThrow();
  });

  test("P2 adapters resolve only through canonical harness ids", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    for (const platform of ["codex", "gemini", "aider"]) {
      expect(getCommandBuilder(platform).platform).toBe(platform);
      expect(() => getCommandBuilder(`${platform}-headless`)).toThrow();
    }
  });

  test("the P2 harness additions resolve without profile aliases", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    for (const platform of ["copilot", "pi", "amazonq", "openhands"]) {
      expect(getCommandBuilder(platform).platform).toBe(platform);
      expect(() => getCommandBuilder(`${platform}-headless`)).toThrow();
    }
  });

  test("unknown custom platforms are rejected", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    expect(() => getCommandBuilder("my-custom-wrapper")).toThrow(/no registered command builder/);
  });

  test("a builtin profile whose builder is missing from the injected registry still surfaces the ConfigError", async () => {
    // The loud missing-builder guard is still live for any future builtin
    // profile that ships without a dedicated builder; simulate one by
    // resolving against an EMPTY builder registry.
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const { ConfigError } = await import("../../src/core/errors");
    expect(() => getCommandBuilder("codex", {})).toThrow(ConfigError);
    expect(() => getCommandBuilder("codex", {})).toThrow(/no registered command builder/);
  });
});
