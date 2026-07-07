// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared random-value generators for the workflow fuzz suites. Pure functions
 * of an {@link Rng} — no clock, no IO — so a seed reproduces a value exactly.
 */

import { canonicalJson } from "../../../src/workflows/exec/step-work";
import type { Rng } from "./_rng";

/** A small pool of unicode-ish / hostile string atoms to widen coverage. */
const STRING_ATOMS = [
  "",
  "a",
  "file.ts",
  "path/to/x",
  "héllo",
  "日本語",
  "emoji-🔥",
  "with space",
  "${{ params.secret }}", // injection payload — must survive as literal data
  "line\nbreak",
  "quote\"'`",
  "$&$$\\",
  "{not: json}",
  "-0",
  "null",
];

/** A random JSON-serializable value, bounded by `depth`. */
export function randomJsonValue(rng: Rng, depth = 3): unknown {
  const leaf = depth <= 0 || rng.bool(0.55);
  if (leaf) {
    switch (rng.int(5)) {
      case 0:
        return rng.pick(STRING_ATOMS);
      case 1:
        return rng.range(-1000, 1000);
      case 2:
        return rng.float() * 1000 - 500; // non-integer number
      case 3:
        return rng.bool();
      default:
        return null;
    }
  }
  if (rng.bool()) {
    const len = rng.int(4);
    return Array.from({ length: len }, () => randomJsonValue(rng, depth - 1));
  }
  const keyCount = rng.int(4);
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < keyCount; i++) {
    obj[`k${rng.int(6)}`] = randomJsonValue(rng, depth - 1);
  }
  return obj;
}

/**
 * `count` canonically-DISTINCT JSON values (no two share a `canonicalJson`).
 * Used wherever a fan-out item list must be dedup-free (unit identity requires
 * distinct items). May return fewer than `count` if the RNG keeps colliding,
 * but always at least one.
 */
export function distinctJsonValues(rng: Rng, count: number): unknown[] {
  const seen = new Set<string>();
  const values: unknown[] = [];
  let guard = 0;
  while (values.length < count && guard++ < count * 20) {
    const value = randomJsonValue(rng, 3);
    const key = canonicalJson(value) ?? "null";
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  if (values.length === 0) values.push(`fallback-${rng.int(1_000_000)}`);
  return values;
}

/** Return a key-shuffled deep copy of an object/array (equal by canonicalJson). */
export function reorderKeys(rng: Rng, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => reorderKeys(rng, v));
  if (value && typeof value === "object") {
    const entries = rng.shuffle(Object.entries(value as Record<string, unknown>));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = reorderKeys(rng, v);
    return out;
  }
  return value;
}
