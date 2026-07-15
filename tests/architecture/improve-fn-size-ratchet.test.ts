// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.4 — the god-function size ratchet meta-test (R31, chunk-7 DoD 5).
 *
 * Guards the WI-7.5–7.8 decomposition: every function-like node in
 * `src/commands/improve/**` must be ≤ 220 lines unless it is in the shrink-only
 * baseline. The baseline is the current post-deletion offender list; it may only
 * ever get smaller as the improve god-functions are broken into named passes,
 * and WI-7.8 empties it (at which point the "no function over the bar" assertion
 * below becomes absolute — no allowlist left to consult).
 */

import { describe, expect, test } from "bun:test";
import {
  IMPROVE_FN_SIZE_BAR,
  IMPROVE_FN_SIZE_BASELINE,
  type ImproveFnOffender,
  measureImproveFnOffenders,
} from "../../scripts/lint-improve-fn-size";

function describeDrift(live: ImproveFnOffender[], baseline: readonly ImproveFnOffender[]): string {
  const baseById = new Map(baseline.map((o) => [o.id, o.lines]));
  const liveById = new Map(live.map((o) => [o.id, o.lines]));
  const lines: string[] = [];
  for (const o of live) {
    const prev = baseById.get(o.id);
    if (prev === undefined)
      lines.push(`  NEW over-bar fn (decompose or, if unavoidable, add to baseline): ${o.id} = ${o.lines}`);
    else if (o.lines > prev) lines.push(`  GREW past its baseline (must not grow): ${o.id} ${prev} → ${o.lines}`);
    else if (o.lines < prev) lines.push(`  SHRUNK — lower its baseline entry to ${o.lines}: ${o.id} (was ${prev})`);
  }
  for (const o of baseline) {
    if (!liveById.has(o.id))
      lines.push(`  DROPPED below the bar — remove its baseline entry: ${o.id} (was ${o.lines})`);
  }
  return lines.join("\n");
}

describe("improve god-fn size ratchet (R31)", () => {
  test(`no function-like node in src/commands/improve/** exceeds ${IMPROVE_FN_SIZE_BAR} lines outside the shrink-only baseline`, () => {
    const live = measureImproveFnOffenders();
    // Equality subsumes both directions: no new/grown offenders (growth), and no
    // stale slack (a decomposed fn must leave the baseline in the same change).
    if (JSON.stringify(live) !== JSON.stringify(IMPROVE_FN_SIZE_BASELINE)) {
      throw new Error(
        `improve god-fn size ratchet drift — the live over-bar set no longer matches the baseline:\n${describeDrift(
          live,
          IMPROVE_FN_SIZE_BASELINE,
        )}\n\nUpdate scripts/lint-improve-fn-size.ts IMPROVE_FN_SIZE_BASELINE (shrink-only) in the same change.`,
      );
    }
    expect(live).toEqual([...IMPROVE_FN_SIZE_BASELINE]);
  });

  test("the baseline is well-formed: unique ids, all over the bar, sorted deterministically", () => {
    const ids = IMPROVE_FN_SIZE_BASELINE.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    for (const o of IMPROVE_FN_SIZE_BASELINE) expect(o.lines).toBeGreaterThan(IMPROVE_FN_SIZE_BAR);
    const sorted = [...IMPROVE_FN_SIZE_BASELINE].sort(
      (a, b) => b.lines - a.lines || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    expect(IMPROVE_FN_SIZE_BASELINE).toEqual(sorted);
  });
});
