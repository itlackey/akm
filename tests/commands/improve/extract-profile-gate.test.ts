// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #593/#594 — the extract gate must respect the ACTIVE improve profile.
 *
 * `isLlmFeatureEnabled(config, "session_extraction")` hardcodes a lookup
 * against `profiles.improve.default.processes.extract.enabled`, so a
 * non-default profile setting `extract.enabled: false` (e.g. the built-in
 * `quick`) was silently ignored and extract ran on every improve call. The
 * fix ANDs the legacy check with `resolveProcessEnabled("extract",
 * improveProfile)` for the active resolved profile. The legacy default-profile
 * check is retained for back-compat (disabling via the default profile still
 * gates every profile's run).
 *
 * Detection seam: `extractCandidateCountFn` is invoked ONLY inside the gated
 * extract block (when `minNewSessions > 0` and a harness is available), so a
 * call counter on it deterministically proves whether the gate opened —
 * without configuring an LLM or touching the network. `minNewSessions` is set
 * on the DEFAULT profile because the count gate reads it from there; the
 * injected counter returns 0 so the extract pass never proceeds past the
 * count even when the gate is open.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import type { SessionLogHarness, SessionSummary } from "../../../src/integrations/session-logs/types";
import { type Cleanup, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const TIMEOUT_MS = 20_000;

let cleanup: Cleanup = () => {};
let stashDir = "";

/** Minimal fake harness with one in-window session; readSession must never be reached. */
function fakeHarness(): SessionLogHarness {
  const sessions: SessionSummary[] = [
    { harness: "fake", sessionId: "sess-0", filePath: "/dev/null/sess-0", endedAt: Date.now() },
  ];
  return {
    name: "fake",
    isAvailable: () => true,
    readEvents: () => [],
    listSessions: () => sessions,
    readSession: () => {
      throw new Error("readSession must not be called — extract should have been gated/skipped");
    },
  };
}

/**
 * Config with a default profile (extract enabled-state + minNewSessions: 1 so
 * the candidate counter runs whenever the gate opens) and an optional extra
 * user-defined profile carrying its own extract enabled-state.
 */
function makeConfig(args: { defaultExtractEnabled: boolean; profile?: { name: string; extractEnabled: boolean } }): {
  config: AkmConfig;
} {
  const improve: Record<string, unknown> = {
    default: {
      processes: {
        // Disable consolidate so its #553 guard never interferes.
        consolidate: { enabled: false },
        extract: { enabled: args.defaultExtractEnabled, minNewSessions: 1 },
      },
    },
  };
  if (args.profile) {
    improve[args.profile.name] = { processes: { extract: { enabled: args.profile.extractEnabled } } };
  }
  return { config: { semanticSearchMode: "off", profiles: { improve } } as unknown as AkmConfig };
}

/** Run improve(memory) with the given active profile; returns how many times the gate opened. */
async function countGateOpens(config: AkmConfig, profile?: string): Promise<number> {
  let countFnCalls = 0;
  await akmImprove({
    scope: "memory",
    ...(profile !== undefined ? { profile } : {}),
    config,
    stashDir,
    minRetrievalCount: 0,
    ensureIndexFn: async () => false,
    reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
    extractHarnesses: [fakeHarness()],
    extractCandidateCountFn: () => {
      countFnCalls += 1;
      return 0; // below minNewSessions → extract proceeds no further (no LLM needed)
    },
  });
  return countFnCalls;
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("#593/#594 extract gate respects the active improve profile", () => {
  test(
    "non-default profile with extract.enabled: false gates the extract pass",
    async () => {
      const { config } = makeConfig({
        defaultExtractEnabled: true,
        profile: { name: "quick-shredder", extractEnabled: false },
      });
      expect(await countGateOpens(config, "quick-shredder")).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "non-default profile with extract.enabled: true keeps the gate open",
    async () => {
      const { config } = makeConfig({
        defaultExtractEnabled: true,
        profile: { name: "extractor", extractEnabled: true },
      });
      expect(await countGateOpens(config, "extractor")).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "default profile is unaffected: extract.enabled true → gate opens",
    async () => {
      const { config } = makeConfig({ defaultExtractEnabled: true });
      expect(await countGateOpens(config)).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "built-in quick profile (extract.enabled: false) gates the extract pass",
    async () => {
      // No user override for "quick" — the built-in profile JSON disables extract.
      const { config } = makeConfig({ defaultExtractEnabled: true });
      expect(await countGateOpens(config, "quick")).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "legacy back-compat: default-profile extract.enabled false gates EVERY profile",
    async () => {
      // The active profile enables extract, but the retained legacy
      // isLlmFeatureEnabled check (default-profile path) still wins.
      const { config } = makeConfig({
        defaultExtractEnabled: false,
        profile: { name: "extractor", extractEnabled: true },
      });
      expect(await countGateOpens(config, "extractor")).toBe(0);
    },
    TIMEOUT_MS,
  );
});
