import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../../src/core/events";
import { akmIndex } from "../../src/indexer/indexer";
import { getCachePaths, parseGitRepoUrl } from "../../src/sources/providers/git";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let lessonPath = "";
const memoryRef = "stash//memories/note";

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  const url = "https://example.com/akm/feedback-publication.git";
  const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
  const content = path.join(repo, "content");
  lessonPath = path.join(content, "lessons", "credited.md");
  fs.mkdirSync(path.dirname(lessonPath), { recursive: true });
  fs.mkdirSync(path.join(storage.stashDir, "memories"), { recursive: true });
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@akm.local"]);
  git(repo, ["config", "user.name", "akm-test"]);
  fs.writeFileSync(lessonPath, "---\ndescription: credited lesson\n---\nUse it.\n");
  fs.writeFileSync(path.join(storage.stashDir, "memories", "note.md"), "---\ndescription: note\n---\nNote.\n");
  git(repo, ["add", "content/lessons/credited.md"]);
  git(repo, ["commit", "-m", "seed"]);
  writeSandboxConfig({
    bundles: { stash: { path: storage.stashDir }, team: { git: url, writable: true } },
    defaultBundle: "stash",
  });
  await akmIndex({ stashDir: storage.stashDir, full: true });
});

afterEach(() => storage.cleanup());

describe("feedback lesson publication", () => {
  test("an unchanged credit succeeds quietly, even when the lesson is dirty", async () => {
    fs.writeFileSync(
      lessonPath,
      `---\ndescription: credited lesson\nlessonStrength:\n  - ${memoryRef}\n---\nUse it.\nuser work\n`,
    );

    const result = await runCliCapture([
      "feedback",
      "memories/note",
      "--positive",
      "--applied-to",
      "team//lessons/credited",
      "--format",
      "json",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).appliedTo.lessonStrength).toBe(1);
  });

  test("a push failure propagates and reports the commit that owns the lesson mutation", async () => {
    const repo = git(path.dirname(lessonPath), ["rev-parse", "--show-toplevel"]);
    const remote = path.join(storage.root, "remote.git");
    const initialized = spawnSync("git", ["init", "--bare", "--initial-branch=main", remote], { encoding: "utf8" });
    if (initialized.status !== 0) throw new Error(initialized.stderr);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    const hook = path.join(repo, ".git", "hooks", "pre-push");
    fs.writeFileSync(hook, `#!/bin/sh\ngit -C '${repo}' commit --allow-empty -m descendant >/dev/null\nexit 1\n`, {
      mode: 0o755,
    });

    const result = await runCliCapture([
      "feedback",
      "memories/note",
      "--positive",
      "--applied-to",
      "team//lessons/credited",
      "--format",
      "json",
    ]);

    expect(result.code).toBe(70);
    const error = String(JSON.parse(result.stderr).error);
    const reportedCommit = error.match(/committed as ([0-9a-f]+)/i)?.[1];
    expect(reportedCommit).toBe(git(repo, ["rev-parse", "HEAD^"]));
    expect(reportedCommit).not.toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("3");
    expect(fs.readFileSync(lessonPath, "utf8")).toContain("lessonStrength");
    expect(readEvents({ type: "feedback", ref: memoryRef }).events).toHaveLength(1);
  });
});
