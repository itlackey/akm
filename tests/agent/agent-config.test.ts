/**
 * Agent profile resolution tests (0.8.0 shape).
 *
 * Verifies `requireAgentProfile`, `resolveAgentProfile`, and
 * `listAgentProfileNames` against the unified AkmConfig shape (
 * `profiles.agent` + `defaults.agent`).
 */
import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";

function mkConfig(over: Partial<AkmConfig> = {}): AkmConfig {
  return { semanticSearchMode: "auto", ...over };
}

describe("built-in profile resolution", () => {
  test("resolves opencode, claude, codex, gemini, aider out of the box", async () => {
    const { BUILTIN_AGENT_PROFILE_NAMES, getBuiltinAgentProfile } = await import(
      "../../src/integrations/agent/profiles"
    );
    expect(BUILTIN_AGENT_PROFILE_NAMES).toEqual(["aider", "claude", "codex", "gemini", "opencode"]);
    for (const name of ["opencode", "claude", "codex", "gemini", "aider"]) {
      const profile = getBuiltinAgentProfile(name);
      expect(profile).toBeDefined();
      expect(profile?.bin).toBeTruthy();
      expect(profile?.envPassthrough).toContain("PATH");
    }
  });

  test("user override merges on top of built-in", async () => {
    const { resolveAgentProfile } = await import("../../src/integrations/agent/config");
    const merged = resolveAgentProfile("opencode", { platform: "opencode", args: ["--scripted"] });
    expect(merged?.bin).toBe("opencode"); // built-in default
    expect(merged?.args).toEqual(["--scripted"]); // override
    expect(merged?.envPassthrough).toContain("PATH"); // built-in retained
  });

  test("user-configured timeoutMs override is honored (config-only timeout, no CLI flag)", async () => {
    const { resolveAgentProfile } = await import("../../src/integrations/agent/config");
    // profiles.agent.<name>.timeoutMs must flow onto the resolved profile so
    // runAgent (spawn.ts) picks it up when no per-call timeout is passed —
    // e.g. `akm wiki ingest` without `--timeout-ms`.
    const merged = resolveAgentProfile("opencode", { platform: "opencode", timeoutMs: 6_000_000 });
    expect(merged?.timeoutMs).toBe(6_000_000);
  });

  test("user-defined profile (no built-in) requires bin", async () => {
    const { resolveAgentProfile } = await import("../../src/integrations/agent/config");
    expect(resolveAgentProfile("rover", undefined)).toBeUndefined();
    const ok = resolveAgentProfile("rover", { platform: "opencode", bin: "rover-cli", args: ["--silent"] });
    expect(ok?.bin).toBe("rover-cli");
    expect(ok?.args).toEqual(["--silent"]);
  });

  test("user-defined opencode-sdk profile resolves without bin", async () => {
    const { resolveAgentProfile } = await import("../../src/integrations/agent/config");
    const profile = resolveAgentProfile("custom", { platform: "opencode-sdk", model: "gpt-4o" });
    expect(profile?.name).toBe("custom");
    expect(profile?.sdkMode).toBe(true);
    expect(profile?.model).toBe("gpt-4o");
  });

  test("listAgentProfileNames includes built-ins plus user-defined", async () => {
    const { listAgentProfileNames } = await import("../../src/integrations/agent/config");
    const cfg = mkConfig({ profiles: { agent: { rover: { platform: "opencode", bin: "rover" } } } });
    const names = listAgentProfileNames(cfg);
    expect(names).toContain("rover");
    expect(names).toContain("opencode");
    expect(names).toContain("claude");
  });
});

describe("requireAgentProfile", () => {
  test("throws ConfigError when the agent block is missing", async () => {
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const { ConfigError } = await import("../../src/core/errors");
    let caught: unknown;
    try {
      requireAgentProfile(undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("agent commands are disabled");
  });

  test("throws when no default and no requested name", async () => {
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const { ConfigError } = await import("../../src/core/errors");
    let caught: unknown;
    try {
      requireAgentProfile(mkConfig());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("require a profile");
  });

  test("resolves the requested profile when valid", async () => {
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const profile = requireAgentProfile(mkConfig({ defaults: { agent: "claude" } }));
    expect(profile.name).toBe("claude");
    expect(profile.bin).toBe("claude");
  });

  test("explicit requested name beats config default", async () => {
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const profile = requireAgentProfile(mkConfig({ defaults: { agent: "claude" } }), "codex");
    expect(profile.name).toBe("codex");
  });
});
