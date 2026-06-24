// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Meta-test for the unit-tier purity ratchet (#664 Step 0 / C0.2). Pins the
 * `lint-tests-unit-purity` allowlist to a shrink-only baseline so a unit-tier
 * test cannot silently (re)introduce a real `Bun.serve` / subprocess spawn — the
 * fd churn that blocks `bun test --parallel>1`. As files migrate onto the
 * injected `fetch` seam (or relocate to tests/integration/), entries are removed
 * and `UNIT_PURITY_BASELINE` lowered in the same change.
 */

import { describe, expect, test } from "bun:test";
import {
  ALLOWED_SERVE,
  ALLOWED_SPAWN,
  combinedAllowlistSize,
  lintAllUnitFiles,
  UNIT_PURITY_BASELINE,
} from "../scripts/lint-tests-unit-purity";

describe("unit-tier purity ratchet", () => {
  test("no NEW (non-grandfathered) unit-tier impurity", () => {
    const violations = lintAllUnitFiles();
    expect(violations).toEqual([]);
  });

  test("baseline exactly matches the live allowlist size (cannot drift)", () => {
    expect(combinedAllowlistSize()).toBe(UNIT_PURITY_BASELINE);
  });

  test("baseline only ever shrinks", () => {
    // If this fails because the number went DOWN, lower UNIT_PURITY_BASELINE to
    // match (a file was migrated — good). It must NEVER be raised.
    expect(combinedAllowlistSize()).toBeLessThanOrEqual(39);
  });

  test("every allowlisted file still exists (no stale entries)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = path.resolve(import.meta.dir, "..");
    const missing: string[] = [];
    for (const rel of [...ALLOWED_SERVE, ...ALLOWED_SPAWN]) {
      if (!fs.existsSync(path.join(root, rel))) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});
