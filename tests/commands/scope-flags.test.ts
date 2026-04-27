/**
 * Native scoping flags (#202) — frontmatter shape, search filters, show scope.
 *
 * Verifies:
 *   - `akm remember --user --agent --run --channel` writes the canonical
 *     `scope_*` top-level frontmatter keys.
 *   - `akm search --filter k=v` narrows results without changing ranking.
 *   - `akm show --scope k=v` resolves to scoped assets and rejects
 *     out-of-scope ones with NotFoundError.
 *   - Legacy memories without scope keys still match unfiltered queries.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMemoryFrontmatter } from "../../src/commands/remember";
import { akmSearch, entryMatchesScopeFilters, parseScopeFilterFlags } from "../../src/commands/search";
import { akmShowUnified } from "../../src/commands/show";
import { saveConfig } from "../../src/core/config";
import { NotFoundError, UsageError } from "../../src/core/errors";
import { parseFrontmatter } from "../../src/core/frontmatter";
import { akmIndex } from "../../src/indexer/indexer";
import type { SourceSearchHit } from "../../src/sources/types";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-scope-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function tmpStash(): string {
  const dir = createTmpDir("akm-scope-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts", "memories"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-scope-cache-");
  testConfigDir = createTmpDir("akm-scope-config-");
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
});

// ── Pure-function tests (no spawn) ────────────────────────────────────────

describe("buildMemoryFrontmatter — scope keys", () => {
  test("emits scope_* top-level keys when scope is supplied", () => {
    const block = buildMemoryFrontmatter({
      tags: ["t"],
      scope: { user: "alice", agent: "claude" },
    });
    expect(block).toContain("scope_user: alice");
    expect(block).toContain("scope_agent: claude");
    expect(block).not.toContain("scope_run");
    expect(block).not.toContain("scope_channel");
    // Frontmatter must be valid YAML
    const parsed = parseFrontmatter(`${block}\nbody\n`);
    expect(parsed.data.scope_user).toBe("alice");
    expect(parsed.data.scope_agent).toBe("claude");
  });

  test("trims and drops empty scope values", () => {
    const block = buildMemoryFrontmatter({
      scope: { user: "  ", agent: "alice", run: "" },
    });
    expect(block).not.toContain("scope_user");
    expect(block).not.toContain("scope_run");
    expect(block).toContain("scope_agent: alice");
  });

  test("legacy frontmatter (no scope) round-trips unchanged", () => {
    const block = buildMemoryFrontmatter({ tags: ["legacy"] });
    expect(block).not.toContain("scope_");
    const parsed = parseFrontmatter(`${block}\nbody\n`);
    expect(parsed.data.scope_user).toBeUndefined();
    expect(parsed.data.tags).toEqual(["legacy"]);
  });
});

describe("parseScopeFilterFlags", () => {
  test("parses k=v tokens into a scope filter", () => {
    const filters = parseScopeFilterFlags(["user=alice", "channel=ops"], "--filter");
    expect(filters).toEqual({ user: "alice", channel: "ops" });
  });

  test("rejects unknown keys with UsageError", () => {
    let captured: unknown;
    try {
      parseScopeFilterFlags(["foo=bar"], "--filter");
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(UsageError);
    expect((captured as UsageError).message).toMatch(/Unknown scope key/);
    // Spec: UsageError → exit 2 and {ok:false, error, code} envelope on stderr.
    const result = spawnSync("bun", [CLI, "search", "foo", "--filter", "foo=bar"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        AKM_STASH_DIR: tmpStash(),
        AKM_CONFIG_DIR: path.join(createTmpDir("akm-scope-config-"), "akm"),
        XDG_CACHE_HOME: createTmpDir("akm-scope-cache-"),
      },
    });
    expect(result.status).toBe(2); // EXIT_USAGE
    const envelope = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(envelope.ok).toBe(false);
    expect(typeof envelope.error).toBe("string");
    expect(envelope.error).toMatch(/Unknown scope key/);
  });

  test("rejects malformed tokens", () => {
    expect(() => parseScopeFilterFlags(["nope"], "--filter")).toThrow(/Expected key=value/);
  });

  test("rejects empty values", () => {
    expect(() => parseScopeFilterFlags(["user="], "--filter")).toThrow(/non-empty value/);
  });

  test("returns undefined for empty input", () => {
    expect(parseScopeFilterFlags([], "--filter")).toBeUndefined();
  });
});

describe("entryMatchesScopeFilters", () => {
  test("returns true when no filter supplied (legacy entries match)", () => {
    expect(entryMatchesScopeFilters(undefined, undefined)).toBe(true);
    expect(entryMatchesScopeFilters({ user: "alice" }, undefined)).toBe(true);
  });

  test("returns false when entry lacks the filtered key", () => {
    expect(entryMatchesScopeFilters(undefined, { user: "alice" })).toBe(false);
    expect(entryMatchesScopeFilters({ agent: "claude" }, { user: "alice" })).toBe(false);
  });

  test("AND-joins multiple filter keys", () => {
    const scope = { user: "alice", agent: "claude" };
    expect(entryMatchesScopeFilters(scope, { user: "alice", agent: "claude" })).toBe(true);
    expect(entryMatchesScopeFilters(scope, { user: "alice", agent: "other" })).toBe(false);
  });
});

// ── End-to-end via akmIndex + akmSearch / akmShow ─────────────────────────

describe("akm search --filter narrows by scope", () => {
  test("filter user=alice returns only alice's memory", async () => {
    const stashDir = tmpStash();
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    writeFile(
      path.join(stashDir, "memories", "alice-note.md"),
      "---\ntags: [deployment]\ndescription: alice deployment note\nscope_user: alice\n---\nAlice deployment context\n",
    );
    writeFile(
      path.join(stashDir, "memories", "bob-note.md"),
      "---\ntags: [deployment]\ndescription: bob deployment note\nscope_user: bob\n---\nBob deployment context\n",
    );
    writeFile(
      path.join(stashDir, "memories", "legacy-note.md"),
      "---\ntags: [deployment]\ndescription: legacy deployment note\n---\nLegacy memory with no scope\n",
    );

    await akmIndex({ stashDir, full: true });

    // Unscoped query sees all three memories
    const all = await akmSearch({ query: "deployment", source: "stash" });
    const allLocal = all.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const allNames = allLocal.map((h) => h.name).sort();
    expect(allNames).toContain("alice-note");
    expect(allNames).toContain("bob-note");

    // Filter user=alice — only alice's memory
    const filtered = await akmSearch({
      query: "deployment",
      source: "stash",
      filters: { user: "alice" },
    });
    const filteredLocal = filtered.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const filteredNames = filteredLocal.map((h) => h.name);
    expect(filteredNames).toEqual(["alice-note"]);
  });

  test("legacy memories without scope still match unfiltered queries", async () => {
    const stashDir = tmpStash();
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    writeFile(
      path.join(stashDir, "memories", "legacy.md"),
      "---\ntags: [legacy]\ndescription: legacy memory description\n---\nLegacy memory without scope keys\n",
    );

    await akmIndex({ stashDir, full: true });

    const result = await akmSearch({ query: "legacy", source: "stash" });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(hits.some((h) => h.name === "legacy")).toBe(true);
  });

  test("scope filter on a key the entry lacks excludes it", async () => {
    const stashDir = tmpStash();
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    writeFile(
      path.join(stashDir, "memories", "legacy.md"),
      "---\ntags: [legacy]\ndescription: legacy memory description\n---\nLegacy memory\n",
    );

    await akmIndex({ stashDir, full: true });

    const result = await akmSearch({
      query: "legacy",
      source: "stash",
      filters: { user: "alice" },
    });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(hits.length).toBe(0);
  });
});

describe("akm show --scope narrows resolution", () => {
  test("returns the asset when scope matches", async () => {
    const stashDir = tmpStash();
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    writeFile(
      path.join(stashDir, "memories", "scoped.md"),
      "---\ntags: [scoped]\nscope_user: alice\nscope_agent: claude\n---\nAlice's note\n",
    );

    await akmIndex({ stashDir, full: true });

    const result = await akmShowUnified({
      ref: "memory:scoped",
      scope: { user: "alice" },
    });
    expect(result.name).toBe("scoped");
  });

  test("throws NotFoundError when scope does not match and body content is not leaked", async () => {
    const stashDir = tmpStash();
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    const SECRET_BODY = "ALICE_SECRET_DEPLOY_TOKEN_XYZ123";
    writeFile(
      path.join(stashDir, "memories", "scoped.md"),
      `---\ntags: [scoped]\nscope_user: alice\n---\n${SECRET_BODY}\n`,
    );

    await akmIndex({ stashDir, full: true });

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = await akmShowUnified({ ref: "memory:scoped", scope: { user: "bob" } });
    } catch (err) {
      thrown = err;
    }
    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(NotFoundError);
    // Crucial leak-prevention guarantee: the out-of-scope body must NOT appear
    // anywhere in the thrown error's message, name, or stack.
    const err = thrown as Error;
    expect(err.message).not.toContain(SECRET_BODY);
    expect(err.name).not.toContain(SECRET_BODY);
    expect(String(err.stack ?? "")).not.toContain(SECRET_BODY);
    expect(JSON.stringify({ ok: false, error: err.message })).not.toContain(SECRET_BODY);
  });

  test("throws NotFoundError when asset has no scope but a scope filter is supplied", async () => {
    const stashDir = tmpStash();
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    writeFile(path.join(stashDir, "memories", "legacy.md"), "---\ntags: [legacy]\n---\nLegacy\n");

    await akmIndex({ stashDir, full: true });

    await expect(akmShowUnified({ ref: "memory:legacy", scope: { user: "alice" } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

// ── CLI smoke test ────────────────────────────────────────────────────────

describe("akm remember --user / --agent / --run / --channel (CLI)", () => {
  test("persists all four scope_* keys to frontmatter", () => {
    const stashDir = tmpStash();
    const configDir = createTmpDir("akm-scope-config-");
    const xdgCache = createTmpDir("akm-scope-cache-");

    const result = spawnSync(
      "bun",
      [
        CLI,
        "remember",
        "Multi-tenant memory",
        "--user",
        "alice",
        "--agent",
        "claude",
        "--run",
        "run-42",
        "--channel",
        "#ops",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          AKM_STASH_DIR: stashDir,
          AKM_CONFIG_DIR: path.join(configDir, "akm"),
          XDG_CACHE_HOME: xdgCache,
        },
      },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; path: string };
    expect(parsed.ok).toBe(true);

    const written = fs.readFileSync(parsed.path, "utf8");
    expect(written).toContain("scope_user: alice");
    expect(written).toContain("scope_agent: claude");
    expect(written).toContain("scope_run: run-42");
    expect(written).toContain('scope_channel: "#ops"');
    // Body content preserved
    expect(written).toContain("Multi-tenant memory");
    // Tags are NOT required when only scope is supplied
    expect(written).not.toContain("tags:");
  });
});
