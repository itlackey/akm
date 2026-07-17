// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.7a — deterministic seeded PRNG for the re-key merge property-test
 * generator (`rekey-generator.ts`).
 *
 * `mulberry32` — a small, dependency-free 32-bit PRNG that produces the exact
 * same output sequence for the same seed on every platform/run. Chunk 0b/8's
 * "same seed -> byte-identical state" requirement forbids `Math.random()`
 * (not reproducible) and `Date.now()`/`new Date()` (not reproducible, and
 * banned outright by the chunk-0b brief's hard constraints) anywhere in the
 * generator; every pseudo-random draw in this tree must route through an
 * instance of this PRNG constructed from the caller's `seed` argument.
 */

/** A seeded PRNG instance: call it to get the next float in `[0, 1)`. */
export type Rng = () => number;

/**
 * Construct a mulberry32 PRNG seeded by `seed`. The same seed always yields
 * the same infinite output sequence (bitwise identical across platforms —
 * the algorithm only uses 32-bit integer arithmetic, no floating-point
 * accumulation that could drift).
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Next integer in `[0, maxExclusive)`, drawn from `rng`. */
export function nextInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

/** Pick one element of `items` (must be non-empty), drawn from `rng`. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick: empty items array");
  return items[nextInt(rng, items.length)] as T;
}

/** True with probability `probability` (`[0, 1]`), drawn from `rng`. */
export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}
