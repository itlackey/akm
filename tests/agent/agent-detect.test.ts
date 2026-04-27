/**
 * Tests for setup-time agent CLI detection.
 *
 * Acceptance coverage:
 *   • Detects every built-in profile bin via the injected `which` probe.
 *   • Picks the first available profile as the default.
 *   • Honours an existing `agent.default` when that profile is still
 *     available (round-trip stability).
 *   • Returns `undefined` when nothing is installed.
 *   • `stepAgentCliDetection` produces a config-shaped result the wizard
 *     can `apply()`.
 */
import { describe, expect, test } from "bun:test";

import { detectAgentCliProfiles, pickDefaultAgentProfile, type WhichFn } from "../../src/integrations/agent/detect";

function whichOnly(installed: string[]): WhichFn {
  const set = new Set(installed);
  return (bin: string) => (set.has(bin) ? `/usr/local/bin/${bin}` : undefined);
}

describe("detectAgentCliProfiles", () => {
  test("reports every built-in profile, available iff bin found", () => {
    const results = detectAgentCliProfiles(undefined, whichOnly(["claude", "codex"]));
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(["aider", "claude", "codex", "gemini", "opencode"]);
    expect(results.find((r) => r.name === "claude")?.available).toBe(true);
    expect(results.find((r) => r.name === "codex")?.available).toBe(true);
    expect(results.find((r) => r.name === "gemini")?.available).toBe(false);
  });

  test("includes user-defined profiles via the resolver", () => {
    const results = detectAgentCliProfiles({ profiles: { rover: { bin: "rover-cli" } } }, whichOnly(["rover-cli"]));
    const rover = results.find((r) => r.name === "rover");
    expect(rover?.available).toBe(true);
    expect(rover?.resolvedPath).toContain("rover-cli");
  });

  test("returns nothing-installed when the probe always says no", () => {
    const results = detectAgentCliProfiles(undefined, whichOnly([]));
    expect(results.every((r) => !r.available)).toBe(true);
  });
});

describe("pickDefaultAgentProfile", () => {
  test("picks the first available result when no existing default", () => {
    const picked = pickDefaultAgentProfile([
      { name: "aider", bin: "aider", available: false },
      { name: "claude", bin: "claude", available: true },
      { name: "codex", bin: "codex", available: true },
    ]);
    expect(picked).toBe("claude");
  });

  test("keeps an existing available default", () => {
    const picked = pickDefaultAgentProfile(
      [
        { name: "claude", bin: "claude", available: true },
        { name: "codex", bin: "codex", available: true },
      ],
      "codex",
    );
    expect(picked).toBe("codex");
  });

  test("falls back when the existing default is no longer available", () => {
    const picked = pickDefaultAgentProfile(
      [
        { name: "claude", bin: "claude", available: true },
        { name: "codex", bin: "codex", available: false },
      ],
      "codex",
    );
    expect(picked).toBe("claude");
  });

  test("returns undefined when nothing is available", () => {
    const picked = pickDefaultAgentProfile([
      { name: "claude", bin: "claude", available: false },
      { name: "codex", bin: "codex", available: false },
    ]);
    expect(picked).toBeUndefined();
  });
});

describe("stepAgentCliDetection (setup wizard)", () => {
  test("persists default + leaves block absent when nothing detected & no prior config", async () => {
    const { stepAgentCliDetection } = await import("../../src/setup/setup");
    const result = stepAgentCliDetection({ semanticSearchMode: "auto" }, () => [
      { name: "claude", bin: "claude", available: false },
      { name: "codex", bin: "codex", available: false },
    ]);
    expect(result.agent).toBeUndefined();
    expect(result.detections).toHaveLength(2);
  });

  test("writes agent.default to the first detected profile", async () => {
    const { stepAgentCliDetection } = await import("../../src/setup/setup");
    const result = stepAgentCliDetection({ semanticSearchMode: "auto" }, () => [
      { name: "claude", bin: "claude", available: false },
      { name: "codex", bin: "codex", available: true },
    ]);
    expect(result.agent?.default).toBe("codex");
  });

  test("preserves user-overridden default when still available", async () => {
    const { stepAgentCliDetection } = await import("../../src/setup/setup");
    const result = stepAgentCliDetection(
      {
        semanticSearchMode: "auto",
        agent: { default: "aider", profiles: { aider: { args: ["--no-auto-commits"] } } },
      },
      () => [
        { name: "claude", bin: "claude", available: true },
        { name: "aider", bin: "aider", available: true },
      ],
    );
    expect(result.agent?.default).toBe("aider");
    expect(result.agent?.profiles?.aider?.args).toEqual(["--no-auto-commits"]);
  });
});
