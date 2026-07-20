// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-8.2 — a smoke run of the Chunk-0b invariant harness against the REAL
 * cutover re-key engine (`rekeyStateDb`, via `cutoverRekeyFn`). This proves the
 * production function satisfies all 5 merge invariants (no key lost; event rows
 * carried as-is with counts; scalar most-recently-updated wins; deterministic;
 * idempotent) when it collapses each asset's legacy spellings onto its
 * `bundle//conceptId` `item_ref`.
 *
 * This is the SMOKE tier. WI-8.7 owns the ≥1000-case property gate; scaling this
 * up is a single-constant change (`SMOKE_SEED_COUNT`), nothing else.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { cutoverKeyFor, cutoverRekeyFn } from "./cutover-rekey-adapter";
import { generateRekeyState } from "./rekey-generator";
import { checkRekeyInvariants } from "./rekey-invariants";

/** WI-8.7 scales this to ≥1000; the smoke tier proves the wiring + engine on 10. */
const SMOKE_SEED_COUNT = 10;
const SMOKE_SEEDS: readonly number[] = Array.from({ length: SMOKE_SEED_COUNT }, (_, i) => 20_000 + i * 911);
const SMOKE_OPTS = { assetCount: 8 } as const;

let storage: IsolatedAkmStorage;
let dbCounter = 0;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  dbCounter = 0;
});

afterEach(() => {
  storage.cleanup();
});

function freshDbPath(label: string): string {
  dbCounter += 1;
  return path.join(storage.root, "cutover-rekey-gen", `${label}-${dbCounter}`, "state.db");
}

describe("WI-8.2 — real rekeyStateDb satisfies every re-key invariant (bundle//conceptId targets)", () => {
  test(`cutoverRekeyFn passes all 5 invariants across ${SMOKE_SEED_COUNT} smoke seeds`, () => {
    for (const seed of SMOKE_SEEDS) {
      const generated = generateRekeyState(seed, { ...SMOKE_OPTS, dbPath: freshDbPath(`cutover-${seed}`) });
      const result = checkRekeyInvariants(generated, cutoverRekeyFn, { keyFor: cutoverKeyFor });
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });
});
