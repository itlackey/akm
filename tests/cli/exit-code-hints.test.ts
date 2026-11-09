import { describe, expect, test } from "bun:test";
import { EMBEDDED_HINTS } from "../../src/output/cli-hints";

describe("embedded exit-code hints", () => {
  for (const [name, hints] of [["brief", EMBEDDED_HINTS]] as const) {
    test(`${name} pins health/internal codes and command failure semantics`, () => {
      expect(hints).toContain("| 4 | Health warning (`akm health` only) |");
      expect(hints).toContain("| 70 | Internal / unclassified error |");
      expect(hints).toContain("Not found or command-reported failure");
      expect(hints).toContain("| 75 | Transient");
    });
  }
});
