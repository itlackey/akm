/**
 * SPEC-5 (stash-conventions-code-spec.md), git-target case: `--supersedes`
 * on a git write target batches BOTH files — the new correction asset and
 * the demoted old asset — into the SINGLE boundary commit (0.9.0
 * batch-at-boundary, issue #507). The old asset's frontmatter mutation
 * (`beliefState: superseded` + `supersededBy`) must therefore be ordered
 * BEFORE `commitWriteTargetBoundary`, or the commit ships incomplete and the
 * working tree is left dirty.
 *
 * INTEGRATION TEST — lives in tests/integration/ because it builds and
 * asserts against a real git fixture repo (spawnSync git), like
 * tests/integration/write-source.test.ts. The `akm` invocation itself uses
 * the in-process harness (tests/_helpers/cli.ts).
 *
 * The rest of the SPEC-5 surface (frontmatter demotion, xref folding,
 * validation, read-only sources, help meta, writeSupersededEdge unit) is
 * pinned in tests/commands/remember-import-supersedes.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { getCachePaths, parseGitRepoUrl } from "../../src/sources/providers/git";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

const cleanups: Cleanup[] = [];
let stashCleanup: Cleanup = () => {};

beforeEach(() => {
  const stash = sandboxStashDir();
  stashCleanup = stash.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  for (const c of cleanups.splice(0)) c();
});

function git(args: string[], failMessage: string): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  expect(result.status, `${failMessage}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

describe("--supersedes on a git write target", () => {
  test("the boundary commit batches BOTH the correction and the demoted old asset, leaving a clean tree", async () => {
    // A git source's on-disk path is the cache mirror keyed by its URL.
    const repoUrl = "https://github.com/acme/supersedes-stash";
    const cache = getCachePaths(parseGitRepoUrl(repoUrl).canonicalUrl);
    const repoDir = cache.repoDir;
    // The git cache lives under the per-process XDG_CACHE_HOME sandbox —
    // clean it after this test so no other test sees the fixture repo.
    cleanups.push(() => fs.rmSync(cache.rootDir, { recursive: true, force: true }));

    git(["init", repoDir], "git init");
    git(["-C", repoDir, "config", "user.name", "akm-test"], "git config user.name");
    git(["-C", repoDir, "config", "user.email", "akm@test"], "git config user.email");
    git(["-C", repoDir, "config", "commit.gpgsign", "false"], "git config gpgsign");
    const oldPath = path.join(repoDir, "memories", "old-note.md");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "Old team note that is being corrected.\n", "utf8");
    git(["-C", repoDir, "add", "-A"], "git add seed");
    git(["-C", repoDir, "commit", "-m", "seed"], "git commit seed");

    writeSandboxConfig({
      semanticSearchMode: "off",
      sources: [{ type: "git", name: "team", url: repoUrl, writable: true }],
    });

    const { code, stdout } = await runCliCapture([
      "remember",
      "Corrected team note superseding the old one.",
      "--name",
      "new-note",
      "--target",
      "team",
      "--supersedes",
      "memory:old-note",
    ]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { superseded?: Array<{ ref: string; applied: boolean }> };
    expect(json.superseded?.[0]?.applied).toBe(true);

    // Exactly ONE boundary commit on top of the seed...
    expect(git(["-C", repoDir, "rev-list", "--count", "HEAD"], "git rev-list").trim()).toBe("2");
    // ...containing BOTH files (the demotion is ordered before the boundary)...
    const committed = git(["-C", repoDir, "show", "--name-only", "--format=", "HEAD"], "git show");
    expect(committed).toContain("memories/new-note.md");
    expect(committed).toContain("memories/old-note.md");
    // ...and no dirty residue: the metadata edit did not land after the commit.
    expect(git(["-C", repoDir, "status", "--porcelain"], "git status").trim()).toBe("");

    // The demotion itself is on disk in the git working tree.
    const oldParsed = parseFrontmatter(fs.readFileSync(oldPath, "utf8"));
    expect(oldParsed.data.beliefState).toBe("superseded");
    expect(oldParsed.data.supersededBy).toEqual(["memory:new-note"]);
  });
});
