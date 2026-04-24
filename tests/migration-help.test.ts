import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { renderMigrationHelp } from "../src/migration-help";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

describe("migration help", () => {
  test("renders embedded migration guidance when changelog is unavailable", () => {
    const result = renderMigrationHelp("0.5.0", undefined);
    expect(result).toContain("Migration notes for akm v0.5.0");
    expect(result).toContain("akm wiki");
  });

  test("normalizes v-prefixed prerelease versions to the stable release notes", () => {
    const result = renderMigrationHelp("v0.5.0-rc1");
    expect(result).toContain("Migration notes for akm v0.5.0");
    expect(result).toContain("## [0.5.0]");
  });

  test("supports latest alias when changelog text is available", () => {
    const result = renderMigrationHelp("latest");
    expect(result).toContain("## [0.6.0]");
  });

  test("ensures published static files exist in the repo", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };

    const staticFiles = (packageJson.files ?? []).filter((entry) => entry !== "dist");
    expect(staticFiles).toContain("CHANGELOG.md");
    for (const entry of staticFiles) {
      expect(fs.existsSync(path.join(PROJECT_ROOT, entry))).toBe(true);
    }
  });
});
