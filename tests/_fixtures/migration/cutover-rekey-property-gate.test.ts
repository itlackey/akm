// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-8.7 — THE chunk-8 property gate (plan §12.3 / chunk-8 manifest gate):
 * the REAL cutover re-key engine (`rekeyStateDb`, via `cutoverRekeyFn`) must
 * hold all 5 merge invariants (no key lost; event rows carried as-is with
 * counts preserved; scalar most-recently-updated wins; deterministic;
 * idempotent) over **≥1000 generated cases** — randomized state across the
 * legacy spelling shapes ({bare, origin-qualified} × {plain, .derived-twin},
 * forced collisions every seed) collapsing onto `bundle//conceptId` item_refs.
 *
 * "The three-spelling merge is an algebra, and two examples cannot pin an
 * algebra" (§12.3) — this file is the ≥1000-case pin. The 10-seed smoke tier
 * (`cutover-rekey-property.test.ts`) stays as the fast wiring proof.
 *
 * Cost: ~0.5s/seed (template-cached generator + file copy + 2 independent
 * re-key runs + idempotency re-run per seed) ≈ 8-9 min total — slow-listed in
 * `scripts/test-unit.sh`, run under CI / AKM_RUN_SLOW_TESTS=1.
 *
 * Seed spacing is coprime-stepped from a distinct base so the gate never
 * replays the smoke seeds; assetCount alternates through three sizes so the
 * algebra is exercised on small, default, and wide models.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { cutoverKeyFor, cutoverRekeyFn } from "./cutover-rekey-adapter";
import { generateRekeyState } from "./rekey-generator";
import { checkRekeyInvariants } from "./rekey-invariants";

const GATE_SEED_COUNT = 1000;
const GATE_SEEDS: readonly number[] = Array.from({ length: GATE_SEED_COUNT }, (_, i) => 1_000_003 + i * 7919);
/** Cycle the model width so the merge algebra is pinned across sizes, not one shape. */
const ASSET_COUNTS = [6, 14, 22] as const;

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
  return path.join(storage.root, "cutover-rekey-gate", `${label}-${dbCounter}`, "state.db");
}

describe("WI-8.7 — ≥1000-case re-key merge property gate (chunk-8 DoD)", () => {
  test(
    `rekeyStateDb holds all 5 invariants across ${GATE_SEED_COUNT} generated cases`,
    () => {
      let checked = 0;
      for (const [index, seed] of GATE_SEEDS.entries()) {
        const assetCount = ASSET_COUNTS[index % ASSET_COUNTS.length];
        const generated = generateRekeyState(seed, { assetCount, dbPath: freshDbPath(`gate-${seed}`) });
        const result = checkRekeyInvariants(generated, cutoverRekeyFn, { keyFor: cutoverKeyFor });
        if (!result.ok) {
          throw new Error(
            `re-key invariant violation at seed ${seed} (assetCount ${assetCount}, case ${index + 1}/${GATE_SEED_COUNT}):\n` +
              result.violations.join("\n"),
          );
        }
        checked += 1;
      }
      expect(checked).toBe(GATE_SEED_COUNT);
    },
    { timeout: 20 * 60 * 1000 },
  );
});
