import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../../src/config";
import { resolveStashProviderFactory } from "../../src/stash-provider-factory";
import { type ContextHubStashProvider, makeContextHubRef } from "../../src/stash-providers/context-hub";
import { akmSearch } from "../../src/stash-search";
import { akmShowUnified } from "../../src/stash-show";

// Trigger self-registration
import "../../src/stash-providers/context-hub";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-context-hub-"): string {
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
  const repoDir = path.join(createTmpDir("akm-context-hub-repo-"), "context-hub-main");

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

  const archivePath = path.join(createTmpDir("akm-context-hub-archive-"), "context-hub-main.tar.gz");
  createTarball(repoDir, archivePath);
  return archivePath;
}

function buildContextHubArchiveWithAuthor(author: string): string {
  const repoDir = path.join(createTmpDir("akm-context-hub-author-repo-"), "context-hub-main");

  writeFile(
    path.join(repoDir, "content", author, "docs", "chat-api", "python", "DOC.md"),
    `---
name: chat-api
description: "Python chat completions reference"
metadata:
  languages: "python"
  versions: "1.1.0"
---
# Chat API

Sanitized author test.
`,
  );

  const archivePath = path.join(createTmpDir("akm-context-hub-author-archive-"), "context-hub-main.tar.gz");
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
  const dir = createTmpDir("akm-context-hub-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function getFactory() {
  const factory = resolveStashProviderFactory("context-hub");
  expect(factory).toBeTruthy();
  if (!factory) {
    throw new Error("Expected context-hub stash provider factory to be registered");
  }
  return factory;
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("akm-context-hub-cache-");
  process.env.XDG_CONFIG_HOME = createTmpDir("akm-context-hub-config-");
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

describe("ContextHubStashProvider", () => {
  test("self-registers as 'context-hub'", () => {
    expect(resolveStashProviderFactory("context-hub")).toBeTruthy();
  });

  test("searches a GitHub context-hub repo archive as stash content", async () => {
    const archivePath = buildContextHubArchive();
    const restoreFetch = mockArchiveFetch(archivePath);

    try {
      const provider = getFactory()({
        type: "context-hub",
        url: "https://github.com/andrewyng/context-hub",
        name: "context-hub",
      }) as ContextHubStashProvider;

      const result = await provider.search({ query: "openai chat", limit: 10 });

      expect(result.warnings).toBeUndefined();
      const hit = result.hits.find((entry) => entry.name === "openai/chat-api");
      expect(hit).toBeDefined();
      expect(hit).toMatchObject({
        type: "knowledge",
        name: "openai/chat-api",
        ref: makeContextHubRef("content/openai/docs/chat-api/python/DOC.md"),
        editable: false,
        origin: "context-hub",
      });
      expect(hit?.description).toContain("Python chat completions reference");
    } finally {
      restoreFetch();
    }
  });

  test("integrates with akm search and akm show", async () => {
    const archivePath = buildContextHubArchive();
    const restoreFetch = mockArchiveFetch(archivePath);

    try {
      saveConfig({
        semanticSearch: false,
        stashes: [{ type: "context-hub", url: "https://github.com/andrewyng/context-hub", name: "context-hub" }],
      });

      const searchResult = await akmSearch({ query: "prompt chaining", source: "stash" });
      const hit = searchResult.hits.find((entry) => entry.type === "skill" && entry.name === "openai/prompt-chaining");
      expect(hit).toBeDefined();

      const showResult = await akmShowUnified({
        ref: makeContextHubRef("content/openai/skills/prompt-chaining/SKILL.md"),
        view: { mode: "lines", start: 9, end: 11 },
      });

      expect(showResult.type).toBe("skill");
      expect(showResult.name).toBe("openai/prompt-chaining");
      expect(showResult.content).toContain("# Prompt Chaining");
      expect(showResult.editable).toBe(false);
      expect(showResult.origin).toBe("context-hub");
    } finally {
      restoreFetch();
    }
  });

  test("show sanitizes author names derived from cached repo paths", async () => {
    const archivePath = buildContextHubArchiveWithAuthor("open\tai");
    const restoreFetch = mockArchiveFetch(archivePath);

    try {
      const provider = getFactory()({
        type: "context-hub",
        url: "https://github.com/andrewyng/context-hub",
        name: "context-hub",
      }) as ContextHubStashProvider;

      const result = await provider.show(makeContextHubRef("content/open\tai/docs/chat-api/python/DOC.md"));
      expect(result.name).toBe("openai/chat-api");
    } finally {
      restoreFetch();
    }
  });

  test("show refreshes the mirror when the cached repo directory is missing", async () => {
    const archivePath = buildContextHubArchive();
    const restoreFetch = mockArchiveFetch(archivePath);

    try {
      const provider = getFactory()({
        type: "context-hub",
        url: "https://github.com/andrewyng/context-hub",
        name: "context-hub",
      }) as ContextHubStashProvider;

      const searchResult = await provider.search({ query: "openai chat", limit: 10 });
      expect(searchResult.hits.some((entry) => entry.name === "openai/chat-api")).toBe(true);

      const cacheHome = process.env.XDG_CACHE_HOME;
      expect(cacheHome).toBeDefined();
      if (!cacheHome) throw new Error("Expected XDG_CACHE_HOME to be set in test");
      const cacheRoot = path.join(cacheHome, "akm", "registry-index");
      const mirrorDir = fs.readdirSync(cacheRoot).find((entry) => entry.startsWith("context-hub-"));
      expect(mirrorDir).toBeDefined();
      if (!mirrorDir) throw new Error("Expected context-hub cache directory to exist");

      fs.rmSync(path.join(cacheRoot, mirrorDir, "repo"), { recursive: true, force: true });

      const showResult = await provider.show(makeContextHubRef("content/openai/docs/chat-api/python/DOC.md"));
      expect(showResult.name).toBe("openai/chat-api");
      expect(showResult.content).toContain("# Chat API");
    } finally {
      restoreFetch();
    }
  });
});
