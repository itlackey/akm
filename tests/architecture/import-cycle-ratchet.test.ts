// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Import-cycle ratchet meta-test (plan §10.7 / §11 Chunk 9, armed early).
 *
 * Asserts no file OUTSIDE the shrink-only baseline participates in a static
 * import cycle in `src/**`. Files leaving the knot pass silently; Chunk 9
 * kills the non-taxonomy cycles and Chunk 3 drives the participant count to
 * zero, at which point the empty baseline makes this an absolute gate.
 *
 * Semantics, measurement, and the baseline itself live in
 * `scripts/lint-import-cycles.ts` (also runnable standalone:
 * `bun scripts/lint-import-cycles.ts`).
 */

import { describe, expect, test } from "bun:test";
import {
  CYCLE_PARTICIPANT_BASELINE,
  checkImportCycleRatchet,
  measureCycleParticipants,
} from "../../scripts/lint-import-cycles";

describe("import-cycle ratchet (shrink-only participant baseline)", () => {
  test("no file outside the baseline participates in a static import cycle", () => {
    const participants = measureCycleParticipants();
    const violations = checkImportCycleRatchet(participants);
    if (violations.length > 0) {
      throw new Error(
        `import-cycle ratchet: ${violations.length} file(s) JOINED an import cycle — break the cycle instead of ` +
          `extending the baseline (it is shrink-only):\n${violations.map((v) => `  ${v}`).join("\n")}`,
      );
    }
    expect(violations).toEqual([]);
  });

  test("the baseline is well-formed: sorted, unique, src-relative", () => {
    const sorted = [...CYCLE_PARTICIPANT_BASELINE].sort();
    expect([...CYCLE_PARTICIPANT_BASELINE]).toEqual(sorted);
    expect(new Set(CYCLE_PARTICIPANT_BASELINE).size).toBe(CYCLE_PARTICIPANT_BASELINE.length);
    for (const p of CYCLE_PARTICIPANT_BASELINE) expect(p.startsWith("src/")).toBe(true);
  });
});
