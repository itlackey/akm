import { describe, expect, test } from "bun:test";
import { _setWarnSinkForTests } from "../src/core/warn";
import { type EntryRow, rowToIndexedEntry } from "../src/storage/repositories/index-entry-mapper";

function row(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    item_ref: "team//knowledge/guide",
    bundle_id: "team",
    component_id: "team",
    concept_id: "knowledge/guide",
    adapter_id: "akm",
    type: "knowledge",
    file_path: "/stash/knowledge/guide.md",
    content_hash: null,
    document_json: JSON.stringify({ type: "knowledge", name: "guide" }),
    ...overrides,
  };
}

describe("rowToIndexedEntry provenance", () => {
  test("maps canonical durable provenance from the entries row", () => {
    expect(rowToIndexedEntry(row(), "test")).toMatchObject({
      itemRef: "team//knowledge/guide",
      bundleId: "team",
      conceptId: "knowledge/guide",
      adapterId: "akm",
    });
  });

  test("rejects corrupt current document JSON", () => {
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      expect(rowToIndexedEntry(row({ document_json: "{" }), "test")).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("corrupt document_json");
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });
});
