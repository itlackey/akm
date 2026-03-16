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
  test("returns real path for valid script", async () => {
    const stashDir = createTmpDir();
    const scriptPath = path.join(stashDir, "scripts", "deploy.sh");
    writeFile(scriptPath, "#!/bin/sh\necho hello");

    const result = await resolveAssetPath(stashDir, "script", "deploy.sh");
    expect(result).toBe(fs.realpathSync(scriptPath));
  });

  test("throws for missing type root", async () => {
    const stashDir = createTmpDir();
    // No scripts/ directory created

    await expect(resolveAssetPath(stashDir, "script", "deploy.sh")).rejects.toThrow(
      "Stash type root not found for ref: script:deploy.sh",
    );
  });

  test("throws for missing file", async () => {
    const stashDir = createTmpDir();
    fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });

    await expect(resolveAssetPath(stashDir, "script", "nonexistent.sh")).rejects.toThrow(
      "Stash asset not found for ref: script:nonexistent.sh",
    );
  });

  test("throws for path traversal", async () => {
    const stashDir = createTmpDir();
    fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });
    // Create a file outside the scripts root
    writeFile(path.join(stashDir, "outside.sh"), "#!/bin/sh\necho escape");

    await expect(resolveAssetPath(stashDir, "script", "../outside.sh")).rejects.toThrow(
      "Ref resolves outside the stash root.",
    );
  });

  test("throws for symlink escape", async () => {
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

    await expect(resolveAssetPath(stashDir, "script", "link.sh")).rejects.toThrow(
      "Ref resolves outside the stash root.",
    );
  });

  test("validates script extension", async () => {
    const stashDir = createTmpDir();
    const badFile = path.join(stashDir, "scripts", "readme.txt");
    writeFile(badFile, "not a script");

    await expect(resolveAssetPath(stashDir, "script", "readme.txt")).rejects.toThrow(
      "Script ref must resolve to a file with a supported script extension",
    );
  });

  test("resolves broader script extensions (e.g. .py)", async () => {
    const stashDir = createTmpDir();
    const scriptPath = path.join(stashDir, "scripts", "analyze.py");
    writeFile(scriptPath, "print('hello')");

    const result = await resolveAssetPath(stashDir, "script", "analyze.py");
    expect(result).toBe(fs.realpathSync(scriptPath));
  });

  test("resolves skill by directory", async () => {
    const stashDir = createTmpDir();
    const skillFile = path.join(stashDir, "skills", "ops", "SKILL.md");
    writeFile(skillFile, "# Ops Skill");

    const result = await resolveAssetPath(stashDir, "skill", "ops");
    expect(result).toBe(fs.realpathSync(skillFile));
  });

  test("resolves installed-kit style nested agent refs outside top-level agents root", async () => {
    const stashDir = createTmpDir();
    const agentFile = path.join(stashDir, "tools", "agents", "svelte-file-editor.md");
    writeFile(agentFile, "---\nname: svelte-file-editor\n---\nUse Svelte tools.\n");

    const result = await resolveAssetPath(stashDir, "agent", "tools/agents/svelte-file-editor");
    expect(result).toBe(fs.realpathSync(agentFile));
  });

  test("resolves installed-kit style nested skill refs outside top-level skills root", async () => {
    const stashDir = createTmpDir();
    const skillFile = path.join(stashDir, "tools", "skills", "svelte-code-writer", "SKILL.md");
    writeFile(skillFile, "# Svelte code writer\n");

    const result = await resolveAssetPath(stashDir, "skill", "tools/skills/svelte-code-writer");
    expect(result).toBe(fs.realpathSync(skillFile));
  });
});
