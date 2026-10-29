// INTEGRATION TEST — spawns real Git processes against a local repository
// standing in for the upstream of a managed git bundle (the git+ ref is mapped
// to it by a process-scoped Git insteadOf rule, so no public network is used).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getRegistryCacheDir } from "../../src/core/paths";
import { readLockfile } from "../../src/integrations/lockfile";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

const GIT_URL = "https://git.example.test/acme/revision-fixture.git";
const BUNDLE = "revision-fixture";

let storage: IsolatedAkmStorage;
let remote: string;
let fixtureEnv: Record<string, string>;

function git(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function commitToRemote(note: string): void {
  fs.mkdirSync(path.join(remote, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(remote, "knowledge", "hello.md"), `---\ndescription: ${note}\n---\n\n# ${note}\n`);
  git(["-C", remote, "add", "."]);
  git(["-C", remote, "commit", "-m", note]);
}

async function bundleCli(...args: string[]): Promise<Record<string, unknown>> {
  const result = await withEnv(fixtureEnv, () => runCliCapture(["bundle", ...args, "--format=json"]), 60_000);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

/** The lock's content root, the `<rev>` directory holding it and that directory's parent. */
function installDirs(): { localRoot: string; revDir: string; slugDir: string } {
  const localRoot = readLockfile().find((entry) => entry.id === BUNDLE)?.localRoot ?? "";
  const [slug, rev] = path.relative(getRegistryCacheDir(), localRoot).split(path.sep);
  const slugDir = path.join(getRegistryCacheDir(), slug ?? "");
  return { localRoot, revDir: path.join(slugDir, rev ?? ""), slugDir };
}

function revisionDirs(slugDir: string): string[] {
  return fs.readdirSync(slugDir).sort();
}

function processedChanged(result: Record<string, unknown>): boolean {
  const processed = result.processed as Array<{ changed: { any: boolean } }>;
  return processed[0]?.changed.any === true;
}

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  remote = path.join(storage.root, "remote");
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "--initial-branch=main", remote]);
  git(["-C", remote, "config", "user.name", "AKM Test"]);
  git(["-C", remote, "config", "user.email", "akm@example.test"]);
  git(["-C", remote, "config", "commit.gpgsign", "false"]);
  commitToRemote("first");
  fixtureEnv = {
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: GIT_URL,
  };
  await bundleCli("add", `git+${GIT_URL}`, "--name", BUNDLE);
});

afterEach(() => {
  storage.cleanup();
});

describe("akm bundle update on a read-only git bundle (#1235)", () => {
  test("an unchanged upstream revision leaves the extracted directory in place and reports unchanged", async () => {
    const { localRoot } = installDirs();
    const inodeBefore = fs.statSync(localRoot).ino;
    const lockBefore = readLockfile().find((entry) => entry.id === BUNDLE);

    const result = await bundleCli("update", BUNDLE);

    expect(processedChanged(result)).toBe(false);
    expect(fs.statSync(localRoot).ino).toBe(inodeBefore);
    expect(readLockfile().find((entry) => entry.id === BUNDLE)).toEqual(lockBefore);
  });

  test("--force still fetches the revision again", async () => {
    const { localRoot } = installDirs();
    const inodeBefore = fs.statSync(localRoot).ino;

    await bundleCli("update", BUNDLE, "--force");

    expect(fs.statSync(localRoot).ino).not.toBe(inodeBefore);
  });

  test("an unchanged revision whose directory is gone is fetched again", async () => {
    const { localRoot, revDir } = installDirs();
    fs.rmSync(revDir, { recursive: true, force: true });

    await bundleCli("update", BUNDLE);

    expect(fs.existsSync(localRoot)).toBe(true);
  });

  test("two real updates keep the current and the previous revision directories and no empty parent", async () => {
    const first = installDirs();

    commitToRemote("second");
    const secondResult = await bundleCli("update", BUNDLE);
    expect(processedChanged(secondResult)).toBe(true);
    const second = installDirs();
    expect(second.revDir).not.toBe(first.revDir);
    expect(revisionDirs(second.slugDir)).toEqual([first.revDir, second.revDir].map((dir) => path.basename(dir)).sort());
    expect(fs.existsSync(first.localRoot)).toBe(true);

    commitToRemote("third");
    await bundleCli("update", BUNDLE);
    const third = installDirs();
    expect(revisionDirs(third.slugDir)).toEqual([second.revDir, third.revDir].map((dir) => path.basename(dir)).sort());
    expect(fs.existsSync(first.revDir)).toBe(false);
    for (const dir of revisionDirs(third.slugDir)) {
      expect(fs.readdirSync(path.join(third.slugDir, dir)).length).toBeGreaterThan(0);
    }
  });
});
