// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.8 — the god-function size gate, now ABSOLUTE (R31, chunk-7 DoD 5).
 *
 * The WI-7.4 ratchet started with 13 offenders in its shrink-only baseline;
 * WI-7.5–7.7 decomposed all of them into named passes and WI-7.8 emptied the
 * baseline, so there is no allowlist left to consult: every function-like node
 * in `src/commands/improve/**` (declarations, expressions, arrows, methods —
 * including nested anonymous ones) must be ≤ 220 lines, absolutely. A new
 * function over the bar fails this test immediately — decompose it into named
 * passes (see the WI-7.6/7.7 pass extractions for the pattern) instead of
 * growing it.
 */

import { describe, expect, test } from "bun:test";
import { IMPROVE_FN_SIZE_BAR, measureImproveFnOffenders } from "../../scripts/lint-improve-fn-size";

describe("improve god-fn size gate (R31, absolute)", () => {
  test(`no function-like node in src/commands/improve/** exceeds ${IMPROVE_FN_SIZE_BAR} lines`, () => {
    const offenders = measureImproveFnOffenders();
    if (offenders.length > 0) {
      throw new Error(
        `improve god-fn size gate: ${offenders.length} function(s) exceed the ${IMPROVE_FN_SIZE_BAR}-line bar ` +
          `(the WI-7.8 baseline is EMPTY — decompose into named passes, do not re-grow):\n${offenders
            .map((o) => `  ${o.id} = ${o.lines}`)
            .join("\n")}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
