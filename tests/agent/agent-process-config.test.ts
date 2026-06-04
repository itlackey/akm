/**
 * `resolveProcessAgentProfile` tests against the 0.8.0 unified shape.
 *
 * After 0.8.0, the per-process binding lives at
 * `profiles.improve.default.processes.<processName>.profile` (and `.timeoutMs`).
 * The fallback default agent comes from `defaults.agent`.
 */
import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config";

function mkConfig(over: Partial<AkmConfig> = {}): AkmConfig {
  return { semanticSearchMode: "auto", ...over };
}

describe("resolveProcessAgentProfile (0.8.0 shape)", () => {
  test("returns default profile when no per-process binding set", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const cfg = mkConfig({ defaults: { agent: "claude" } });
    const { profile, timeoutMs } = resolveProcessAgentProfile("reflect", cfg);
    expect(profile.name).toBe("claude");
    expect(timeoutMs).toBeUndefined();
  });

  test("process binding profile name overrides default", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const cfg = mkConfig({
      defaults: { agent: "claude" },
      profiles: {
        improve: {
          default: { processes: { reflect: { profile: "codex" } } },
        },
      },
    });
    const { profile } = resolveProcessAgentProfile("reflect", cfg);
    expect(profile.name).toBe("codex");
  });

  test("process binding timeoutMs: null returns null (unlimited)", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const cfg = mkConfig({
      defaults: { agent: "claude" },
      profiles: {
        improve: { default: { processes: { reflect: { timeoutMs: null } } } },
      },
    });
    const { timeoutMs } = resolveProcessAgentProfile("reflect", cfg);
    expect(timeoutMs).toBeNull();
  });

  test("process binding timeoutMs: 5000 returns 5000", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const cfg = mkConfig({
      defaults: { agent: "claude" },
      profiles: {
        improve: { default: { processes: { reflect: { timeoutMs: 5000 } } } },
      },
    });
    const { timeoutMs } = resolveProcessAgentProfile("reflect", cfg);
    expect(timeoutMs).toBe(5000);
  });

  test("unknown process falls back to defaults.agent", async () => {
    const { resolveProcessAgentProfile } = await import("../../src/integrations/agent/config");
    const cfg = mkConfig({
      defaults: { agent: "opencode" },
      profiles: { improve: { default: { processes: { distill: { profile: "claude" } } } } },
    });
    const { profile } = resolveProcessAgentProfile("reflect", cfg);
    expect(profile.name).toBe("opencode");
  });
});
