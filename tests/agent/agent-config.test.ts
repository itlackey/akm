/**
 * Tests for the `agent.*` config block parser and profile resolver.
 *
 * Acceptance coverage:
 *   • Parser accepts the documented shape.
 *   • Unknown keys are warn-and-ignored (no throw).
 *   • Built-in profiles resolve for opencode, claude, codex, gemini, aider.
 *   • Missing block surfaces a stable ConfigError via requireAgentProfile.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const warnings: string[] = [];

mock.module("../../src/core/warn", () => ({
  warn: (...args: unknown[]) => {
    warnings.push(args.join(" "));
  },
  setQuiet: () => {},
  resetQuiet: () => {},
  isQuiet: () => false,
}));

beforeEach(() => {
  warnings.length = 0;
});

afterEach(() => {
  warnings.length = 0;
});

describe("parseAgentConfig", () => {
  test("returns undefined when block is absent", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    expect(parseAgentConfig(undefined)).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  test("warns and returns undefined for non-object root", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    expect(parseAgentConfig("oops")).toBeUndefined();
    expect(warnings.some((w) => w.includes('"agent"'))).toBe(true);
  });

  test("accepts the documented shape", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    const parsed = parseAgentConfig({
      default: "opencode",
      timeoutMs: 30000,
      profiles: {
        opencode: { bin: "opencode", args: ["--non-interactive"], stdio: "captured" },
      },
    });
    expect(parsed?.default).toBe("opencode");
    expect(parsed?.timeoutMs).toBe(30000);
    expect(parsed?.profiles?.opencode).toEqual({
      bin: "opencode",
      args: ["--non-interactive"],
      stdio: "captured",
    });
  });

  test("warn-and-ignore unknown top-level keys (no throw)", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    const parsed = parseAgentConfig({
      default: "claude",
      moonRoutingTable: { foo: "bar" }, // unknown
    });
    expect(parsed?.default).toBe("claude");
    expect(warnings.some((w) => w.includes("moonRoutingTable"))).toBe(true);
  });

  test("warn-and-ignore unknown per-profile keys", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    const parsed = parseAgentConfig({
      profiles: {
        custom: { bin: "ok", quirks: "nope" },
      },
    });
    expect(parsed?.profiles?.custom?.bin).toBe("ok");
    expect(warnings.some((w) => w.includes("quirks"))).toBe(true);
  });

  test("warn-and-ignore malformed timeoutMs", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    const parsed = parseAgentConfig({ timeoutMs: "60s" });
    expect(parsed?.timeoutMs).toBeUndefined();
    expect(warnings.some((w) => w.includes("timeoutMs"))).toBe(true);
  });

  test("rejects non-string args entries", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    const parsed = parseAgentConfig({
      profiles: { opencode: { args: ["--ok", 5, "--also-ok"] } },
    });
    expect(parsed?.profiles?.opencode?.args).toEqual(["--ok", "--also-ok"]);
    expect(warnings.some((w) => w.includes("args"))).toBe(true);
  });

  test("rejects bad stdio mode", async () => {
    const { parseAgentConfig } = await import("../../src/integrations/agent/config");
    const parsed = parseAgentConfig({
      profiles: { opencode: { stdio: "weird" } },
    });
    expect(parsed?.profiles?.opencode?.stdio).toBeUndefined();
    expect(warnings.some((w) => w.includes("stdio"))).toBe(true);
  });
});

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
    const merged = resolveAgentProfile("opencode", { args: ["--scripted"], stdio: "captured" });
    expect(merged?.bin).toBe("opencode"); // built-in default
    expect(merged?.args).toEqual(["--scripted"]); // override
    expect(merged?.stdio).toBe("captured"); // override
    expect(merged?.envPassthrough).toContain("PATH"); // built-in retained
  });

  test("user-defined profile (no built-in) requires bin", async () => {
    const { resolveAgentProfile } = await import("../../src/integrations/agent/config");
    expect(resolveAgentProfile("rover", undefined)).toBeUndefined();
    expect(resolveAgentProfile("rover", {})).toBeUndefined();
    const ok = resolveAgentProfile("rover", { bin: "rover-cli", args: ["--silent"] });
    expect(ok?.bin).toBe("rover-cli");
    expect(ok?.args).toEqual(["--silent"]);
    expect(ok?.stdio).toBe("captured");
  });

  test("envPassthrough merges base + override", async () => {
    const { resolveAgentProfile } = await import("../../src/integrations/agent/config");
    const merged = resolveAgentProfile("opencode", { envPassthrough: ["MY_TOKEN"] });
    expect(merged?.envPassthrough).toContain("PATH"); // from built-in
    expect(merged?.envPassthrough).toContain("MY_TOKEN"); // from override
  });

  test("listAgentProfileNames includes built-ins plus user-defined", async () => {
    const { listAgentProfileNames } = await import("../../src/integrations/agent/config");
    const names = listAgentProfileNames({ profiles: { rover: { bin: "rover" } } });
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
    const hint = (caught as { hint: () => string | undefined }).hint();
    expect(hint).toBeTruthy();
    expect(hint).toContain("akm setup");
  });

  test("throws when no default and no requested name", async () => {
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const { ConfigError } = await import("../../src/core/errors");
    let caught: unknown;
    try {
      requireAgentProfile({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("require a profile");
  });

  test("resolves the requested profile when valid", async () => {
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const profile = requireAgentProfile({ default: "claude" });
    expect(profile.name).toBe("claude");
    expect(profile.bin).toBe("claude");
  });

  test("explicit requested name beats config default", async () => {
    const { requireAgentProfile } = await import("../../src/integrations/agent/config");
    const profile = requireAgentProfile({ default: "claude" }, "codex");
    expect(profile.name).toBe("codex");
  });
});
