// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1296: re-adding a read-only Git bundle with `--writable` promotes it by
 * materializing a fresh checkout, not by reusing the read-only snapshot as one.
 *
 * Integration: spawns real `git` processes and opens the real index database.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { readLockfile } from "../../src/integrations/lockfile";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, makeSandboxDir, withIsolatedAkmStorage, withTTY } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let originDir: string;
let cleanupOrigin: () => void;
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let REMOTE_URL = "";
/** A stored `$VAR` credential reference, resolved from the environment at sync time. */
const CREDENTIAL_REF = "$AKM_1296_TOKEN";

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const sandbox = makeSandboxDir("akm-1296-origin");
  cleanupOrigin = sandbox.cleanup;
  originDir = path.join(sandbox.dir, "knowledge.git");
  const seed = path.join(sandbox.dir, "seed");
  git(["init", "--initial-branch=main", seed]);
  git(["-C", seed, "config", "user.name", "akm-test"]);
  git(["-C", seed, "config", "user.email", "akm@test"]);
  git(["-C", seed, "config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(seed, "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(seed, "knowledge", "note.md"),
    "---\ntype: knowledge\ndescription: Team note\n---\n\n# Team note\n",
  );
  git(["-C", seed, "add", "-A"]);
  git(["-C", seed, "commit", "-m", "seed"]);
  git(["clone", "--bare", seed, originDir]);

  // Serve the bare repo over git:// on loopback. It must be a separate process:
  // akm's synchronous git calls would deadlock an in-process server.
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  daemon = Bun.spawn(
    [
      "git",
      "daemon",
      "--reuseaddr",
      "--listen=127.0.0.1",
      `--port=${port}`,
      `--base-path=${sandbox.dir}`,
      "--export-all",
      sandbox.dir,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  REMOTE_URL = `git://127.0.0.1:${port}/knowledge.git`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spawnSync("git", ["ls-remote", REMOTE_URL]).status === 0) break;
    Bun.sleepSync(100);
  }
});

afterEach(() => {
  daemon?.kill();
  cleanupOrigin();
  storage.cleanup();
});

function add(...extra: string[]) {
  return withTTY(false, () => runCliCapture(["bundle", "add", `git+${REMOTE_URL}`, "--name", "shared", ...extra]));
}

function installed() {
  const bundle = loadConfig().bundles?.shared;
  const lock = readLockfile().find((entry) => entry.id === "shared");
  return { bundle, lock };
}

function isWritable(bundle: ReturnType<typeof installed>["bundle"]): boolean {
  return (Object.values(bundle?.components ?? {})[0]?.writable ?? bundle?.writable) === true;
}

async function promote() {
  expect((await add()).code).toBe(0);
  const snapshot = installed().lock?.localRoot as string;
  expect(fs.existsSync(path.join(snapshot, ".git"))).toBe(false);
  const promoted = await add("--writable");
  return { snapshot, promoted };
}

describe("bundle add --writable on an existing read-only Git bundle (#1296)", () => {
  test("promotes the snapshot to a real checkout and keeps the bundle identity", async () => {
    const { promoted } = await promote();
    expect(promoted.stderr).not.toContain("is not a checkout");
    expect(promoted.code).toBe(0);

    const { bundle, lock } = installed();
    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["shared"]);
    expect(isWritable(bundle)).toBe(true);
    const root = lock?.localRoot as string;
    expect(git(["-C", root, "rev-parse", "--show-toplevel"]).trim()).toBeTruthy();
    expect(git(["-C", root, "remote", "get-url", "origin"]).trim()).toBe(REMOTE_URL);
  }, 60_000);

  test("promotion keeps component selection, bundle order and credential, and drops the old snapshot", async () => {
    expect((await add()).code).toBe(0);
    const snapshot = installed().lock?.localRoot as string;
    const otherDir = makeSandboxDir("akm-1296-other");
    const config = loadConfig();
    const shared = config.bundles?.shared;
    if (!shared) throw new Error("shared bundle missing");
    saveConfig({
      ...config,
      bundles: {
        shared: {
          ...shared,
          credential: CREDENTIAL_REF,
          components: { notes: { root: "knowledge", adapter: "akm", writable: false } },
        },
        other: { path: otherDir.dir },
      },
    });
    process.env.AKM_1296_TOKEN = "synthetic-token";
    try {
      const promoted = await add("--writable");
      expect(promoted.code).toBe(0);
    } finally {
      delete process.env.AKM_1296_TOKEN;
      otherDir.cleanup();
    }

    const bundles = loadConfig().bundles ?? {};
    expect(Object.keys(bundles)).toEqual(["shared", "other"]);
    expect(bundles.shared?.credential).toBe(CREDENTIAL_REF);
    expect(bundles.shared?.components).toEqual({ notes: { root: "knowledge", adapter: "akm", writable: true } });
    const root = installed().lock?.localRoot as string;
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true);
    expect(fs.existsSync(snapshot)).toBe(false);
  }, 60_000);

  test("a failed promotion preserves the read-only snapshot and registration", async () => {
    expect((await add()).code).toBe(0);
    const before = installed();
    const snapshot = before.lock?.localRoot as string;

    fs.renameSync(originDir, `${originDir}.gone`);
    const failed = await add("--writable");
    expect(failed.code).not.toBe(0);

    const after = installed();
    expect(fs.existsSync(path.join(snapshot, "knowledge", "note.md"))).toBe(true);
    expect(after.lock?.localRoot).toBe(snapshot);
    expect(isWritable(after.bundle)).toBe(false);
  }, 60_000);

  test("a re-add of an existing writable checkout still refuses a dirty worktree", async () => {
    await promote();
    const root = installed().lock?.localRoot as string;
    fs.writeFileSync(path.join(root, "knowledge", "local.md"), "local work\n");

    const result = await add("--writable");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("uncommitted changes");
    expect(fs.readFileSync(path.join(root, "knowledge", "local.md"), "utf8")).toBe("local work\n");
  }, 60_000);

  test("a re-add of an existing writable checkout still refuses a mismatched origin", async () => {
    await promote();
    const root = installed().lock?.localRoot as string;
    git(["-C", root, "remote", "set-url", "origin", "https://example.org/other/repo.git"]);

    const result = await add("--writable");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("different origin");
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true);
  }, 60_000);
});
