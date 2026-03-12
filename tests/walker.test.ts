import { afterAll, describe, expect, test } from "bun:test";
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
