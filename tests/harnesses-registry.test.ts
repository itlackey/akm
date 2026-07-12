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
  defaultProfileName,
  denormalizeRuntimeIdentity,
  getHarness,
  HARNESS_BY_ID,
  HARNESS_REGISTRY,
  normalizeHarnessId,
  SESSION_LOG_HARNESSES,
  VALID_HARNESS_IDS,
} from "../src/integrations/harnesses";

// The full registry membership, in registration order: the pre-unification
// trio first (pinned prefix — the generated JSON-schema enum must not reorder),
// then the seven P2 harness adapters (plan §"Capability matrix").
const ALL_HARNESS_IDS = [
  "opencode",
  "claude",
  "opencode-sdk",
  "codex",
  "copilot",
  "pi",
  "gemini",
  "aider",
  "amazonq",
  "openhands",
];

describe("HARNESS_REGISTRY membership", () => {
  it("contains every known harness with canonical ids, legacy trio first", () => {
    expect(HARNESS_REGISTRY.map((h) => h.id as string)).toEqual(ALL_HARNESS_IDS);
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
    // The Zod schema, the AgentProfileConfig platform union, and setup's
    // DetectedHarness all derive from this exact array.
    expect([...CONFIG_VALID_HARNESS_IDS]).toEqual([...VALID_HARNESS_IDS]);
  });
});

describe("capability-derived sublists", () => {
  it("SESSION_LOG_HARNESSES = harnesses with native session logs (claude, opencode)", () => {
    expect(SESSION_LOG_HARNESSES.map((h) => h.id)).toEqual(["opencode", "claude"]);
  });

  it("AGENT_DISPATCH_HARNESSES = every harness", () => {
    expect(AGENT_DISPATCH_HARNESSES.map((h) => h.id as string)).toEqual(ALL_HARNESS_IDS);
  });

  it("CONFIG_IMPORTER_HARNESSES = harnesses that import config (claude, opencode)", () => {
    expect(CONFIG_IMPORTER_HARNESSES.map((h) => h.id)).toEqual(["opencode", "claude"]);
  });

  it("DETECTION_HARNESSES = every harness", () => {
    expect(DETECTION_HARNESSES.map((h) => h.id as string)).toEqual(ALL_HARNESS_IDS);
  });

  // #567 — only session-log-capable harnesses may be offered as setup stash
  // sources. A harness that declares a `setupDetectionDir` (so `akm setup`
  // offers it) MUST have a session-log provider, otherwise selecting it is a
  // silent no-op. This pins the registry so a future harness can't reintroduce
  // the detection trap.
  it("every harness with a setupDetectionDir also has sessionLogs capability", () => {
    for (const h of HARNESS_REGISTRY) {
      if (h.setupDetectionDir) {
        expect(h.capabilities.sessionLogs).toBe(true);
      }
    }
  });

  it("setup stash-source candidates = session-log harnesses with a detection dir (claude, opencode)", () => {
    const candidates = SESSION_LOG_HARNESSES.filter((h) => h.setupDetectionDir).map((h) => h.id);
    expect(candidates).toEqual(["opencode", "claude"]);
  });
});

describe("workflow-engine descriptor fields (P2, plan §'Capability matrix')", () => {
  it("every registry entry declares pattern + structuredOutput", () => {
    // Optional on the AkmHarness interface (additive seam change), but
    // REQUIRED on every registry entry — this test is the enforcement.
    for (const h of HARNESS_REGISTRY) {
      expect(h.pattern).toBeDefined();
      expect(h.structuredOutput).toBeDefined();
    }
  });

  it("claude: in-harness, native-json (`claude -p --output-format json` envelope), --resume, CLAUDE_SESSION_ID", () => {
    const claude = getHarness("claude");
    if (!claude) throw new Error("claude harness not registered");
    expect(claude.pattern).toBe("in-harness");
    // The headless `claude -p` dispatch path is native-JSON (result envelope +
    // validate), NOT native-schema — the CLI has no output-schema flag (Codex
    // round-3 finding A). It carries a result extractor to unwrap that envelope.
    expect(claude.structuredOutput).toBe("native-json");
    expect(claude.resultExtractor).toBeDefined();
    expect(claude.resume).toEqual({ flag: "--resume", takesSessionId: true });
    expect([...(claude.identityEnv ?? [])]).toEqual(["CLAUDE_SESSION_ID"]);
  });

  it("opencode (CLI path): local-runner, prompt+validate tier, --session, OPENCODE_SESSION_ID", () => {
    const opencode = getHarness("opencode");
    if (!opencode) throw new Error("opencode harness not registered");
    expect(opencode.pattern).toBe("local-runner");
    expect(opencode.structuredOutput).toBe("none");
    expect(opencode.resume).toEqual({ flag: "--session", takesSessionId: true });
    expect([...(opencode.identityEnv ?? [])]).toEqual(["OPENCODE_SESSION_ID"]);
  });

  it("opencode-sdk: local-runner, native-json, programmatic resume (no flag), no env marker", () => {
    const sdk = getHarness("opencode-sdk");
    if (!sdk) throw new Error("opencode-sdk harness not registered");
    expect(sdk.pattern).toBe("local-runner");
    expect(sdk.structuredOutput).toBe("native-json");
    expect(sdk.resume).toBeUndefined();
    expect(sdk.identityEnv).toBeUndefined();
  });

  it("every sessionLogs-capable harness supplies a sessionLogProvider whose name resolves back to it", () => {
    // The session-logs index derives its provider array from this factory;
    // a sessionLogs harness without one would throw at import time there.
    for (const h of SESSION_LOG_HARNESSES) {
      expect(h.sessionLogProvider).toBeDefined();
      const provider = h.sessionLogProvider?.();
      if (!provider) throw new Error(`harness ${h.id} returned no provider`);
      // Provider runtime name (e.g. 'claude-code') must normalize to the
      // harness's canonical id via the #562 bridge.
      expect(normalizeHarnessId(provider.name)).toBe(h.id);
    }
  });

  it("harnesses without sessionLogs capability do not carry a provider factory", () => {
    for (const h of HARNESS_REGISTRY) {
      if (!h.capabilities.sessionLogs) {
        expect(h.sessionLogProvider).toBeUndefined();
      }
    }
  });

  it("identityEnv + presenceEnv markers are unique across harnesses (no ambiguous attribution)", () => {
    // One flat namespace: the same var on two harnesses (or on both seams)
    // would make harness inference order-dependent.
    const all = HARNESS_REGISTRY.flatMap((h) => [...(h.identityEnv ?? []), ...(h.presenceEnv ?? [])]);
    expect(new Set(all).size).toBe(all.length);
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

describe("defaultProfileName — registry-derived headless default (#566)", () => {
  it("returns the canonical id for each dispatch-capable detected harness", () => {
    expect(defaultProfileName("opencode")).toBe("opencode");
    expect(defaultProfileName("claude")).toBe("claude");
    expect(defaultProfileName("opencode-sdk")).toBe("opencode-sdk");
  });

  it("resolves the 'claude-code' runtime alias to the canonical 'claude' default", () => {
    expect(defaultProfileName("claude-code")).toBe("claude");
  });

  it("returns undefined for 'none' and unknown ids (no spurious default)", () => {
    expect(defaultProfileName("none")).toBeUndefined();
    expect(defaultProfileName("cursor")).toBeUndefined();
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
