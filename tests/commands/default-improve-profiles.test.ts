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
import { resolveImproveProfile } from "../../src/commands/improve-profiles";
import type { AkmConfig } from "../../src/core/config";
import { ImproveProfileConfigSchema } from "../../src/core/config-schema";

const MINIMAL_CONFIG: AkmConfig = { semanticSearchMode: "off" };

describe("default improve profiles (#552)", () => {
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

  test("consolidate resolves to consolidation-only with maxChunkSize 25", () => {
    const p = resolveImproveProfile("consolidate", MINIMAL_CONFIG);
    expect(p.processes?.consolidate?.enabled).toBe(true);
    expect(p.processes?.consolidate?.allowedTypes).toEqual(["memory"]);
    expect(p.processes?.consolidate?.maxChunkSize).toBe(25);
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

  test("none of the new profiles carry keys the loader/type does not support yet", () => {
    // minPoolSize / minNewSessions are added by #553/#554 — they must NOT be in
    // these JSONs so this branch type-checks and validates standalone.
    for (const raw of [profileFrequent, profileConsolidate, profileCatchup]) {
      const json = JSON.stringify(raw);
      expect(json).not.toContain("minPoolSize");
      expect(json).not.toContain("minNewSessions");
    }
  });
});
