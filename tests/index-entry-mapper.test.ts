import { describe, expect, test } from "bun:test";
import { type EntryRow, rowToIndexedEntry } from "../src/storage/repositories/index-entry-mapper";

function row(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    entry_key: "/stash:knowledge:guide",
    dir_path: "/stash/knowledge",
    file_path: "/stash/knowledge/guide.md",
    stash_dir: "/stash",
    entry_json: JSON.stringify({ type: "knowledge", name: "guide" }),
    search_text: "guide",
    item_ref: "team//knowledge/guide",
    bundle_id: "team",
    concept_id: "knowledge/guide",
    ...overrides,
  };
}

describe("rowToIndexedEntry provenance", () => {
  test("maps canonical durable provenance from the entries row", () => {
    expect(rowToIndexedEntry(row(), "test")).toMatchObject({
      itemRef: "team//knowledge/guide",
      bundleId: "team",
      conceptId: "knowledge/guide",
    });
  });

  test("keeps nullable pre-flip provenance available as an undefined fallback", () => {
    const mapped = rowToIndexedEntry(row({ item_ref: null, bundle_id: null, concept_id: null }), "test");
    expect(mapped?.itemRef).toBeUndefined();
    expect(mapped?.bundleId).toBeUndefined();
    expect(mapped?.conceptId).toBeUndefined();
    expect(mapped?.entryKey).toBe("/stash:knowledge:guide");
  });
});
