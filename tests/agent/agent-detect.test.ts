/**
 * Tests for setup-time agent CLI detection: every built-in profile bin is
 * probed via the injected `which`, and a configured harness is probed too.
 */
import { describe, expect, test } from "bun:test";

import { detectAgentCliProfiles, type WhichFn } from "../../src/integrations/agent/detect";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";

function whichOnly(installed: string[]): WhichFn {
  const set = new Set(installed);
  return (bin: string) => (set.has(bin) ? `/usr/local/bin/${bin}` : undefined);
}

describe("detectAgentCliProfiles", () => {
  test("reports every built-in profile, available iff bin found", () => {
    const results = detectAgentCliProfiles(undefined, whichOnly(["claude", "codex"]));
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(
      HARNESS_REGISTRY.filter((h) => h.profile)
        .map((h) => h.id as string)
        .sort(),
    );
    expect(results.find((r) => r.name === "claude")?.available).toBe(true);
    expect(results.find((r) => r.name === "codex")?.available).toBe(true);
    expect(results.find((r) => r.name === "gemini")?.available).toBe(false);
  });

  test("includes user-defined profiles via the resolver", () => {
    const results = detectAgentCliProfiles(
      {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        harnesses: { rover: { platform: "opencode", bin: "rover-cli" } },
      },
      whichOnly(["rover-cli"]),
    );
    const rover = results.find((r) => r.name === "rover");
    expect(rover?.available).toBe(true);
    expect(rover?.resolvedPath).toContain("rover-cli");
  });

  test("returns nothing-installed when the probe always says no", () => {
    const results = detectAgentCliProfiles(undefined, whichOnly([]));
    expect(results.every((r) => !r.available)).toBe(true);
  });
});
