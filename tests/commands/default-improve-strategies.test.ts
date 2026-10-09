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
import profileCatchup from "../../src/assets/improve-strategies/catchup.json";
import profileConsolidate from "../../src/assets/improve-strategies/consolidate.json";
import profileProactiveMaintenance from "../../src/assets/improve-strategies/proactive-maintenance.json";
import profileReflectDistill from "../../src/assets/improve-strategies/reflect-distill.json";
import { resolveImproveStrategy } from "../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../src/core/config/config";
import { ImproveProfileConfigSchema } from "../../src/core/config/config-schema";

const MINIMAL_CONFIG: AkmConfig = { semanticSearchMode: "off" };
const BUILTIN_STRATEGIES = [
  "default",
  "quick",
  "thorough",
  "consolidate",
  "catchup",
  "reflect-distill",
  "proactive-maintenance",
] as const;

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
    expect(
      resolveImproveStrategy("reflect-distill", MINIMAL_CONFIG).config.processes?.proactiveMaintenance?.enabled,
    ).toBe(false);
    expect(
      resolveImproveStrategy("proactive-maintenance", MINIMAL_CONFIG).config.processes?.proactiveMaintenance?.enabled,
    ).toBe(true);
  });

  test("no shipped strategy turns triage judgment on (#1132)", () => {
    expect(profileReflectDistill.processes.triage.judgment).toBe(false);
    expect(profileProactiveMaintenance.processes.triage.judgment).toBe(false);
    for (const name of BUILTIN_STRATEGIES) {
      const judgment = resolveImproveStrategy(name, MINIMAL_CONFIG).config.processes?.triage?.judgment;
      expect(typeof judgment === "object" ? judgment?.enabled : judgment, name).not.toBe(true);
    }
  });

  test("consolidate: validates against the live schema", () => {
    expect(() => ImproveProfileConfigSchema.parse(profileConsolidate)).not.toThrow();
  });

  test("catchup: validates against the live schema", () => {
    expect(() => ImproveProfileConfigSchema.parse(profileCatchup)).not.toThrow();
  });

  test("thorough is exactly default plus a promoting triage drain (#878)", () => {
    // The 0.9.6-era thorough.json omitted `validation`, `extract`, and
    // `proactiveMaintenance`; absent keys resolve to DISABLED, so "like
    // default, plus triage" was silently default-minus-validation. Pin the
    // real contract: every process default enables, thorough enables (with
    // identical tuning), plus triage promoting judged proposals.
    const def = resolveImproveStrategy("default", MINIMAL_CONFIG).config;
    const thor = resolveImproveStrategy("thorough", MINIMAL_CONFIG).config;
    const enabledOf = (p: unknown): boolean | undefined =>
      typeof p === "object" && p !== null && "enabled" in p ? (p as { enabled?: boolean }).enabled : undefined;
    for (const [name, defProcess] of Object.entries(def.processes ?? {})) {
      if (name === "triage") continue;
      const thorProcess = (thor.processes as Record<string, unknown> | undefined)?.[name];
      expect(enabledOf(thorProcess), name).toBe(enabledOf(defProcess));
    }
    expect(thor.processes?.validation?.enabled).toBe(true);
    expect(thor.processes?.triage?.enabled).toBe(true);
    expect(thor.processes?.triage?.applyMode).toBe("promote");
    // Judgment is off (#1132): the judged drain harmed items in the nightly eval.
    const judgment = thor.processes?.triage?.judgment;
    expect(typeof judgment === "object" ? judgment?.enabled : judgment).not.toBe(true);
    expect(def.processes?.triage?.enabled).toBe(false);
  });

  test("default resolves with improve-stage extract off", () => {
    expect(resolveImproveStrategy("default", MINIMAL_CONFIG).config.processes?.extract?.enabled).toBe(false);
  });

  test("reflect-distill processes distill-only signal deltas", () => {
    const p = resolveImproveStrategy("reflect-distill", MINIMAL_CONFIG).config;
    expect(p.processes?.distill?.enabled).toBe(true);
    expect(p.processes?.distill?.requirePlannedRefs).toBe(false);
  });

  test("consolidate resolves to consolidation-only with maxChunkSize 25 and no pool-size floor", () => {
    const p = resolveImproveStrategy("consolidate", MINIMAL_CONFIG).config;
    expect(p.processes?.consolidate?.enabled).toBe(true);
    expect(p.processes?.consolidate?.allowedTypes).toEqual(["memory"]);
    expect(p.processes?.consolidate?.maxChunkSize).toBe(25);
    // The built-in strategies no longer ship a minPoolSize floor: a shipped
    // 500 meant `akm improve --strategy consolidate`, typed by a human,
    // silently did nothing on almost every real install. Unset resolves to
    // the runtime default of 0 (disabled) in preparation.ts.
    expect(p.processes?.consolidate?.minPoolSize).toBeUndefined();
    expect(p.processes?.reflect?.enabled).toBe(false);
    expect(p.processes?.distill?.enabled).toBe(false);
    expect(p.processes?.memoryInference?.enabled).toBe(false);
    expect(p.processes?.extract?.enabled).toBe(false);
    expect(p.processes?.triage?.enabled).toBe(false);
    expect(p.sync?.push).toBe(true);
  });

  test("catchup resolves to consolidate (chunk 50) + judged triage promote/personal-stash/100 (#878)", () => {
    const p = resolveImproveStrategy("catchup", MINIMAL_CONFIG).config;
    expect(p.processes?.consolidate?.enabled).toBe(true);
    expect(p.processes?.consolidate?.maxChunkSize).toBe(50);
    // #553: catchup disables the pool-size guard (drain regardless of pool size).
    expect(p.processes?.consolidate?.minPoolSize).toBe(0);
    expect(p.processes?.triage?.enabled).toBe(true);
    // #878: queue mode never reaches the promote loop, so the old
    // queue+maxAcceptsPerRun combination was inert. Promote is demoted back
    // to queue by the autonomy gate unless improve autonomy is enabled.
    expect(p.processes?.triage?.applyMode).toBe("promote");
    expect(p.processes?.triage?.policy).toBe("personal-stash");
    expect(p.processes?.triage?.maxAcceptsPerRun).toBe(100);
    expect(p.processes?.reflect?.enabled).toBe(false);
    expect(p.processes?.distill?.enabled).toBe(false);
    expect(p.processes?.memoryInference?.enabled).toBe(false);
    expect(p.processes?.extract?.enabled).toBe(false);
    expect(p.sync?.push).toBe(true);
  });

  test("minPoolSize is no longer shipped on consolidate.json now that 0 is the runtime default", () => {
    // #553 added `minPoolSize` to consolidate.json (500) and catchup.json (0).
    expect(JSON.stringify(profileConsolidate)).not.toContain("minPoolSize");
    expect(JSON.stringify(profileCatchup)).toContain("minPoolSize");
  });
});
