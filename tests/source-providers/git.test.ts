import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache, saveConfig } from "../../src/core/config";
import { resolveSourceProviderFactory } from "../../src/sources/provider-factory";
import { ensureGitMirror, getCachePaths, parseGitRepoUrl, saveGitStash } from "../../src/sources/providers/git";

// Trigger self-registration
import "../../src/sources/providers/git";

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

function createRootLayoutGitRepo(): string {
  const repoDir = createTmpDir("akm-git-root-repo-");

  writeFile(
    path.join(repoDir, "README.md"),
    `---
description: Root readme
---
# Root Repo
`,
  );
  writeFile(
    path.join(repoDir, "skills", "demo", "SKILL.md"),
    `---
description: Demo skill
---
# Demo
`,
  );

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

describe("GitSourceProvider", () => {
  test("self-registers as 'git' only (legacy aliases removed)", () => {
    expect(resolveSourceProviderFactory("git")).toBeTruthy();
    expect(resolveSourceProviderFactory("context-hub")).toBeNull();
    expect(resolveSourceProviderFactory("github")).toBeNull();
  });

  test("provider exposes only the v1 SourceProvider surface (no search/show stubs)", () => {
    const factory = resolveSourceProviderFactory("git");
    expect(factory).toBeTruthy();
    // biome-ignore lint/style/noNonNullAssertion: factory is guaranteed by the expect above
    const provider = factory!({
      type: "git",
      url: "https://github.com/andrewyng/context-hub",
      name: "context-hub",
    });

    expect(provider.kind).toBe("git");
    expect(provider.name).toBe("context-hub");
    expect(typeof provider.path).toBe("function");
    expect(typeof provider.sync).toBe("function");
    // The v1 interface intentionally drops these stubs.
    expect((provider as unknown as { search?: unknown }).search).toBeUndefined();
    expect((provider as unknown as { show?: unknown }).show).toBeUndefined();
    expect((provider as unknown as { canShow?: unknown }).canShow).toBeUndefined();
  });

  test("path() returns the same value across calls (lifetime stability)", () => {
    const factory = resolveSourceProviderFactory("git");
    expect(factory).toBeTruthy();
    // biome-ignore lint/style/noNonNullAssertion: factory is guaranteed by the expect above
    const provider = factory!({
      type: "git",
      url: "https://github.com/andrewyng/context-hub",
      name: "test",
    });
    const first = provider.path();
    const second = provider.path();
    expect(second).toBe(first);
  });

  test("getCachePaths uses 'git-' prefix (not legacy 'context-hub-')", () => {
    const cachePaths = getCachePaths("https://github.com/example/repo");
    expect(path.basename(cachePaths.rootDir).startsWith("git-")).toBe(true);
    expect(path.basename(cachePaths.rootDir).startsWith("context-hub-")).toBe(false);
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

  test("cache mirror treats repo-root stash layouts as fresh extracted repos", async () => {
    const localRepoPath = createRootLayoutGitRepo();
    const repo = { cloneUrl: localRepoPath, ref: null as string | null, canonicalUrl: localRepoPath };
    const cachePaths = getCachePaths(repo.canonicalUrl);

    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });

    const skillPath = path.join(cachePaths.repoDir, "skills", "demo", "SKILL.md");
    fs.rmSync(skillPath);

    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });

    expect(fs.existsSync(skillPath)).toBe(false);
  });

  test("integrates with stash sources via ensureSourceCaches", async () => {
    // Pre-populate the cache so ensureGitMirror returns early without cloning
    const stashUrl = "https://github.com/andrewyng/context-hub";
    const repo = parseGitRepoUrl(stashUrl);
    const cachePaths = getCachePaths(repo.canonicalUrl);

    fs.mkdirSync(cachePaths.rootDir, { recursive: true });
    fs.mkdirSync(path.join(cachePaths.repoDir, "content"), { recursive: true });
    fs.writeFileSync(cachePaths.indexPath, "[]", { encoding: "utf8", mode: 0o600 });

    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "git", url: stashUrl, name: "context-hub" }],
    });
    resetConfigCache();

    const { ensureSourceCaches } = await import("../../src/indexer/search-source");
    const { loadConfig } = await import("../../src/core/config");
    const config = loadConfig();
    await ensureSourceCaches(config);

    // Verify git stash content dir appears in stash sources.
    const { resolveSourceEntries } = await import("../../src/indexer/search-source");
    const sources = resolveSourceEntries(undefined, config);
    const gitSource = sources.find((s) => s.path.includes(path.basename(cachePaths.rootDir)));
    expect(gitSource).toBeDefined();
  });
});

// ── saveGitStash commit message sanitization (issue #270) ───────────────────

describe("saveGitStash — commit message sanitization (issue #270)", () => {
  /** Initialise an empty git repo at the given dir. */
  function initRepo(dir: string): void {
    for (const args of [
      ["init", "--initial-branch=main"],
      ["config", "user.email", "test@akm.local"],
      ["config", "user.name", "akm-test"],
      ["config", "commit.gpgsign", "false"],
    ] as string[][]) {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }

  test("--message with embedded newlines is collapsed to a single line", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);
    // Stage some change to commit.
    writeFile(path.join(stashDir, "skills", "x.md"), "x\n");

    const malign = "feat: add skill\n\nCo-Authored-By: attacker <evil@example>";
    const result = saveGitStash(undefined, malign);
    expect(result.committed).toBe(true);

    const log = spawnSync("git", ["-C", stashDir, "log", "--format=%B%x00", "-1"], { encoding: "utf8" });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is the explicit record separator.
    const body = log.stdout.replace(/\x00\s*$/, "").replace(/\n$/, "");
    expect(body.includes("\n")).toBe(false);
    expect(body).toBe("feat: add skill Co-Authored-By: attacker <evil@example>");
  });

  test("--message with NUL byte is sanitized so commit succeeds", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "skills", "y.md"), "y\n");

    const malign = "subject\x00embedded";
    const result = saveGitStash(undefined, malign);
    expect(result.committed).toBe(true);

    const log = spawnSync("git", ["-C", stashDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.includes("\x00")).toBe(false);
    expect(log.stdout.trim()).toBe("subjectembedded");
  });

  test("--message that sanitizes to empty falls back to the timestamped default", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "skills", "z.md"), "z\n");

    // Whitespace + control chars only — must NOT result in an empty commit
    // subject; fall back to the timestamped default.
    const result = saveGitStash(undefined, "\n\r\x00 \t");
    expect(result.committed).toBe(true);

    const log = spawnSync("git", ["-C", stashDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.startsWith("akm save ")).toBe(true);
  });

  test("--message exceeding 4096 chars is clamped", () => {
    const stashDir = process.env.AKM_STASH_DIR as string;
    initRepo(stashDir);
    writeFile(path.join(stashDir, "skills", "w.md"), "w\n");

    const longMessage = `prefix-${"x".repeat(5000)}`;
    const result = saveGitStash(undefined, longMessage);
    expect(result.committed).toBe(true);

    const log = spawnSync("git", ["-C", stashDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim().length).toBeLessThanOrEqual(4096);
    expect(log.stdout.trim().startsWith("prefix-xxxx")).toBe(true);
  });
});
