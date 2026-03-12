import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAssetPath } from "../src/stash-resolve";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-resolve-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveAssetPath ──────────────────────────────────────────────────────────

describe("resolveAssetPath", () => {
  test("returns real path for valid script", () => {
    const stashDir = createTmpDir();
    const scriptPath = path.join(stashDir, "scripts", "deploy.sh");
    writeFile(scriptPath, "#!/bin/sh\necho hello");

    const result = resolveAssetPath(stashDir, "script", "deploy.sh");
    expect(result).toBe(fs.realpathSync(scriptPath));
  });

  test("throws for missing type root", () => {
    const stashDir = createTmpDir();
    // No scripts/ directory created

    expect(() => resolveAssetPath(stashDir, "script", "deploy.sh")).toThrow(
      "Stash type root not found for ref: script:deploy.sh",
    );
  });

  test("throws for missing file", () => {
    const stashDir = createTmpDir();
    fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });

    expect(() => resolveAssetPath(stashDir, "script", "nonexistent.sh")).toThrow(
      "Stash asset not found for ref: script:nonexistent.sh",
    );
  });

  test("throws for path traversal", () => {
    const stashDir = createTmpDir();
    fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });
    // Create a file outside the scripts root
    writeFile(path.join(stashDir, "outside.sh"), "#!/bin/sh\necho escape");

    expect(() => resolveAssetPath(stashDir, "script", "../outside.sh")).toThrow("Ref resolves outside the stash root.");
  });

  test("throws for symlink escape", () => {
    const stashDir = createTmpDir();
    const scriptsDir = path.join(stashDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Create a file outside the stash entirely
    const outsideDir = createTmpDir("akm-outside-");
    const outsideFile = path.join(outsideDir, "escaped.sh");
    writeFile(outsideFile, "#!/bin/sh\necho escaped");

    const symlinkPath = path.join(scriptsDir, "link.sh");
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
    } catch {
      // Symlinks may not be supported on all environments; skip gracefully
      return;
    }

    expect(() => resolveAssetPath(stashDir, "script", "link.sh")).toThrow("Ref resolves outside the stash root.");
  });

  test("validates script extension", () => {
    const stashDir = createTmpDir();
    const badFile = path.join(stashDir, "scripts", "readme.txt");
    writeFile(badFile, "not a script");

    expect(() => resolveAssetPath(stashDir, "script", "readme.txt")).toThrow(
      "Script ref must resolve to a file with a supported script extension",
    );
  });

  test("resolves broader script extensions (e.g. .py)", () => {
    const stashDir = createTmpDir();
    const scriptPath = path.join(stashDir, "scripts", "analyze.py");
    writeFile(scriptPath, "print('hello')");

    const result = resolveAssetPath(stashDir, "script", "analyze.py");
    expect(result).toBe(fs.realpathSync(scriptPath));
  });

  test("resolves skill by directory", () => {
    const stashDir = createTmpDir();
    const skillFile = path.join(stashDir, "skills", "ops", "SKILL.md");
    writeFile(skillFile, "# Ops Skill");

    const result = resolveAssetPath(stashDir, "skill", "ops");
    expect(result).toBe(fs.realpathSync(skillFile));
  });
});
