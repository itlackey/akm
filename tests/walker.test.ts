import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkStash, walkStashFlat } from "../src/walker";

const createdTmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-walker-"));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("walkStash", () => {
  test("returns empty array for non-existent directory", () => {
    expect(walkStash("/nonexistent/path", "script")).toEqual([]);
  });

  test("returns empty array for empty directory", () => {
    const dir = tmpDir();
    expect(walkStash(dir, "script")).toEqual([]);
  });

  test("groups script files by parent directory", () => {
    const root = tmpDir();
    writeFile(path.join(root, "docker", "build.sh"), "echo build\n");
    writeFile(path.join(root, "docker", "compose.sh"), "echo compose\n");
    writeFile(path.join(root, "git", "diff.ts"), "console.log('diff')\n");

    const groups = walkStash(root, "script");
    expect(groups).toHaveLength(2);

    const dockerGroup = groups.find((g) => g.dirPath.endsWith("docker"));
    const gitGroup = groups.find((g) => g.dirPath.endsWith("git"));

    expect(dockerGroup).toBeDefined();
    expect(dockerGroup?.files).toHaveLength(2);
    expect(gitGroup).toBeDefined();
    expect(gitGroup?.files).toHaveLength(1);
  });

  test("skips .stash.json files", () => {
    const root = tmpDir();
    writeFile(path.join(root, "group", "run.sh"), "echo hi\n");
    writeFile(path.join(root, "group", ".stash.json"), '{"entries":[]}');

    const groups = walkStash(root, "script");
    expect(groups).toHaveLength(1);
    const files = groups[0].files;
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("run.sh");
  });

  test("only includes relevant files for script type", () => {
    const root = tmpDir();
    writeFile(path.join(root, "group", "run.sh"), "echo hi\n");
    writeFile(path.join(root, "group", "README.md"), "ignore\n");
    writeFile(path.join(root, "group", "data.json"), "{}");

    const groups = walkStash(root, "script");
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(1);
  });

  test("only includes SKILL.md for skill type", () => {
    const root = tmpDir();
    writeFile(path.join(root, "review", "SKILL.md"), "# Review\n");
    writeFile(path.join(root, "review", "README.md"), "ignore\n");
    writeFile(path.join(root, "refactor", "SKILL.md"), "# Refactor\n");

    const groups = walkStash(root, "skill");
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.files).toHaveLength(1);
      expect(group.files[0]).toContain("SKILL.md");
    }
  });

  test("only includes .md for command type", () => {
    const root = tmpDir();
    writeFile(path.join(root, "release.md"), "release\n");
    writeFile(path.join(root, "setup.sh"), "echo setup\n");

    const groups = walkStash(root, "command");
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(1);
    expect(groups[0].files[0]).toContain("release.md");
  });

  test("walks nested directories", () => {
    const root = tmpDir();
    writeFile(path.join(root, "a", "b", "c", "deep.sh"), "echo deep\n");

    const groups = walkStash(root, "script");
    expect(groups).toHaveLength(1);
    expect(groups[0].files[0]).toContain("deep.sh");
  });

  test("includes files from root level", () => {
    const root = tmpDir();
    writeFile(path.join(root, "deploy.sh"), "echo deploy\n");

    const groups = walkStash(root, "script");
    expect(groups).toHaveLength(1);
    expect(groups[0].dirPath).toBe(root);
  });

  test("handles knowledge type (.md files)", () => {
    const root = tmpDir();
    writeFile(path.join(root, "guide.md"), "# Guide\n");
    writeFile(path.join(root, "reference.md"), "# Reference\n");
    writeFile(path.join(root, "data.json"), "{}");

    const groups = walkStash(root, "knowledge");
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(2);
  });
});

describe("walkStashFlat", () => {
  test("returns FileContext objects (not plain paths)", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "build.sh"), "echo build\n");

    const results = walkStashFlat(root);
    expect(results).toHaveLength(1);

    const ctx = results[0];
    expect(typeof ctx.absPath).toBe("string");
    expect(typeof ctx.relPath).toBe("string");
    expect(typeof ctx.ext).toBe("string");
    expect(typeof ctx.fileName).toBe("string");
    expect(typeof ctx.stashRoot).toBe("string");
    expect(typeof ctx.content).toBe("function");
    expect(typeof ctx.frontmatter).toBe("function");
    expect(typeof ctx.stat).toBe("function");
  });

  test("walks across all asset type directories", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "build.sh"), "echo build\n");
    writeFile(path.join(root, "agents", "helper.md"), "# Helper\n");
    writeFile(path.join(root, "knowledge", "guide.md"), "# Guide\n");
    writeFile(path.join(root, "scripts", "deploy.py"), "print('deploy')\n");

    const results = walkStashFlat(root);
    expect(results).toHaveLength(4);

    const fileNames = results.map((r) => r.fileName).sort();
    expect(fileNames).toEqual(["build.sh", "deploy.py", "guide.md", "helper.md"]);
  });

  test("does not filter by asset type", () => {
    const root = tmpDir();
    writeFile(path.join(root, "data.json"), '{"key":"value"}');
    writeFile(path.join(root, "script.py"), "print('hi')\n");

    const results = walkStashFlat(root);
    expect(results).toHaveLength(2);

    const fileNames = results.map((r) => r.fileName).sort();
    expect(fileNames).toEqual(["data.json", "script.py"]);
  });

  test("skips directories starting with dot", () => {
    const root = tmpDir();
    writeFile(path.join(root, ".hidden", "file.txt"), "secret\n");
    writeFile(path.join(root, "visible", "file.txt"), "public\n");

    const results = walkStashFlat(root);
    expect(results).toHaveLength(1);
    expect(results[0].fileName).toBe("file.txt");
    expect(results[0].absPath).toContain("visible");
  });

  test("preserves stashRoot on all FileContext results", () => {
    const root = tmpDir();
    writeFile(path.join(root, "a", "one.sh"), "echo one\n");
    writeFile(path.join(root, "b", "two.md"), "# Two\n");
    writeFile(path.join(root, "c", "three.py"), "print(3)\n");

    const results = walkStashFlat(root);
    expect(results).toHaveLength(3);

    for (const ctx of results) {
      expect(ctx.stashRoot).toBe(root);
    }
  });

  test("git walk stays scoped to the stash root subtree", () => {
    const repoRoot = tmpDir();
    const stashRoot = path.join(repoRoot, "stash");

    writeFile(path.join(repoRoot, "outside.txt"), "outside\n");
    writeFile(path.join(stashRoot, "scripts", "build.sh"), "echo build\n");

    const gitInit = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
    expect(gitInit.status).toBe(0);

    const results = walkStashFlat(stashRoot);

    expect(results).toHaveLength(1);
    expect(results[0]?.relPath).toBe("scripts/build.sh");
    expect(results[0]?.absPath.startsWith(stashRoot)).toBe(true);
  });
});

// ── T6: isInsideGitRepo in nested repo ───────────────────────────────────────
//
// Gap: isInsideGitRepo() walks up the directory tree looking for .git. In a
// nested git repo (e.g. a stash directory inside a monorepo worktree), it
// should find the nearest .git — but creating nested repos in CI is fragile
// and platform-dependent, so this gap is intentionally left untested here.
// If regression is suspected, test manually by creating a nested git init
// inside an existing repo and verifying walkStashFlat still uses the git walker.

// ── R4.3: symlink escape ─────────────────────────────────────────────────────
//
// walkStashFlat (manual fallback) must skip symlinks that point outside the
// stash root so that malicious or accidental symlinks cannot leak files from
// the host filesystem into search results.

describe("walkStashFlat — symlink escape", () => {
  // Track extra files created outside tmpDir() so we can clean them up.
  const extraFiles: string[] = [];

  afterEach(() => {
    for (const f of extraFiles.splice(0)) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  test("symlink pointing outside stash root is NOT included in results", () => {
    // Create a stash root that is NOT inside a git repo so the manual walker
    // is used (the git walker relies on git ls-files which won't list a
    // symlink that targets an untracked file outside the repo).
    const stashRoot = tmpDir();
    const skillsDir = path.join(stashRoot, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create a real file OUTSIDE the stash root
    const outsideFile = path.join(os.tmpdir(), `akm-symlink-target-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(outsideFile, "# Secret content outside stash\n");
    extraFiles.push(outsideFile);

    // Create a symlink inside the stash that points to the outside file
    const symlinkPath = path.join(skillsDir, "escaped.md");
    fs.symlinkSync(outsideFile, symlinkPath);

    // Also create a legitimate file so we can confirm the walker still works
    writeFile(path.join(skillsDir, "legitimate.md"), "# Legit\n");

    const results = walkStashFlat(stashRoot);

    const resultPaths = results.map((r) => r.absPath);

    // The symlink must NOT appear in results
    expect(resultPaths).not.toContain(symlinkPath);

    // Confirm the outside target is also not reached through the symlink
    expect(resultPaths).not.toContain(outsideFile);

    // The legitimate file should still be found
    expect(resultPaths.some((p) => p.endsWith("legitimate.md"))).toBe(true);

    // Cleanup the symlink (tmpDir cleanup handles the rest)
    fs.rmSync(symlinkPath, { force: true });
  });

  test("symlink pointing to a directory outside stash root is also skipped", () => {
    const stashRoot = tmpDir();
    const knowledgeDir = path.join(stashRoot, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });

    // Create a directory OUTSIDE the stash with a file inside
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-symlink-dir-target-"));
    extraFiles.push(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "# Outside dir secret\n");

    // Symlink the outside directory into the stash
    const symlinkDir = path.join(knowledgeDir, "escaped-dir");
    fs.symlinkSync(outsideDir, symlinkDir);

    // Create a legitimate file to confirm walker still functions
    writeFile(path.join(knowledgeDir, "real.md"), "# Real\n");

    const results = walkStashFlat(stashRoot);
    const resultPaths = results.map((r) => r.absPath);

    // No file from inside the outside dir must appear
    expect(resultPaths.some((p) => p.startsWith(outsideDir))).toBe(false);

    // The legitimate file should still be found
    expect(resultPaths.some((p) => p.endsWith("real.md"))).toBe(true);

    // Cleanup the symlink
    fs.rmSync(symlinkDir, { force: true });
  });
});
