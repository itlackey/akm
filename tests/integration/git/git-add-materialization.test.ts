// INTEGRATION TEST — opens a real index and shells out to Git while exercising
// the real bundle-add command. A process-scoped Git insteadOf rule maps the
// HTTPS-shaped CLI input to a local fixture repository, so no network is used.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, saveConfig } from "../../../src/core/config/config";
import { getCachePaths } from "../../../src/sources/providers/git";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

function git(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function createRemoteFixture(): string {
  const repo = path.join(storage.root, "remote");
  fs.mkdirSync(path.join(repo, "skills", "private-demo"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "skills", "private-demo", "SKILL.md"),
    "---\ndescription: Private Git materialization fixture\n---\n\n# Private demo\n",
  );
  git(["init", "--initial-branch=main", repo]);
  git(["-C", repo, "config", "user.name", "AKM Test"]);
  git(["-C", repo, "config", "user.email", "akm@example.test"]);
  git(["-C", repo, "config", "commit.gpgsign", "false"]);
  git(["-C", repo, "add", "."]);
  git(["-C", repo, "commit", "-m", "seed"]);
  return repo;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
});

describe("akm bundle add --provider git", () => {
  test("materializes, indexes, and preserves writable/auth settings before reporting success (#968/#970/#977)", async () => {
    const fixture = createRemoteFixture();
    const remoteUrl = "https://fixture.invalid/private-team.git";
    const fileUrl = pathToFileURL(fixture).href;

    const result = await withEnv(
      {
        GIT_ALLOW_PROTOCOL: "file",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${fileUrl}.insteadOf`,
        GIT_CONFIG_VALUE_0: remoteUrl,
        AKM_TEST_GIT_TOKEN: "test-only-token",
      },
      () =>
        runCliCapture([
          "bundle",
          "add",
          remoteUrl,
          "--provider",
          "git",
          "--name",
          "private-team",
          "--writable",
          "--credential",
          "$AKM_TEST_GIT_TOKEN",
          "--format=json",
        ]),
      30_000,
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as { added: boolean; index?: { totalEntries?: number } };
    expect(output.added).toBe(true);
    expect(output.index?.totalEntries).toBeGreaterThan(0);

    const bundle = loadConfig().bundles?.["private-team"];
    expect(bundle?.writable).toBe(true);
    expect(bundle?.credential).toBe("$AKM_TEST_GIT_TOKEN");
    const checkout = getCachePaths(remoteUrl).repoDir;
    expect(fs.existsSync(path.join(checkout, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(checkout, "skills", "private-demo", "SKILL.md"))).toBe(true);
  });
});
