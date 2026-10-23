// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { redactUnitOutcome } from "../../src/workflows/exec/dispatch-redaction";
import type { UnitOutcome } from "../../src/workflows/exec/step-work";

describe("redactUnitOutcome number leaves", () => {
  test("redacts a numeric secret in the parsed result and no other number", () => {
    const outcome = redactUnitOutcome<UnitOutcome>(
      { unitId: "u", ok: true, result: { n: 4242, other: 42, nested: [4242] } },
      ["4242"],
    );
    expect(outcome.result).toEqual({ n: "[REDACTED]", other: 42, nested: ["[REDACTED]"] });
  });

  test("keeps tokens a number when a sensitive value equals it", () => {
    const outcome = redactUnitOutcome<UnitOutcome>({ unitId: "u", ok: true, tokens: 1200, result: { n: 1200 } }, [
      "1200",
    ]);
    expect(outcome.tokens).toBe(1200);
    expect(outcome.result).toEqual({ n: "[REDACTED]" });
  });
});
