import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept, akmProposalRevert } from "../../src/commands/proposal/proposal";
import { createProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import type { AkmConfig } from "../../src/core/config/config";
import { getCachePaths, parseGitRepoUrl } from "../../src/sources/providers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const ACCEPTED =
  "---\ndescription: Git accepted proposal content\nwhen_to_use: Testing proposal Git commits\n---\n\nACCEPTED.\n";
const ORIGINAL =
  "---\ndescription: Git original proposal content\nwhen_to_use: Testing proposal Git commits\n---\n\nORIGINAL.\n";
let storage: IsolatedAkmStorage;

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

describe("proposal Git target commits", () => {
  test("accept and revert each commit the exact destination path", async () => {
    const url = "https://example.com/akm/proposal-git-commit.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    const assetPath = path.join(content, "lessons", "git-proposal.md");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(assetPath, ORIGINAL, "utf8");
    git(repo, ["add", "--", "content/lessons/git-proposal.md"]);
    git(repo, ["commit", "-m", "initial"]);
    const config = {
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        team: { git: url, writable: true },
      } as AkmConfig["bundles"],
      defaultBundle: "stash",
      defaultWriteTarget: "team",
    } as AkmConfig;
    const proposal = createProposal(storage.stashDir, {
      ref: "lessons/git-proposal",
      source: "distill",
      force: true,
      payload: { content: ACCEPTED },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");

    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(git(repo, ["show", "HEAD:content/lessons/git-proposal.md"])).toContain("ACCEPTED.");

    await akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("3");
    expect(git(repo, ["show", "HEAD:content/lessons/git-proposal.md"])).toContain("ORIGINAL.");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });
});
