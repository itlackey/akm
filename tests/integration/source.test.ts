import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified as akmShow } from "../../src/commands/read/show";
import { akmInit } from "../../src/commands/sources/init";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { getConfigPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { mergeLockEntriesSync } from "../../src/integrations/lockfile";
import type { SearchHit, SourceSearchHit } from "../../src/sources/types";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-stash-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function isLocalHit(hit: SearchHit): hit is SourceSearchHit {
  return hit.type !== "registry";
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("source commands and resolution", () => {
  // XDG_* / AKM_STASH_DIR snapshot+restore is provided by tests/_preload.ts.
  // This block still creates per-test tmp dirs and points the XDG vars at
  // them so each test sees a clean cache/config/data/state tree.
  let testCacheDir = "";
  let testConfigDir = "";
  let testDataDir = "";
  let testStateDir = "";

  beforeEach(() => {
    testCacheDir = createTmpDir("akm-stash-cache-");
    testConfigDir = createTmpDir("akm-stash-config-");
    testDataDir = createTmpDir("akm-stash-data-");
    testStateDir = createTmpDir("akm-stash-state-");
    process.env.XDG_CACHE_HOME = testCacheDir;
    process.env.XDG_CONFIG_HOME = testConfigDir;
    // Pair AKM_STASH_DIR mutations below with XDG_DATA_HOME / XDG_STATE_HOME
    // so the test-isolation guard in src/core/paths.ts stays inert.
    process.env.XDG_DATA_HOME = testDataDir;
    process.env.XDG_STATE_HOME = testStateDir;
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    if (testCacheDir) {
      fs.rmSync(testCacheDir, { recursive: true, force: true });
      testCacheDir = "";
    }
    if (testConfigDir) {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
      testConfigDir = "";
    }
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
      testDataDir = "";
    }
    if (testStateDir) {
      fs.rmSync(testStateDir, { recursive: true, force: true });
      testStateDir = "";
    }
  });

  test("akmSearch only includes script files with supported extensions and returns run", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(path.join(stashDir, "scripts", "script.ts"), "console.log('x')\n");
    writeFile(path.join(stashDir, "scripts", "README.md"), "ignore\n");

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmSearch({ query: "", type: "script" });
    const localHits = result.hits.filter(isLocalHit);

    expect(localHits.length).toBe(2);
    expect(localHits.every((hit) => hit.type === "script")).toBe(true);
    expect(localHits.some((hit) => hit.name === "README.md")).toBe(false);
    expect(localHits.some((hit) => typeof hit.run === "string")).toBe(true);
  });

  test("akmSearch creates bun run from nearest package.json up to scripts root", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const nestedScript = path.join(stashDir, "scripts", "group", "nested", "job.js");
    writeFile(nestedScript, "console.log('job')\n");
    writeFile(path.join(stashDir, "scripts", "group", "package.json"), '{"name":"group"}');
    writeFile(path.join(stashDir, "scripts", "package.json"), '{"name":"root"}');

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmSearch({ query: "job", type: "script" });
    const hit = result.hits.filter(isLocalHit)[0];

    expect(result.hits.length).toBe(1);
    expect(hit!.run).toContain("bun");
    expect(hit!.run).toContain("job.js");
  });

  test("akmSearch detects setup from package.json in nearby directory", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const nestedScript = path.join(stashDir, "scripts", "group", "nested", "job.js");
    writeFile(nestedScript, "console.log('job')\n");
    writeFile(path.join(stashDir, "scripts", "group", "nested", "package.json"), '{"name":"group"}');

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmSearch({ query: "job", type: "script" });
    const hit = result.hits.filter(isLocalHit)[0];
    expect(result.hits.length).toBe(1);
    // Search hits only expose run, not setup/cwd
    expect(hit!.run).toContain("bun");
    expect(hit!.run).toContain("job.js");
  });

  test("akmSearch resolves script run correctly for search path directories", async () => {
    const primaryStashDir = createTmpDir("akm-stash-primary-");
    const searchPathDir = createTmpDir("akm-stash-searchpath-");

    writeFile(path.join(primaryStashDir, "scripts", "placeholder.sh"), "#!/usr/bin/env bash\necho primary\n");
    writeFile(path.join(searchPathDir, "scripts", "group", "nested", "job.js"), "console.log('job')\n");
    writeFile(path.join(searchPathDir, "scripts", "group", "package.json"), '{"name":"group"}');

    saveConfig({ semanticSearchMode: "off", bundles: { extra: { path: searchPathDir } } });

    process.env.AKM_STASH_DIR = primaryStashDir;
    await akmIndex({ stashDir: primaryStashDir, full: true });

    const result = await akmSearch({ query: "job", type: "script" });
    const searchPathHit = result.hits.filter(isLocalHit).find((hit) => hit.path.includes(searchPathDir));

    expect(searchPathHit).toBeDefined();
    expect(searchPathHit?.run ?? "").toContain("bun");
    expect(searchPathHit?.run ?? "").toContain("job.js");
  });

  test("akmSearch includes explainability reasons for indexed hits", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "summarize-diff.ts"), "console.log('summarize')\n");

    saveConfig({ semanticSearchMode: "auto" });
    process.env.AKM_STASH_DIR = stashDir;

    await akmIndex({ stashDir, full: true });
    const result = await akmSearch({ query: "summarize diff", type: "script" });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.whyMatched).toBeDefined();
    // Ranking mode depends on whether semantic search (embeddings) is available.
    // Accept "fts bm25 relevance", "semantic similarity", or "hybrid (fts + semantic)".
    expect(
      result.hits[0]!.whyMatched?.includes("fts bm25 relevance") ||
        result.hits[0]!.whyMatched?.includes("semantic similarity") ||
        result.hits[0]!.whyMatched?.includes("hybrid (fts + semantic)"),
    ).toBe(true);
    expect(result.hits[0]!.whyMatched).toContain("matched name tokens");
  });

  test("akmSearch includes ref, action, and size for local hits", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const scriptPath = path.join(stashDir, "scripts", "deploy.sh");
    writeFile(scriptPath, "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({ semanticSearchMode: "off" });
    process.env.AKM_STASH_DIR = stashDir;

    await akmIndex({ stashDir, full: true });
    const result = await akmSearch({ query: "deploy", type: "script" });
    const hit = result.hits.filter(isLocalHit)[0];

    expect(hit!.ref).toContain("scripts/deploy.sh");
    expect(hit!.action).toContain("akm show");
    expect(hit!.size).toBe("small");
  });

  test("akmSearch includes origin for installed-source hits", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const installedStash = createTmpDir("akm-installed-");
    writeFile(path.join(stashDir, "scripts", "placeholder.sh"), "#!/usr/bin/env bash\necho placeholder\n");
    writeFile(path.join(installedStash, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "deploy-stash": { npm: "@scope/deploy-stash", registryId: "npm:@scope/deploy-stash" } },
    });
    mergeLockEntriesSync([
      { id: "deploy-stash", source: "npm", ref: "@scope/deploy-stash", localRoot: installedStash },
    ]);
    process.env.AKM_STASH_DIR = stashDir;

    await akmIndex({ stashDir, full: true });
    const result = await akmSearch({ query: "deploy", type: "script" });

    // The hit's origin is the bundle id (the slug-legal bundle key).
    expect(result.hits.filter(isLocalHit).some((hit) => hit.origin === "deploy-stash")).toBe(true);
  });

  test("akmShow returns full payloads for skill/command/agent", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\n");
    writeFile(path.join(stashDir, "commands", "release.md"), '---\ndescription: "Release command"\n---\nrun release\n');
    writeFile(
      path.join(stashDir, "agents", "coach.md"),
      '---\ndescription: "Coach"\nmodel: "gpt-5"\n---\nGuide users\n',
    );

    process.env.AKM_STASH_DIR = stashDir;

    const skill = await akmShow({ ref: "skills/ops" });
    const command = await akmShow({ ref: "commands/release.md" });
    const agent = await akmShow({ ref: "agents/coach.md" });

    expect(skill.type).toBe("skill");
    expect(skill.action).toContain("Read and follow");
    expect(skill.content ?? "").toMatch(/Ops/);
    expect(command.type).toBe("command");
    expect(command.action).toContain("dispatch");
    expect(command.template ?? "").toMatch(/run release/);
    expect(command.description).toBe("Release command");
    expect(agent.type).toBe("agent");
    expect(agent.action).toContain("verbatim");
    expect(agent.prompt ?? "").toMatch(/Guide users/);
    expect(agent.modelHint).toBe("gpt-5");
  });

  test("akmShow returns clear error when stash type root is missing", async () => {
    const stashDir = createTmpDir("akm-stash-");
    try {
      process.env.AKM_STASH_DIR = stashDir;
      // QA #27: error should not leak "Stash type root" wording; be user-facing
      await expect(akmShow({ ref: "agents/missing.md" })).rejects.toThrow(
        /Asset not found for ref: agent:missing\.md|not found for ref/i,
      );
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmShow rejects a foreign/unknown conceptId leading segment (F5 new grammar closes the type token)", async () => {
    const stashDir = createTmpDir("akm-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    // The F5 new-grammar input parser (`parseRefInput`) is CLOSED at the type
    // token: a conceptId whose leading segment is not a known stash subdir
    // ("widget" is not) has no legacy type predicate and is rejected as an
    // unrecognized ref — the same outcome an unknown asset type produced before,
    // now surfaced at the input-parse boundary. (The pre-0.9.0 open-token /
    // "Unknown asset type" phasing is retired with the legacy grammar.)
    await expect(akmShow({ ref: "widget/foo" })).rejects.toThrow(/no known asset-type prefix|Unrecognized asset ref/i);
  });

  test("akmShow rejects the retired tool/vault types as unrecognized new-grammar refs", async () => {
    const stashDir = createTmpDir("akm-stash-");
    process.env.AKM_STASH_DIR = stashDir;
    // `tool`/`vault` are not stash subdirs, so the new-grammar input parser
    // rejects them as unrecognized refs. (The vault-removal migration hint lives
    // in the STORED-ref parser `parseStoredRef` for durable data, not the CLI
    // input path, which never durably re-key round-trips a `vault` ref.)
    await expect(akmShow({ ref: "tool/deploy.sh" })).rejects.toThrow(
      /no known asset-type prefix|Unrecognized asset ref/i,
    );
    await expect(akmShow({ ref: "vault/prod" })).rejects.toThrow(/no known asset-type prefix|Unrecognized asset ref/i);
  });

  test("akmShow rejects traversal and absolute path refs", async () => {
    const stashDir = createTmpDir("akm-stash-");
    process.env.AKM_STASH_DIR = stashDir;

    // The new-grammar conceptId validator (`validateName`) is the path-safety
    // guard: a `../`-leading conceptId trips traversal, an absolute path trips
    // the absolute-path guard — both at the input-parse boundary.
    await expect(akmShow({ ref: "../outside.sh" })).rejects.toThrow(/Path traversal/);
    await expect(akmShow({ ref: "/etc/passwd" })).rejects.toThrow(/Absolute path/);
  });

  test("akmShow blocks symlink escapes outside stash type root", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const outsideDir = createTmpDir("akm-outside-");
    const outsideFile = path.join(outsideDir, "outside.sh");
    const symlinkFile = path.join(stashDir, "scripts", "link.sh");
    writeFile(outsideFile, "echo outside\n");
    fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });

    try {
      fs.symlinkSync(outsideFile, symlinkFile);
    } catch {
      // Symlinks not supported in this environment — skip
      return;
    }

    process.env.AKM_STASH_DIR = stashDir;
    // Symlinks are skipped by the indexer, so the asset won't be found
    await expect(akmShow({ ref: "scripts/link.sh" })).rejects.toThrow(/not found for ref/);
  });

  // ── Knowledge tests ─────────────────────────────────────────────────────────

  const KNOWLEDGE_DOC = `---
title: API Guide
description: "API documentation"
---
# Overview

This is the API guide.

## Authentication

Use bearer tokens.

## Endpoints

### GET /users

Returns all users.

### POST /users

Creates a user.
`;

  test("akmSearch finds knowledge assets", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmSearch({ query: "", type: "knowledge" });

    expect(result.hits.length).toBe(1);
    expect(result.hits[0]!.type).toBe("knowledge");
    expect(result.hits[0]!.name).toBe("api-guide");
  });

  test("akmShow returns full content for knowledge by default", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({ ref: "knowledge/api-guide.md" });

    expect(result.type).toBe("knowledge");
    expect(result.content).toContain("# Overview");
    expect(result.content).toContain("## Authentication");
  });

  test("akmShow returns TOC for knowledge with view toc", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({ ref: "knowledge/api-guide.md", view: { mode: "toc" } });

    expect(result.type).toBe("knowledge");
    expect(result.content).toContain("# Overview");
    expect(result.content).toContain("## Authentication");
    expect(result.content).toContain("## Endpoints");
    expect(result.content).toContain("lines total");
  });

  test("akmShow extracts section for knowledge", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({
      ref: "knowledge/api-guide.md",
      view: { mode: "section", heading: "Authentication" },
    });

    expect(result.type).toBe("knowledge");
    expect(result.content).toContain("bearer tokens");
    expect(result.content).not.toContain("Endpoints");
  });

  test("akmShow extracts line range for knowledge", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({ ref: "knowledge/api-guide.md", view: { mode: "lines", start: 5, end: 7 } });

    expect(result.type).toBe("knowledge");
    expect(result.content).toContain("# Overview");
  });

  test("akmShow extracts frontmatter for knowledge", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({ ref: "knowledge/api-guide.md", view: { mode: "frontmatter" } });

    expect(result.type).toBe("knowledge");
    expect(result.content).toContain("title: API Guide");
    expect(result.content).not.toContain("# Overview");
  });

  test("akmShow returns no-frontmatter message when missing", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "plain.md"), "# Just a heading\nSome text.\n");

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({ ref: "knowledge/plain.md", view: { mode: "frontmatter" } });

    expect(result.content).toBe("(no frontmatter)");
  });

  test("akmShow returns helpful message for missing section in knowledge", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({
      ref: "knowledge/api-guide.md",
      view: { mode: "section", heading: "Nonexistent" },
    });
    expect(result.type).toBe("knowledge");
    expect(result.content).toContain('Section "Nonexistent" not found');
    expect(result.content).toContain("akm show");
    expect(result.content).toContain("toc");
    expect(result.content).toContain("discover available headings");
  });

  test("akmShow for script type returns run", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({ ref: "scripts/deploy.sh" });

    expect(result.type).toBe("script");
    expect(result.run).toBeTruthy();
    expect(typeof result.run).toBe("string");
    expect(result.run).toContain("bash");
  });

  test("akmInit returns created false when stash dir already exists", async () => {
    const origHome = process.env.HOME;
    const origStashDir = process.env.AKM_STASH_DIR;
    const tmpHome = createTmpDir("akm-home-");
    // Pre-create the akm directory at the new default location (~/akm)
    const stashPath = path.join(tmpHome, "akm");
    fs.mkdirSync(stashPath, { recursive: true });

    process.env.HOME = tmpHome;
    delete process.env.AKM_STASH_DIR;

    try {
      const result = await akmInit();
      expect(result.created).toBe(false);
      expect(result.stashDir).toBe(stashPath);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = origStashDir;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("akmShow throws unsupported script extension for .txt file", async () => {
    const origStashDir = process.env.AKM_STASH_DIR;
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "readme.txt"), "not a script\n");

    process.env.AKM_STASH_DIR = stashDir;
    try {
      await expect(akmShow({ ref: "scripts/readme.txt" })).rejects.toThrow(
        /unsupported file type|supported script extension/i,
      );
    } finally {
      if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = origStashDir;
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmInit creates knowledge directory", async () => {
    const origHome = process.env.HOME;
    const origStashDir = process.env.AKM_STASH_DIR;
    const tmpHome = createTmpDir("akm-home-");
    process.env.HOME = tmpHome;
    delete process.env.AKM_STASH_DIR;

    try {
      const result = await akmInit();
      expect(fs.existsSync(path.join(result.stashDir, "knowledge"))).toBe(true);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = origStashDir;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // ── Script tests ────────────────────────────────────────────────────────────

  test("akmSearch finds script assets with broad extensions", async () => {
    const origStashDir = process.env.AKM_STASH_DIR;
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "cleanup.sh"), "#!/usr/bin/env bash\necho cleanup\n");
    writeFile(path.join(stashDir, "scripts", "process.py"), "print('hello')\n");
    writeFile(path.join(stashDir, "scripts", "README.md"), "ignore\n");

    try {
      process.env.AKM_STASH_DIR = stashDir;
      const result = await akmSearch({ query: "", type: "script" });

      expect(result.hits.length).toBe(2);
      expect(result.hits.every((hit: SearchHit) => hit.type === "script")).toBe(true);
      expect(result.hits.some((hit: SearchHit) => hit.name === "README.md")).toBe(false);
    } finally {
      if (origStashDir === undefined) {
        delete process.env.AKM_STASH_DIR;
      } else {
        process.env.AKM_STASH_DIR = origStashDir;
      }
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmSearch returns run for runnable script extensions", async () => {
    const origStashDir = process.env.AKM_STASH_DIR;
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    try {
      process.env.AKM_STASH_DIR = stashDir;
      const result = await akmSearch({ query: "", type: "script" });
      const hit = result.hits.filter(isLocalHit)[0];

      expect(result.hits.length).toBe(1);
      expect(hit!.run).toBeTruthy();
      expect(hit!.run).toContain("bash");
    } finally {
      if (origStashDir === undefined) {
        delete process.env.AKM_STASH_DIR;
      } else {
        process.env.AKM_STASH_DIR = origStashDir;
      }
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmShow returns run for python script (auto-detected interpreter)", async () => {
    const origStashDir = process.env.AKM_STASH_DIR;
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "process.py"), "# A python script\nprint('hello')\n");

    try {
      process.env.AKM_STASH_DIR = stashDir;
      const result = await akmShow({ ref: "scripts/process.py" });

      expect(result.type).toBe("script");
      expect(result.run).toBeDefined();
      expect(result.run).toContain("python");
    } finally {
      if (origStashDir === undefined) {
        delete process.env.AKM_STASH_DIR;
      } else {
        process.env.AKM_STASH_DIR = origStashDir;
      }
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmShow returns run for runnable script", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmShow({ ref: "scripts/deploy.sh" });

    expect(result.type).toBe("script");
    expect(result.run).toBeTruthy();
    expect(result.run).toContain("bash");
  });

  test("akmInit writes config outside the stash directory", async () => {
    const origHome = process.env.HOME;
    const origStashDir = process.env.AKM_STASH_DIR;
    const tmpHome = createTmpDir("akm-home-");
    process.env.HOME = tmpHome;
    delete process.env.AKM_STASH_DIR;

    try {
      const result = await akmInit();
      expect(result.configPath).toBe(getConfigPath());
      expect(result.configPath.startsWith(result.stashDir)).toBe(false);
      expect(fs.existsSync(result.configPath)).toBe(true);
      expect(fs.existsSync(path.join(result.stashDir, "config.json"))).toBe(false);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origStashDir === undefined) delete process.env.AKM_STASH_DIR;
      else process.env.AKM_STASH_DIR = origStashDir;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
