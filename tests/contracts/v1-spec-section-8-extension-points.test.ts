import { describe, expect, test } from "bun:test";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §8 — Extension points.
//
// The freeze rule: six surfaces are pluggable at v1; four are deliberately
// not. Removing or adding a surface to either list after v1.0 is a major
// bump.

const PLUGGABLE = ["SourceProvider", "RegistryProvider", "Asset type", "Embedder", "Renderer", "Ingest transformer"];

const NOT_EXTENSIBLE = ["API-backed sources", "Vault", "Scorer algorithm", "Output format"];

describe("v1 spec §8 — extension points", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 8. Extension points");

  test("§8 exists in the spec", () => {
    expect(section).not.toBe("");
  });

  test("§8 names every pluggable surface at v1", () => {
    for (const surface of PLUGGABLE) {
      expect(section).toContain(surface);
    }
  });

  test("§8 names every surface deliberately not extensible at v1", () => {
    for (const surface of NOT_EXTENSIBLE) {
      expect(section).toContain(surface);
    }
  });

  test("§8 declares output format is text/json only", () => {
    expect(section).toMatch(/`text` and `json` only/);
    expect(section).toMatch(/ndjson.*tsv.*mcp/);
  });

  test("§8 stops before §9 (helper boundary check)", () => {
    expect(section).not.toContain("## 9.");
    expect(section).not.toContain("## 10.");
  });
});
