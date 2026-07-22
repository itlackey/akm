// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.7c -- the chunk-0b gate: proves the WI-0b.7a generator and WI-0b.7b
 * invariant harness actually FUNCTION and DISCRIMINATE correct from
 * incorrect re-key behavior, over a smoke-sized fixed seed set (Chunk 8 runs
 * >=1000 generated cases against its real full-table re-key function once it
 * exists -- this suite is 0b's substrate-level proof, not that exercise).
 *
 * Four things this suite proves, all deterministic and un-flaky (fixed seed
 * list, no `Math.random()`/`Date.now()`/`new Date()` anywhere in the
 * generator or harness):
 *
 *   1. Same seed -> identical generated state (`generateRekeyState` is a
 *      pure function of its seed -- Chunk 8 replays it).
 *   2. `correctReferenceRekey` (most-recently-updated-wins merge) satisfies
 *      every WI-0b.7b invariant, on every smoke seed.
 *   3. `naiveClobberRekey` (rekeyStateDbForMove's delete-then-rename,
 *      generalized to a full-table pass, WITHOUT `updated_at` comparison)
 *      FAILS invariant 3 (scalar-merge-wins) on every smoke seed -- proving
 *      the harness tests the STRONGER rule anchors.md E.2 documents
 *      `rekeyStateDbForMove` never had to satisfy.
 *   4. Idempotence holds for the correct reference (folded into invariant 5
 *      inside `checkRekeyInvariants`; asserted explicitly here too).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { generateRekeyState } from "./rekey-generator";
import { checkRekeyInvariants } from "./rekey-invariants";
import { correctReferenceRekey, naiveClobberRekey } from "./rekey-reference-impls";
import { snapshotRekeyState } from "./rekey-snapshot";

/**
 * Fixed, deterministic smoke-sized seed set. The WI-0b.7 brief suggested
 * "50-100"; this suite only needs to PROVE the generator is deterministic and
 * that the harness discriminates correct from incorrect re-key behavior --
 * asset index 0 (and its `.derived` twin) is a FORCED collision on every
 * single seed (see `rekey-generator.ts`'s `plainForced`/`derivedForced`),
 * so a handful of seeds already exercises every key shape and both collision
 * directions deterministically; more seeds add committed-suite runtime
 * without adding coverage. 10 seeds keeps this convincing while staying fast.
 * Chunk 8's own property suite is the real exerciser and runs >=1000
 * generated cases against the real full-table re-key function once it
 * exists (this suite is 0b's substrate-level proof, not that exercise --
 * see the file doc comment above). Arbitrary arithmetic sequence, not
 * `Math.random()` -- the point is a STABLE list, not a random one.
 */
const SMOKE_SEEDS: readonly number[] = Array.from({ length: 10 }, (_, i) => 10_000 + i * 733);

/** Keep the smoke run fast: `generateRekeyState` file-copies a cached, once-built migrated template per call (see `rekey-generator.ts`'s "Perf: template-db cache" doc) rather than re-running the full migration chain per seed, and `assetCount` stays small since row-insert cost still scales with it -- while still covering every key shape and both collision directions, since the forced-collision assets (index 0 and its derived twin) don't depend on `assetCount`. */
const SMOKE_OPTS = { assetCount: 8 } as const;

let storage: IsolatedAkmStorage;
let dbCounter = 0;

beforeEach(() => {
  // openStateDatabase() resolves its canonical path unconditionally (even
  // with an explicit dbPath override), which under `bun test` requires
  // XDG_DATA_HOME/AKM_DATA_DIR (src/core/paths.ts test-isolation guard) --
  // same pattern as migration-fixtures.test.ts (WI-0b.6).
  storage = withIsolatedAkmStorage();
  dbCounter = 0;
});

afterEach(() => {
  storage.cleanup();
});

/** A fresh path under this test's isolated temp root -- `storage.cleanup()` removes it, so no per-call cleanup is needed. */
function freshDbPath(label: string): string {
  dbCounter += 1;
  return path.join(storage.root, "rekey-gen", `${label}-${dbCounter}`, "state.db");
}

describe("WI-0b.7a — generator determinism", () => {
  test("same seed -> byte-identical generated state, for every smoke seed", () => {
    for (const seed of SMOKE_SEEDS) {
      const a = generateRekeyState(seed, { ...SMOKE_OPTS, dbPath: freshDbPath(`det-a-${seed}`) });
      const b = generateRekeyState(seed, { ...SMOKE_OPTS, dbPath: freshDbPath(`det-b-${seed}`) });

      // The model itself (which key shapes, which spelling wins, every
      // timestamp/row-count) is a pure function of the seed.
      expect(JSON.stringify(b.model)).toBe(JSON.stringify(a.model));

      // The actual rows written to disk are identical too.
      const snapshotA = snapshotRekeyState(a.dbPath);
      const snapshotB = snapshotRekeyState(b.dbPath);
      expect(snapshotB).toEqual(snapshotA);
    }
  });
});

describe("WI-0b.7c — discrimination proof: correct reference passes every invariant", () => {
  test("correctReferenceRekey satisfies all 5 invariants on every smoke seed", () => {
    for (const seed of SMOKE_SEEDS) {
      const generated = generateRekeyState(seed, { ...SMOKE_OPTS, dbPath: freshDbPath(`correct-${seed}`) });
      const result = checkRekeyInvariants(generated, correctReferenceRekey);
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });
});

describe("WI-0b.7c — discrimination proof: naive clobber fails invariant 3 on the collision case", () => {
  test("naiveClobberRekey FAILS scalar-merge-wins (invariant 3) on every smoke seed's forced collision", () => {
    for (const seed of SMOKE_SEEDS) {
      const generated = generateRekeyState(seed, { ...SMOKE_OPTS, dbPath: freshDbPath(`naive-${seed}`) });
      const result = checkRekeyInvariants(generated, naiveClobberRekey);

      // Discriminates: the harness must say NOT ok, specifically because of
      // the stronger most-recently-updated-wins rule -- never because
      // invariant 1 (no key lost) or invariant 2 (event rows carried) broke,
      // which both references satisfy identically (rekey-reference-impls.ts
      // re-keys events/proposals identically under both modes).
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.startsWith("scalar-merge-wins:"))).toBe(true);
      expect(result.violations.some((v) => v.startsWith("no-key-lost:"))).toBe(false);
      expect(result.violations.some((v) => v.startsWith("event-rows-carried:"))).toBe(false);
    }
  });

  test("documents one concrete violation message verbatim (seed 10000, the forced-collision asset)", () => {
    const generated = generateRekeyState(SMOKE_SEEDS[0] as number, { ...SMOKE_OPTS, dbPath: freshDbPath("naive-doc") });
    const result = checkRekeyInvariants(generated, naiveClobberRekey);
    const scalarViolations = result.violations.filter((v) => v.startsWith("scalar-merge-wins:"));
    expect(scalarViolations.length).toBeGreaterThan(0);
    // The forced collision (asset index 0, origin "stash", type "skill",
    // name "asset-0") always resolves with the origin-qualified spelling as
    // the winner (see rekey-generator.ts's `plainForced` const) -- naive
    // always keeps the bare row's fields instead, so this exact asset's
    // canonical key is always among the reported violations.
    expect(scalarViolations.some((v) => v.includes('asset="stash//skill:asset-0"'))).toBe(true);
  });
});

describe("WI-0b.7b — idempotence holds for the correct reference", () => {
  test("no idempotence violation is ever reported for correctReferenceRekey", () => {
    for (const seed of SMOKE_SEEDS) {
      const generated = generateRekeyState(seed, { ...SMOKE_OPTS, dbPath: freshDbPath(`idem-${seed}`) });
      const result = checkRekeyInvariants(generated, correctReferenceRekey);
      expect(result.violations.some((v) => v.startsWith("idempotent:"))).toBe(false);
    }
  });
});
