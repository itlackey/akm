// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue #552: the three new default improve profiles (`frequent`,
 * `consolidate`, `catchup`) must load through the real profile resolver AND
 * validate against the live `ImproveProfileConfigSchema` (the same zod schema
 * that parses user config), so they are guaranteed to be accepted in the wild.
 */

import { describe, expect, test } from "bun:test";
import profileCatchup from "../../src/assets/profiles/catchup.json";
import profileConsolidate from "../../src/assets/profiles/consolidate.json";
import profileFrequent from "../../src/assets/profiles/frequent.json";
import profileSynthesize from "../../src/assets/profiles/synthesize.json";
import { resolveImproveProfile } from "../../src/commands/improve/improve-profiles";
import type { AkmConfig } from "../../src/core/config/config";
import { ImproveProfileConfigSchema } from "../../src/core/config/config-schema";

const MINIMAL_CONFIG: AkmConfig = { semanticSearchMode: "off" };

describe("default improve profiles (#552)", () => {
  test("default profile ships the sustaining proactiveMaintenance lane ON", () => {
    // Intentional default (deep-tuning 2026-06-29): on a mature stash, reflect is
    // signal-delta-gated to ~0 actionable, so proactiveMaintenance is the lane
    // that keeps the nightly default-profile cron producing. This pins that the
    // default profile resolves it ON (other built-ins inherit the OFF code default).
    const p = resolveImproveProfile("default", MINIMAL_CONFIG);
    expect(p.processes?.proactiveMaintenance?.enabled).toBe(true);
  });

  test("frequent: validates against the live schema", () => {
    expect(() => ImproveProfileConfigSchema.parse(profileFrequent)).not.toThrow();
  });

  test("consolidate: validates against the live schema", () => {
    expect(() => ImproveProfileConfigSchema.parse(profileConsolidate)).not.toThrow();
  });

  test("catchup: validates against the live schema", () => {
    expect(() => ImproveProfileConfigSchema.parse(profileCatchup)).not.toThrow();
  });

  test("frequent resolves with extract + inference on, consolidate/distill off", () => {
    const p = resolveImproveProfile("frequent", MINIMAL_CONFIG);
    expect(p.description).toContain("Frequent");
    expect(p.processes?.reflect?.enabled).toBe(true);
    expect(p.processes?.distill?.enabled).toBe(false);
    expect(p.processes?.consolidate?.enabled).toBe(false);
    expect(p.processes?.memoryInference?.enabled).toBe(true);
    expect(p.processes?.graphExtraction?.enabled).toBe(true);
    expect(p.processes?.extract?.enabled).toBe(true);
    expect(p.processes?.triage?.enabled).toBe(false);
    expect(p.sync?.push).toBe(true);
  });

  test("consolidate resolves to consolidation-only with maxChunkSize 25 and minPoolSize 500", () => {
    const p = resolveImproveProfile("consolidate", MINIMAL_CONFIG);
    expect(p.processes?.consolidate?.enabled).toBe(true);
    expect(p.processes?.consolidate?.allowedTypes).toEqual(["memory"]);
    expect(p.processes?.consolidate?.maxChunkSize).toBe(25);
    // #553: consolidate profile sets the production guard threshold.
    expect(p.processes?.consolidate?.minPoolSize).toBe(500);
    expect(p.processes?.reflect?.enabled).toBe(false);
    expect(p.processes?.distill?.enabled).toBe(false);
    expect(p.processes?.memoryInference?.enabled).toBe(false);
    expect(p.processes?.graphExtraction?.enabled).toBe(false);
    expect(p.processes?.extract?.enabled).toBe(false);
    expect(p.processes?.triage?.enabled).toBe(false);
    expect(p.sync?.push).toBe(true);
  });

  test("catchup resolves to consolidate (chunk 50) + triage queue/personal-stash/100", () => {
    const p = resolveImproveProfile("catchup", MINIMAL_CONFIG);
    expect(p.processes?.consolidate?.enabled).toBe(true);
    expect(p.processes?.consolidate?.maxChunkSize).toBe(50);
    // #553: catchup disables the pool-size guard (drain regardless of pool size).
    expect(p.processes?.consolidate?.minPoolSize).toBe(0);
    expect(p.processes?.triage?.enabled).toBe(true);
    expect(p.processes?.triage?.applyMode).toBe("queue");
    expect(p.processes?.triage?.policy).toBe("personal-stash");
    expect(p.processes?.triage?.maxAcceptsPerRun).toBe(100);
    expect(p.processes?.reflect?.enabled).toBe(false);
    expect(p.processes?.distill?.enabled).toBe(false);
    expect(p.processes?.memoryInference?.enabled).toBe(false);
    expect(p.processes?.graphExtraction?.enabled).toBe(false);
    expect(p.processes?.extract?.enabled).toBe(false);
    expect(p.sync?.push).toBe(true);
  });

  test("minPoolSize (#553) lives only on the consolidate-bearing profiles, not frequent", () => {
    // #553 added `minPoolSize` to consolidate.json (500) and catchup.json (0).
    // It must NOT leak into `frequent` (which disables consolidate entirely).
    expect(JSON.stringify(profileFrequent)).not.toContain("minPoolSize");
    expect(JSON.stringify(profileConsolidate)).toContain("minPoolSize");
    expect(JSON.stringify(profileCatchup)).toContain("minPoolSize");
  });

  test("synthesize: validates against the live schema", () => {
    expect(() => ImproveProfileConfigSchema.parse(profileSynthesize)).not.toThrow();
  });

  test("synthesize resolves to recombine ON, procedural OFF (held until cross-project scoping), all generative/extract passes OFF", () => {
    const p = resolveImproveProfile("synthesize", MINIMAL_CONFIG);
    expect(p.processes?.recombine?.enabled).toBe(true);
    // #615 procedural is held OFF everywhere — it over-fits one-off sequences (0% accept, deep-tuning analysis 2026-06-29).
    expect(p.processes?.procedural?.enabled).toBe(false);
    expect(p.processes?.reflect?.enabled).toBe(false);
    expect(p.processes?.distill?.enabled).toBe(false);
    expect(p.processes?.consolidate?.enabled).toBe(false);
    expect(p.processes?.memoryInference?.enabled).toBe(false);
    expect(p.processes?.graphExtraction?.enabled).toBe(false);
    expect(p.processes?.extract?.enabled).toBe(false);
    expect(p.sync?.push).toBe(true);
  });

  test("minNewSessions (#554) lives only on the frequent profile's extract process", () => {
    // #554 added `minNewSessions: 3` to frequent.json's extract process — the
    // only profile that opts into the extract candidate-pool gate. The in-code
    // default is 0 (disabled), so consolidate/catchup (which don't run extract)
    // must NOT carry the key; existing behaviour is preserved everywhere else.
    expect(profileFrequent.processes?.extract?.minNewSessions).toBe(3);
    for (const raw of [profileConsolidate, profileCatchup]) {
      expect(JSON.stringify(raw)).not.toContain("minNewSessions");
    }
  });
});
