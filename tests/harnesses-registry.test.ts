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
 *   2. exact ids are shared by config, dispatch, attribution, and logs, and
 *   3. that every currently-valid platform/harness id is present so the
 *      derived registries cannot silently drift from the canonical one.
 */
import { describe, expect, it } from "bun:test";
import { VALID_HARNESS_IDS as CONFIG_VALID_HARNESS_IDS } from "../src/core/config/config-types";
import {
  AGENT_DISPATCH_HARNESSES,
  defaultProfileName,
  getHarness,
  HARNESS_BY_ID,
  HARNESS_REGISTRY,
  SESSION_LOG_HARNESSES,
  VALID_HARNESS_IDS,
} from "../src/integrations/harnesses";

// The pre-unification trio leads the registry: the generated JSON-schema enum
// order must not change. Everything after is appended.
const LEGACY_PREFIX = ["opencode", "claude", "opencode-sdk"];

describe("HARNESS_REGISTRY membership", () => {
  it("keeps the legacy trio first so the schema enum order is stable", () => {
    expect(HARNESS_REGISTRY.slice(0, LEGACY_PREFIX.length).map((h) => h.id as string)).toEqual(LEGACY_PREFIX);
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

  it("does not carry a second runtime-identity compatibility capability", () => {
    for (const harness of HARNESS_REGISTRY) {
      expect(harness.capabilities).not.toHaveProperty("runtimeIdentity");
    }
  });
});

describe("capability-derived sublists", () => {
  it("SESSION_LOG_HARNESSES = harnesses with native session logs (claude, codex, opencode)", () => {
    expect(SESSION_LOG_HARNESSES.map((h) => h.id)).toEqual(["opencode", "claude", "codex"]);
  });

  it("AGENT_DISPATCH_HARNESSES = every harness that declares agentDispatch", () => {
    expect(AGENT_DISPATCH_HARNESSES.map((h) => h.id)).toEqual(
      HARNESS_REGISTRY.filter((h) => h.capabilities.agentDispatch).map((h) => h.id),
    );
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
  it("claude: result extractor for the `claude -p --output-format json` envelope, CLAUDE_SESSION_ID", () => {
    const claude = getHarness("claude");
    if (!claude) throw new Error("claude harness not registered");
    // The headless `claude -p` dispatch path returns a result envelope; the
    // harness carries a result extractor to unwrap it.
    expect(claude.resultExtractor).toBeDefined();
    expect([...(claude.identityEnv ?? [])]).toEqual(["CLAUDE_SESSION_ID"]);
  });

  it("opencode (CLI path): OPENCODE_SESSION_ID", () => {
    const opencode = getHarness("opencode");
    if (!opencode) throw new Error("opencode harness not registered");
    expect([...(opencode.identityEnv ?? [])]).toEqual(["OPENCODE_SESSION_ID"]);
  });

  it("opencode-sdk: no env marker", () => {
    const sdk = getHarness("opencode-sdk");
    if (!sdk) throw new Error("opencode-sdk harness not registered");
    expect(sdk.identityEnv).toBeUndefined();
  });

  // WI-9.7 (H1): the sessionLogs↔sessionLogProvider PAIRING (a session-log-
  // capable harness has a provider factory, and a non-session-log harness has
  // none) is now enforced by the `AkmHarness` discriminated union at compile
  // time — `HARNESS_REGISTRY`'s `satisfies readonly AkmHarness[]` check would
  // fail to build if any entry got this wrong. What's left to test at runtime
  // is the part the type system can't see: whether a provider's own `name`
  // string actually points back to the harness that produced it.
  it("every sessionLogs-capable harness's provider name resolves back to it", () => {
    for (const h of SESSION_LOG_HARNESSES) {
      const provider = h.sessionLogProvider();
      expect(provider.name).toBe(h.id);
    }
  });

  it("identityEnv + presenceEnv markers are unique across harnesses (no ambiguous attribution)", () => {
    // One flat namespace: the same var on two harnesses (or on both seams)
    // would make harness inference order-dependent.
    const all = HARNESS_REGISTRY.flatMap((h) => [...(h.identityEnv ?? []), ...(h.presenceEnv ?? [])]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("exact harness ids", () => {
  it("rejects aliases and unknown ids", () => {
    expect(getHarness("claude")).toBeDefined();
    expect(getHarness("claude-code")).toBeUndefined();
    expect(getHarness("nope")).toBeUndefined();
  });
});

describe("defaultProfileName — registry-derived headless default (#566)", () => {
  it("returns the canonical id for each dispatch-capable detected harness", () => {
    expect(defaultProfileName("opencode")).toBe("opencode");
    expect(defaultProfileName("claude")).toBe("claude");
    expect(defaultProfileName("opencode-sdk")).toBe("opencode-sdk");
  });

  it("returns undefined for 'none' and unknown ids (no spurious default)", () => {
    expect(defaultProfileName("none")).toBeUndefined();
    expect(defaultProfileName("cursor")).toBeUndefined();
    expect(defaultProfileName("claude-code")).toBeUndefined();
  });
});

// #915: harness ids are persisted keys (`extract_sessions_seen.harness`,
// `workflow_runs.agent_harness`). This literal is deliberately NOT derived from
// the registry: removing or renaming an id must fail here until a state
// migration ships for the old key (see 027-extract-sessions-seen-harness-rename).
// Adding a harness needs no edit here.
const PERSISTED_HARNESS_IDS = [
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

describe("harness ids are persisted keys (#915)", () => {
  for (const id of PERSISTED_HARNESS_IDS) {
    it(`"${id}" is still registered; removing or renaming it needs a state migration`, () => {
      expect(getHarness(id)).toBeDefined();
    });
  }
});
