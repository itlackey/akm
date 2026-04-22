import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache, saveConfig } from "../../src/config";
import { resolveStashProviderFactory } from "../../src/stash-provider-factory";
import { ensureGitMirror, getCachePaths, parseGitRepoUrl } from "../../src/stash-providers/git";

// Trigger self-registration
import "../../src/stash-providers/git";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-git-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/** Create a local git repo with akm-style content for use as a clone source in tests. */
function createLocalGitRepo(): string {
  const repoDir = createTmpDir("akm-git-repo-");

  writeFile(
    path.join(repoDir, "content", "openai", "docs", "chat-api", "python", "DOC.md"),
    `---
name: chat-api
description: "Python chat completions reference"
metadata:
  languages: "python"
  versions: "1.1.0"
  tags: "openai,chat,python"
---
# Chat API

Use this document to call chat completions safely.
`,
  );

  writeFile(
    path.join(repoDir, "content", "openai", "skills", "prompt-chaining", "SKILL.md"),
    `---
name: prompt-chaining
description: "Build multi-step prompt flows"
metadata:
  revision: 1
  updated-on: "2026-03-10"
  tags: "automation,prompts"
---
# Prompt Chaining

Chain multiple prompts together.
`,
  );

  // Initialise a real git repo so git clone works from local path
  for (const args of [
    ["init"],
    ["checkout", "-b", "main"],
    ["config", "user.email", "test@test.com"],
    ["config", "user.name", "Test"],
    ["config", "commit.gpgsign", "false"],
    ["add", "."],
    ["commit", "-m", "init"],
  ] as string[][]) {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }

  return repoDir;
}

function createWorkingStash(): string {
  const dir = createTmpDir("akm-git-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("akm-git-cache-");
  process.env.XDG_CONFIG_HOME = createTmpDir("akm-git-config-");
  process.env.AKM_STASH_DIR = createWorkingStash();
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;

  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitStashProvider", () => {
  test("self-registers as 'context-hub' and 'github' (migration aliases)", () => {
    expect(resolveStashProviderFactory("context-hub")).toBeTruthy();
    expect(resolveStashProviderFactory("github")).toBeTruthy();
    expect(resolveStashProviderFactory("git")).toBeTruthy();
  });

  test("search() returns empty hits (content indexed via FTS5 pipeline)", async () => {
    const factory = resolveStashProviderFactory("context-hub");
    expect(factory).toBeTruthy();
    // biome-ignore lint/style/noNonNullAssertion: factory is guaranteed by the expect above
    const provider = factory!({
      type: "context-hub",
      url: "https://github.com/andrewyng/context-hub",
      name: "context-hub",
    });

    const result = await provider.search({ query: "openai chat", limit: 10 });
    expect(result.hits).toEqual([]);
  });

  test("canShow() returns false (content is local)", () => {
    const factory = resolveStashProviderFactory("git");
    expect(factory).toBeTruthy();
    // biome-ignore lint/style/noNonNullAssertion: factory is guaranteed by the expect above
    const provider = factory!({
      type: "git",
      url: "https://github.com/andrewyng/context-hub",
      name: "test",
    });
    expect(provider.canShow("skill:foo")).toBe(false);
  });

  test("cache mirror clones content to disk via git", async () => {
    const localRepoPath = createLocalGitRepo();
    // Construct ParsedRepoUrl directly to point at the local repo
    const repo = { cloneUrl: localRepoPath, ref: null as string | null, canonicalUrl: localRepoPath };
    const cachePaths = getCachePaths(repo.canonicalUrl);

    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });

    // Verify cloned content exists at the expected path
    const docPath = path.join(cachePaths.repoDir, "content", "openai", "docs", "chat-api", "python", "DOC.md");
    expect(fs.existsSync(docPath)).toBe(true);
    const content = fs.readFileSync(docPath, "utf8");
    expect(content).toContain("# Chat API");
  });

  test("cache mirror respects TTL and skips re-clone when fresh", async () => {
    const localRepoPath = createLocalGitRepo();
    const repo = { cloneUrl: localRepoPath, ref: null as string | null, canonicalUrl: localRepoPath };
    const cachePaths = getCachePaths(repo.canonicalUrl);

    // Prime the cache
    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });

    // Remove the content to verify it is NOT re-cloned (cache is still fresh)
    const docPath = path.join(cachePaths.repoDir, "content", "openai", "docs", "chat-api", "python", "DOC.md");
    fs.rmSync(docPath);

    await ensureGitMirror(repo, cachePaths, { requireRepoDir: false });

    // File should still be absent — clone was skipped due to fresh cache
    expect(fs.existsSync(docPath)).toBe(false);
  });

  test("integrates with stash sources via ensureGitCaches", async () => {
    // Pre-populate the cache so ensureGitMirror returns early without cloning
    const stashUrl = "https://github.com/andrewyng/context-hub";
    const repo = parseGitRepoUrl(stashUrl);
    const cachePaths = getCachePaths(repo.canonicalUrl);

    fs.mkdirSync(cachePaths.rootDir, { recursive: true });
    fs.mkdirSync(path.join(cachePaths.repoDir, "content"), { recursive: true });
    fs.writeFileSync(cachePaths.indexPath, "[]", { encoding: "utf8", mode: 0o600 });

    saveConfig({
      semanticSearchMode: "off",
      stashes: [{ type: "context-hub", url: stashUrl, name: "context-hub" }],
    });
    resetConfigCache();

    const { ensureGitCaches } = await import("../../src/search-source");
    const { loadConfig } = await import("../../src/config");
    const config = loadConfig();
    await ensureGitCaches(config);

    // Verify context-hub content dir appears in stash sources
    const { resolveStashSources } = await import("../../src/search-source");
    const sources = resolveStashSources(undefined, config);
    const gitSource = sources.find((s) => s.path.includes("context-hub-"));
    expect(gitSource).toBeDefined();
  });
});
