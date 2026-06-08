// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #562 — the unified HARNESS_REGISTRY is the single source of truth replacing
 * the three previously-disconnected registries (session-logs index, agent
 * profiles, config/setup platform strings).
 *
 * These tests pin:
 *   1. registry membership + capability-derived sublists,
 *   2. the 'claude' ↔ 'claude-code' id-normalization round-trips, and
 *   3. that every currently-valid platform/harness id is present so the
 *      derived registries cannot silently drift from the canonical one.
 */
import { describe, expect, it } from "bun:test";
import { VALID_HARNESS_IDS as CONFIG_VALID_HARNESS_IDS } from "../src/core/config/config-types";
import {
  AGENT_DISPATCH_HARNESSES,
  CONFIG_IMPORTER_HARNESSES,
  DETECTION_HARNESSES,
  denormalizeRuntimeIdentity,
  getHarness,
  HARNESS_BY_ID,
  HARNESS_REGISTRY,
  normalizeHarnessId,
  SESSION_LOG_HARNESSES,
  VALID_HARNESS_IDS,
} from "../src/integrations/harnesses";

describe("HARNESS_REGISTRY membership", () => {
  it("contains the three known harnesses with canonical ids", () => {
    expect(HARNESS_REGISTRY.map((h) => h.id)).toEqual(["opencode", "claude", "opencode-sdk"]);
  });

  it("HARNESS_BY_ID resolves every canonical id", () => {
    for (const h of HARNESS_REGISTRY) {
      expect(HARNESS_BY_ID.get(h.id)).toBe(h);
    }
  });

  it("VALID_HARNESS_IDS derives exactly from the registry", () => {
    expect([...VALID_HARNESS_IDS]).toEqual(HARNESS_REGISTRY.map((h) => h.id));
  });

  it("config-types re-exports the SAME derived id list (single source of truth)", () => {
    // The Zod schema, the AgentProfileConfigV2 platform union, and setup's
    // DetectedHarness all derive from this exact array.
    expect([...CONFIG_VALID_HARNESS_IDS]).toEqual([...VALID_HARNESS_IDS]);
  });
});

describe("capability-derived sublists", () => {
  it("SESSION_LOG_HARNESSES = harnesses with native session logs (claude, opencode)", () => {
    expect(SESSION_LOG_HARNESSES.map((h) => h.id)).toEqual(["opencode", "claude"]);
  });

  it("AGENT_DISPATCH_HARNESSES = every harness", () => {
    expect(AGENT_DISPATCH_HARNESSES.map((h) => h.id)).toEqual(["opencode", "claude", "opencode-sdk"]);
  });

  it("CONFIG_IMPORTER_HARNESSES = harnesses that import config (claude, opencode)", () => {
    expect(CONFIG_IMPORTER_HARNESSES.map((h) => h.id)).toEqual(["opencode", "claude"]);
  });

  it("DETECTION_HARNESSES = every harness", () => {
    expect(DETECTION_HARNESSES.map((h) => h.id)).toEqual(["opencode", "claude", "opencode-sdk"]);
  });
});

describe("id normalization bridge ('claude' ↔ 'claude-code')", () => {
  it("normalizes the 'claude-code' alias to the canonical 'claude'", () => {
    expect(normalizeHarnessId("claude-code")).toBe("claude");
  });

  it("normalizing the canonical id is a no-op", () => {
    expect(normalizeHarnessId("claude")).toBe("claude");
    expect(normalizeHarnessId("opencode")).toBe("opencode");
    expect(normalizeHarnessId("opencode-sdk")).toBe("opencode-sdk");
  });

  it("denormalizes 'claude' to the 'claude-code' runtime identity", () => {
    expect(denormalizeRuntimeIdentity("claude")).toBe("claude-code");
    // round-trip: the alias denormalizes to the same runtime identity
    expect(denormalizeRuntimeIdentity("claude-code")).toBe("claude-code");
  });

  it("round-trips both directions for Claude Code", () => {
    expect(normalizeHarnessId(denormalizeRuntimeIdentity("claude"))).toBe("claude");
    expect(denormalizeRuntimeIdentity(normalizeHarnessId("claude-code"))).toBe("claude-code");
  });

  it("harnesses without a distinct runtime id denormalize to themselves", () => {
    expect(denormalizeRuntimeIdentity("opencode")).toBe("opencode");
    expect(denormalizeRuntimeIdentity("opencode-sdk")).toBe("opencode-sdk");
  });

  it("getHarness resolves canonical id, alias, and runtime id to the same harness", () => {
    const byCanonical = getHarness("claude");
    expect(byCanonical).toBeDefined();
    expect(getHarness("claude-code")).toBe(byCanonical);
  });

  it("unknown ids pass through normalization unchanged and resolve to undefined", () => {
    expect(getHarness("nope")).toBeUndefined();
    expect(normalizeHarnessId("nope")).toBe("nope");
    expect(denormalizeRuntimeIdentity("nope")).toBe("nope");
  });
});

describe("every currently-valid platform/harness id is present", () => {
  // The historical set of valid platform strings the three old registries
  // accepted. Each must resolve through the unified registry so we never break
  // an already-persisted config or session log.
  const HISTORICAL_IDS = ["claude", "claude-code", "opencode", "opencode-sdk"];

  for (const id of HISTORICAL_IDS) {
    it(`"${id}" resolves to a registered harness`, () => {
      expect(getHarness(id)).toBeDefined();
    });
  }

  it("the session-log provider name 'claude-code' maps to the canonical 'claude' harness", () => {
    expect(normalizeHarnessId("claude-code")).toBe("claude");
    expect(getHarness("claude-code")?.id).toBe("claude");
  });
});
