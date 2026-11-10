import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { resolveSourceProviderFactory } from "../../../src/sources/provider-factory";
import {
  ensureGitMirror,
  getCachePaths,
  type ParsedRepoUrl,
  parseGitRepoUrl,
  saveGitStash,
} from "../../../src/sources/providers/git";
import { assertCleanWorktree, verifyClonedRevision } from "../../../src/sources/providers/git-install";
import { runCliCapture } from "../../_helpers/cli";
import {
  type Cleanup,
  type IsolatedAkmStorage,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withDefaultBundle,
  withEnv,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

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

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
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

let currentStashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
  currentStashDir = stashResult.dir;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitSourceProvider", () => {
  test("resolves 'git' only (legacy aliases removed)", () => {
    expect(resolveSourceProviderFactory("git")).toBeTruthy();
    expect(resolveSourceProviderFactory("context-hub")).toBeNull();
    expect(resolveSourceProviderFactory("github")).toBeNull();
  });

  test("provider exposes only the v1 SourceProvider surface (no search/show stubs)", () => {
    const factory = resolveSourceProviderFactory("git");
    expect(factory).toBeTruthy();
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

  test("a materialized mirror is not re-cloned however old it is; force re-clones it", async () => {
    const localRepoPath = createLocalGitRepo();
    const repo = { cloneUrl: localRepoPath, ref: null as string | null, canonicalUrl: localRepoPath };
    const cachePaths = getCachePaths(repo.canonicalUrl);

    // Prime the cache
    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });

    // Age the freshness marker far past any former refresh interval.
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(cachePaths.indexPath, longAgo, longAgo);

    // Remove the content to verify it is NOT re-cloned: age never triggers a fetch.
    const docPath = path.join(cachePaths.repoDir, "content", "openai", "docs", "chat-api", "python", "DOC.md");
    fs.rmSync(docPath);

    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });
    expect(fs.existsSync(docPath)).toBe(false);

    // `akm bundle update` forces a sync regardless of age.
    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true, force: true });
    expect(fs.existsSync(docPath)).toBe(true);
  });

  test("a mirror that was never materialized is cloned", async () => {
    const localRepoPath = createLocalGitRepo();
    const repo = { cloneUrl: localRepoPath, ref: null as string | null, canonicalUrl: localRepoPath };
    const cachePaths = getCachePaths(repo.canonicalUrl);
    const docPath = path.join(cachePaths.repoDir, "content", "openai", "docs", "chat-api", "python", "DOC.md");

    // No marker, no repo directory: first sync clones.
    expect(fs.existsSync(cachePaths.indexPath)).toBe(false);
    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });
    expect(fs.existsSync(docPath)).toBe(true);

    // A marker whose repo directory is gone is not a materialization: clone again.
    fs.rmSync(cachePaths.repoDir, { recursive: true, force: true });
    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });
    expect(fs.existsSync(docPath)).toBe(true);
  });

  test("a failed forced refresh reports the failure and keeps the previous copy, however recent the marker", async () => {
    const localRepoPath = createLocalGitRepo();
    const repo = { cloneUrl: localRepoPath, ref: null as string | null, canonicalUrl: localRepoPath };
    const cachePaths = getCachePaths(repo.canonicalUrl);
    const docPath = path.join(cachePaths.repoDir, "content", "openai", "docs", "chat-api", "python", "DOC.md");

    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });
    expect(fs.existsSync(docPath)).toBe(true);
    const markerBefore = fs.statSync(cachePaths.indexPath).mtimeMs;

    // The upstream disappears; the marker is seconds old, well inside the
    // former seven-day window that used to turn this failure into a success.
    fs.rmSync(localRepoPath, { recursive: true, force: true });

    await expect(ensureGitMirror(repo, cachePaths, { requireRepoDir: true, force: true })).rejects.toThrow();

    // The previous copy is still on disk and the marker was not advanced.
    expect(fs.existsSync(docPath)).toBe(true);
    expect(fs.statSync(cachePaths.indexPath).mtimeMs).toBe(markerBefore);

    // A plain (non-forced) sync keeps serving that copy without touching upstream.
    await ensureGitMirror(repo, cachePaths, { requireRepoDir: true });
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
      bundles: { "context-hub": { git: stashUrl } },
    });
    resetConfigCache();

    const { ensureSourceCaches } = await import("../../../src/indexer/search/search-source");
    const { loadConfig } = await import("../../../src/core/config/config");
    const config = loadConfig();
    await ensureSourceCaches(config);

    // Verify git stash content dir appears in stash sources.
    const { resolveSourceEntries } = await import("../../../src/indexer/search/search-source");
    const sources = resolveSourceEntries(undefined, config);
    const gitSource = sources.find((s) => s.path.includes(path.basename(cachePaths.rootDir)));
    expect(gitSource).toBeDefined();
  });
});

// ── saveGitStash commit message sanitization (issue #270) ───────────────────

describe("saveGitStash — commit message sanitization (issue #270)", () => {
  test("--message with embedded newlines is collapsed to a single line", () => {
    const stashDir = currentStashDir;
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
    const stashDir = currentStashDir;
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
    const stashDir = currentStashDir;
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
    const stashDir = currentStashDir;
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

describe("saveGitStash named stash resolution", () => {
  test("matches slash-containing configured stash names", () => {
    const stashUrl = "https://github.com/itlackey/akm-stash";
    const repo = parseGitRepoUrl(stashUrl);
    const cachePaths = getCachePaths(repo.canonicalUrl);
    initRepo(cachePaths.repoDir);

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "akm-stash": { git: stashUrl, registryId: "itlackey/akm-stash" } },
    });
    resetConfigCache();

    writeFile(path.join(cachePaths.repoDir, "skills", "named", "SKILL.md"), "# named\n");

    const result = saveGitStash("itlackey/akm-stash", "slash name");
    expect(result.committed).toBe(true);

    const log = spawnSync("git", ["-C", cachePaths.repoDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("slash name");
  });

  test("matches GitHub owner/repo shorthand against canonical git source URL", () => {
    const stashUrl = "https://github.com/itlackey/akm-stash";
    const repo = parseGitRepoUrl(stashUrl);
    const cachePaths = getCachePaths(repo.canonicalUrl);
    initRepo(cachePaths.repoDir);

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "akm-stash": { git: stashUrl } },
    });
    resetConfigCache();

    writeFile(path.join(cachePaths.repoDir, "skills", "owner-repo", "SKILL.md"), "# owner-repo\n");

    const result = saveGitStash("itlackey/akm-stash", "owner repo");
    expect(result.committed).toBe(true);

    const log = spawnSync("git", ["-C", cachePaths.repoDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("owner repo");
  });

  test("matches GitHub canonical identifiers with branch refs", () => {
    const stashUrl = "https://github.com/itlackey/akm-stash/tree/feature/save-fix";
    const repo = parseGitRepoUrl(stashUrl);
    const cachePaths = getCachePaths(repo.canonicalUrl);
    initRepo(cachePaths.repoDir);

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "akm-stash": { git: stashUrl } },
    });
    resetConfigCache();

    writeFile(path.join(cachePaths.repoDir, "skills", "branch-ref", "SKILL.md"), "# branch-ref\n");

    const result = saveGitStash("github:itlackey/akm-stash#feature/save-fix", "branch ref");
    expect(result.committed).toBe(true);

    const log = spawnSync("git", ["-C", cachePaths.repoDir, "log", "--format=%s", "-1"], { encoding: "utf8" });
    expect(log.stdout.trim()).toBe("branch ref");
  });
});

describe("assert-clean-worktree", () => {
  const tmpDirs: string[] = [];

  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clean-worktree-"));
    tmpDirs.push(dir);
    const run = (args: string[]) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    run(["init", "-q"]);
    fs.writeFileSync(path.join(dir, "tracked.md"), "a\n");
    run(["add", "."]);
    run(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
    return dir;
  }

  function message(dir: string): string {
    try {
      assertCleanWorktree(dir, "Subject", "has uncommitted changes; refusing.");
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  }

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("assertCleanWorktree", () => {
    test("passes on a clean repo", () => {
      expect(message(makeRepo())).toBe("");
    });

    test("names a modified tracked file", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "tracked.md"), "b\n");
      expect(message(dir)).toBe("Subject has uncommitted changes; refusing. Changed: tracked.md.");
    });

    test("names an untracked file and caps the list", () => {
      const dir = makeRepo();
      for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `new-${i}.md`), "x\n");
      const msg = message(dir);
      expect(msg).toContain("new-0.md");
      expect(msg).toContain("(and 2 more)");
      expect(msg).not.toContain("new-6.md");
    });

    test("reports a git failure instead of uncommitted changes", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-not-a-repo-"));
      tmpDirs.push(dir);
      const msg = message(dir);
      expect(msg).toContain("git status failed");
      expect(msg).not.toContain("uncommitted changes");
    });

    test("prints non-ASCII names as UTF-8", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "café.md"), "x\n");
      expect(message(dir)).toContain("Changed: café.md.");
    });

    test("reports a missing git binary", () => {
      const dir = makeRepo();
      const script = `import { assertCleanWorktree } from ${JSON.stringify(path.resolve("src/sources/providers/git-install.ts"))};
try { assertCleanWorktree(process.argv[1], "S", "dirty."); } catch (e) { console.log(e.message); }`;
      const result = spawnSync(process.execPath, ["-e", script, dir], {
        encoding: "utf8",
        env: { PATH: path.join(os.tmpdir(), "akm-no-such-bin") },
      });
      expect(result.stdout).toContain("git status failed");
      expect(result.stdout).not.toContain("exit undefined");
    });
  });
});

describe("git-add-materialization", () => {
  // INTEGRATION TEST — opens a real index and shells out to Git while exercising
  // the real bundle-add command. A process-scoped Git insteadOf rule maps the
  // HTTPS-shaped CLI input to a local fixture repository, so no network is used.

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
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, storage.stashDir));
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
});

describe("git-provider-sync-ahead", () => {
  const createdTmpDirs: string[] = [];

  function makeTempDir(prefix = "akm-git-ahead-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    createdTmpDirs.push(dir);
    return dir;
  }

  function git(args: string[], cwd?: string): string {
    const result = spawnSync("git", cwd ? ["-C", cwd, ...args] : args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    return result.stdout.trim();
  }

  afterAll(() => {
    for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("syncMirroredRepo: ahead with nothing to fast-forward is a no-op", () => {
    test("does not refuse, and keeps the local commit, when ahead > 0 and behind === 0", async () => {
      const root = makeTempDir();
      const remote = path.join(root, "remote.git");
      git(["init", "--bare", remote]);
      git(["init", "-b", "main", path.join(root, "seed")]);
      const seed = path.join(root, "seed");
      git(["config", "user.name", "AKM Test"], seed);
      git(["config", "user.email", "akm@example.test"], seed);
      fs.writeFileSync(path.join(seed, "seed.md"), "seed\n", "utf8");
      git(["add", "."], seed);
      git(["commit", "-m", "seed"], seed);
      git(["remote", "add", "origin", remote], seed);
      git(["push", "-u", "origin", "main"], seed);
      git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

      const cacheRoot = makeTempDir("akm-git-ahead-cache-");
      const repo: ParsedRepoUrl = { cloneUrl: remote, ref: null, canonicalUrl: remote };
      const cachePaths = getCachePaths(repo.canonicalUrl, cacheRoot);

      await ensureGitMirror(repo, cachePaths, { writable: true, force: true });

      const { repoDir } = cachePaths;
      git(["config", "user.name", "AKM Test"], repoDir);
      git(["config", "user.email", "akm@example.test"], repoDir);

      fs.writeFileSync(path.join(repoDir, "local-only.md"), "local commit\n", "utf8");
      git(["add", "."], repoDir);
      git(["commit", "-m", "local only, never pushed"], repoDir);

      await expect(ensureGitMirror(repo, cachePaths, { writable: true, force: true })).resolves.toBeUndefined();

      expect(fs.existsSync(path.join(repoDir, "local-only.md"))).toBe(true);
      expect(git(["log", "-1", "--format=%s"], repoDir)).toBe("local only, never pushed");
    });

    test("still refuses when ahead AND behind (a real merge is needed)", async () => {
      const root = makeTempDir();
      const remote = path.join(root, "remote.git");
      git(["init", "--bare", remote]);
      git(["init", "-b", "main", path.join(root, "seed")]);
      const seed = path.join(root, "seed");
      git(["config", "user.name", "AKM Test"], seed);
      git(["config", "user.email", "akm@example.test"], seed);
      fs.writeFileSync(path.join(seed, "seed.md"), "seed\n", "utf8");
      git(["add", "."], seed);
      git(["commit", "-m", "seed"], seed);
      git(["remote", "add", "origin", remote], seed);
      git(["push", "-u", "origin", "main"], seed);
      git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

      const cacheRoot = makeTempDir("akm-git-ahead-behind-cache-");
      const repo: ParsedRepoUrl = { cloneUrl: remote, ref: null, canonicalUrl: remote };
      const cachePaths = getCachePaths(repo.canonicalUrl, cacheRoot);
      await ensureGitMirror(repo, cachePaths, { writable: true, force: true });

      const { repoDir } = cachePaths;
      git(["config", "user.name", "AKM Test"], repoDir);
      git(["config", "user.email", "akm@example.test"], repoDir);

      fs.writeFileSync(path.join(repoDir, "local-only.md"), "local commit\n", "utf8");
      git(["add", "."], repoDir);
      git(["commit", "-m", "local only"], repoDir);

      fs.writeFileSync(path.join(seed, "upstream-only.md"), "upstream\n", "utf8");
      git(["add", "."], seed);
      git(["commit", "-m", "upstream commit"], seed);
      git(["push", "origin", "main"], seed);

      await expect(ensureGitMirror(repo, cachePaths, { writable: true, force: true })).rejects.toThrow(
        /unpushed commits/,
      );
    });
  });
});

describe("git-stash-out-of-step", () => {
  /**
   * `saveGitStash` (the end-of-run sync and `akm sync`) always commits the paths it
   * is given. A branch it cannot push — no upstream — only skips the push, and the result says
   * why. A branch that is ahead of its upstream (an accept commits locally) is pushed along with
   * the new commit. Behind or diverged branches fetch and merge first (git-sync-two-host.test.ts).
   */

  const tempDirs: string[] = [];
  let remoteDir = "";
  let workDir = "";

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout.replace(/\n$/, "");
  }

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  /** Commit `file` in `cwd` and return its subject, the way a person (or another machine) would. */
  function commitFile(cwd: string, file: string, subject: string): void {
    fs.writeFileSync(path.join(cwd, file), `${subject}\n`);
    git(cwd, "add", file);
    git(cwd, "commit", "-m", subject);
  }

  function configure(cwd: string): void {
    git(cwd, "config", "user.email", "test@akm.local");
    git(cwd, "config", "user.name", "akm test");
  }

  /** A work tree on `main` with one pushed seed commit; `track: false` leaves it without an upstream. */
  function setup(track: boolean): void {
    remoteDir = tempDir("akm-oos-remote-");
    workDir = tempDir("akm-oos-work-");
    git(remoteDir, "init", "--bare", "--initial-branch=main");
    git(workDir, "init", "--initial-branch=main");
    configure(workDir);
    git(workDir, "remote", "add", "origin", remoteDir);
    commitFile(workDir, "README.md", "seed");
    if (track) git(workDir, "push", "-u", "origin", "main");
  }

  /** The remote moves on without the work tree, which has not fetched. */
  function advanceRemote(): void {
    const other = tempDir("akm-oos-other-");
    git(other, "clone", remoteDir, ".");
    configure(other);
    commitFile(other, "elsewhere.md", "pushed from elsewhere");
    git(other, "push", "origin", "main");
  }

  const save = () => {
    fs.writeFileSync(path.join(workDir, "run.md"), "run output\n");
    return saveGitStash(undefined, "end of run", true, { repoDir: workDir, paths: ["run.md"] });
  };
  const remoteSubject = () => git(remoteDir, "log", "-1", "--format=%s", "main");

  beforeEach(() => {
    remoteDir = "";
    workDir = "";
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("saveGitStash with a branch it cannot push", () => {
    test("no upstream: commits and skips the push, saying so", () => {
      setup(false);

      const result = save();

      expect(result).toMatchObject({ committed: true, pushed: false, skipped: false });
      expect(result.reason).toContain("no upstream");
      expect(git(workDir, "log", "-1", "--format=%s")).toBe("end of run");
    });

    test("behind its upstream: fetches, merges, and pushes the merge", () => {
      setup(true);
      advanceRemote();

      const result = save();

      expect(result).toMatchObject({ committed: true, pushed: true, skipped: false });
      expect(result.reason).toBeUndefined();
      expect(remoteSubject()).toContain("merge");
      expect(git(remoteDir, "log", "--format=%s", "main")).toContain("pushed from elsewhere");
      expect(git(workDir, "log", "--format=%s", "main")).toContain("end of run");
    });

    test("ahead of its upstream: pushes the new commit together with the unpushed ones", () => {
      setup(true);
      commitFile(workDir, "local.md", "local commit");

      const result = save();

      expect(result).toMatchObject({ committed: true, pushed: true });
      expect(result.reason).toBeUndefined();
      expect(remoteSubject()).toBe("end of run");
      expect(git(remoteDir, "log", "--format=%s", "main")).toContain("local commit");
    });
  });
});

describe("git-install-revision-verify", () => {
  /**
   * R-011: `doSyncGit` resolved a git revision via a SEPARATE `git ls-remote`
   * round-trip (`resolveGitArtifact` / `resolveGithubArtifact` in
   * `registry/resolve.ts`) before cloning, then reported that PRE-clone
   * revision as `resolvedRevision` in the returned lock data without ever
   * comparing it to what actually got cloned. `verifyClonedRevision` closes
   * that gap: it re-derives the actual cloned HEAD and fails loudly on a
   * mismatch instead of silently trusting the earlier resolution.
   *
   * These tests exercise `verifyClonedRevision` directly against real local
   * git repos (no network) — the full `doSyncGit`/`syncGitRef` pipeline
   * additionally requires a `https/http/ssh/git` URL scheme (`validateGitUrl`
   * deliberately rejects bare local paths and `file:`), which would require
   * standing up a real git-over-the-wire server to exercise end-to-end; the
   * unit boundary tested here is where the R-011 fix actually lives.
   */

  const createdTmpDirs: string[] = [];

  function makeTempDir(prefix = "akm-clone-verify-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    createdTmpDirs.push(dir);
    return dir;
  }

  function git(cwd: string, args: string[]): string {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** A real bare repo + a real shallow clone of it, exactly like `doSyncGit` produces. */
  function makeClonedFixture(): { remote: string; cloneDir: string; headSha: string } {
    const root = makeTempDir();
    const remote = path.join(root, "remote.git");
    const author = path.join(root, "author");
    const cloneDir = path.join(root, "clone");
    spawnSync("git", ["init", "--quiet", "--bare", remote]);
    spawnSync("git", ["init", "--quiet", "-b", "main", author]);
    git(author, ["config", "user.name", "AKM Test"]);
    git(author, ["config", "user.email", "akm@example.test"]);
    fs.writeFileSync(path.join(author, "a.txt"), "hello\n");
    git(author, ["add", "."]);
    git(author, ["commit", "--quiet", "-m", "seed"]);
    git(author, ["remote", "add", "origin", remote]);
    git(author, ["push", "--quiet", "-u", "origin", "main"]);
    git(root, ["clone", "--quiet", "--depth", "1", "--branch", "main", remote, cloneDir]);
    const headSha = git(cloneDir, ["rev-parse", "HEAD"]);
    return { remote, cloneDir, headSha };
  }

  afterAll(() => {
    for (const dir of createdTmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("verifyClonedRevision", () => {
    test("does not throw when the cloned HEAD matches the resolved revision", () => {
      const { cloneDir, headSha } = makeClonedFixture();
      expect(() => verifyClonedRevision(cloneDir, "https://example.test/repo.git", headSha)).not.toThrow();
    });

    test("throws when no revision was resolved (undefined) instead of silently skipping verification", () => {
      const { cloneDir } = makeClonedFixture();
      expect(() => verifyClonedRevision(cloneDir, "https://example.test/repo.git", undefined)).toThrow(
        /No revision was resolved/,
      );
    });

    test("throws when the cloned HEAD does NOT match the resolved revision", () => {
      const { cloneDir } = makeClonedFixture();
      const bogusRevision = "0123456789abcdef0123456789abcdef01234567";
      expect(() => verifyClonedRevision(cloneDir, "https://example.test/repo.git", bogusRevision)).toThrow(
        /does not match the revision resolved from/,
      );
    });

    test("peels an annotated-tag OBJECT id to its underlying commit before comparing", () => {
      // git ls-remote on an annotated tag reports the TAG OBJECT sha, not the
      // commit it points to — resolveGitRevisionFromRemote (registry/resolve.ts)
      // returns that object id verbatim. A naive string-equality check against
      // `git rev-parse HEAD` (which always reports a commit) would treat every
      // annotated-tag install as a false-positive mismatch.
      const root = makeTempDir();
      const remote = path.join(root, "remote.git");
      const author = path.join(root, "author");
      const cloneDir = path.join(root, "clone");
      spawnSync("git", ["init", "--quiet", "--bare", remote]);
      spawnSync("git", ["init", "--quiet", "-b", "main", author]);
      git(author, ["config", "user.name", "AKM Test"]);
      git(author, ["config", "user.email", "akm@example.test"]);
      fs.writeFileSync(path.join(author, "a.txt"), "hello\n");
      git(author, ["add", "."]);
      git(author, ["commit", "--quiet", "-m", "seed"]);
      git(author, ["tag", "-a", "v1", "-m", "annotated tag"]);
      git(author, ["remote", "add", "origin", remote]);
      git(author, ["push", "--quiet", "-u", "origin", "main"]);
      git(author, ["push", "--quiet", "origin", "v1"]);
      git(root, ["clone", "--quiet", "--depth", "1", "--branch", "v1", remote, cloneDir]);

      const tagObjectSha = git(author, ["rev-parse", "v1"]);
      const commitSha = git(cloneDir, ["rev-parse", "HEAD"]);
      expect(tagObjectSha).not.toBe(commitSha); // sanity: really is an annotated tag

      expect(() => verifyClonedRevision(cloneDir, remote, tagObjectSha)).not.toThrow();
    });

    test("error message names the clone dir, the url, and both revisions", () => {
      const { cloneDir, headSha } = makeClonedFixture();
      const bogusRevision = "f".repeat(40);
      let message = "";
      try {
        verifyClonedRevision(cloneDir, "https://example.test/mismatch.git", bogusRevision);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain(cloneDir);
      expect(message).toContain("https://example.test/mismatch.git");
      expect(message).toContain(bogusRevision);
      expect(message).toContain(headSha);
    });
  });
});
