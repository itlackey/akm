// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression suite for the auto-sync staging behaviour (#476 + the auto-sync
// incident where stray non-akm files in the stash root refused EVERY commit
// for ~1.5 days). `saveGitStash` no longer refuses when unrelated non-akm
// files are dirty; instead it SCOPES what it stages:
//   1. explicit `options.paths` → exactly those
//   2. fallback → akm-managed pathspecs (TYPE_DIRS + `.akm`) that exist
//   3. no managed pathspec → no commit (never broad-stage unrelated files)
// The non-akm files must be left untouched/uncommitted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { commitWriteTargetBoundary, writeAssetToSource } from "../../src/core/write-source";
import { parseAssetRef } from "../../src/migrate/legacy-ref-grammar";
import { saveGitStash } from "../../src/sources/providers/git";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "test@akm.local"],
    ["config", "user.name", "akm-test"],
    ["config", "commit.gpgsign", "false"],
  ] as string[][]) {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/** Files (relative paths) touched by the most recent commit on HEAD. */
function committedFiles(repoDir: string): string[] {
  const out = spawnSync("git", ["-C", repoDir, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Porcelain status lines (still-dirty working-tree paths). */
function status(repoDir: string): string {
  return spawnSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" }).stdout;
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

describe("saveGitStash — scoped staging (auto-sync incident regression)", () => {
  test("content-layout boundary commits only content and leaves repository-root WIP dirty", () => {
    const repoDir = process.env.AKM_STASH_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(contentDir, "memories", "asset.md"), "asset\n");
    writeFile(path.join(repoDir, "src", "work-in-progress.ts"), "unrelated WIP\n");

    commitWriteTargetBoundary(
      {
        source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir },
        config: { type: "git", name: "team", url: "https://example.com/team/stash.git", writable: true },
      },
      "content only",
      { push: false, paths: ["content/memories/asset.md"] },
    );

    expect(committedFiles(repoDir)).toEqual(["content/memories/asset.md"]);
    expect(status(repoDir)).toContain("src/");
  });

  test("content-layout boundary does not commit unrelated pre-staged WIP", () => {
    const repoDir = process.env.AKM_STASH_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(repoDir, "src", "staged-wip.ts"), "pre-staged WIP\n");
    const stageWip = spawnSync("git", ["-C", repoDir, "add", "--", "src/staged-wip.ts"], { encoding: "utf8" });
    expect(stageWip.status).toBe(0);
    writeFile(path.join(contentDir, "memories", "asset.md"), "asset\n");

    commitWriteTargetBoundary(
      {
        source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir },
        config: { type: "git", name: "team", url: "https://example.com/team/stash.git", writable: true },
      },
      "content only",
      { push: false, paths: ["content/memories/asset.md"] },
    );

    expect(committedFiles(repoDir)).toEqual(["content/memories/asset.md"]);
    expect(status(repoDir)).toContain("A  src/staged-wip.ts");
  });

  test("write boundary excludes pre-staged WIP inside the same content asset directory", async () => {
    const repoDir = process.env.AKM_STASH_DIR as string;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(contentDir, "memories", "staged-wip.md"), "pre-staged content WIP\n");
    expect(
      spawnSync("git", ["-C", repoDir, "add", "--", "content/memories/staged-wip.md"], { encoding: "utf8" }).status,
    ).toBe(0);
    const target = {
      source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir },
      config: { type: "git" as const, name: "team", url: "https://example.com/team/stash.git", writable: true },
    };

    await writeAssetToSource(
      target.source,
      target.config,
      parseAssetRef("memory:operation-owned"),
      "---\ndescription: Operation-owned memory\n---\n\nAsset body.\n",
    );
    commitWriteTargetBoundary(target, "exact operation paths", { push: false });

    expect(committedFiles(repoDir)).toEqual(["content/memories/operation-owned.md"]);
    expect(status(repoDir)).toContain("A  content/memories/staged-wip.md");
  });

  test("commits akm-managed files and leaves unrelated non-akm files dirty/untouched", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);

    // akm-managed dirty files.
    writeFile(path.join(stashDir, "memories", "x.md"), "memory x\n");
    writeFile(path.join(stashDir, "knowledge", "y.md"), "knowledge y\n");
    // Unrelated non-akm files (the exact shapes that caused the incident).
    writeFile(path.join(stashDir, "data.js"), "window.data = {};\n");
    writeFile(path.join(stashDir, "akm-health-report.html"), "<html></html>\n");
    writeFile(path.join(stashDir, "reports", "summary.txt"), "report\n");
    writeFile(path.join(stashDir, "tasks.bak-123", "z"), "backup\n");

    const result = saveGitStash(undefined, "scoped commit");
    expect(result.committed).toBe(true);
    expect(result.skipped).toBe(false);

    // The commit contains ONLY managed paths.
    const files = committedFiles(stashDir);
    expect(files).toContain("memories/x.md");
    expect(files).toContain("knowledge/y.md");
    expect(files.some((f) => f.startsWith("data.js"))).toBe(false);
    expect(files.some((f) => f.startsWith("akm-health-report.html"))).toBe(false);
    expect(files.some((f) => f.startsWith("reports/"))).toBe(false);
    expect(files.some((f) => f.startsWith("tasks.bak-123/"))).toBe(false);

    // The non-akm files are STILL dirty afterward (untouched). Untracked
    // directories are collapsed to "<dir>/" by git porcelain.
    const after = status(stashDir);
    expect(after).toContain("data.js");
    expect(after).toContain("akm-health-report.html");
    expect(after).toContain("reports/");
    expect(after).toContain("tasks.bak-123/");
  });

  test("does NOT throw the old 'refusing to push' error when non-akm files are present", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "facts", "a.md"), "fact a\n");
    writeFile(path.join(stashDir, "scratch.tmp"), "stray\n");

    let threw: unknown;
    try {
      saveGitStash(undefined, "no refuse");
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeUndefined();
  });

  test("explicit options.paths stages only the listed subset", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "memories", "keep.md"), "keep\n");
    writeFile(path.join(stashDir, "memories", "skip.md"), "skip\n");
    writeFile(path.join(stashDir, "lessons", "also-skip.md"), "skip\n");

    const result = saveGitStash(undefined, "subset", undefined, { paths: ["memories/keep.md"] });
    expect(result.committed).toBe(true);

    const files = committedFiles(stashDir);
    expect(files).toEqual(["memories/keep.md"]);

    const after = status(stashDir);
    expect(after).toContain("memories/skip.md");
    // lessons/ is entirely untracked → porcelain collapses it to "lessons/".
    expect(after).toContain("lessons/");
  });

  test("only non-akm files dirty → nothing committed, no commit created, no throw", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);
    // Seed an initial commit so HEAD exists, then add only non-akm dirt.
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    saveGitStash(undefined, "seed");
    const headBefore = spawnSync("git", ["-C", stashDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

    writeFile(path.join(stashDir, "data.js"), "only non-akm\n");
    writeFile(path.join(stashDir, "tasks.bak-9", "z"), "backup\n");

    const result = saveGitStash(undefined, "should not commit");
    expect(result.committed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.output).toBe("nothing to commit");

    // No new commit was created.
    const headAfter = spawnSync("git", ["-C", stashDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(headAfter).toBe(headBefore);

    // Non-akm files still dirty.
    const after = status(stashDir);
    expect(after).toContain("data.js");
    // tasks.bak-9/ is entirely untracked → porcelain collapses it.
    expect(after).toContain("tasks.bak-9/");
  });

  test("clean tree → nothing to commit, working tree clean", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "facts", "seed.md"), "seed\n");
    saveGitStash(undefined, "seed");

    const result = saveGitStash(undefined, "nothing left");
    expect(result.committed).toBe(false);
    expect(result.output).toBe("nothing to commit, working tree clean");
  });

  test("committed change pushes when a remote is configured and stash is writable", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    // Bare remote to push into.
    const remoteDir = `${stashDir}-remote.git`;
    spawnSync("git", ["init", "--bare", "--initial-branch=main", remoteDir], { encoding: "utf8" });

    initRepo(stashDir);
    spawnSync("git", ["-C", stashDir, "remote", "add", "origin", remoteDir], { encoding: "utf8" });
    // Seed an initial commit and set the branch upstream so `git push` (no args)
    // resolves a target — mirrors a cloned writable stash's tracking config.
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    spawnSync("git", ["-C", stashDir, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", stashDir, "-c", "user.name=akm", "-c", "user.email=akm@local", "commit", "-m", "seed"], {
      encoding: "utf8",
    });
    spawnSync("git", ["-C", stashDir, "push", "-u", "origin", "main"], { encoding: "utf8" });

    writeFile(path.join(stashDir, "memories", "pushed.md"), "pushed\n");
    // Stray non-akm file must NOT block the push.
    writeFile(path.join(stashDir, "data.js"), "stray\n");

    const result = saveGitStash(undefined, "push it", /* writableOverride */ true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);

    // The remote received exactly the managed file.
    const remoteFiles = spawnSync("git", ["-C", remoteDir, "show", "--name-only", "--format=", "HEAD"], {
      encoding: "utf8",
    }).stdout;
    expect(remoteFiles).toContain("memories/pushed.md");
    expect(remoteFiles).not.toContain("data.js");

    fs.rmSync(remoteDir, { recursive: true, force: true });
  });
});
