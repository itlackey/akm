/**
 * Native scoping flags (#202) — frontmatter shape, search filters, show scope.
 *
 * Verifies:
 *   - `akm remember --user --agent --run --channel` writes the canonical
 *     `scope_*` top-level frontmatter keys.
 *   - `akm search --filter k=v` narrows results without changing ranking.
 *   - `akm show` reads a scoped asset whatever the caller's scope, and
 *     rejects `--filter` as an unknown flag.
 *   - Legacy memories without scope keys still match unfiltered queries.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch, parseScopeFilterFlags } from "../../src/commands/read/search";
import { akmShowUnified } from "../../src/commands/read/show";
import { buildMemoryFrontmatter } from "../../src/commands/remember";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import type { SourceSearchHit } from "../../src/sources/types";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withDefaultBundle,
} from "../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process harness
// (tests/_helpers/cli.ts). The preload (tests/_preload.ts) sandboxes HOME / XDG
// dirs per test, and beforeEach re-sandboxes the stash/config/cache through the
// allowlisted sandbox helpers. Both former spawns are pure read/write against
// the sandboxed stash/config, so they migrate cleanly.

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function tmpStash(): string {
  return currentStashDir;
}

let currentStashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  currentStashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  currentStashDir = "";
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
    expect(filters).toEqual({ user: ["alice"], channel: ["ops"] });
  });

  test("a repeated key collects all its values", () => {
    expect(parseScopeFilterFlags(["user=alice", "user=bob", "channel=ops"], "--filter")).toEqual({
      user: ["alice", "bob"],
      channel: ["ops"],
    });
  });

  test("accepts any frontmatter key", () => {
    expect(parseScopeFilterFlags(["team=platform", "project=openpalm"], "--filter")).toEqual({
      team: ["platform"],
      project: ["openpalm"],
    });
  });

  test("rejects malformed tokens", () => {
    expect(() => parseScopeFilterFlags(["nope"], "--filter")).toThrow(/Expected key=value/);
    expect(() => parseScopeFilterFlags([" =x"], "--filter")).toThrow(/Expected key=value/);
  });

  test("a key named like an Object member is just a key", () => {
    expect(Object.entries(parseScopeFilterFlags(["__proto__=x"], "--filter") ?? {})).toEqual([["__proto__", ["x"]]]);
  });

  test("an empty value is kept: it selects assets without the key", () => {
    expect(Object.entries(parseScopeFilterFlags(["user=", "user=alice"], "--filter") ?? {})).toEqual([
      ["user", ["", "alice"]],
    ]);
  });

  test("returns undefined for empty input", () => {
    expect(parseScopeFilterFlags([], "--filter")).toBeUndefined();
  });
});

// ── End-to-end via akmIndex + akmSearch / akmShow ─────────────────────────

describe("akm search --filter narrows by scope", () => {
  test("filter user=alice returns only alice's memory", async () => {
    const stashDir = tmpStash();
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, stashDir));

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
    const all = await akmSearch({ query: "deployment", source: "local" });
    const allLocal = all.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const allNames = allLocal.map((h) => h.name).sort();
    expect(allNames).toContain("alice-note");
    expect(allNames).toContain("bob-note");

    // Filter user=alice — only alice's memory
    const filtered = await akmSearch({
      query: "deployment",
      source: "local",
      filters: { user: "alice" },
    });
    const filteredLocal = filtered.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const filteredNames = filteredLocal.map((h) => h.name);
    expect(filteredNames).toEqual(["alice-note"]);
  });

  test("a repeated key matches any value; different keys must all match", async () => {
    const stashDir = tmpStash();
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, stashDir));
    const note = (name: string, user: string, channel: string) =>
      writeFile(
        path.join(stashDir, "memories", `${name}.md`),
        `---\ntags: [t]\ndescription: deployment note\nscope_user: ${user}\nscope_channel: ${channel}\n---\nDeployment note ${name}\n`,
      );
    note("alice-ops", "alice", "ops");
    note("bob-ops", "bob", "ops");
    note("bob-dev", "bob", "dev");
    note("carol-ops", "carol", "ops");
    await akmIndex({ stashDir, full: true });
    const names = async (filters: NonNullable<Parameters<typeof akmSearch>[0]["filters"]>) =>
      (await akmSearch({ query: "deployment", source: "local", filters })).hits
        .filter((h): h is SourceSearchHit => h.type !== "registry")
        .map((h) => h.name)
        .sort();
    const cli = parseScopeFilterFlags(["user=alice", "user=bob"], "--filter");
    expect(await names(cli ?? {})).toEqual(["alice-ops", "bob-dev", "bob-ops"]);
    expect(await names({ user: ["alice", "bob"], channel: "ops" })).toEqual(["alice-ops", "bob-ops"]);
    expect(await names({ user: "bob" })).toEqual(["bob-dev", "bob-ops"]);
  });

  test("legacy memories without scope still match unfiltered queries", async () => {
    const stashDir = tmpStash();
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, stashDir));

    writeFile(
      path.join(stashDir, "memories", "legacy.md"),
      "---\ntags: [legacy]\ndescription: legacy memory description\n---\nLegacy memory without scope keys\n",
    );

    await akmIndex({ stashDir, full: true });

    const result = await akmSearch({ query: "legacy", source: "local" });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(hits.some((h) => h.name === "legacy")).toBe(true);
  });

  test("scope filter on a key the entry lacks excludes it", async () => {
    const stashDir = tmpStash();
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, stashDir));

    writeFile(
      path.join(stashDir, "memories", "legacy.md"),
      "---\ntags: [legacy]\ndescription: legacy memory description\n---\nLegacy memory\n",
    );

    await akmIndex({ stashDir, full: true });

    const result = await akmSearch({
      query: "legacy",
      source: "local",
      filters: { user: "alice" },
    });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(hits.length).toBe(0);
  });
});

describe("akm show is a direct reader and never filters", () => {
  test("shows a scoped asset whatever the caller's scope", async () => {
    const stashDir = tmpStash();
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, stashDir));
    writeFile(
      path.join(stashDir, "memories", "scoped.md"),
      "---\ntags: [scoped]\nscope_user: alice\n---\nAlice's note\n",
    );
    writeFile(path.join(stashDir, "memories", "legacy.md"), "---\ntags: [legacy]\n---\nLegacy\n");
    await akmIndex({ stashDir, full: true });

    expect((await akmShowUnified({ ref: "memories/scoped" })).name).toBe("scoped");
    expect((await akmShowUnified({ ref: "memories/legacy" })).name).toBe("legacy");
  });

  test("the CLI shows a scoped asset, and --filter and the removed --scope are unknown flags", async () => {
    const stashDir = tmpStash();
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, stashDir));
    writeFile(
      path.join(stashDir, "memories", "cli-scoped.md"),
      "---\ntags: [cli]\nscope_user: alice\n---\nCli scoped body\n",
    );
    await akmIndex({ stashDir, full: true });

    const shown = await runCliCapture(["show", "memories/cli-scoped", "--format", "json"]);
    expect(shown.code).toBe(0);

    const filtered = await runCliCapture(["show", "memories/cli-scoped", "--filter", "user=bob", "--format", "json"]);
    expect(filtered.code).toBe(2);
    expect(filtered.stderr).toContain('Unknown flag "--filter"');

    const removed = await runCliCapture(["show", "memories/cli-scoped", "--scope", "user=alice", "--format", "json"]);
    expect(removed.code).toBe(2);
  });
});

// ── CLI smoke test ────────────────────────────────────────────────────────

describe("akm remember --user / --agent / --run / --channel (CLI)", () => {
  test("persists all four scope_* keys to frontmatter", async () => {
    const result = await runCliCapture([
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
    ]);

    expect(result.code).toBe(0);
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
