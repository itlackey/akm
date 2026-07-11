import { describe, expect, test } from "bun:test";
import { isProposedQuality, KNOWN_QUALITY_VALUES, normalizeQuality } from "../../src/indexer/passes/metadata";

describe("current asset quality runtime contract", () => {
  test("well-known values include every actively interpreted quality", () => {
    expect([...KNOWN_QUALITY_VALUES].sort()).toEqual(["curated", "enriched", "generated", "proposed"]);
  });

  test("only exact proposed quality is filtered by default", () => {
    expect(isProposedQuality("proposed")).toBe(true);
    for (const quality of ["generated", "curated", "enriched", "PROPOSED", undefined]) {
      expect(isProposedQuality(quality)).toBe(false);
    }
  });

  test("unknown quality values remain accepted verbatim", () => {
    expect(normalizeQuality("experimental-contract-value")).toBe("experimental-contract-value");
  });
});
