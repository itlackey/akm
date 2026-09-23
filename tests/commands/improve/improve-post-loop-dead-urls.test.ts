// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #892 follow-up: `runImprovePostLoopStage`'s URL scan used to `.slice(0, 10)`
 * the actionable knowledge refs before handing them to `checkDeadUrls`, so
 * `deadUrlCoverage.total` only ever counted the first ten refs scanned — a
 * bundle with more knowledge refs reported "everything checked" (checked ===
 * total) while most refs were never looked at. This pins that every
 * actionable knowledge ref is scanned regardless of count.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runImprovePostLoopStage } from "../../../src/commands/improve/loop-stages";
import type { AkmConfig, ImproveProfileConfig } from "../../../src/core/config/config";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";
import { makeStashDir, withMockedFetch } from "../../_helpers/sandbox";

function disabledProcesses(): ImproveProfileConfig["processes"] {
  return {
    reflect: { enabled: false },
    distill: { enabled: false },
    consolidate: { enabled: false },
    memoryInference: { enabled: false },
    graphExtraction: { enabled: false },
    extract: { enabled: false },
    validation: { enabled: false },
    triage: { enabled: false },
    proactiveMaintenance: { enabled: false },
    recombine: { enabled: false },
    procedural: { enabled: false },
  } as ImproveProfileConfig["processes"];
}

describe("runImprovePostLoopStage dead-URL scan coverage (#892)", () => {
  test("scans every actionable knowledge ref, not just the first ten", async () => {
    const stash = makeStashDir();
    try {
      // Comfortably past the old `.slice(0, 10)`.
      const REF_COUNT = 14;
      const actionableRefs: ImproveEligibleRef[] = [];
      for (let i = 0; i < REF_COUNT; i++) {
        const filePath = path.join(stash.dir, "knowledge", `doc-${i}.md`);
        fs.writeFileSync(filePath, `See https://example.com/doc-${i} for details.`);
        actionableRefs.push({ ref: `knowledge/doc-${i}.md`, reason: "scope-type", filePath });
      }

      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: { stash: { path: stash.dir, writable: true } },
        defaultBundle: "stash",
      };

      const requested: string[] = [];
      const result = await withMockedFetch(
        () =>
          runImprovePostLoopStage({
            scope: { mode: "all" },
            options: { config, stashDir: stash.dir },
            primaryStashDir: stash.dir,
            actionableRefs,
            cleanupWarnings: [],
            memoryRefsForInference: new Set(),
            consolidationRan: false,
            improveProfile: { processes: disabledProcesses() } as ImproveProfileConfig,
          }),
        (url) => {
          requested.push(url);
          return new Response(null, { status: 200 });
        },
      );

      expect(requested.length).toBe(REF_COUNT);
      expect(result.deadUrlCoverage).toEqual({ checked: REF_COUNT, total: REF_COUNT, skipped: 0 });
      expect(result.deadUrls).toEqual([]);
    } finally {
      stash.cleanup();
    }
  });
});
