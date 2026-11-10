// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { withAssetMutationLease } from "../../../src/indexer/index-writer-lock";
import { type ResolvedWriteTarget, withWriteTargetMutation } from "../../../src/sources/write-source";
import { configHomeWithBundle } from "../../_helpers/sandbox";

// `withWriteTargetMutation` (src/sources/write-source.ts): lease → mutate → one
// exact-path commit. Integration test — it drives real git repositories with
// spawnSync.

const roots: string[] = [];

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A git target whose `.gitignore` excludes `env/`. */
function gitTarget(): ResolvedWriteTarget {
  const root = tempRoot("akm-write-mutation-");
  git(["init", "--initial-branch=main"], root);
  git(["config", "user.email", "test@akm.local"], root);
  git(["config", "user.name", "akm test"], root);
  git(["config", "commit.gpgsign", "false"], root);
  fs.writeFileSync(path.join(root, ".gitignore"), "env/\n");
  fs.writeFileSync(path.join(root, "README.md"), "seed\n");
  git(["add", ".gitignore", "README.md"], root);
  git(["commit", "-m", "seed"], root);
  return {
    source: { kind: "git", name: "team", path: root, repoPath: root },
    config: { type: "git", name: "team", writable: true },
  };
}

function committedFiles(root: string): string[] {
  return git(["show", "--name-only", "--format=", "HEAD"], root).split("\n").filter(Boolean);
}

afterEach(() => {
  _setWarnSinkForTests(undefined);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("withWriteTargetMutation", () => {
  test("commits exactly the mutated paths and returns the mutation's result", () => {
    const target = gitTarget();
    const root = target.source.path;
    const assetPath = path.join(root, "workflows", "one.md");
    const strayPath = path.join(root, "workflows", "stray.md");
    fs.mkdirSync(path.dirname(strayPath), { recursive: true });
    fs.writeFileSync(strayPath, "user work in progress\n");

    const result = withWriteTargetMutation(
      target,
      [assetPath],
      { purpose: "test-mutation", message: "Create workflows/one" },
      () => {
        fs.writeFileSync(assetPath, "# Workflow: One\n");
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(git(["log", "-1", "--format=%s"], root)).toBe("Create workflows/one");
    expect(committedFiles(root)).toEqual(["workflows/one.md"]);
    expect(git(["status", "--porcelain"], root)).toContain("workflows/stray.md");
  });

  test("refuses a path outside the source root before running the mutation", () => {
    const target = gitTarget();
    const outside = path.join(tempRoot("akm-write-mutation-outside-"), "outside.md");
    let ran = false;

    expect(() =>
      withWriteTargetMutation(target, [outside], { purpose: "test-escape", message: "escape" }, () => {
        ran = true;
      }),
    ).toThrow(/outside source/);

    expect(ran).toBe(false);
  });

  test("refuses a symlink below the source root while allowing a symlinked source root", () => {
    const realRoot = tempRoot("akm-write-mutation-fs-");
    const linkedRoot = `${realRoot}-link`;
    const outside = tempRoot("akm-write-mutation-outside-");
    roots.push(linkedRoot);
    fs.symlinkSync(realRoot, linkedRoot);
    const target: ResolvedWriteTarget = {
      source: { kind: "filesystem", name: "local", path: linkedRoot },
      config: { type: "filesystem", name: "local", path: linkedRoot, writable: true },
    };
    const safePath = path.join(linkedRoot, "env", "safe.env");
    const mutate = () => {
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      fs.writeFileSync(safePath, "TOKEN=x\n");
    };

    withWriteTargetMutation(target, [safePath], { purpose: "test-symlink", message: "Update env/safe" }, mutate);
    expect(fs.existsSync(path.join(realRoot, "env", "safe.env"))).toBe(true);

    fs.rmSync(path.join(realRoot, "env"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(realRoot, "env"));
    expect(() =>
      withWriteTargetMutation(target, [safePath], { purpose: "test-symlink", message: "Update env/safe" }, mutate),
    ).toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(outside, "safe.env"))).toBe(false);
  });

  test("an ignored path is written locally and left out of the commit, with a warning", () => {
    const target = gitTarget();
    const root = target.source.path;
    const envPath = path.join(root, "env", "prod.env");
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });

    withWriteTargetMutation(target, [envPath], { purpose: "test-ignored", message: "Update env/prod" }, () => {
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      fs.writeFileSync(envPath, "TOKEN=private\n");
    });

    expect(fs.readFileSync(envPath, "utf8")).toBe("TOKEN=private\n");
    expect(git(["rev-list", "--count", "HEAD"], root)).toBe("1");
    expect(warnings.some((w) => w.includes("env/prod.env"))).toBe(true);
  });
});

describe("write-mutation-lease", () => {
  const WORKER = path.resolve(import.meta.dir, "../../fixtures/write-mutation-lease-worker.ts");
  const roots: string[] = [];

  function tempRoot(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  function git(repo: string, args: string[]): string {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  function worker(args: string[], env: NodeJS.ProcessEnv = process.env): ReturnType<typeof Bun.spawn> {
    return Bun.spawn([process.execPath, WORKER, ...args], { env, stdout: "pipe", stderr: "pipe" });
  }

  async function waitForFile(filePath: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(filePath)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
      await Bun.sleep(10);
    }
  }

  async function assertExited(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const code = await proc.exited;
    if (code !== 0) {
      const message = proc.stderr instanceof ReadableStream ? await new Response(proc.stderr).text() : `exit ${code}`;
      throw new Error(message);
    }
  }

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  describe("write mutation lease", () => {
    test("two processes cannot both preflight before the first snapshots and commits its bytes", async () => {
      const repo = tempRoot("akm-write-lease-repo-");
      git(repo, ["init", "--initial-branch=main"]);
      git(repo, ["config", "user.email", "test@akm.local"]);
      git(repo, ["config", "user.name", "akm test"]);
      fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "seed"]);
      const enteredA = path.join(repo, "entered-a");
      const enteredB = path.join(repo, "entered-b");
      const readyA = path.join(repo, "ready-a");
      const readyB = path.join(repo, "ready-b");
      const releaseA = path.join(repo, "release-a");
      const releaseB = path.join(repo, "release-b");
      fs.writeFileSync(releaseB, "release");

      const first = worker(["helper", repo, "first\n", enteredA, releaseA, readyA]);
      await waitForFile(readyA);
      await waitForFile(enteredA);
      const second = worker(["helper", repo, "second\n", enteredB, releaseB, readyB]);
      await waitForFile(readyB);
      await Bun.sleep(150);
      expect(fs.existsSync(enteredB)).toBe(false);

      fs.writeFileSync(releaseA, "release");
      await assertExited(first);
      await assertExited(second);

      expect(git(repo, ["show", "HEAD^:workflows/shared.md"])).toBe("first");
      expect(git(repo, ["show", "HEAD:workflows/shared.md"])).toBe("second");
    });

    test("workflow authoring waits for the shared asset mutation lease", async () => {
      const stash = tempRoot("akm-workflow-lease-stash-");
      const config = tempRoot("akm-workflow-lease-config-");
      let releaseHolder: () => void = () => {};
      let markAcquired: () => void = () => {};
      const acquired = new Promise<void>((resolve) => {
        markAcquired = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = withAssetMutationLease("test-holder", async () => {
        markAcquired();
        await release;
      });
      await acquired;

      const child = worker(["workflow", stash, "# Workflow: Leased\n\n## Step: One\nDo it.\n", "-", "-"], {
        ...process.env,
        XDG_CONFIG_HOME: configHomeWithBundle(config, stash),
      });
      await Bun.sleep(250);
      expect(fs.existsSync(path.join(stash, "workflows", "leased.md"))).toBe(false);

      releaseHolder();
      await holder;
      await assertExited(child);
      expect(fs.existsSync(path.join(stash, "workflows", "leased.md"))).toBe(true);
    });
  });
});
