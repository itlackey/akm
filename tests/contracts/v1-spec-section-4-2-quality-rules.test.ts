import { describe, expect, test } from "bun:test";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §4.2 — Asset quality rules (open set, default-filtered).
//
// The freeze rule is:
//   * `generated` and `curated` are well-known and included in default search.
//   * `proposed` is well-known and excluded from default search; surfaced via
//     `--include-proposed` or `akm proposal *`.
//   * Unknown values parse, warn, and remain searchable.

describe("v1 spec §4.2 — asset quality rules", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "### 4.2 Asset quality rules");

  test("§4.2 exists in the spec", () => {
    expect(section).not.toBe("");
  });

  test("§4.2 names the three well-known quality values", () => {
    expect(section).toContain('"generated"');
    expect(section).toContain('"curated"');
    expect(section).toContain('"proposed"');
  });

  test("§4.2 declares `proposed` is excluded from default search", () => {
    // Either phrasing is fine; we want both pieces of the rule present.
    expect(section).toMatch(/Excluded from default search/i);
    expect(section).toMatch(/--include-proposed|akm proposal/);
  });

  test("§4.2 declares unknown quality values parse-warn-include", () => {
    expect(section).toMatch(/Unknown quality values/i);
    expect(section).toMatch(/parse,?\s*warn/i);
  });

  test("§4.2 declares the legacy registry `curated` boolean is removed", () => {
    expect(section).toMatch(/legacy registry boolean `curated`/i);
    expect(section).toMatch(/parses and ignores/i);
  });

  test("§4.2 names the new optional SearchHit fields", () => {
    expect(section).toContain("quality?");
    expect(section).toContain("warnings?");
  });
});
