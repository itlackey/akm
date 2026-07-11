import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ARCHITECTURE_PATH, extractSection, readDoc } from "./spec-helpers";

const REQUIRED_FILES = [
  "src/cli.ts",
  "src/core/asset/asset-ref.ts",
  "src/core/errors.ts",
  "src/core/config/config.ts",
  "src/core/write-source.ts",
];

const REQUIRED_DIRS = ["src/commands", "src/sources", "src/registry", "src/indexer", "src/output"];

const repoRoot = path.resolve(import.meta.dir, "..", "..");

describe("current module boundary contract", () => {
  const section = extractSection(readDoc(ARCHITECTURE_PATH), "## Module Boundaries");

  test("current architecture documents every anchor module", () => {
    expect(section).not.toBe("");
    for (const rel of REQUIRED_FILES) expect(section).toContain(`\`${rel}\``);
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
});
