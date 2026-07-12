/**
 * Tests for the agent command builder feature:
 *   - model-aliases.ts: resolveModel() alias resolution
 *   - builders.ts: opencodeBuilder, claudeBuilder, getCommandBuilder
 *   - config.ts: commandBuilder / modelAliases parsing and resolveAgentProfile merge
 *
 * Coverage follows v1 spec §12.2 and §12.3.
 */
import { describe, expect, test } from "bun:test";
import type { AgentCommandBuilder, AgentDispatchRequest } from "../../src/integrations/agent/builders";
import type { AgentProfile } from "../../src/integrations/agent/profiles";

// NOTE: this file previously carried a full 13-export mock.module fake of
// src/core/warn. Nothing under test here (builders, model-aliases, profiles)
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

// ── model-aliases.ts ──────────────────────────────────────────────────────────

describe("resolveModel — builtin aliases", () => {
  test('resolveModel("opus", "opencode") → "opencode/claude-opus-4-7"', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("opus", "opencode")).toBe("opencode/claude-opus-4-7");
  });

  test('resolveModel("sonnet", "claude") → "claude-sonnet-4-6"', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("sonnet", "claude")).toBe("claude-sonnet-4-6");
  });

  test('resolveModel("haiku", "opencode") → "opencode/claude-haiku-4-5"', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("haiku", "opencode")).toBe("opencode/claude-haiku-4-5");
  });

  test('resolveModel("fable", "claude") → "claude-fable-5"', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("fable", "claude")).toBe("claude-fable-5");
  });

  test('resolveModel("fable", "opencode") → "opencode/claude-fable-5"', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("fable", "opencode")).toBe("opencode/claude-fable-5");
  });

  test('resolveModel("claude-opus-4-7", "opencode") → pass-through (no alias match)', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    // Exact model ID — not a known alias key, so returned verbatim.
    expect(resolveModel("claude-opus-4-7", "opencode")).toBe("claude-opus-4-7");
  });

  test('resolveModel("opus", "unknown-platform") → pass-through (no platform entry)', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    // "opus" IS a known alias but has no entry for "unknown-platform".
    expect(resolveModel("opus", "unknown-platform")).toBe("opus");
  });
});

describe("resolveModel — custom alias precedence", () => {
  test("custom alias wins over builtin for the same key", async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    const custom = { fast: "opencode/claude-haiku-4-5" };
    expect(resolveModel("fast", "opencode", custom)).toBe("opencode/claude-haiku-4-5");
  });

  test("custom alias overrides builtin when keys collide", async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    // "opus" is a builtin alias — a custom entry with the same key must win.
    const custom = { opus: "opencode/my-custom-opus" };
    expect(resolveModel("opus", "opencode", custom)).toBe("opencode/my-custom-opus");
  });
});

describe("resolveModel — case-insensitivity", () => {
  test('resolveModel("OPUS", "claude") is case-insensitive → "claude-opus-4-7"', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("OPUS", "claude")).toBe("claude-opus-4-7");
  });

  test('resolveModel("Sonnet", "opencode") is case-insensitive', async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("Sonnet", "opencode")).toBe("opencode/claude-sonnet-4-6");
  });
});

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

  test("with systemPrompt: --system-prompt flag present before prompt", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", systemPrompt: "You are helpful." };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("You are helpful.");
    // Prompt is last
    expect(argv[argv.length - 1]).toBe("do work");
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

  test('with model alias "opus": resolveModel is called and resolved value appears in argv', async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", model: "opus" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    // "opus" resolves to "opencode/claude-opus-4-7" for the opencode platform
    expect(argv[idx + 1]).toBe("opencode/claude-opus-4-7");
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

  test("with model: --model flag present and resolved", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    const req: AgentDispatchRequest = { prompt: "do work", model: "opus" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    // "opus" resolves to "claude-opus-4-7" for the claude platform
    expect(argv[idx + 1]).toBe("claude-opus-4-7");
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
      build(_profile, req) {
        return { argv: ["my-cli", req.prompt] };
      },
    };
    expect(() => getCommandBuilder("other", { "my-platform": myBuilder })).toThrow(/no registered command builder/);
  });
});

// ── (removed in 0.8.0) parseAgentConfig / modelAliases / commandBuilder ─────
//
// The v1 `parseAgentConfig` parser and the `modelAliases`/`commandBuilder`
// fields on `AgentProfileConfig` were removed when the unified
// `profiles.agent` shape replaced the legacy `agent` block. Tests for those
// pieces lived here and have been removed alongside the code. The model
// alias feature itself lives on at the builder layer; the builder
// integration tests in the next describe block still exercise that path.

// ── Integration: builder picks up profile.modelAliases ───────────────────────

describe("builder + profile.modelAliases integration", () => {
  test("opencodeBuilder uses profile.modelAliases to resolve custom alias", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({
      modelAliases: { fast: "opencode/claude-haiku-4-5" },
    });
    const req: AgentDispatchRequest = { prompt: "go fast", model: "fast" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("opencode/claude-haiku-4-5");
  });

  test("claudeBuilder uses profile.modelAliases to resolve custom alias", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile({
      modelAliases: { quick: "claude-haiku-4-5-20251001" },
    });
    const req: AgentDispatchRequest = { prompt: "be quick", model: "quick" };
    const cmd = builder.build(profile, req);
    const argv = cmd.argv as string[];
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("claude-haiku-4-5-20251001");
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

  test("unknown platforms cannot synthesize a generic argv", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    expect(() => getCommandBuilder("unknown-platform")).toThrow(/no registered command builder/);
  });

  test("opencodeBuilder: throws UsageError when model starts with '--'", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    expect(() => builder.build(profile, { prompt: "task", model: "--evil-flag" })).toThrow(
      /model must not start with "--"/,
    );
  });

  test("claudeBuilder: throws UsageError when model starts with '--'", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    expect(() => builder.build(profile, { prompt: "task", model: "--evil" })).toThrow(/model must not start with "--"/);
  });

  test("opencodeBuilder: throws UsageError when systemPrompt starts with '--'", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile();
    expect(() => builder.build(profile, { prompt: "task", systemPrompt: "--injected-flag value" })).toThrow(
      /systemPrompt must not start with "--"/,
    );
  });

  test("claudeBuilder: throws UsageError when systemPrompt starts with '--'", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile();
    expect(() => builder.build(profile, { prompt: "task", systemPrompt: "--injected" })).toThrow(
      /systemPrompt must not start with "--"/,
    );
  });

  test("unknown platforms fail before accepting model flags", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    expect(() => getCommandBuilder("unknown-platform")).toThrow(/no registered command builder/);
  });

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

// ── Global model-alias tiers (config-root `modelAliases`) ─────────────────────

describe("resolveModel — global alias tiers", () => {
  const global = {
    fast: { claude: "claude-haiku-4-5-20251001", opencode: "opencode/claude-haiku-4-5", "*": "haiku-generic" },
    deep: { "*": "deep-generic" },
    opus: { claude: "my-pinned-opus" },
  };

  test("platform column wins over '*' fallback", async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("fast", "claude", undefined, global)).toBe("claude-haiku-4-5-20251001");
    expect(resolveModel("fast", "opencode", undefined, global)).toBe("opencode/claude-haiku-4-5");
  });

  test("'*' fallback used when no platform column matches", async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("fast", "codex", undefined, global)).toBe("haiku-generic");
    expect(resolveModel("deep", "claude", undefined, global)).toBe("deep-generic");
  });

  test("profile-level custom alias beats the global table", async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("fast", "claude", { fast: "profile-wins" }, global)).toBe("profile-wins");
  });

  test("global table shadows the built-in alias table", async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("opus", "claude", undefined, global)).toBe("my-pinned-opus");
    // …but only for platforms the global entry names: no column + no '*' falls
    // through to the built-in table.
    expect(resolveModel("opus", "opencode", undefined, global)).toBe("opencode/claude-opus-4-7");
  });

  test("alias lookup is case-insensitive; unknown alias passes through verbatim", async () => {
    const { resolveModel } = await import("../../src/integrations/agent/model-aliases");
    expect(resolveModel("FAST", "claude", undefined, global)).toBe("claude-haiku-4-5-20251001");
    expect(resolveModel("exact-model-id", "claude", undefined, global)).toBe("exact-model-id");
  });
});

// ── resolveEngine: modelAliases config wiring ─────────────────────────────────

describe("resolveEngine — modelAliases from config", () => {
  test("engine.modelAliases reaches the lowered profile", async () => {
    const { resolveEngine } = await import("../../src/integrations/agent/engine-resolution");
    const runner = resolveEngine("reviewer", {
      engines: {
        reviewer: {
          kind: "agent",
          platform: "claude",
          modelAliases: { quick: "claude-haiku-4-5-20251001" },
        },
      },
    });
    expect(runner.kind === "agent" && runner.profile.modelAliases).toEqual({
      quick: "claude-haiku-4-5-20251001",
    });
  });

  test("global modelAliases is stamped onto the lowered profile", async () => {
    const { resolveEngine } = await import("../../src/integrations/agent/engine-resolution");
    const global = { fast: { "*": "generic-fast" } };
    const runner = resolveEngine("reviewer", {
      engines: { reviewer: { kind: "agent", platform: "claude" } },
      modelAliases: global,
    });
    expect(runner.kind === "agent" && runner.profile.globalModelAliases).toEqual(global);
  });

  test("engine model aliases are resolved during lowering", async () => {
    const { resolveEngine } = await import("../../src/integrations/agent/engine-resolution");
    const runner = resolveEngine("reviewer", {
      engines: {
        reviewer: {
          kind: "agent",
          platform: "claude",
          model: "quick",
          modelAliases: { quick: "claude-haiku-4-5-20251001" },
        },
      },
    });
    expect(runner.kind === "agent" && runner.profile.model).toBe("claude-haiku-4-5-20251001");
  });
});

// ── Integration: builder resolves through the global tier table ──────────────

describe("builder + globalModelAliases integration", () => {
  test("claudeBuilder resolves a global tier alias", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("claude");
    const profile = makeClaudeProfile({
      globalModelAliases: { fast: { claude: "claude-haiku-4-5-20251001" } },
    });
    const cmd = builder.build(profile, { prompt: "go", model: "fast" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  });

  test("profile.modelAliases beats globalModelAliases in the builder", async () => {
    const { getCommandBuilder } = await import("../../src/integrations/agent/builders");
    const builder = getCommandBuilder("opencode");
    const profile = makeOpencodeProfile({
      modelAliases: { fast: "opencode/profile-wins" },
      globalModelAliases: { fast: { opencode: "opencode/global-loses" } },
    });
    const cmd = builder.build(profile, { prompt: "go", model: "fast" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("opencode/profile-wins");
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
