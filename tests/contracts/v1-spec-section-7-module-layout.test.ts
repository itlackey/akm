import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §7 — Module layout.
//
// We don't enforce the literal tree the spec sketches (the spec uses a
// schematic, the actual tree has more files). We DO enforce the named
// anchor modules — moving or renaming any of these is a contract change.

// The spec's §7 schematic uses idealized names (`refs.ts`, `types.ts`); the
// shipped tree has slightly different file names but the same concepts. We
// pin the actually-shipped anchors — moving any of these is a real
// contract change, not a rename of a doc-only schematic.
const REQUIRED_FILES = [
  "src/cli.ts",
  "src/core/asset-ref.ts",
  "src/core/errors.ts",
  "src/core/config.ts",
  "src/core/write-source.ts",
];

const REQUIRED_DIRS = ["src/commands", "src/sources", "src/registry", "src/indexer", "src/output"];

const repoRoot = path.resolve(import.meta.dir, "..", "..");

describe("v1 spec §7 — module layout", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 7. Module layout");

  test("§7 exists in the spec", () => {
    expect(section).not.toBe("");
  });

  test("§7 names the locked anchor modules in the schematic", () => {
    // The schematic in the spec uses these names; renaming requires a major
    // bump. (Some files ship under slightly different names; see the
    // on-disk anchor check below.)
    expect(section).toContain("write-source.ts");
    expect(section).toContain("config.ts");
    expect(section).toContain("errors.ts");
    expect(section).toContain("cli.ts");
  });

  test("locked anchor files exist on disk", () => {
    for (const rel of REQUIRED_FILES) {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true);
    }
  });

  test("locked anchor directories exist on disk", () => {
    for (const rel of REQUIRED_DIRS) {
      const stat = fs.statSync(path.join(repoRoot, rel));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  test("§7 lists what was removed from 0.6.0", () => {
    expect(section).toMatch(/Removed from 0\.6\.0/);
    expect(section).toMatch(/openviking/i);
    expect(section).toMatch(/stash-search\.ts|stash-show\.ts/);
  });

  test("§7 stops before §8 (helper boundary check)", () => {
    expect(section).not.toContain("## 8.");
    expect(section).not.toContain("## 9.");
  });
});
