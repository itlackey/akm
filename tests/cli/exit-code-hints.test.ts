import { describe, expect, test } from "bun:test";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "../../src/output/cli-hints";

describe("embedded exit-code hints", () => {
  for (const [name, hints] of [
    ["brief", EMBEDDED_HINTS],
    ["full", EMBEDDED_HINTS_FULL],
  ] as const) {
    test(`${name} pins health/internal codes and command failure semantics`, () => {
      expect(hints).toContain("| 4 | Health warning (`akm health` only) |");
      expect(hints).toContain("| 70 | Internal / unclassified error |");
      expect(hints).toContain("Not found or command-reported failure");
      expect(hints).toContain("`env run`, `secret run`, and `migrate`");
      expect(hints).toContain("`task run`");
      expect(hints).toContain("`agent`");
    });
  }

  test("full hints scope the two-signal guarantee to envelope surfaces", () => {
    expect(EMBEDDED_HINTS_FULL).toContain("On result-envelope surfaces, both signals are always set consistently.");
    expect(EMBEDDED_HINTS_FULL).toContain("Passthrough surfaces");
  });

  test("shipped task and show guidance uses the 0.9 contracts", () => {
    expect(EMBEDDED_HINTS).toContain("`task run` preserves configuration failures as exit 78");
    expect(EMBEDDED_HINTS_FULL).toContain("other failures exit 1");
    expect(EMBEDDED_HINTS_FULL).toContain("local index and materialized bundle files only");
    expect(EMBEDDED_HINTS_FULL).toContain("selected engine invocation timeout");
    expect(EMBEDDED_HINTS_FULL).toContain("--negative --reason");
  });
});
