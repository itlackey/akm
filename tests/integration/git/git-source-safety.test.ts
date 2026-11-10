// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Git write safety at the source boundary (real repositories, spawnSync git):
//
//   - `saveGitStash` SCOPES what it stages instead of refusing (#476, #1502):
//     explicit `options.paths` → exactly those; otherwise every unignored change
//     inside the bundle (a nested content root stays contained). Ignored paths
//     are left untouched/uncommitted.
//   - `commitWriteTargetBoundary` commits exactly the operation's paths (also
//     under a content/ layout, also next to pre-staged user WIP), keeps
//     ignored paths local with a warning, and when the lease-guarded push is
//     rejected leaves the commit local and names it.
//   - `prepareWriteTargetForMutation` refuses a detached checkout before
//     anything is written.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parsePlacementRef } from "../../../src/core/asset/resolve-ref";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { saveGitStash } from "../../../src/sources/providers/git";
import {
  commitWriteTargetBoundary,
  prepareWriteTargetForMutation,
  writeAssetToSource,
} from "../../../src/sources/write-source";
import { seedLockEntries } from "../../_helpers/lockfile";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

function configureRepo(dir: string): void {
  for (const args of [
    ["config", "user.email", "test@akm.local"],
    ["config", "user.name", "akm-test"],
    ["config", "commit.gpgsign", "false"],
  ] as string[][]) {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync("git", ["-C", dir, "init", "--initial-branch=main"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr}`);
  configureRepo(dir);
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function git(repoDir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
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

function captureWarnings(): string[] {
  const warnings: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  return warnings;
}

let currentStashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const dataResult = sandboxXdgDataHome(cacheResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(dataResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
  currentStashDir = stashResult.dir;
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  envCleanup();
  envCleanup = () => {};
});

describe("commitWriteTargetBoundary — exact operation paths", () => {
  test("named sync commits the lock-backed managed checkout instead of a URL-derived mirror", () => {
    const repoDir = currentStashDir;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(contentDir, "memories", "seed.md"), "seed\n");
    spawnSync("git", ["-C", repoDir, "add", "."]);
    spawnSync("git", ["-C", repoDir, "commit", "-m", "seed"]);
    writeSandboxConfig({
      bundles: {
        team: {
          git: "https://example.com/team/stash.git",
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id: "team",
        source: "git",
        ref: "git+https://example.com/team/stash.git",
        localRoot: contentDir,
        installedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    writeFile(path.join(contentDir, "memories", "managed.md"), "managed\n");

    const result = saveGitStash("team", "managed sync", true, { push: false });

    expect(result.committed).toBe(true);
    expect(committedFiles(repoDir)).toEqual(["content/memories/managed.md"]);
  });

  test("content-layout boundary commits only content and leaves repository-root WIP dirty", () => {
    const repoDir = currentStashDir;
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
    const repoDir = currentStashDir;
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
    const repoDir = currentStashDir;
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
      parsePlacementRef("memories/operation-owned"),
      "---\ndescription: Operation-owned memory\n---\n\nAsset body.\n",
    );
    commitWriteTargetBoundary(target, "exact operation paths", { push: false });

    expect(committedFiles(repoDir)).toEqual(["content/memories/operation-owned.md"]);
    expect(status(repoDir)).toContain("A  content/memories/staged-wip.md");
  });

  test("an ignored destination is written locally and left out of the boundary commit, with a warning", async () => {
    const repoDir = currentStashDir;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(repoDir, ".gitignore"), "content/memories/ignored.md\n");
    git(repoDir, ["add", ".gitignore"]);
    git(repoDir, ["commit", "-m", "seed ignore"]);
    const target = {
      source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git" as const, name: "team", path: contentDir, writable: true },
    };
    const warnings = captureWarnings();

    const ignored = await writeAssetToSource(
      target.source,
      target.config,
      { type: "memory", name: "ignored" },
      "---\ndescription: Ignored memory\n---\n\nStays local.\n",
    );
    await writeAssetToSource(
      target.source,
      target.config,
      { type: "memory", name: "tracked" },
      "---\ndescription: Tracked memory\n---\n\nPublished.\n",
    );
    commitWriteTargetBoundary(target, "ignored sibling", { push: false });

    expect(fs.existsSync(ignored.path)).toBe(true);
    expect(committedFiles(repoDir)).toEqual(["content/memories/tracked.md"]);
    expect(warnings.some((w) => w.includes("content/memories/ignored.md"))).toBe(true);
  });

  test("a push the remote rejects leaves the commit local and names it", async () => {
    const repoDir = currentStashDir;
    const cacheHome = process.env.XDG_CACHE_HOME as string;
    const remoteDir = path.join(cacheHome, "lease-remote.git");
    const otherClone = path.join(cacheHome, "lease-other");
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, ["init", "--bare", "--initial-branch=main"]);
    initRepo(repoDir);
    writeFile(path.join(repoDir, "knowledge", "seed.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    git(repoDir, ["remote", "add", "origin", remoteDir]);
    git(repoDir, ["push", "-u", "origin", "main"]);
    // Advance the remote from a second checkout; the sync fetches and merges it, then the
    // remote (a pre-receive hook below) refuses the push.
    git(cacheHome, ["clone", "--quiet", remoteDir, otherClone]);
    configureRepo(otherClone);
    writeFile(path.join(otherClone, "knowledge", "elsewhere.md"), "elsewhere\n");
    git(otherClone, ["add", "."]);
    git(otherClone, ["commit", "-m", "remote advance"]);
    git(otherClone, ["push", "origin", "main"]);
    const hook = path.join(remoteDir, "hooks", "pre-receive");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\necho rejected by remote policy >&2\nexit 1\n", { mode: 0o755 });
    const target = {
      source: { kind: "git", name: "team", path: repoDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git" as const, name: "team", path: repoDir, writable: true },
    };

    await writeAssetToSource(target.source, target.config, { type: "memory", name: "local" }, "local\n");
    expect(() => commitWriteTargetBoundary(target, "local write")).toThrow(
      /committed as [0-9a-f]{40}, but publication failed/,
    );

    // The sync merged the remote's advance before the push was refused; the local commit stays.
    expect(git(repoDir, ["log", "--format=%s", "main"])).toContain("local write");
    expect(git(repoDir, ["log", "--format=%s", "main"])).toContain("remote advance");
    expect(git(remoteDir, ["log", "-1", "--format=%s", "main"])).toBe("remote advance");
  });

  test("mutation preparation rejects a detached local target before writing", () => {
    const repoDir = currentStashDir;
    const contentDir = path.join(repoDir, "content");
    initRepo(repoDir);
    writeFile(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "seed"]);
    fs.mkdirSync(contentDir, { recursive: true });
    git(repoDir, ["checkout", "--detach"]);
    const target = {
      source: { kind: "git", name: "team", path: contentDir, repoPath: repoDir, adapterId: "akm" },
      config: { type: "git" as const, name: "team", path: contentDir, writable: true },
    };

    expect(() => prepareWriteTargetForMutation(target)).toThrow(/detached from a branch/i);
    expect(fs.existsSync(path.join(contentDir, "memories"))).toBe(false);
  });
});

describe("saveGitStash — scoped staging (exact paths, bundle-wide default)", () => {
  test("an ignored path aborts a mixed exact-path commit without staging its siblings", () => {
    const repoDir = currentStashDir;
    initRepo(repoDir);
    writeFile(path.join(repoDir, ".gitignore"), "memories/ignored.md\n");
    git(repoDir, ["add", ".gitignore"]);
    git(repoDir, ["commit", "-m", "seed ignore"]);
    writeFile(path.join(repoDir, "memories", "allowed.md"), "allowed\n");
    writeFile(path.join(repoDir, "memories", "ignored.md"), "ignored\n");

    expect(() =>
      saveGitStash(undefined, "mixed paths", undefined, {
        push: false,
        paths: ["memories/allowed.md", "memories/ignored.md"],
      }),
    ).toThrow(/is ignored/);

    expect(git(repoDir, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  test("commits every unignored change in the bundle, files outside asset directories included (#1502)", () => {
    const stashDir = currentStashDir;
    initRepo(stashDir);
    writeFile(path.join(stashDir, ".gitignore"), "tasks.bak-*/\n");

    writeFile(path.join(stashDir, "memories", "x.md"), "memory x\n");
    writeFile(path.join(stashDir, "knowledge", "y.md"), "knowledge y\n");
    writeFile(path.join(stashDir, "data.js"), "window.data = {};\n");
    writeFile(path.join(stashDir, "reports", "summary.txt"), "report\n");
    writeFile(path.join(stashDir, "tasks.bak-123", "z"), "backup\n");

    const result = saveGitStash(undefined, "bundle commit");
    expect(result.committed).toBe(true);
    expect(result.skipped).toBe(false);

    expect(committedFiles(stashDir).sort()).toEqual([
      ".gitignore",
      "data.js",
      "knowledge/y.md",
      "memories/x.md",
      "reports/summary.txt",
    ]);
    // An ignored path stays out and stays local.
    expect(status(stashDir)).toBe("");
  });

  test("does NOT throw the old 'refusing to push' error when non-akm files are present", () => {
    const stashDir = currentStashDir;
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
    const stashDir = currentStashDir;
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

  test("commit-tree bypasses user commit hooks", () => {
    const stashDir = currentStashDir;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    git(stashDir, ["add", "."]);
    git(stashDir, ["commit", "-m", "seed"]);
    const hook = path.join(stashDir, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(hook, 0o755);
    writeFile(path.join(stashDir, "memories", "hook-safe.md"), "hook-safe\n");

    const result = saveGitStash(undefined, "hook-safe commit", undefined, {
      push: false,
      paths: ["memories/hook-safe.md"],
    });

    expect(result.committed).toBe(true);
    expect(committedFiles(stashDir)).toEqual(["memories/hook-safe.md"]);
  });

  test("a change outside the asset directories is committed, not reported as nothing to commit (#1502)", () => {
    const stashDir = currentStashDir;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    writeFile(path.join(stashDir, "README.md"), "v1\n");
    saveGitStash(undefined, "seed");

    writeFile(path.join(stashDir, "README.md"), "v2\n");

    const result = saveGitStash(undefined, "readme edit");
    expect(result.committed).toBe(true);
    expect(committedFiles(stashDir)).toEqual(["README.md"]);
    expect(status(stashDir)).toBe("");
  });

  test("clean tree → nothing to commit, working tree clean", () => {
    const stashDir = currentStashDir;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "facts", "seed.md"), "seed\n");
    saveGitStash(undefined, "seed");

    const result = saveGitStash(undefined, "nothing left");
    expect(result.committed).toBe(false);
    expect(result.output).toBe("nothing to commit, working tree clean");
  });

  test("committed change pushes when a remote is configured and stash is writable", () => {
    const stashDir = currentStashDir;
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
    writeFile(path.join(stashDir, "data.js"), "also bundle content\n");

    const result = saveGitStash(undefined, "push it", /* writableOverride */ true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);

    // The remote received both unignored files.
    const remoteFiles = spawnSync("git", ["-C", remoteDir, "show", "--name-only", "--format=", "HEAD"], {
      encoding: "utf8",
    }).stdout;
    expect(remoteFiles).toContain("memories/pushed.md");
    expect(remoteFiles).toContain("data.js");

    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  test("pushes the exact AKM commit when a pre-push hook creates a local descendant", () => {
    const stashDir = currentStashDir;
    const remoteDir = path.join(process.env.XDG_CACHE_HOME as string, "exact-push-remote.git");
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, ["init", "--bare"]);
    initRepo(stashDir);
    writeFile(path.join(stashDir, "knowledge", "seed.md"), "seed\n");
    git(stashDir, ["add", "."]);
    git(stashDir, ["commit", "-m", "seed"]);
    git(stashDir, ["remote", "add", "origin", remoteDir]);
    git(stashDir, ["push", "-u", "origin", "main"]);
    writeFile(path.join(stashDir, "user-descendant.txt"), "user descendant\n");
    git(stashDir, ["add", "--", "user-descendant.txt"]);
    writeFile(path.join(stashDir, "memories", "exact.md"), "exact AKM commit\n");
    const hook = path.join(stashDir, ".git", "hooks", "pre-push");
    fs.writeFileSync(hook, '#!/bin/sh\ngit commit -m "user descendant" >/dev/null 2>&1\n', "utf8");
    fs.chmodSync(hook, 0o755);

    const result = saveGitStash(undefined, "exact push", true, { paths: ["memories/exact.md"] });
    if (!result.commit) throw new Error("expected exact commit");

    expect(git(remoteDir, ["rev-parse", "main"])).toBe(result.commit);
    expect(git(stashDir, ["rev-parse", "HEAD"])).not.toBe(result.commit);
    expect(git(remoteDir, ["ls-tree", "--name-only", "main", "user-descendant.txt"])).toBe("");
    expect(git(stashDir, ["rev-list", "--count", `${result.commit}..HEAD`])).toBe("1");
  });
});
