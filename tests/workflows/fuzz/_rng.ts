// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Seeded, deterministic fuzz harness shared by `tests/workflows/fuzz/*`.
 *
 * A property-based suite is only useful if a failure is REPRODUCIBLE and
 * REPORTABLE: every iteration draws its randomness from a pure xorshift32 PRNG
 * seeded by the iteration number, and every failure carries its seed
 * ({@link withSeed}) so a red run names the exact case to replay. No wall
 * clock, no `Math.random`, no IO — reruns are byte-identical.
 *
 * Iteration count is small by default so the whole `fuzz/` directory stays in
 * the fast unit tier (target < ~20s), and is overridable via `AKM_FUZZ_SEEDS`
 * for deep nightly runs (`AKM_FUZZ_SEEDS=20000 bun test tests/workflows/fuzz/`).
 */

/** Deterministic xorshift32 PRNG. Same seed ⇒ same stream, forever. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // xorshift is undefined at 0; fold the seed into a nonzero 32-bit state.
    this.state = (seed ^ 0x9e3779b9) >>> 0 || 0x6d2b79f5;
  }

  /** Next unsigned 32-bit integer. */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next() / 0x1_0000_0000;
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.float() * maxExclusive);
  }

  /** Uniform integer in [min, maxInclusive]. */
  range(min: number, maxInclusive: number): number {
    if (maxInclusive < min) return min;
    return min + this.int(maxInclusive - min + 1);
  }

  /** True with probability `p` (default 0.5). */
  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  /** Pick one element (caller guarantees a non-empty array). */
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }

  /** A fresh Fisher-Yates shuffle (does not mutate the input). */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }
}

/**
 * The seed list for a suite. Default is deliberately small (fast tier);
 * `AKM_FUZZ_SEEDS=<n>` overrides it for deep runs. Seeds are `1..n` so a
 * reported `seed=N` maps to `new Rng(N)` verbatim.
 */
export function fuzzSeeds(defaultCount: number): number[] {
  const raw = process.env.AKM_FUZZ_SEEDS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const count = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultCount;
  return Array.from({ length: count }, (_, i) => i + 1);
}

/**
 * Run one iteration's assertions, tagging any failure with its seed so the
 * reported message names the exact case to replay. Wrap the body of every
 * per-seed loop in this — it is the contract that "EVERY failure message
 * includes the seed".
 */
export function withSeed<T>(seed: number, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tagged = new Error(`[seed=${seed}] ${message}`);
    if (error instanceof Error && error.stack) tagged.stack = `[seed=${seed}] ${error.stack}`;
    throw tagged;
  }
}
