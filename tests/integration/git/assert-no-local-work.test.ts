import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoLocalWork } from "../../../src/sources/providers/git-install";

const tmpDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clean-worktree-"));
  tmpDirs.push(dir);
  const run = (args: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  run(["init", "-q"]);
  fs.writeFileSync(path.join(dir, "tracked.md"), "a\n");
  run(["add", "."]);
  run(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
  return dir;
}

function message(dir: string): string {
  try {
    assertNoLocalWork(dir, "Subject", false);
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function commit(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), "x\n");
  spawnSync("git", ["-C", dir, "add", "."]);
  spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", `add ${name}`]);
}

describe("assertNoLocalWork", () => {
  test("names commits that are not on the upstream, and not a pushed one", () => {
    const origin = makeRepo();
    const clone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "akm-nlw-")), "c");
    tmpDirs.push(path.dirname(clone));
    spawnSync("git", ["clone", "-q", origin, clone]);
    expect(() => assertNoLocalWork(clone, "Subject")).not.toThrow();
    commit(clone, "mine.md");
    let error: Error | undefined;
    try {
      assertNoLocalWork(clone, "Subject");
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain("commits not on origin/");
    expect(error?.message).toContain("add mine.md");
    expect((error as { code?: string }).code).toBe("SOURCE_HAS_LOCAL_WORK");
    // A fast-forward keeps commits, so the commit check can be skipped.
    expect(() => assertNoLocalWork(clone, "Subject", false)).not.toThrow();
  });

  test("passes on a clean repo", () => {
    expect(message(makeRepo())).toBe("");
  });

  test("names a modified tracked file", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "tracked.md"), "b\n");
    expect(message(dir)).toContain("Subject holds local work that would be lost; it has uncommitted changes: tracked.md.");
  });

  test("names an untracked file and caps the list", () => {
    const dir = makeRepo();
    for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `new-${i}.md`), "x\n");
    const msg = message(dir);
    expect(msg).toContain("new-0.md");
    expect(msg).toContain("(and 2 more)");
    expect(msg).not.toContain("new-6.md");
  });

  test("reports a git failure instead of uncommitted changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-not-a-repo-"));
    tmpDirs.push(dir);
    const msg = message(dir);
    expect(msg).toContain("git status failed");
    expect(msg).not.toContain("uncommitted changes");
  });

  test("prints non-ASCII names as UTF-8", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "café.md"), "x\n");
    expect(message(dir)).toContain("uncommitted changes: café.md");
  });

  test("reports a missing git binary", () => {
    const dir = makeRepo();
    const script = `import { assertNoLocalWork } from ${JSON.stringify(path.resolve("src/sources/providers/git-install.ts"))};
try { assertNoLocalWork(process.argv[1], "S", false); } catch (e) { console.log(e.message); }`;
    const result = spawnSync(process.execPath, ["-e", script, dir], {
      encoding: "utf8",
      env: { PATH: path.join(os.tmpdir(), "akm-no-such-bin") },
    });
    expect(result.stdout).toContain("git status failed");
    expect(result.stdout).not.toContain("exit undefined");
  });
});
