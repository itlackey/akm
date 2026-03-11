import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAssetPath } from "../src/stash-resolve";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "agentikit-resolve-"): string {
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
  test("returns real path for valid tool", () => {
    const stashDir = createTmpDir();
    const toolPath = path.join(stashDir, "tools", "deploy.sh");
    writeFile(toolPath, "#!/bin/sh\necho hello");

    const result = resolveAssetPath(stashDir, "tool", "deploy.sh");
    expect(result).toBe(fs.realpathSync(toolPath));
  });

  test("throws for missing type root", () => {
    const stashDir = createTmpDir();
    // No tools/ directory created

    expect(() => resolveAssetPath(stashDir, "tool", "deploy.sh")).toThrow(
      "Stash type root not found for ref: script:deploy.sh",
    );
  });

  test("throws for missing file", () => {
    const stashDir = createTmpDir();
    fs.mkdirSync(path.join(stashDir, "tools"), { recursive: true });
    fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });

    expect(() => resolveAssetPath(stashDir, "tool", "nonexistent.sh")).toThrow(
      "Stash asset not found for ref: script:nonexistent.sh",
    );
  });

  test("throws for path traversal", () => {
    const stashDir = createTmpDir();
    fs.mkdirSync(path.join(stashDir, "tools"), { recursive: true });
    // Create a file outside the tools root
    writeFile(path.join(stashDir, "outside.sh"), "#!/bin/sh\necho escape");

    expect(() => resolveAssetPath(stashDir, "tool", "../outside.sh")).toThrow("Ref resolves outside the stash root.");
  });

  test("throws for symlink escape", () => {
    const stashDir = createTmpDir();
    const toolsDir = path.join(stashDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    // Create a file outside the stash entirely
    const outsideDir = createTmpDir("agentikit-outside-");
    const outsideFile = path.join(outsideDir, "escaped.sh");
    writeFile(outsideFile, "#!/bin/sh\necho escaped");

    const symlinkPath = path.join(toolsDir, "link.sh");
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
    } catch {
      // Symlinks may not be supported on all environments; skip gracefully
      return;
    }

    expect(() => resolveAssetPath(stashDir, "tool", "link.sh")).toThrow("Ref resolves outside the stash root.");
  });

  test("validates tool extension (tool is alias for script)", () => {
    const stashDir = createTmpDir();
    const badFile = path.join(stashDir, "tools", "readme.txt");
    writeFile(badFile, "not a script");

    expect(() => resolveAssetPath(stashDir, "tool", "readme.txt")).toThrow(
      "Script ref must resolve to a file with a supported script extension",
    );
  });

  test("validates script extension", () => {
    const stashDir = createTmpDir();
    const badFile = path.join(stashDir, "scripts", "data.xyz");
    writeFile(badFile, "not a script");

    expect(() => resolveAssetPath(stashDir, "script", "data.xyz")).toThrow(
      "Script ref must resolve to a file with a supported script extension",
    );
  });

  test("script: resolves files from tools/ directory as fallback", () => {
    const stashDir = createTmpDir();
    const toolPath = path.join(stashDir, "tools", "deploy.sh");
    writeFile(toolPath, "#!/bin/sh\necho hello");

    // script: should find files in tools/ when scripts/ doesn't have them
    const result = resolveAssetPath(stashDir, "script", "deploy.sh");
    expect(result).toBe(fs.realpathSync(toolPath));
  });

  test("tool: resolves files from scripts/ directory as fallback", () => {
    const stashDir = createTmpDir();
    const scriptPath = path.join(stashDir, "scripts", "analyze.py");
    writeFile(scriptPath, "print('hello')");

    // tool: should find files in scripts/ when tools/ doesn't have them
    const result = resolveAssetPath(stashDir, "tool", "analyze.py");
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
