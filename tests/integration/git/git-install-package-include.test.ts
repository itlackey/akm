// INTEGRATION TEST — shells out to Git through the real install pipeline. A
// process-scoped Git insteadOf rule maps the HTTPS-shaped ref to a local
// fixture repository, so no network is used.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncGitRef } from "../../../src/sources/providers/git-install";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const REMOTE_URL = "https://fixture.invalid/mixed.git";

let storage: IsolatedAkmStorage;

function git(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

/** A bundle whose `package.json` still carries the retired `akm.include` list. */
function createRemoteFixture(): string {
  const repo = path.join(storage.root, "remote");
  fs.mkdirSync(path.join(repo, "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(repo, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(repo, "skills", "demo", "SKILL.md"), "---\ndescription: Demo\n---\n\n# Demo\n");
  fs.writeFileSync(path.join(repo, "knowledge", "note.md"), "# Note\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "mixed", akm: { include: ["skills"] } }));
  git(["init", "--initial-branch=main", repo]);
  git(["-C", repo, "config", "user.name", "AKM Test"]);
  git(["-C", repo, "config", "user.email", "akm@example.test"]);
  git(["-C", repo, "config", "commit.gpgsign", "false"]);
  git(["-C", repo, "add", "."]);
  git(["-C", repo, "commit", "-m", "seed"]);
  return repo;
}

function install(writable: boolean) {
  const fileUrl = pathToFileURL(createRemoteFixture()).href;
  return withEnv(
    {
      GIT_ALLOW_PROTOCOL: "file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${fileUrl}.insteadOf`,
      GIT_CONFIG_VALUE_0: REMOTE_URL,
    },
    () => syncGitRef(REMOTE_URL, { writable, cacheRootDir: path.join(storage.cacheDir, "registry") }),
  );
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("a git install of a repo whose package.json lists akm.include", () => {
  test("a read-only install is the whole checkout, not a filtered copy", async () => {
    const lock = await install(false);

    expect(lock.contentDir).toBe(lock.extractedDir);
    expect(fs.existsSync(path.join(lock.contentDir, "knowledge", "note.md"))).toBe(true);
    expect(fs.readdirSync(lock.cacheDir)).toEqual(["extracted"]);
  });

  test("a writable install is accepted and stays a checkout", async () => {
    const lock = await install(true);

    expect(lock.writable).toBe(true);
    expect(lock.contentDir).toBe(lock.extractedDir);
    expect(fs.existsSync(path.join(lock.contentDir, ".git"))).toBe(true);
  });
});
