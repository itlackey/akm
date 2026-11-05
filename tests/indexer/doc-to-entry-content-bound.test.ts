import { describe, expect, test } from "bun:test";
import type { IndexDocument } from "../../src/core/adapter/types";
import { MARKDOWN_CONTENT_MAX_CHARS } from "../../src/indexer/passes/metadata";
import { indexDocumentToStashEntry } from "../../src/indexer/scan/doc-to-entry";

function doc(content: string, adapterId: string): IndexDocument {
  return { type: "file", name: "big", path: "/tmp/big.txt", adapterId, content };
}

describe("indexDocumentToStashEntry content bound", () => {
  test.each(["generic-files", "okf"])("%s: an oversized body is cut and flagged", (adapterId) => {
    const entry = indexDocumentToStashEntry(doc("a ".repeat(MARKDOWN_CONTENT_MAX_CHARS), adapterId));
    expect(entry.content?.length).toBeLessThanOrEqual(MARKDOWN_CONTENT_MAX_CHARS);
    expect(entry.contentTruncated).toBe(true);
  });

  test("a body within the bound is kept whole and not flagged", () => {
    const entry = indexDocumentToStashEntry(doc("short", "generic-files"));
    expect(entry.content).toBe("short");
    expect(entry.contentTruncated).toBeUndefined();
  });
});
