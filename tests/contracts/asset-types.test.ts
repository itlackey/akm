import { describe, expect, test } from "bun:test";
import { ASSET_SPECS } from "../../src/core/asset/asset-spec";
import { ASSET_TYPES, isAssetType } from "../../src/core/common";
import { ARCHITECTURE_PATH, extractSection, readDoc } from "./contract-helpers";

describe("current asset type registry contract", () => {
  const section = extractSection(readDoc(ARCHITECTURE_PATH), "## Asset Types");

  test("current architecture documents the runtime registry", () => {
    expect(section).not.toBe("");
    for (const type of Object.keys(ASSET_SPECS)) {
      expect(section).toContain(`\`${type}\``);
    }
  });

  test("the static type catalog and asset specs cannot drift", () => {
    expect<string[]>([...ASSET_TYPES].sort()).toEqual(Object.keys(ASSET_SPECS).sort());
  });

  test("runtime recognition follows the registered specs", () => {
    for (const type of Object.keys(ASSET_SPECS)) expect(isAssetType(type)).toBe(true);
    expect(isAssetType("definitely-not-a-real-type")).toBe(false);
  });
});
