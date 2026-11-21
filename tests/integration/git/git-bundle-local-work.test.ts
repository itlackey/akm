// INTEGRATION TEST — real git, a bare repository on disk served by a real git daemon, and the real CLI.
//
// akm never replaces or deletes a git checkout that holds uncommitted paths or commits that are not on its
// upstream. Every update, re-add or remove that would do so is refused with SOURCE_HAS_LOCAL_WORK (exit 78),
// naming the work and the checkout's real path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../../../src/core/config/config";
import { readLockfile } from "../../../src/integrations/lockfile";
import { getCachePaths, parseGitRepoUrl } from "../../../src/sources/providers/git";
import { runCliCapture } from "../../_helpers/cli";
import { type GitDaemon, startGitDaemon } from "../../_helpers/git-daemon";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withTTY } from "../../_helpers/sandbox";

const BUNDLE = "gb";

let storage: IsolatedAkmStorage;
let bare: string;
let daemon: GitDaemon;
let GIT_URL = "";

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function configure(dir: string): void {
  git(["-C", dir, "config", "user.name", "AKM Test"]);
  git(["-C", dir, "config", "user.email", "akm@example.test"]);
  git(["-C", dir, "config", "commit.gpgsign", "false"]);
}

async function bundleCli(...args: string[]) {
  return withTTY(false, () => runCliCapture(["bundle", ...args, "--format=json"]));
}

function checkout(): string {
  return readLockfile().find((entry) => entry.id === BUNDLE)?.localRoot ?? "";
}

/** A writable checkout holding one commit that is not on its upstream and one uncommitted file. */
async function checkoutWithLocalWork(): Promise<string> {
  expect((await bundleCli("add", `git+${GIT_URL}`, "--name", BUNDLE, "--writable")).code).toBe(0);
  const root = checkout();
  configure(root);
  fs.writeFileSync(path.join(root, "knowledge", "committed.md"), "---\ndescription: c\n---\n\n# Committed\n");
  git(["-C", root, "add", "-A"]);
  git(["-C", root, "commit", "-m", "unpushed work"]);
  fs.writeFileSync(path.join(root, "knowledge", "uncommitted.md"), "# Uncommitted\n");
  return root;
}

/** A plain (lockless) git source mirrored into the registry-index cache, with the same local work. */
async function plainSourceWithLocalWork(): Promise<string> {
  expect((await bundleCli("add", GIT_URL, "--provider", "git", "--name", BUNDLE, "--writable")).code).toBe(0);
  const root = getCachePaths(parseGitRepoUrl(GIT_URL).canonicalUrl).repoDir;
  configure(root);
  fs.writeFileSync(path.join(root, "knowledge", "committed.md"), "---\ndescription: c\n---\n\n# Committed\n");
  git(["-C", root, "add", "-A"]);
  git(["-C", root, "commit", "-m", "unpushed work"]);
  fs.writeFileSync(path.join(root, "knowledge", "uncommitted.md"), "# Uncommitted\n");
  return root;
}

function makeReadOnly(): void {
  const config = loadConfig();
  const entry = config.bundles?.[BUNDLE];
  if (!entry) throw new Error("bundle missing");
  const components = Object.fromEntries(
    Object.entries(entry.components ?? {}).map(([name, component]) => [name, { ...component, writable: false }]),
  );
  saveConfig({
    ...config,
    bundles: {
      ...config.bundles,
      [BUNDLE]: { ...entry, writable: false, ...(entry.components ? { components } : {}) },
    },
  });
}

function expectRefusedWithWork(result: { code: number; stderr: string; stdout: string }, root: string): void {
  const text = `${result.stdout}${result.stderr}`;
  expect(result.code, text).toBe(78);
  expect(text).toContain("SOURCE_HAS_LOCAL_WORK");
  expect(text).toContain("unpushed work");
  expect(text).toContain("uncommitted.md");
  expect(text).toContain(root);
  expect(text).not.toContain(".akm-update-stage-");
  expect(fs.readFileSync(path.join(root, "knowledge", "uncommitted.md"), "utf8")).toBe("# Uncommitted\n");
  expect(fs.existsSync(path.join(root, "knowledge", "committed.md"))).toBe(true);
  expect(git(["-C", root, "log", "-1", "--format=%s"])).toBe("unpushed work");
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  bare = path.join(storage.root, "remote.git");
  const seed = path.join(storage.root, "seed");
  git(["init", "--bare", "--initial-branch=main", bare]);
  git(["init", "--initial-branch=main", seed]);
  configure(seed);
  fs.mkdirSync(path.join(seed, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(seed, "knowledge", "hello.md"), "---\ndescription: hello\n---\n\n# Hello\n");
  git(["-C", seed, "add", "-A"]);
  git(["-C", seed, "commit", "-m", "seed"]);
  git(["-C", seed, "remote", "add", "origin", bare]);
  git(["-C", seed, "push", "-u", "origin", "main"]);
  daemon = startGitDaemon(storage.root, "remote.git");
  GIT_URL = `${daemon.baseUrl}/remote.git`;
});

afterEach(() => {
  daemon.stop();
  storage.cleanup();
});

describe("a git bundle checkout with local work", () => {
  test("a read-only refresh of a git source refuses, names the work and the live path, and deletes nothing", async () => {
    const root = await plainSourceWithLocalWork();
    makeReadOnly();
    expectRefusedWithWork(await bundleCli("update", BUNDLE), root);
  }, 90_000);

  test("removing a git source is refused with local work, and allowed with --force", async () => {
    const root = await plainSourceWithLocalWork();
    expectRefusedWithWork(await bundleCli("remove", BUNDLE, "--yes"), root);
    expect(loadConfig().bundles?.[BUNDLE]).toBeDefined();
    expect((await bundleCli("remove", BUNDLE, "--yes", "--force")).code).toBe(0);
  }, 90_000);

  test("a diverged writable checkout is an environment error that names the live path", async () => {
    const root = await checkoutWithLocalWork();
    const work = path.join(storage.root, "other");
    git(["clone", bare, work]);
    configure(work);
    fs.writeFileSync(path.join(work, "upstream.md"), "upstream\n");
    git(["-C", work, "add", "-A"]);
    git(["-C", work, "commit", "-m", "upstream change"]);
    git(["-C", work, "push", "origin", "main"]);

    const result = await bundleCli("update", BUNDLE);
    const text = `${result.stdout}${result.stderr}`;
    expect(result.code, text).toBe(78);
    expect(text).toContain("SOURCE_HAS_LOCAL_WORK");
    expect(text).toContain("unpushed work");
    expect(text).toContain(root);
    expect(text).not.toContain(".akm-update-stage-");
    expect(fs.existsSync(path.join(root, "knowledge", "committed.md"))).toBe(true);
  }, 90_000);

  test("removing the bundle is refused with local work, and allowed with --force", async () => {
    const root = await checkoutWithLocalWork();
    expectRefusedWithWork(await bundleCli("remove", BUNDLE, "--yes"), root);
    expect(loadConfig().bundles?.[BUNDLE]).toBeDefined();

    const forced = await bundleCli("remove", BUNDLE, "--yes", "--force");
    expect(forced.code, forced.stderr).toBe(0);
    expect(loadConfig().bundles?.[BUNDLE]).toBeUndefined();
  }, 90_000);

  test("removing a bundle whose checkout has no local work is not refused", async () => {
    expect((await bundleCli("add", `git+${GIT_URL}`, "--name", BUNDLE, "--writable")).code).toBe(0);
    const removed = await bundleCli("remove", BUNDLE, "--yes");
    expect(removed.code, removed.stderr).toBe(0);
    expect(loadConfig().bundles?.[BUNDLE]).toBeUndefined();
  }, 90_000);

  test("re-adding without --writable over the checkout refuses and keeps the work", async () => {
    const root = await checkoutWithLocalWork();
    const readd = await bundleCli("add", `git+${GIT_URL}`, "--name", BUNDLE);
    const text = `${readd.stdout}${readd.stderr}`;
    expect(readd.code, text).not.toBe(0);
    expect(fs.readFileSync(path.join(root, "knowledge", "uncommitted.md"), "utf8")).toBe("# Uncommitted\n");
    expect(git(["-C", root, "log", "-1", "--format=%s"])).toBe("unpushed work");
  }, 90_000);

  test("a clean checkout still updates and re-adds", async () => {
    expect((await bundleCli("add", `git+${GIT_URL}`, "--name", BUNDLE, "--writable")).code).toBe(0);
    const updated = await bundleCli("update", BUNDLE);
    expect(updated.code, updated.stderr).toBe(0);
    const readded = await bundleCli("add", `git+${GIT_URL}`, "--name", BUNDLE, "--writable");
    expect(readded.code, readded.stderr).toBe(0);
  }, 90_000);
});
