// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { canonicalJson, reduceStepOutcomes, type UnitOutcome } from "../../../src/workflows/exec/step-work";
import type { IrStepPlan } from "../../../src/workflows/ir/schema";
import { distinctJsonValues, randomJsonValue, reorderKeys } from "./_gen";
import { fuzzSeeds, Rng, withSeed } from "./_rng";

/**
 * Seeded fuzz for the step reducers (`reduceStepOutcomes` / `buildEvidence` in
 * `exec/step-work.ts`) — the shared post-dispatch decision the engine and the
 * report surface both run.
 *
 * Properties (each iteration reproducible from its printed seed):
 *   - `collect` promotes one slot per unit, in order, with `null` for every
 *     failed slot (artifact length == item count);
 *   - `vote` winner selection is deterministic across repeated reductions;
 *   - a `vote` tie fails the step (no majority) rather than picking silently;
 *   - `vote` ignores failed units entirely (they cast no ballot);
 *   - canonically-equal objects (key order aside) vote for the SAME candidate.
 *
 * The golden cases live in `native-executor.test.ts`; this widens them over
 * random outcome multisets. Pure — no storage, no dispatch.
 */

const PLAN: IrStepPlan = {
  stepId: "s",
  title: "s",
  sequenceIndex: 0,
  gate: { kind: "gate", id: "s.gate", stepId: "s", criteria: [] },
};

let idCounter = 0;
function ok(result: unknown): UnitOutcome {
  return { unitId: `u${idCounter++}`, ok: true, result };
}
function failed(): UnitOutcome {
  return { unitId: `u${idCounter++}`, ok: false, failureReason: "reported_failure" };
}

/** A random object value (never a primitive) for the key-order property. */
function randomObject(rng: Rng): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const keyCount = rng.range(1, 4);
  for (let i = 0; i < keyCount; i++) obj[`k${i}`] = randomJsonValue(rng, 2);
  return obj;
}

describe("reducer fuzz — collect", () => {
  const seeds = fuzzSeeds(250);
  test("collect artifact has one slot per unit, in order, null for failures", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const count = rng.range(1, 8);
        const units: UnitOutcome[] = [];
        const expected: unknown[] = [];
        for (let i = 0; i < count; i++) {
          if (rng.bool(0.6)) {
            const value = randomJsonValue(rng, 2);
            units.push(ok(value));
            expected.push(value);
          } else {
            units.push(failed());
            expected.push(null);
          }
        }
        const outcome = reduceStepOutcomes(PLAN, "collect", true, "continue", units);
        const output = outcome.evidence.output;
        expect(Array.isArray(output)).toBe(true);
        expect((output as unknown[]).length).toBe(count);
        expect(canonicalJson(output)).toBe(canonicalJson(expected));
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("reducer fuzz — vote determinism + majority", () => {
  const seeds = fuzzSeeds(250);
  test("a unique-plurality vote picks that winner, deterministically and repeatably", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const candidateCount = rng.range(2, 4);
        const candidates = distinctJsonValues(rng, candidateCount);
        if (candidates.length < 2) return; // degenerate draw; nothing to rank

        // Give the winner a STRICT plurality; every other candidate gets fewer.
        const winnerVotes = rng.range(3, 6);
        const units: UnitOutcome[] = [];
        for (let c = 0; c < candidates.length; c++) {
          const votes = c === 0 ? winnerVotes : rng.range(1, winnerVotes - 1);
          for (let v = 0; v < votes; v++) units.push(ok(candidates[c]));
        }
        // Sprinkle in failed units — they must not affect the tally.
        for (let f = 0; f < rng.int(4); f++) units.push(failed());
        const shuffled = rng.shuffle(units);

        const first = reduceStepOutcomes(PLAN, "vote", true, "continue", shuffled);
        const second = reduceStepOutcomes(PLAN, "vote", true, "continue", rng.shuffle(units));

        expect(first.evidence.voteError).toBeUndefined();
        const vote = first.evidence.vote as { winner: unknown; votes: number };
        expect(canonicalJson(vote.winner)).toBe(canonicalJson(candidates[0]));
        expect(vote.votes).toBe(winnerVotes);
        // Determinism: a reshuffled multiset reduces to the identical decision.
        expect(canonicalJson(second.evidence.output)).toBe(canonicalJson(first.evidence.output));
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("reducer fuzz — vote tie fails", () => {
  const seeds = fuzzSeeds(200);
  test("two candidates sharing the top count is a no-majority failure", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const candidates = distinctJsonValues(rng, 2);
        if (candidates.length < 2) return;
        const topVotes = rng.range(2, 5);
        const units: UnitOutcome[] = [];
        for (const candidate of candidates) {
          for (let v = 0; v < topVotes; v++) units.push(ok(candidate));
        }
        const outcome = reduceStepOutcomes(PLAN, "vote", true, "continue", rng.shuffle(units));
        expect(outcome.ok).toBe(false);
        expect(String(outcome.evidence.voteError)).toContain("tied");
        expect(outcome.evidence.vote).toBeUndefined();
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("reducer fuzz — vote ignores failed units", () => {
  const seeds = fuzzSeeds(200);
  test("a lone successful ballot wins over any number of failures", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const winner = randomJsonValue(rng, 2);
        const units: UnitOutcome[] = [ok(winner)];
        const failures = rng.range(1, 10);
        for (let f = 0; f < failures; f++) units.push(failed());
        const outcome = reduceStepOutcomes(PLAN, "vote", true, "continue", rng.shuffle(units));
        expect(outcome.evidence.voteError).toBeUndefined();
        const vote = outcome.evidence.vote as { winner: unknown; votes: number; total: number };
        expect(canonicalJson(vote.winner)).toBe(canonicalJson(winner));
        expect(vote.votes).toBe(1); // failures cast no ballot
        expect(vote.total).toBe(units.length); // total still counts every unit
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("reducer fuzz — canonically-equal objects vote together", () => {
  const seeds = fuzzSeeds(200);
  test("key-reordered copies of one object are counted as the same candidate", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const target = randomObject(rng);
        // Find a distinct rival object (different canonical form).
        let rival = randomObject(rng);
        let guard = 0;
        while (canonicalJson(rival) === canonicalJson(target) && guard++ < 20) rival = randomObject(rng);

        const targetVotes = rng.range(2, 5);
        const rivalVotes = rng.int(targetVotes); // strictly fewer, so target wins
        const units: UnitOutcome[] = [];
        for (let v = 0; v < targetVotes; v++) units.push(ok(reorderKeys(rng, target)));
        for (let v = 0; v < rivalVotes; v++) units.push(ok(reorderKeys(rng, rival)));

        const outcome = reduceStepOutcomes(PLAN, "vote", true, "continue", rng.shuffle(units));
        if (canonicalJson(rival) === canonicalJson(target)) return; // couldn't find a rival
        const vote = outcome.evidence.vote as { winner: unknown; votes: number } | undefined;
        // The reordered copies collapse to ONE candidate with all target votes.
        expect(vote).toBeDefined();
        expect(canonicalJson(vote?.winner)).toBe(canonicalJson(target));
        expect(vote?.votes).toBe(targetVotes);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});
