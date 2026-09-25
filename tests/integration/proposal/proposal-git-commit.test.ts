import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept, akmProposalReject, akmProposalRevert } from "../../../src/commands/proposal/proposal";
import { createProposal, getProposal, isProposalSkipped } from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import { txnNamespaceDir, txnQuarantineNamespaceDir } from "../../../src/core/fs-txn";
import { getCachePaths, parseGitRepoUrl } from "../../../src/sources/providers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

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
      target: { source: "team", root: content },
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

  test("recovery pushes only the recorded accept commit after a rejected push", async () => {
    const url = "https://example.com/akm/proposal-git-recovery.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    const assetPath = path.join(content, "lessons", "git-proposal.md");
    const remote = path.join(storage.root, "remote.git");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    git(remote, ["init", "--bare"]);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(assetPath, ORIGINAL, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);

    const userWip = path.join(content, "knowledge", "user-wip.md");
    fs.mkdirSync(path.dirname(userWip), { recursive: true });
    fs.writeFileSync(userWip, "User-owned staged work.\n", "utf8");
    git(repo, ["add", "--", "content/knowledge/user-wip.md"]);
    const rejectingHook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(rejectingHook, "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(rejectingHook, 0o755);

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
      target: { source: "team", root: content },
      payload: { content: ACCEPTED },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");

    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      "git push failed",
    );
    expect(git(repo, ["status", "--porcelain"])).toBe("A  content/knowledge/user-wip.md");
    const transactionCommit = git(repo, ["rev-parse", "HEAD"]);
    const namespace = txnNamespaceDir(content);
    const transactionDirs = fs.readdirSync(namespace);
    expect(transactionDirs).toHaveLength(1);
    const journal = JSON.parse(
      fs.readFileSync(path.join(namespace, transactionDirs[0] as string, "journal.json"), "utf8"),
    ) as { phase: string; payload: { gitPublication: { commit?: string } } };
    expect(journal.phase).toBe("asset-published");
    expect(journal.payload.gitPublication.commit).toBe(transactionCommit);

    git(repo, ["commit", "--only", "-m", "user follow-up", "--", "content/knowledge/user-wip.md"]);
    const userCommit = git(repo, ["rev-parse", "HEAD"]);
    const laterWip = path.join(content, "knowledge", "later-wip.md");
    fs.writeFileSync(laterWip, "Later staged user work.\n", "utf8");
    git(repo, ["add", "--", "content/knowledge/later-wip.md"]);
    git(repo, ["reset", "--quiet", `${transactionCommit}^`, "--", "content/lessons/git-proposal.md"]);

    fs.rmSync(rejectingHook);
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });

    expect(git(remote, ["rev-parse", "main"])).toBe(transactionCommit);
    expect(git(remote, ["show", "main:content/lessons/git-proposal.md"])).toContain("ACCEPTED.");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(userCommit);
    expect(git(repo, ["rev-list", "--count", "@{u}..HEAD"])).toBe("1");
    expect(git(repo, ["status", "--porcelain"])).toBe("A  content/knowledge/later-wip.md");
    expect(fs.existsSync(namespace)).toBe(false);
  });

  test("a push that still fails on retry leaves the journal in place and a later retry publishes it", async () => {
    const url = "https://example.com/akm/proposal-git-retry-push.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    const assetPath = path.join(content, "lessons", "git-proposal.md");
    const remote = path.join(storage.root, "retry-push-remote.git");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    git(remote, ["init", "--bare"]);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(assetPath, ORIGINAL, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    const rejectingHook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(rejectingHook, "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(rejectingHook, 0o755);

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
      target: { source: "team", root: content },
      payload: { content: ACCEPTED },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");

    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      "git push failed",
    );
    const namespace = txnNamespaceDir(content);
    expect(fs.readdirSync(namespace)).toHaveLength(1);

    // Retried while the push still fails: the journal it is about to act on
    // stays in place and is rethrown, not quarantined.
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      "git push failed",
    );
    expect(fs.readdirSync(namespace)).toHaveLength(1);
    const quarantineDir = txnQuarantineNamespaceDir(content);
    expect(fs.existsSync(quarantineDir) ? fs.readdirSync(quarantineDir) : []).toHaveLength(0);

    fs.rmSync(rejectingHook);
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
    expect(git(remote, ["show", "main:content/lessons/git-proposal.md"])).toContain("ACCEPTED.");
  });

  test("a reject while the push still fails rejects with the push failure, and the proposal stays pending", async () => {
    const url = "https://example.com/akm/proposal-git-retry-reject.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    const assetPath = path.join(content, "lessons", "git-proposal.md");
    const remote = path.join(storage.root, "retry-reject-remote.git");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    git(remote, ["init", "--bare"]);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(assetPath, ORIGINAL, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    const rejectingHook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(rejectingHook, "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(rejectingHook, 0o755);

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
      target: { source: "team", root: content },
      payload: { content: ACCEPTED },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");

    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      "git push failed",
    );

    await expect(akmProposalReject({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      "git push failed",
    );
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
  });

  test("refuses same-path user work before replacing a proposal target", async () => {
    const url = "https://example.com/akm/proposal-git-wip.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    const assetPath = path.join(content, "lessons", "git-proposal.md");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(assetPath, ORIGINAL, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
    fs.writeFileSync(assetPath, "USER WORK IN PROGRESS\n", "utf8");
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
      target: { source: "team", root: content },
      payload: { content: ACCEPTED },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");

    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      /staged or unstaged work/i,
    );
    expect(fs.readFileSync(assetPath, "utf8")).toBe("USER WORK IN PROGRESS\n");
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(fs.existsSync(txnNamespaceDir(content))).toBe(false);
  });

  test("refuses an ignored proposal destination before creating the asset", async () => {
    const url = "https://example.com/akm/proposal-git-ignored.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    const assetPath = path.join(content, "lessons", "ignored-proposal.md");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(path.join(repo, ".gitignore"), "content/lessons/ignored-proposal.md\n", "utf8");
    git(repo, ["add", ".gitignore"]);
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
      ref: "lessons/ignored-proposal",
      source: "distill",
      force: true,
      target: { source: "team", root: content },
      payload: { content: ACCEPTED },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");

    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      /ignored/i,
    );
    expect(fs.existsSync(assetPath)).toBe(false);
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(fs.existsSync(txnNamespaceDir(content))).toBe(false);
  });

  test("refuses to publish an asset-published journal without Git publication identity, and leaves it for retry", async () => {
    const url = "https://example.com/akm/proposal-git-legacy-journal.git";
    const repo = getCachePaths(parseGitRepoUrl(url).canonicalUrl).repoDir;
    const content = path.join(repo, "content");
    const assetPath = path.join(content, "lessons", "git-proposal.md");
    const remote = path.join(storage.root, "legacy-remote.git");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    git(remote, ["init", "--bare"]);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm-test"]);
    fs.writeFileSync(assetPath, ORIGINAL, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    const rejectingHook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(rejectingHook, "#!/bin/sh\nexit 1\n", "utf8");
    fs.chmodSync(rejectingHook, 0o755);
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
      target: { source: "team", root: content },
      payload: { content: ACCEPTED },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      "git push failed",
    );

    const namespace = txnNamespaceDir(content);
    const transactionDir = fs.readdirSync(namespace)[0] as string;
    const journalPath = path.join(namespace, transactionDir, "journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      payload: Record<string, unknown>;
    };
    delete journal.payload.gitPublication;
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    fs.rmSync(rejectingHook);

    // Recovery rethrows the failure on the journal it is about to act on
    // rather than quarantining it, so the busted journal survives in place
    // for a retry once its payload is repaired.
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
      "has no Git publication identity",
    );
    expect(git(remote, ["show", "main:content/lessons/git-proposal.md"])).toContain("ORIGINAL.");
    expect(fs.existsSync(namespace)).toBe(true);
    expect(fs.existsSync(txnQuarantineNamespaceDir(content))).toBe(false);
  });
});
