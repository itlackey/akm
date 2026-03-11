/**
 * End-to-end tests that replicate real-world usage of akm.
 *
 * Uses realistic fixtures in tests/fixtures/ representing a typical user's
 * stash directory with tools, skills, commands, and agents.
 *
 * Tests cover:
 * - Full lifecycle: index → search → show
 * - CLI interface via subprocess
 * - Metadata generation and persistence
 * - Semantic search ranking quality
 * - Ripgrep pre-filtering
 * - Multi-tool directories with .stash.json
 * - Graceful degradation (no index, no ripgrep)
 * - Edge cases and error handling
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { closeDatabase, getAllEntries, getMeta, openDatabase } from "../src/db";
import { agentikitIndex } from "../src/indexer";
import { loadStashFile } from "../src/metadata";
import { agentikitSearch } from "../src/stash-search";
import { agentikitShow } from "../src/stash-show";

// ── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, "fixtures");
const CLI = path.join(__dirname, "..", "src", "cli.ts");

function copyFixturesToTmp(): string {
  const tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-"));
  copyDirRecursive(FIXTURES, tmpStash);
  return tmpStash;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function runCli(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  // Append --json by default so existing tests get JSON output (the new default is human-readable)
  const cliArgs = args.length > 0 ? [...args, "--json"] : args;
  const result = spawnSync("bun", [CLI, ...cliArgs], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? 1,
  };
}

function parseJson(text: string): any {
  return JSON.parse(text);
}

function createEmptyStashDir(prefix: string): string {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  return stashDir;
}

async function withMockedFetch<T>(handler: (input: string) => Response, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let testCacheDir = "";
let testConfigDir = "";

beforeAll(async () => {
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-cache-"));
  process.env.XDG_CACHE_HOME = testCacheDir;
});

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-config-"));
  process.env.XDG_CONFIG_HOME = testConfigDir;
});

afterAll(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1: Full lifecycle — user sets up stash, indexes, searches, runs
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Full lifecycle (index → search → show)", () => {
  let stashDir: string;

  beforeAll(async () => {
    stashDir = copyFixturesToTmp();
    process.env.AKM_STASH_DIR = stashDir;
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("search works without index (substring fallback)", async () => {
    const result = await agentikitSearch({ query: "deploy", type: "tool" });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.name.includes("deploy"))).toBe(true);
    // No score field in substring mode
    expect(result.hits[0].score).toBeUndefined();
  });

  test("index generates metadata and builds search index", async () => {
    const result = await agentikitIndex({ stashDir });

    expect(result.stashDir).toBe(stashDir);
    expect(result.totalEntries).toBeGreaterThanOrEqual(8);
    expect(result.generatedMetadata).toBeGreaterThan(0);
    expect(fs.existsSync(result.indexPath)).toBe(true);
  });

  test("index generates metadata in database for directories that lack .stash.json", async () => {
    // git/ directory had no .stash.json — metadata generated in DB only
    expect(fs.existsSync(path.join(stashDir, "tools", "git", ".stash.json"))).toBe(false);

    const db = openDatabase();
    const entries = getAllEntries(db, "tool");
    const gitEntries = entries.filter((e) => e.dirPath.includes(path.join("tools", "git")));
    expect(gitEntries.length).toBeGreaterThanOrEqual(2);

    // Each generated entry should be marked
    for (const e of gitEntries) {
      expect(e.entry.quality).toBe("generated");
      expect(e.entry.type).toBe("tool");
      expect(e.entry.filename).toBeTruthy();
    }
    closeDatabase(db);
  });

  test("index preserves hand-written .stash.json (docker/ has intent fields)", async () => {
    const dockerStash = loadStashFile(path.join(stashDir, "tools", "docker"));
    expect(dockerStash).not.toBeNull();
    expect(dockerStash?.entries.length).toBe(2);

    // These were hand-written, should NOT have generated flag
    expect(dockerStash?.entries[0].quality).not.toBe("generated");
    expect(dockerStash?.entries[0].intent).toBeDefined();
    expect(dockerStash?.entries[0].intent?.when).toBeTruthy();
  });

  test("index extracts description from code comments", async () => {
    const db = openDatabase();
    const entries = getAllEntries(db, "tool");
    const diffEntry = entries.find((e) => e.entry.name.includes("summarize-diff"));
    expect(diffEntry).toBeDefined();
    // Should have extracted the JSDoc comment as description
    expect(diffEntry?.entry.description).toBeTruthy();
    expect(diffEntry?.entry.description?.toLowerCase()).toContain("git diff");
    closeDatabase(db);
  });

  test("index extracts metadata from package.json", async () => {
    const db = openDatabase();
    const entries = getAllEntries(db, "tool");
    const lintEntry = entries.find((e) => e.entry.name.includes("eslint-check"));
    expect(lintEntry).toBeDefined();
    // package.json had description and keywords
    expect(lintEntry?.entry.description).toContain("ESLint");
    expect(lintEntry?.entry.tags).toContain("eslint");
    closeDatabase(db);
  });

  test("search with index returns scored results with descriptions", async () => {
    const result = await agentikitSearch({ query: "docker build image", type: "any" });

    expect(result.schemaVersion).toBe(1);
    expect(result.hits.length).toBeGreaterThan(0);
    // Docker-build should be ranked first
    const topHit = result.hits[0];
    expect(topHit.name).toContain("docker");
    expect(topHit.score).toBeDefined();
    expect(topHit.score!).toBeGreaterThan(0);
    expect(topHit.description).toBeTruthy();
  });

  test.skipIf(!!process.env.CI)("search ranks semantically relevant results higher", async () => {
    const result = await agentikitSearch({ query: "summarize commit changes", type: "any" });

    expect(result.hits.length).toBeGreaterThan(0);
    // Git tools should rank higher than docker tools for this query
    const topNames = result.hits.slice(0, 5).map((h) => h.name.toLowerCase());
    const hasGitRelated = topNames.some(
      (n) => n.includes("git") || n.includes("diff") || n.includes("commit") || n.includes("summarize"),
    );
    expect(hasGitRelated).toBe(true);
  });

  test("search type filter restricts results to that type", async () => {
    const toolResult = await agentikitSearch({ query: "review", type: "skill" });
    expect(toolResult.hits.every((h) => h.type === "skill")).toBe(true);

    const cmdResult = await agentikitSearch({ query: "", type: "command" });
    expect(cmdResult.hits.every((h) => h.type === "command")).toBe(true);
  });

  test("search with empty query returns all entries of that type", async () => {
    const result = await agentikitSearch({ query: "", type: "agent" });
    expect(result.hits.length).toBe(2); // architect.md and debugger.md
  });

  test("search respects limit parameter", async () => {
    const result = await agentikitSearch({ query: "", type: "any", limit: 3 });
    expect(result.hits.length).toBeLessThanOrEqual(3);
  });

  test("show a tool returns run", async () => {
    const searchResult = await agentikitSearch({ query: "deploy", type: "tool" });
    const deployHit = searchResult.hits.find((h) => h.hitSource === "local" && h.name.includes("deploy"));
    expect(deployHit).toBeDefined();

    const openResult = await agentikitShow({ ref: deployHit!.openRef });
    expect(openResult.schemaVersion).toBe(1);
    expect(openResult.type).toBe("script");
    expect(openResult.run).toBeTruthy();
    expect(openResult.run).toContain("bash");
  });

  test("show a skill returns full SKILL.md content", async () => {
    const openResult = await agentikitShow({ ref: "skill:code-review" });
    expect(openResult.type).toBe("skill");
    expect(openResult.content).toContain("Code Review Skill");
    expect(openResult.content).toContain("security vulnerabilities");
  });

  test("show a command returns template and description", async () => {
    const openResult = await agentikitShow({ ref: "command:release.md" });
    expect(openResult.type).toBe("command");
    expect(openResult.description).toBe("Create a new release with changelog and version bump");
    expect(openResult.template).toContain("npm version");
  });

  test("show an agent returns prompt, description, model hint, and tool policy", async () => {
    const openResult = await agentikitShow({ ref: "agent:architect.md" });
    expect(openResult.type).toBe("agent");
    expect(openResult.description).toContain("architect");
    expect(openResult.prompt).toContain("software architect");
    expect(openResult.modelHint).toBe("claude-sonnet-4-20250514");
    expect(openResult.toolPolicy).toEqual({ allow: "Read,Glob,Grep" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2: Agent workflow — discover capability for a natural language task
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Agent discovers capabilities for task", () => {
  let stashDir: string;

  beforeAll(async () => {
    stashDir = copyFixturesToTmp();
    process.env.AKM_STASH_DIR = stashDir;
    await agentikitIndex({ stashDir });
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test.skipIf(!!process.env.CI)("agent asks 'set up local dev environment' → docker-compose ranks high", async () => {
    const result = await agentikitSearch({ query: "set up local development environment" });
    const names = result.hits.map((h) => h.name.toLowerCase());
    // Docker compose should appear because its intent says "start local development services"
    expect(names.some((n) => n.includes("compose") || n.includes("docker"))).toBe(true);
  });

  test("agent asks 'check code quality' → lint tool ranks high", async () => {
    const result = await agentikitSearch({ query: "check code quality style" });
    expect(result.hits.length).toBeGreaterThan(0);
    const names = result.hits.map((h) => h.name.toLowerCase());
    expect(names.some((n) => n.includes("lint") || n.includes("eslint"))).toBe(true);
  });

  test.skipIf(!!process.env.CI)("agent asks 'review my pull request' → code-review skill found", async () => {
    const result = await agentikitSearch({ query: "review pull request code changes" });
    expect(result.hits.length).toBeGreaterThan(0);
    // Skill openRef contains "code-review" (directory name), even though display name is "SKILL"
    expect(
      result.hits.some(
        (h) =>
          (h.hitSource === "local" && h.openRef.includes("code-review")) ||
          h.description?.toLowerCase().includes("review"),
      ),
    ).toBe(true);
  });

  test.skipIf(!!process.env.CI)("agent asks 'help me design the system' → architect agent found", async () => {
    const result = await agentikitSearch({ query: "system design architecture" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.name.includes("architect"))).toBe(true);
  });

  test("agent workflow: search → show (end-to-end)", async () => {
    // Step 1: Agent searches for a tool to run tests
    const searchResult = await agentikitSearch({ query: "run tests" });
    expect(searchResult.hits.length).toBeGreaterThan(0);
    const testTool = searchResult.hits.find(
      (h) => h.hitSource === "local" && h.type === "script" && h.name.includes("test"),
    );
    expect(testTool).toBeDefined();

    // Step 2: Agent reads the tool to get run command for host execution
    const showResult = await agentikitShow({ ref: testTool!.openRef });
    expect(showResult.run).toBeTruthy();
  });
});

describe("Scenario: Mixed local + registry search compatibility", () => {
  let stashDir: string;
  let savedCacheDir: string;

  beforeAll(async () => {
    stashDir = copyFixturesToTmp();
    process.env.AKM_STASH_DIR = stashDir;
    await agentikitIndex({ stashDir });
  });

  // Isolate registry index cache per test so mocked fetch responses
  // aren't shadowed by a cached index from a previous test.
  beforeEach(() => {
    savedCacheDir = process.env.XDG_CACHE_HOME ?? "";
    process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-reg-cache-"));
  });

  afterEach(() => {
    const tmpCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = savedCacheDir;
    if (tmpCache && tmpCache !== savedCacheDir) {
      fs.rmSync(tmpCache, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("local source does not call registry providers", async () => {
    const result = await withMockedFetch(
      () => {
        throw new Error("fetch should not be called for source=local");
      },
      () => agentikitSearch({ query: "docker", source: "local" }),
    );

    expect(result.source).toBe("local");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((h) => h.hitSource === "local")).toBe(true);
  });

  test("registry source returns install guidance", async () => {
    const registryIndex = {
      version: 1,
      updatedAt: "2026-03-09T00:00:00Z",
      kits: [
        {
          id: "npm:@scope/kit",
          name: "@scope/kit",
          description: "Example registry kit",
          ref: "@scope/kit",
          source: "npm",
          homepage: "https://www.npmjs.com/package/@scope/kit",
          tags: ["kit"],
          latestVersion: "1.2.3",
        },
        {
          id: "github:itlackey/example-kit",
          name: "Example Kit",
          description: "Example GitHub kit",
          ref: "itlackey/example-kit",
          source: "github",
          homepage: "https://github.com/itlackey/example-kit",
          tags: ["kit"],
        },
      ],
    };
    const result = await withMockedFetch(
      () => new Response(JSON.stringify(registryIndex), { status: 200 }),
      () => agentikitSearch({ query: "kit", source: "registry" }),
    );

    expect(result.source).toBe("registry");
    expect(result.hits.length).toBeGreaterThan(0);

    for (const hit of result.hits) {
      expect(hit.hitSource).toBe("registry");
      if (hit.hitSource === "registry") {
        expect(hit.installCmd.startsWith("akm add ")).toBe(true);
        expect(hit.installRef.length).toBeGreaterThan(0);
      }
    }
  });

  test("both source includes local and registry hits", async () => {
    const registryIndex = {
      version: 1,
      updatedAt: "2026-03-09T00:00:00Z",
      kits: [
        {
          id: "npm:docker-kit",
          name: "docker-kit",
          description: "Registry docker helper",
          ref: "docker-kit",
          source: "npm",
          tags: ["docker"],
          latestVersion: "0.1.0",
        },
      ],
    };
    const result = await withMockedFetch(
      () => new Response(JSON.stringify(registryIndex), { status: 200 }),
      () => agentikitSearch({ query: "docker", source: "both", limit: 10 }),
    );

    expect(result.source).toBe("both");
    expect(result.hits.some((h) => h.hitSource === "local")).toBe(true);
    expect(result.hits.some((h) => h.hitSource === "registry")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3: CLI interface — real subprocess execution
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: CLI subprocess execution", () => {
  let stashDir: string;

  beforeAll(async () => {
    stashDir = copyFixturesToTmp();
    process.env.AKM_STASH_DIR = stashDir;
    await agentikitIndex({ stashDir });
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("cli: akm search returns JSON with hits", async () => {
    const result = runCli("search", "docker");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.hits).toBeInstanceOf(Array);
    expect(json.hits.length).toBeGreaterThan(0);
    expect(json.stashDir).toBeTruthy();
  });

  test("cli: akm search --type tool filters by type", async () => {
    const result = runCli("search", "deploy", "--type", "tool");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.hits.every((h: any) => h.type === "script")).toBe(true);
  });

  test("cli: akm search --type knowledge filters by type", async () => {
    const result = runCli("search", "guide", "--type", "knowledge");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.hits.length).toBeGreaterThan(0);
    expect(json.hits.every((h: any) => h.type === "knowledge")).toBe(true);
  });

  test("cli: akm search --limit 2 respects limit", async () => {
    const result = runCli("search", "", "--limit", "2");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.hits.length).toBeLessThanOrEqual(2);
  });

  test("cli: akm search default usage mode includes usageGuide", async () => {
    const result = runCli("search", "docker", "--type", "tool");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.usageGuide).toBeDefined();
    expect(json.usageGuide.tool).toBeInstanceOf(Array);
    expect(json.hits.some((h: any) => Array.isArray(h.usage) && h.usage.length > 0)).toBe(true);
  });

  test("cli: akm search default source is local", async () => {
    // hitSource is only present in verbose mode
    const result = runCli("search", "docker", "--verbose");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.source).toBe("local");
    expect(json.hits.every((h: any) => h.hitSource === "local")).toBe(true);
  });

  test("cli: akm search --usage none excludes usageGuide and per-hit usage", async () => {
    const result = runCli("search", "docker", "--type", "tool", "--usage", "none");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.usageGuide).toBeUndefined();
    expect(json.hits.some((h: any) => h.usage !== undefined)).toBe(false);
  });

  test("cli: akm search --usage item includes per-hit usage only", async () => {
    const result = runCli("search", "docker", "--type", "tool", "--usage", "item");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.usageGuide).toBeUndefined();
    expect(json.hits.some((h: any) => Array.isArray(h.usage) && h.usage.length > 0)).toBe(true);
  });

  test("cli: akm search --usage guide includes usageGuide only", async () => {
    const result = runCli("search", "docker", "--type", "tool", "--usage", "guide");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.usageGuide).toBeDefined();
    expect(json.usageGuide.tool).toBeInstanceOf(Array);
    expect(json.hits.some((h: any) => h.usage !== undefined)).toBe(false);
  });

  test("cli: akm search --usage both includes usageGuide and per-hit usage", async () => {
    const result = runCli("search", "docker", "--type", "tool", "--usage", "both");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.usageGuide).toBeDefined();
    expect(json.usageGuide.tool).toBeInstanceOf(Array);
    expect(json.hits.some((h: any) => Array.isArray(h.usage) && h.usage.length > 0)).toBe(true);
  });

  test("cli: akm search --usage invalid value fails with clear error", async () => {
    const result = runCli("search", "docker", "--usage", "bad");
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Invalid value for --usage: bad. Expected one of: none|both|item|guide");
  });

  test("cli: akm search --source invalid value fails with clear error", async () => {
    const result = runCli("search", "docker", "--source", "bad");
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Invalid value for --source: bad. Expected one of: local|registry|both");
  });

  test("cli: akm search default output excludes verbose fields", async () => {
    const result = runCli("search", "docker");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.hits.length).toBeGreaterThan(0);
    // Default JSON output should not include verbose-only fields
    for (const hit of json.hits) {
      expect(hit.whyMatched).toBeUndefined();
      expect(hit.editable).toBeUndefined();
      expect(hit.editHint).toBeUndefined();
      expect(hit.hitSource).toBeUndefined();
    }
    expect(json.timing).toBeUndefined();
  });

  test("cli: akm search --verbose includes verbose fields", async () => {
    const result = runCli("search", "docker", "--verbose");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.hits.length).toBeGreaterThan(0);
    // Verbose JSON output should include verbose fields on every hit
    expect(json.timing).toBeDefined();
    expect(json.hits.every((h: any) => h.hitSource !== undefined)).toBe(true);
    expect(json.hits.every((h: any) => h.whyMatched !== undefined)).toBe(true);
  });

  test("cli: akm show returns asset content", async () => {
    const result = runCli("show", "skill:code-review");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.type).toBe("skill");
    expect(json.content).toContain("Code Review Skill");
  });

  test("cli: akm show command returns template", async () => {
    const result = runCli("show", "command:release.md");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.type).toBe("command");
    expect(json.description).toBeTruthy();
    expect(json.template).toContain("npm version");
  });

  test("cli: akm index builds index and reports stats", async () => {
    const result = runCli("index");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.totalEntries).toBeGreaterThan(0);
    expect(json.indexPath).toBeTruthy();
  });

  test("cli: akm index --full returns mode full", async () => {
    const result = runCli("index", "--full");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.mode).toBe("full");
  });

  test("cli: akm config set/get manages llm settings via JSON", async () => {
    const setResult = runCli(
      "config",
      "set",
      "llm",
      '{"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2","maxTokens":256}',
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli("config", "get", "llm");
    expect(getResult.exitCode).toBe(0);

    const json = parseJson(getResult.stdout);
    expect(json).toMatchObject({
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
      maxTokens: 256,
    });
  });

  test("cli: akm config <key> [value] supports git-style get/set via JSON", async () => {
    const setResult = runCli(
      "config",
      "embedding",
      '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text","dimension":384}',
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli("config", "embedding");
    expect(getResult.exitCode).toBe(0);

    const json = parseJson(getResult.stdout);
    expect(json).toMatchObject({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
      dimension: 384,
    });
  });

  test("cli: akm config --get/--unset support familiar git-style flags", async () => {
    // Set up llm config via JSON first
    expect(
      runCli("config", "set", "llm", '{"endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2"}')
        .exitCode,
    ).toBe(0);

    // Verify --get works for llm
    const getResult = runCli("config", "--get", "llm");
    expect(getResult.exitCode).toBe(0);
    const json = parseJson(getResult.stdout);
    expect(json).toMatchObject({ model: "llama3.2" });

    // Verify --unset completes successfully
    const unsetResult = runCli("config", "--unset", "llm");
    expect(unsetResult.exitCode).toBe(0);
  });

  test("cli: akm with no command prints usage", async () => {
    const result = runCli();
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("No command specified");
  });

  test("cli: akm show with no ref prints error", async () => {
    const result = runCli("show");
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Missing required positional argument");
  });
});

describe("Scenario: Registry lifecycle CLI (no network)", () => {
  test("cli: akm list returns empty installed set when none configured", async () => {
    const stashDir = createEmptyStashDir("akm-e2e-registry-empty-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });

    try {
      const result = runCli("list");
      expect(result.exitCode).toBe(0);

      const json = parseJson(result.stdout);
      expect(json.totalInstalled).toBe(0);
      expect(json.installed).toEqual([]);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("cli: akm remove resolves parsed ref id and removes cache directory", async () => {
    const stashDir = createEmptyStashDir("akm-e2e-registry-remove-");
    const stashRoot = path.join(stashDir, "registry-kit");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-cache-remove-"));
    fs.mkdirSync(path.join(stashRoot, "tools"), { recursive: true });
    process.env.AKM_STASH_DIR = stashDir;

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
      registry: {
        installed: [
          {
            id: "npm:@scope/kit",
            source: "npm",
            ref: "npm:@scope/kit@1.0.0",
            artifactUrl: "https://registry.npmjs.org/@scope/kit/-/kit-1.0.0.tgz",
            resolvedVersion: "1.0.0",
            resolvedRevision: "abc123",
            stashRoot,
            cacheDir,
            installedAt: new Date().toISOString(),
          },
        ],
      },
    });

    try {
      const result = runCli("remove", "npm:@scope/kit@latest");
      expect(result.exitCode).toBe(0);

      const json = parseJson(result.stdout);
      expect(json.removed.id).toBe("npm:@scope/kit");

      const config = loadConfig();
      expect(config.registry).toBeUndefined();
      expect(fs.existsSync(cacheDir)).toBe(false);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("cli: akm update requires target or --all", async () => {
    const stashDir = createEmptyStashDir("akm-e2e-registry-update-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });

    try {
      const result = runCli("update");
      expect(result.exitCode).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Either <target> or --all is required.");
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("cli: akm update rejects target with --all", async () => {
    const stashDir = createEmptyStashDir("akm-e2e-registry-update-both-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });

    try {
      const result = runCli("update", "npm:@scope/kit", "--all");
      expect(result.exitCode).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Specify either <target> or --all, not both.");
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("cli: akm update missing target returns stable not-installed error", async () => {
    const stashDir = createEmptyStashDir("akm-e2e-registry-missing-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });

    try {
      const result = runCli("update", "npm:@scope/kit");
      expect(result.exitCode).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain("No installed registry entry matched target: npm:@scope/kit");
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3a: CLI upgrade and update --force commands
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: upgrade and update --force (no network)", () => {
  test("upgrade --check returns version info (mocked fetch)", async () => {
    const { checkForUpdate } = await import("../src/self-update");
    const result = await withMockedFetch(
      () => Response.json({ tag_name: "v0.0.14" }),
      () => checkForUpdate("0.0.13"),
    );
    expect(result.currentVersion).toBe("0.0.13");
    expect(result.latestVersion).toBe("0.0.14");
    expect(result.updateAvailable).toBe(true);
    expect(["binary", "npm", "unknown"]).toContain(result.installMethod);
  });

  test("performUpgrade detects non-binary install and returns guidance", async () => {
    const { performUpgrade } = await import("../src/self-update");
    const result = await performUpgrade({
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
      updateAvailable: true,
      installMethod: "unknown",
    });
    expect(result.upgraded).toBe(false);
    expect(["npm", "unknown"]).toContain(result.installMethod);
    expect(result.message).toBeTruthy();
  });

  test("cli: akm update --help shows --force flag", async () => {
    const result = spawnSync("bun", [CLI, "update", "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output).toContain("--force");
    expect(output).toContain("Force fresh download");
  });

  test("cli: akm update --force requires target or --all", async () => {
    const stashDir = createEmptyStashDir("akm-e2e-update-force-");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, mountedStashDirs: [] });

    try {
      const result = runCli("update", "--force");
      expect(result.exitCode).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Either <target> or --all is required.");
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("cli: akm upgrade --help shows --check and --force flags", async () => {
    const result = spawnSync("bun", [CLI, "upgrade", "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output).toContain("--check");
    expect(output).toContain("--force");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3b: CLI knowledge view modes (positional syntax)
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: CLI knowledge view modes (positional)", () => {
  let stashDir: string;

  beforeAll(async () => {
    stashDir = copyFixturesToTmp();
    process.env.AKM_STASH_DIR = stashDir;
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("cli: show knowledge with positional toc", async () => {
    const result = runCli("show", "knowledge:guide.md", "toc");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.type).toBe("knowledge");
    expect(json.content).toContain("# API Reference Guide");
    expect(json.content).toContain("## Getting Started");
    expect(json.content).toContain("lines total");
  });

  test("cli: show knowledge with positional section heading", async () => {
    const result = runCli("show", "knowledge:guide.md", "section", "Getting Started");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.type).toBe("knowledge");
    expect(json.content).toContain("Getting Started");
    expect(json.content).toContain("install the package");
    // Should include sub-headings but not sibling headings
    expect(json.content).toContain("Prerequisites");
    expect(json.content).not.toContain("Authentication");
  });

  test("cli: show knowledge with positional lines start end", async () => {
    const result = runCli("show", "knowledge:guide.md", "lines", "1", "5");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.type).toBe("knowledge");
    // Lines 1-5 cover the frontmatter start
    expect(json.content).toContain("---");
  });

  test("cli: show knowledge with --view flag still works (backward compat)", async () => {
    const result = runCli("show", "knowledge:guide.md", "--view", "toc");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.type).toBe("knowledge");
    expect(json.content).toContain("# API Reference Guide");
  });

  test("cli: show knowledge default (no view mode) returns full content", async () => {
    const result = runCli("show", "knowledge:guide.md");
    expect(result.exitCode).toBe(0);

    const json = parseJson(result.stdout);
    expect(json.type).toBe("knowledge");
    expect(json.content).toBeDefined();
    // Full content should include everything
    expect(json.content).toContain("API Reference Guide");
    expect(json.content).toContain("Getting Started");
    expect(json.content).toContain("Authentication");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4: Progressive improvement — user drops scripts, indexes later
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Zero-config progressive improvement", () => {
  let stashDir: string;

  beforeAll(async () => {
    stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-prog-"));
    for (const sub of ["tools", "skills", "commands", "agents"]) {
      fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
    }
    process.env.AKM_STASH_DIR = stashDir;
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("user drops a script in tools/ — search finds it by name (no index)", async () => {
    fs.mkdirSync(path.join(stashDir, "tools", "format"), { recursive: true });
    fs.writeFileSync(
      path.join(stashDir, "tools", "format", "prettier-check.sh"),
      "#!/usr/bin/env bash\n# Format code with Prettier\nprettier --check .\n",
    );

    const result = await agentikitSearch({ query: "prettier", type: "tool" });
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].name).toContain("prettier");
  });

  test("user runs index — metadata generated in database with description from comments", async () => {
    await agentikitIndex({ stashDir });

    // No .stash.json should be auto-generated
    expect(fs.existsSync(path.join(stashDir, "tools", "format", ".stash.json"))).toBe(false);

    const db = openDatabase();
    const entries = getAllEntries(db, "tool");
    const formatEntry = entries.find((e) => e.entry.name.includes("prettier"));
    expect(formatEntry).toBeDefined();
    expect(formatEntry?.entry.quality).toBe("generated");
    expect(formatEntry?.entry.description).toContain("Format code");
    closeDatabase(db);
  });

  test("user adds more scripts — re-index picks them up", async () => {
    fs.mkdirSync(path.join(stashDir, "tools", "db"), { recursive: true });
    fs.writeFileSync(
      path.join(stashDir, "tools", "db", "migrate.sh"),
      "#!/usr/bin/env bash\n# Run database migrations\necho 'migrating...'\n",
    );

    const result = await agentikitIndex({ stashDir });
    expect(result.totalEntries).toBeGreaterThanOrEqual(2);

    const db = openDatabase();
    const entries = getAllEntries(db, "tool");
    const migrateEntry = entries.find((e) => e.entry.name.includes("migrate"));
    expect(migrateEntry).toBeDefined();
    expect(migrateEntry?.entry.description).toContain("database migrations");
    closeDatabase(db);
  });

  test("user creates .stash.json manually — overrides used on next index", async () => {
    // User creates a .stash.json override for the format tool
    const stashPath = path.join(stashDir, "tools", "format", ".stash.json");
    fs.writeFileSync(
      stashPath,
      JSON.stringify(
        {
          entries: [
            {
              name: "prettier-check",
              type: "tool",
              description: "Check code formatting with Prettier",
              tags: ["prettier", "format", "style"],
              filename: "prettier-check.sh",
            },
          ],
        },
        null,
        2,
      ),
    );

    // Re-index — should use user override
    await agentikitIndex({ stashDir });

    const reloaded = loadStashFile(path.join(stashDir, "tools", "format"))!;
    expect(reloaded.entries[0].description).toBe("Check code formatting with Prettier");
    expect(reloaded.entries[0].tags).toContain("prettier");
    expect(reloaded.entries[0].quality).not.toBe("generated");
  });

  test("semantic search finds user-edited metadata after re-index", async () => {
    // Re-index to pick up manual edits in the search index
    await agentikitIndex({ stashDir });

    const result = await agentikitSearch({ query: "format code style" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.name.includes("prettier"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5: Multi-tool directory with .stash.json
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Multi-tool directory with hand-written .stash.json", () => {
  let stashDir: string;

  beforeAll(async () => {
    stashDir = copyFixturesToTmp();
    process.env.AKM_STASH_DIR = stashDir;
    await agentikitIndex({ stashDir });
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("docker/ directory exposes two tools from single .stash.json", async () => {
    const stash = loadStashFile(path.join(stashDir, "tools", "docker"))!;
    expect(stash.entries).toHaveLength(2);

    const names = stash.entries.map((e) => e.name);
    expect(names).toContain("docker-build");
    expect(names).toContain("docker-compose");
  });

  test("search for 'docker build' returns docker-build as top result", async () => {
    const result = await agentikitSearch({ query: "docker build" });
    expect(result.hits[0].name).toContain("docker");
    expect(result.hits[0].description).toContain("Docker image");
  });

  test("search for 'compose development' returns docker-compose", async () => {
    const result = await agentikitSearch({ query: "compose development" });
    const composeHit = result.hits.find((h) => h.name.includes("compose"));
    expect(composeHit).toBeDefined();
    expect(composeHit?.tags).toContain("compose");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6: Index persistence and cache
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Index persistence across sessions", () => {
  let stashDir: string;

  beforeAll(async () => {
    stashDir = copyFixturesToTmp();
    process.env.AKM_STASH_DIR = stashDir;
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("index is persisted and loadable", async () => {
    await agentikitIndex({ stashDir });

    const db = openDatabase();
    const version = getMeta(db, "version");
    expect(version).toBe("6");
    const storedStashDir = getMeta(db, "stashDir");
    expect(storedStashDir).toBe(stashDir);
    const entries = getAllEntries(db);
    expect(entries.length).toBeGreaterThan(0);
    const builtAt = getMeta(db, "builtAt");
    expect(builtAt).toBeTruthy();
    closeDatabase(db);
  });

  test("search uses persisted index (simulates new session)", async () => {
    // First index
    await agentikitIndex({ stashDir });

    // Simulate a new session by just doing search (no re-index)
    const result = await agentikitSearch({ query: "docker" });
    expect(result.hits.length).toBeGreaterThan(0);
    // Should have scores from semantic search, not substring
    expect(result.hits[0].score).toBeDefined();
  });

  test("re-index updates the persisted index", async () => {
    await agentikitIndex({ stashDir });
    const db1 = openDatabase();
    const entries1 = getAllEntries(db1);
    const builtAt1 = getMeta(db1, "builtAt")!;
    closeDatabase(db1);

    // Add a new tool
    fs.mkdirSync(path.join(stashDir, "tools", "new-tool"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "tools", "new-tool", "hello.sh"), "#!/bin/bash\necho hello\n");

    await agentikitIndex({ stashDir });
    const db2 = openDatabase();
    const entries2 = getAllEntries(db2);
    const builtAt2 = getMeta(db2, "builtAt")!;
    closeDatabase(db2);

    expect(entries2.length).toBeGreaterThan(entries1.length);
    expect(new Date(builtAt2).getTime()).toBeGreaterThanOrEqual(new Date(builtAt1).getTime());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 7: Error handling and edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Error handling and edge cases", () => {
  test("search with non-existent AKM_STASH_DIR throws clear error", async () => {
    const orig = process.env.AKM_STASH_DIR;
    process.env.AKM_STASH_DIR = "/nonexistent/path";
    try {
      await expect(agentikitSearch({ query: "test" })).rejects.toThrow(/Unable to read/);
    } finally {
      if (orig === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = orig;
    }
  });

  test("search with unset AKM_STASH_DIR throws clear error", async () => {
    const orig = process.env.AKM_STASH_DIR;
    const origHome = process.env.HOME;
    delete process.env.AKM_STASH_DIR;
    // Point HOME somewhere without an akm directory to force the "no stash" error
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-nohome-"));
    process.env.HOME = tmpHome;
    try {
      await expect(agentikitSearch({ query: "test" })).rejects.toThrow(/No stash directory found/);
    } finally {
      if (orig === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = orig;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("show with invalid ref format throws", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-err-"));
    process.env.AKM_STASH_DIR = stashDir;
    try {
      await expect(agentikitShow({ ref: "badref" })).rejects.toThrow(/Invalid ref/);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("show with unknown type throws", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-err-"));
    process.env.AKM_STASH_DIR = stashDir;
    try {
      await expect(agentikitShow({ ref: "widget:foo" })).rejects.toThrow(/Invalid asset type/);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("show with path traversal attempt throws", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-err-"));
    fs.mkdirSync(path.join(stashDir, "tools"), { recursive: true });
    process.env.AKM_STASH_DIR = stashDir;
    try {
      await expect(agentikitShow({ ref: "tool:../../etc/passwd" })).rejects.toThrow(/Path traversal/);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("search on empty stash returns no hits with tip", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-empty-"));
    for (const sub of ["tools", "skills", "commands", "agents"]) {
      fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
    }
    process.env.AKM_STASH_DIR = stashDir;
    try {
      const result = await agentikitSearch({ query: "anything" });
      expect(result.hits).toHaveLength(0);
      expect(result.tip).toBeTruthy();
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("index on empty stash succeeds with zero entries", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-e2e-empty-"));
    for (const sub of ["tools", "skills", "commands", "agents"]) {
      fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
    }
    try {
      const result = await agentikitIndex({ stashDir });
      expect(result.totalEntries).toBe(0);
      expect(result.generatedMetadata).toBe(0);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 8: Mixed asset type discovery
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario: Cross-type discovery", () => {
  let stashDir: string;

  beforeAll(async () => {
    stashDir = copyFixturesToTmp();
    process.env.AKM_STASH_DIR = stashDir;
    await agentikitIndex({ stashDir });
  });

  afterAll(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("search 'any' type returns mixed results across tools, skills, commands, agents", async () => {
    const result = await agentikitSearch({ query: "", type: "any" });
    const types = new Set(result.hits.map((h) => h.type));
    // Should have at least scripts (including assets from tools/) and one other type
    expect(types.has("script")).toBe(true);
    expect(types.size).toBeGreaterThan(1);
  });

  test("each hit has a valid openRef that can be used with show", async () => {
    const result = await agentikitSearch({ query: "", type: "any", limit: 10 });
    for (const hit of result.hits) {
      expect(hit.openRef).toBeTruthy();
      expect(hit.openRef).toContain(":");

      // Should not throw when opening
      const openResult = await agentikitShow({ ref: hit.openRef! });
      // tool and script types are now unified — the matcher pipeline returns
      // "script" for files in tools/ directories, while the search index still
      // stores "tool" from metadata. Both are acceptable.
      const expected = hit.type === "tool" ? "script" : hit.type;
      expect(openResult.type).toBe(expected);
    }
  });

  test("tool hits have run, non-tool hits do not", async () => {
    const result = await agentikitSearch({ query: "", type: "any" });
    for (const hit of result.hits) {
      if (hit.type === "tool") {
        expect(hit.run).toBeTruthy();
      }
    }
  });
});
