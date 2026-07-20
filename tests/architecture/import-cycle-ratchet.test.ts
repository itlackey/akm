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
  checkDynamicImportRatchet,
  checkImportCycleRatchet,
  DYNAMIC_IMPORT_BASELINE,
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

  test("the baseline is well-formed: sorted, unique, src-relative — and never grows past its armed size", () => {
    const sorted = [...CYCLE_PARTICIPANT_BASELINE].sort();
    expect([...CYCLE_PARTICIPANT_BASELINE]).toEqual(sorted);
    expect(new Set(CYCLE_PARTICIPANT_BASELINE).size).toBe(CYCLE_PARTICIPANT_BASELINE.length);
    for (const p of CYCLE_PARTICIPANT_BASELINE) expect(p.startsWith("src/")).toBe(true);
    // Cardinality pin (adversarial audit): the baseline emptied at chunk-8
    // WI-8.6 (DoD 11) and the ratchet is ABSOLUTE — any entry added here to
    // admit a new cycle is a loud, reviewable violation of that gate.
    expect(CYCLE_PARTICIPANT_BASELINE.length).toBe(0);
  });

  test("dynamic import() counts never grow per file (cycle-laundering guard)", () => {
    const violations = checkDynamicImportRatchet();
    if (violations.length > 0) {
      throw new Error(
        `dynamic-import ratchet violations (converting a static import to import() to dodge the cycle ratchet is ` +
          `not sanctioned; a genuine new lazy-load edits DYNAMIC_IMPORT_BASELINE in its own diff line):\n${violations
            .map((v) =>
              v.kind === "new"
                ? `  NEW dynamic-import file: ${v.file} (${v.count})`
                : `  GREW: ${v.file} ${v.baseline} → ${v.count}`,
            )
            .join("\n")}`,
      );
    }
    expect(violations).toEqual([]);
  });

  test("the dynamic-import baseline never grows past its armed size", () => {
    const files = Object.keys(DYNAMIC_IMPORT_BASELINE);
    const total = files.reduce((s, f) => s + DYNAMIC_IMPORT_BASELINE[f], 0);
    expect(files.length).toBeLessThanOrEqual(33);
    expect(total).toBeLessThanOrEqual(102);
  });
});
