// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue #552 (amended by #878, which removed `frequent` and `memory-focus`):
 * shipped improve profiles must load through the real profile resolver AND
 * validate against the live `ImproveProfileConfigSchema` (the same zod schema
 * that parses user config), so they are guaranteed to be accepted in the wild.
 */

import { describe, expect, test } from "bun:test";
import profileConsolidate from "../../src/assets/improve-strategies/consolidate.json";
import profileProactiveMaintenance from "../../src/assets/improve-strategies/proactive-maintenance.json";
import { resolveImproveStrategy } from "../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../src/core/config/config";
import { ImproveProfileConfigSchema } from "../../src/core/config/config-schema";

const MINIMAL_CONFIG: AkmConfig = { semanticSearchMode: "off" };
const BUILTIN_STRATEGIES = ["default", "consolidate", "proactive-maintenance"] as const;

describe("default improve strategies (#552)", () => {
  test("complete resolved trees are pinned for all built-ins", () => {
    for (const name of BUILTIN_STRATEGIES) {
      expect(resolveImproveStrategy(name, MINIMAL_CONFIG)).toMatchSnapshot(name);
    }
  });
  test("proactive maintenance is opt-in", () => {
    expect(resolveImproveStrategy("default", MINIMAL_CONFIG).config.processes?.proactiveMaintenance?.enabled).toBe(
      false,
    );
    expect(resolveImproveStrategy("consolidate", MINIMAL_CONFIG).config.processes?.proactiveMaintenance?.enabled).toBe(
      false,
    );
    expect(
      resolveImproveStrategy("proactive-maintenance", MINIMAL_CONFIG).config.processes?.proactiveMaintenance?.enabled,
    ).toBe(true);
  });

  test("no shipped strategy turns triage judgment on (#1132)", () => {
    expect(profileProactiveMaintenance.processes.triage.judgment).toBe(false);
    for (const name of BUILTIN_STRATEGIES) {
      const judgment = resolveImproveStrategy(name, MINIMAL_CONFIG).config.processes?.triage?.judgment;
      expect(typeof judgment === "object" ? judgment?.enabled : judgment, name).not.toBe(true);
    }
  });

  test("consolidate: validates against the live schema", () => {
    expect(() => ImproveProfileConfigSchema.parse(profileConsolidate)).not.toThrow();
  });

  test("default resolves with improve-stage extract off", () => {
    expect(resolveImproveStrategy("default", MINIMAL_CONFIG).config.processes?.extract?.enabled).toBe(false);
  });

  test("consolidate resolves to consolidation-only with maxChunkSize 25 and no pool-size floor", () => {
    const p = resolveImproveStrategy("consolidate", MINIMAL_CONFIG).config;
    expect(p.processes?.consolidate?.enabled).toBe(true);
    expect(p.processes?.consolidate?.allowedTypes).toEqual(["memory"]);
    expect(p.processes?.consolidate?.maxChunkSize).toBe(25);
    expect(p.processes?.reflect?.enabled).toBe(false);
    expect(p.processes?.distill?.enabled).toBe(false);
    expect(p.processes?.memoryInference?.enabled).toBe(false);
    expect(p.processes?.extract?.enabled).toBe(false);
    expect(p.processes?.triage?.enabled).toBe(false);
    expect(p.sync?.push).toBe(true);
  });

  test("default drains the queue through the deterministic gates, bounded, with no judgment (#1143)", () => {
    const triage = resolveImproveStrategy("default", MINIMAL_CONFIG).config.processes?.triage;
    expect(triage?.enabled).toBe(true);
    expect(triage?.applyMode).toBe("promote");
    expect(triage?.maxAcceptsPerRun).toBe(25);
    expect(triage?.judgment?.enabled).not.toBe(true);
  });

  // #1130: quick, reflect-distill, thorough and catchup were removed.
  describe.each(["quick", "reflect-distill", "thorough", "catchup"])("removed built-in %s (#1130)", (name) => {
    test("with no user block, resolution fails with an error that names default", () => {
      expect(() => resolveImproveStrategy(name, MINIMAL_CONFIG)).toThrow(/removed in 0\.10.*"default"/);
    });

    test("a user block of that name is a user-defined strategy that inherits default", () => {
      const config: AkmConfig = {
        ...MINIMAL_CONFIG,
        improve: { strategies: { [name]: { processes: { reflect: { limit: 3 } } } } },
      };
      const selected = resolveImproveStrategy(name, config);
      const def = resolveImproveStrategy("default", MINIMAL_CONFIG).config;
      expect(selected.name).toBe(name);
      expect(selected.config.processes?.reflect?.limit).toBe(3);
      expect(selected.config.processes?.triage).toEqual(def.processes?.triage);
      expect(selected.config.processes?.consolidate).toEqual(def.processes?.consolidate);
    });
  });

  test("no shipped strategy sets a removed improve knob (#1131)", () => {
    for (const key of ["antiCollapse", "p90ChunkSecondsDefault", "minPoolSize", "fidelityCheck", "lowValueFilter"]) {
      expect(JSON.stringify(profileConsolidate)).not.toContain(key);
    }
  });
});
