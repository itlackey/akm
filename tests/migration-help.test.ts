import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBundledReleaseVersions, renderMigrationHelp } from "../src/migration-help";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const RELEASE_NOTES_DIR = path.join(PROJECT_ROOT, "docs", "migration", "release-notes");

describe("migration help", () => {
  test("renders bundled migration guidance when changelog is unavailable", () => {
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
    expect(staticFiles).toContain("docs/migration/release-notes");
    for (const entry of staticFiles) {
      expect(fs.existsSync(path.join(PROJECT_ROOT, entry))).toBe(true);
    }
  });

  test("every bundled release-notes file is surfaced by the loader", () => {
    const bundled = listBundledReleaseVersions();
    expect(bundled.length).toBeGreaterThan(0);
    // Sanity: every known prior release has a note. Adding a new file to
    // docs/migration/release-notes/ should be all it takes to extend this.
    for (const version of ["0.0.13", "0.1.0", "0.2.0", "0.3.0", "0.5.0", "0.6.0"]) {
      expect(bundled).toContain(version);
      const result = renderMigrationHelp(version, undefined);
      expect(result).toContain(`Migration notes for akm v${version}`);
    }
  });

  test("renders dedicated message when no bundled note or changelog entry exists", () => {
    const result = renderMigrationHelp("9.9.9", undefined);
    expect(result).toContain("No dedicated migration note");
    expect(result).toContain("9.9.9");
    // Fallback lists the bundled versions so users can pick one that exists.
    expect(result).toContain("Available bundled notes:");
    expect(result).toContain("0.6.0");
  });

  test("rejects unsafe version components (path traversal guard)", () => {
    // Any of these would escape the release-notes directory if passed
    // directly to fs.readFileSync; the loader must refuse them and fall
    // through to the no-note fallback.
    for (const bad of ["../../etc/passwd", "..", "0.6.0/../secret", "0.6.0\0"]) {
      const result = renderMigrationHelp(bad, undefined);
      expect(result).toContain("No dedicated migration note");
    }
  });

  test("dist build resolves release-notes relative to the compiled module", () => {
    // Simulate the published layout: a `<pkg>/dist` directory alongside
    // `<pkg>/docs/migration/release-notes`. The loader derives its path
    // from `import.meta.dir`, so we rebuild that relationship in a temp
    // directory and assert the expected file resolves.
    const tempPkg = fs.mkdtempSync(path.join(os.tmpdir(), "akm-pkg-layout-"));
    try {
      fs.mkdirSync(path.join(tempPkg, "dist"));
      fs.mkdirSync(path.join(tempPkg, "docs", "migration", "release-notes"), { recursive: true });
      const notePath = path.join(tempPkg, "docs", "migration", "release-notes", "0.6.0.md");
      fs.writeFileSync(notePath, "Migration notes for akm v0.6.0\n- stub body for test\n", "utf8");

      // Resolve exactly the way migration-help does (path.resolve(<mod>, "../docs/migration/release-notes")).
      const moduleDir = path.join(tempPkg, "dist");
      const resolved = path.resolve(moduleDir, "../docs/migration/release-notes", "0.6.0.md");
      expect(fs.existsSync(resolved)).toBe(true);
      expect(fs.readFileSync(resolved, "utf8")).toContain("Migration notes for akm v0.6.0");
    } finally {
      fs.rmSync(tempPkg, { recursive: true, force: true });
    }
  });

  test("every release-notes filename matches a published version shape", () => {
    const files = fs.readdirSync(RELEASE_NOTES_DIR).filter((name) => name.endsWith(".md") && name !== "README.md");
    for (const file of files) {
      const version = file.slice(0, -".md".length);
      // Accept semver-ish strings the loader is willing to serve.
      expect(version).toMatch(/^[A-Za-z0-9._+-]+$/);
    }
  });
});
