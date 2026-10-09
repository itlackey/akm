import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBundledReleaseVersions, renderMigrationHelp } from "../src/commands/sources/migration-help";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const RELEASE_NOTES_DIR = path.join(PROJECT_ROOT, "docs", "migration", "release-notes");

describe("migration help", () => {
  test("renders bundled migration guidance when changelog is unavailable", () => {
    const result = renderMigrationHelp("0.5.0", undefined);
    expect(result).toContain("# akm v0.5.0 migration notes");
    expect(result).toContain("akm wiki");
  });

  test("normalizes v-prefixed prerelease versions to the stable release notes", () => {
    const result = renderMigrationHelp("v0.5.0-rc1");
    expect(result).toContain("# akm v0.5.0 migration notes");
    expect(result).toContain("## [0.5.0]");
  });

  test("ensures published static files exist in the repo", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };

    const staticFiles = (packageJson.files ?? []).filter((entry) => entry !== "dist");
    // CHANGELOG.md and LICENSE are auto-published by npm from the package root
    // and intentionally NOT listed in files[] to avoid duplicate shipment.
    // An entry ships its path, or every path under it when it names a folder.
    const published = (file: string) => staticFiles.some((entry) => file === entry || file.startsWith(`${entry}/`));
    for (const file of [
      "docs/migration/release-notes",
      "docs/migration/v0.7-to-v0.8.md",
      "docs/migration/v0.9.1-to-v0.9.2.md",
      "docs/reference/tasks.md",
    ]) {
      expect(published(file)).toBe(true);
    }
    for (const entry of staticFiles) {
      expect(fs.existsSync(path.join(PROJECT_ROOT, entry))).toBe(true);
    }
    expect(fs.existsSync(path.join(PROJECT_ROOT, "CHANGELOG.md"))).toBe(true);
    expect(fs.existsSync(path.join(PROJECT_ROOT, "LICENSE"))).toBe(true);
  });

  test("every bundled release-notes file is surfaced by the loader", () => {
    const bundled = listBundledReleaseVersions();
    expect(bundled.length).toBeGreaterThan(0);
    // Sanity: every known prior release has a note. Adding a new file to
    // docs/migration/release-notes/ should be all it takes to extend this.
    for (const version of ["0.0.13", "0.1.0", "0.2.0", "0.3.0", "0.5.0", "0.6.0", "0.7.5", "0.9.0", "0.9.2"]) {
      expect(bundled).toContain(version);
      const result = renderMigrationHelp(version, undefined);
      expect(result).toContain(`# akm v${version} migration notes`);
    }
  });

  test("the 0.9.2 terminal note points task-v2 users at the fail-closed migration", () => {
    const result = renderMigrationHelp("v0.9.2", undefined);
    expect(result).toContain("# akm v0.9.2 migration notes");
    // P4 (docs/plans/specs/p4-deletions-closeout.md §4.7, F-A2.28) rewrote
    // the 0.9.2 release notes off the capitalized "Task v3" proper-noun
    // wording onto "task source v4" (the destination) / "task-v3" (the
    // retired generation, §0.1's one permitted bare "task v3" form) — this
    // pin follows the rewrite rather than the retired string.
    expect(result).toContain("task source v4");
    expect(result).toContain("TASK_SCHEMA_VERSION_UNSUPPORTED");
    expect(result).toContain("akm migrate apply --dry-run");
    expect(result).toMatch(/\[[^\]]+\]\(\.\.\/v0\.9\.1-to-v0\.9\.2\.md(?:#[^)]+)?\)/i);
  });

  test("supports latest alias when changelog text is available", () => {
    // Behavior only: `latest` resolves to the newest RELEASED (non-Unreleased)
    // section. The expectation is derived from the changelog so this never
    // re-breaks on a version bump.
    //
    // Whether that section names the version actually being shipped is a
    // property of the RELEASE, not of this renderer, and is asserted in
    // tests/integration/workflow-release.test.ts — which is
    // `run_step "Workflow Release Contract"` in tests/release-check.sh.
    const result = renderMigrationHelp("latest");
    const changelog = fs.readFileSync(path.join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");
    const latest = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)]
      .map((match) => match[1])
      .find((heading) => heading?.toLowerCase() !== "unreleased");
    expect(latest).toBeTruthy();
    expect(result).toContain(`## [${latest}]`);
  });

  test("renders the whole changelog section, not just up to the first capital Z", () => {
    // The section pattern anchored its end with `\Z`, which is not a JavaScript
    // anchor — it matches a literal "Z". The body therefore stopped at the first
    // capital Z (in the real changelog: inside `PAGE_SIZE`, ~7.1KB into a 45KB
    // section), silently dropping breaking changes, Added and Fixed. `latest`
    // resolves to the newest heading, which is precisely the version with no
    // bundled note, so it always renders through this path.
    const changelog = fs.readFileSync(path.join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");
    const latest = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)]
      .map((match) => match[1])
      .find((heading) => heading?.toLowerCase() !== "unreleased");
    const start = changelog.indexOf(`## [${latest}]`);
    const nextHeading = changelog.indexOf("\n## [", start + 1);
    const expectedBody = (nextHeading === -1 ? changelog.slice(start) : changelog.slice(start, nextHeading)).trim();

    const result = renderMigrationHelp("latest");

    // The last non-empty line of the real section must survive.
    const lastLine = expectedBody
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .at(-1);
    expect(lastLine).toBeTruthy();
    expect(result).toContain(lastLine!);
    // And a section containing a capital Z must not be cut short at it.
    const zIndex = expectedBody.search(/[A-Z]*Z/);
    if (zIndex > 0) expect(result.length).toBeGreaterThan(zIndex + 1);
  });

  test("renders the final changelog entry, which has no following heading", () => {
    // With `\Z` the end-of-input alternative never matched, so the LAST entry in
    // the changelog returned undefined and fell through to the generic message.
    const changelog = fs.readFileSync(path.join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");
    const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]!);
    const oldest = headings.at(-1);
    expect(oldest).toBeTruthy();
    const result = renderMigrationHelp(oldest!, undefined);
    expect(result).toContain(`## [${oldest}]`);
    expect(result).not.toContain("No dedicated migration note");
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
    // VALUE-07: the previous version of this test reimplemented the
    // path-resolution logic under test and got it wrong — it resolved only
    // ONE directory level up from a flat `<pkg>/dist`, so it could never
    // fail even if production's traversal broke. Production's
    // `releaseNotesDir()` (src/commands/sources/migration-help.ts) computes
    // `path.resolve(getDirname(import.meta.url), "../../../docs/migration/release-notes")`
    // — THREE levels up — because `tsc` (see package.json "build") mirrors
    // `src/` into `dist/` 1:1, so the compiled module really lives three
    // levels deep at `<pkg>/dist/commands/sources/migration-help.js`.
    //
    // This rewrite extracts the literal traversal string straight out of the
    // production source (so it can't silently drift from what production
    // actually does) and applies it at a module directory that mirrors the
    // REAL `dist/commands/sources` nesting (a structural fact independent of
    // that literal). If production's traversal depth ever stops matching the
    // real src/dist nesting, `resolved` points at a directory that doesn't
    // exist in this fixture and the test fails.
    const migrationHelpSrcPath = path.join(PROJECT_ROOT, "src", "commands", "sources", "migration-help.ts");
    const migrationHelpSrc = fs.readFileSync(migrationHelpSrcPath, "utf8");
    const traversalMatch = migrationHelpSrc.match(/path\.resolve\(getDirname\(import\.meta\.url\),\s*"([^"]+)"\)/);
    expect(traversalMatch, "releaseNotesDir()'s path.resolve(...) call shape changed").not.toBeNull();
    const traversal = traversalMatch![1]!;

    const tempPkg = fs.mkdtempSync(path.join(os.tmpdir(), "akm-pkg-layout-"));
    try {
      // `tsc` preserves the src/ directory structure, so the compiled module
      // for src/commands/sources/migration-help.ts lands at this same depth.
      const moduleDir = path.join(tempPkg, "dist", "commands", "sources");
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.mkdirSync(path.join(tempPkg, "docs", "migration", "release-notes"), { recursive: true });
      const notePath = path.join(tempPkg, "docs", "migration", "release-notes", "0.6.0.md");
      fs.writeFileSync(notePath, "Migration notes for akm v0.6.0\n- stub body for test\n", "utf8");

      const resolved = path.resolve(moduleDir, traversal, "0.6.0.md");
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
