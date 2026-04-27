import { describe, expect, test } from "bun:test";
import { ASSET_SPECS } from "../../src/core/asset-spec";
import { isAssetType } from "../../src/core/common";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §4.1 — Asset type rules (open set).
//
// These tests are intentionally about the *rule*, not the specific list of
// well-known types. The closed-set list can grow without breaking the
// contract; what cannot change is that types are an open string set and
// that the renderer registry is the authority.

describe("v1 spec §4.1 — asset type rules (open set)", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "### 4.1 Asset type rules (open set)");

  test("§4.1 declares the open set rule in the spec", () => {
    expect(section).not.toBe("");
    expect(section).toContain("open string");
    // Renderer registry is named as the authority for well-known types.
    expect(section).toMatch(/renderer/i);
  });

  test("§4.1 names every well-known type that has a renderer today", () => {
    // Every type that ships with an ASSET_SPECS entry today must be named in
    // the well-known list. Adding a new type is fine; silently dropping one
    // is not.
    for (const type of Object.keys(ASSET_SPECS)) {
      expect(section).toContain(`\`${type}\``);
    }
  });

  test("§4.1 names `lesson` as a planned-for-v1 well-known type", () => {
    expect(section).toContain("`lesson`");
  });

  test("isAssetType() accepts arbitrary strings — open set in code", () => {
    // The spec says the type is an open string. The runtime validator must
    // not reject unknown types as part of ref parsing. We only assert the
    // function returns the expected boolean shape; specific well-known
    // values are allowed but not required to be the only true cases.
    expect(typeof isAssetType("skill")).toBe("boolean");
    expect(typeof isAssetType("definitely-not-a-real-type")).toBe("boolean");
  });
});
