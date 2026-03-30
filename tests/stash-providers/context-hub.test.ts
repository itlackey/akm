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

function createTarball(sourceDir: string, archivePath: string): void {
  const result = spawnSync("tar", ["czf", archivePath, "-C", path.dirname(sourceDir), path.basename(sourceDir)], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
}

function buildContextHubArchive(): string {
  const repoDir = path.join(createTmpDir("akm-git-repo-"), "context-hub-main");

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

  const archivePath = path.join(createTmpDir("akm-git-archive-"), "context-hub-main.tar.gz");
  createTarball(repoDir, archivePath);
  return archivePath;
}

function mockArchiveFetch(archivePath: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://github.com/andrewyng/context-hub/archive/refs/heads/main.tar.gz") {
      return new Response(Bun.file(archivePath), {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
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

  test("cache mirror extracts content to disk", async () => {
    const archivePath = buildContextHubArchive();
    const restoreFetch = mockArchiveFetch(archivePath);

    try {
      const repo = parseGitRepoUrl("https://github.com/andrewyng/context-hub");
      const cachePaths = getCachePaths(repo.canonicalUrl);
      await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });

      // Verify extracted content exists
      const docPath = path.join(cachePaths.repoDir, "content", "openai", "docs", "chat-api", "python", "DOC.md");
      expect(fs.existsSync(docPath)).toBe(true);
      const content = fs.readFileSync(docPath, "utf8");
      expect(content).toContain("# Chat API");
    } finally {
      restoreFetch();
    }
  });

  test("integrates with stash sources via ensureGitCaches", async () => {
    const archivePath = buildContextHubArchive();
    const restoreFetch = mockArchiveFetch(archivePath);

    try {
      saveConfig({
        semanticSearchMode: "off",
        stashes: [{ type: "context-hub", url: "https://github.com/andrewyng/context-hub", name: "context-hub" }],
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
    } finally {
      restoreFetch();
    }
  });
});
