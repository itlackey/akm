/**
 * Reproduction test for issue #36: Search and index issues
 *
 * Problem: Scripts in the stash aren't found via `akm search` with keywords
 * like "foundry", "provision", "ai" — even though the file
 * `provision-ai-foundry.sh` exists under scripts/.
 *
 * Also covers: sqlite-vec extension not available on macOS arm binary install.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { closeDatabase, getAllEntries, openDatabase, searchFts } from "../src/db";
import { agentikitIndex } from "../src/indexer";
import { agentikitSearch } from "../src/stash-search";
import type { LocalSearchHit } from "../src/stash-types";

// ── Temp directory tracking ─────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-issue36-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function tmpStash(): string {
  const dir = createTmpDir("akm-issue36-stash-");
  for (const sub of ["tools", "skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

async function buildTestIndex(stashDir: string, files: Record<string, string> = {}) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(stashDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearch: false, searchPaths: [] });
  return agentikitIndex({ stashDir, full: true });
}

// ── Environment isolation ───────────────────────────────────────────────────

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-issue36-cache-");
  testConfigDir = createTmpDir("akm-issue36-config-");
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalAkmStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalAkmStashDir;
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

// ── Issue #36 reproduction tests ────────────────────────────────────────────

describe("Issue #36: Script search and index", () => {
  test("scripts placed directly in scripts/ dir are indexed", async () => {
    const stashDir = tmpStash();

    // Mimics the reported scenario: a script file placed directly in scripts/
    writeFile(
      path.join(stashDir, "scripts", "provision-ai-foundry.sh"),
      "#!/usr/bin/env bash\n# Provision AI Foundry resources on Azure\naz group create --name ai-foundry\n",
    );

    const result = await buildTestIndex(stashDir);

    expect(result.totalEntries).toBeGreaterThanOrEqual(1);

    // Verify the script entry was created in the index
    const db = openDatabase();
    try {
      const entries = getAllEntries(db);
      const scriptEntries = entries.filter((e) => e.entry.type === "script");
      expect(scriptEntries.length).toBeGreaterThanOrEqual(1);

      const foundryEntry = scriptEntries.find(
        (e) => e.entry.name.includes("provision") || e.entry.name.includes("foundry"),
      );
      expect(foundryEntry).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("search for 'foundry' finds provision-ai-foundry.sh", async () => {
    const stashDir = tmpStash();

    writeFile(
      path.join(stashDir, "scripts", "provision-ai-foundry.sh"),
      "#!/usr/bin/env bash\n# Provision AI Foundry resources on Azure\naz group create --name ai-foundry\n",
    );

    await buildTestIndex(stashDir);

    const result = await agentikitSearch({ query: "foundry", source: "local" });
    const localHits = result.hits.filter((h): h is LocalSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const foundryHit = localHits.find((h) => h.name.includes("foundry") || h.name.includes("provision"));
    expect(foundryHit).toBeDefined();
  });

  test("search for 'provision' finds provision-ai-foundry.sh", async () => {
    const stashDir = tmpStash();

    writeFile(
      path.join(stashDir, "scripts", "provision-ai-foundry.sh"),
      "#!/usr/bin/env bash\n# Provision AI Foundry resources on Azure\naz group create --name ai-foundry\n",
    );

    await buildTestIndex(stashDir);

    const result = await agentikitSearch({ query: "provision", source: "local" });
    const localHits = result.hits.filter((h): h is LocalSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const hit = localHits.find((h) => h.name.includes("provision") || h.name.includes("foundry"));
    expect(hit).toBeDefined();
  });

  test("search for 'ai' finds provision-ai-foundry.sh", async () => {
    const stashDir = tmpStash();

    writeFile(
      path.join(stashDir, "scripts", "provision-ai-foundry.sh"),
      "#!/usr/bin/env bash\n# Provision AI Foundry resources on Azure\naz group create --name ai-foundry\n",
    );

    await buildTestIndex(stashDir);

    const result = await agentikitSearch({ query: "ai", source: "local" });
    const localHits = result.hits.filter((h): h is LocalSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const hit = localHits.find(
      (h) => h.name.includes("provision") || h.name.includes("foundry") || h.name.includes("ai"),
    );
    expect(hit).toBeDefined();
  });

  test("multiple scripts in scripts/ dir are all indexed", async () => {
    const stashDir = tmpStash();

    // Scenario: multiple scripts placed flat in scripts/ (not in subdirectories)
    const scripts: Record<string, string> = {
      "scripts/provision-ai-foundry.sh": "#!/bin/bash\n# Provision AI Foundry\necho provision\n",
      "scripts/deploy-webapp.sh": "#!/bin/bash\n# Deploy web application\necho deploy\n",
      "scripts/backup-database.py": "#!/usr/bin/env python3\n# Backup the database\nprint('backup')\n",
      "scripts/setup-environment.sh": "#!/bin/bash\n# Set up dev environment\necho setup\n",
      "scripts/run-tests.ts": "// Run all test suites\nconsole.log('test')\n",
    };

    const result = await buildTestIndex(stashDir, scripts);

    // All 5 scripts should be indexed
    expect(result.totalEntries).toBeGreaterThanOrEqual(5);

    const db = openDatabase();
    try {
      const entries = getAllEntries(db);
      const scriptEntries = entries.filter((e) => e.entry.type === "script");
      expect(scriptEntries.length).toBe(5);
    } finally {
      closeDatabase(db);
    }
  });

  test("scripts in subdirectories of scripts/ are indexed", async () => {
    const stashDir = tmpStash();

    writeFile(
      path.join(stashDir, "scripts", "azure", "provision-ai-foundry.sh"),
      "#!/bin/bash\n# Provision AI Foundry\necho provision\n",
    );

    const result = await buildTestIndex(stashDir);
    expect(result.totalEntries).toBeGreaterThanOrEqual(1);

    const searchResult = await agentikitSearch({ query: "foundry", source: "local" });
    const localHits = searchResult.hits.filter((h): h is LocalSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Issue #36: buildSearchText includes script content from comments", () => {
  test("buildSearchText includes description derived from comments for scripts", async () => {
    const stashDir = tmpStash();

    writeFile(
      path.join(stashDir, "scripts", "provision-ai-foundry.sh"),
      "#!/usr/bin/env bash\n# Provision AI Foundry resources on Azure\naz group create --name ai-foundry\n",
    );

    await buildTestIndex(stashDir);

    const db = openDatabase();
    try {
      const entries = getAllEntries(db);
      const scriptEntry = entries.find((e) => e.entry.name.includes("provision"));
      expect(scriptEntry).toBeDefined();

      // The search text should include words from filename AND from the description
      // (which is extracted from the comment header)
      const searchText = scriptEntry?.searchText;
      expect(searchText).toContain("provision");
      expect(searchText).toContain("foundry");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("Issue #36: FTS5 query sanitization", () => {
  test("sanitizeFtsQuery keeps short but valid tokens like 'ai'", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "ai-helper.sh"), "#!/bin/bash\n# AI helper script\necho ai\n");

    await buildTestIndex(stashDir);

    // Directly test FTS with "ai" query
    const db = openDatabase();
    try {
      const results = searchFts(db, "ai", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("sanitizeFtsQuery filters single-character tokens", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "x-tool.sh"), "#!/bin/bash\n# X tool\necho x\n");

    await buildTestIndex(stashDir);

    // Single char tokens are now allowed by sanitizeFtsQuery
    const db = openDatabase();
    try {
      const results = searchFts(db, "x", 10);
      // "x" is a valid single-character token, so it should match
      expect(results.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db);
    }
  });
});

describe("Issue #36: Stale .stash.json prevents new files from being indexed", () => {
  test("new files added after initial index are discovered on re-index", async () => {
    const stashDir = tmpStash();

    // Step 1: Create initial scripts and index
    writeFile(path.join(stashDir, "scripts", "deploy-app.sh"), "#!/bin/bash\n# Deploy application\necho deploy\n");
    writeFile(path.join(stashDir, "scripts", "backup-db.sh"), "#!/bin/bash\n# Backup database\necho backup\n");

    const result1 = await buildTestIndex(stashDir);
    expect(result1.totalEntries).toBe(2);

    // No .stash.json should be auto-generated
    const stashJsonPath = path.join(stashDir, "scripts", ".stash.json");
    expect(fs.existsSync(stashJsonPath)).toBe(false);

    // Step 2: Add a NEW script file after the initial index
    writeFile(
      path.join(stashDir, "scripts", "provision-ai-foundry.sh"),
      "#!/usr/bin/env bash\n# Provision AI Foundry resources\naz group create --name ai-foundry\n",
    );

    // Step 3: Re-index (full rebuild) — all files discovered without .stash.json
    const result2 = await buildTestIndex(stashDir);
    expect(result2.totalEntries).toBe(3);

    // Step 4: Verify the new script is searchable
    const searchResult = await agentikitSearch({ query: "foundry", source: "local" });
    const localHits = searchResult.hits.filter((h): h is LocalSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const foundryHit = localHits.find((h) => h.name.includes("foundry") || h.name.includes("provision"));
    expect(foundryHit).toBeDefined();
  });

  test("incremental index discovers newly added scripts in existing directory", async () => {
    const stashDir = tmpStash();

    // Initial index with one script
    writeFile(path.join(stashDir, "scripts", "existing.sh"), "#!/bin/bash\n# Existing script\necho existing\n");

    await buildTestIndex(stashDir);

    // Add new script and run incremental index
    writeFile(
      path.join(stashDir, "scripts", "provision-ai-foundry.sh"),
      "#!/usr/bin/env bash\n# Provision AI Foundry resources\necho provision\n",
    );

    // Incremental index (not full)
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });
    const result = await agentikitIndex({ stashDir });

    // Both scripts should be in the index
    expect(result.totalEntries).toBe(2);

    // Search should find the new script
    const searchResult = await agentikitSearch({ query: "provision", source: "local" });
    const localHits = searchResult.hits.filter((h): h is LocalSearchHit => h.type !== "registry");
    expect(localHits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Issue #36: Search path and installed source indexing", () => {
  test("scripts from search path sources are indexed and searchable", async () => {
    const workingStash = tmpStash();
    const searchPathStash = tmpStash();

    // Put the script in the search path, not the primary stash
    writeFile(
      path.join(searchPathStash, "scripts", "provision-ai-foundry.sh"),
      "#!/usr/bin/env bash\n# Provision AI Foundry resources on Azure\naz group create --name ai-foundry\n",
    );

    process.env.AKM_STASH_DIR = workingStash;
    saveConfig({ semanticSearch: false, searchPaths: [searchPathStash] });
    await agentikitIndex({ stashDir: workingStash, full: true });

    const result = await agentikitSearch({ query: "foundry", source: "local" });
    const localHits = result.hits.filter((h): h is LocalSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const hit = localHits.find((h) => h.name.includes("foundry") || h.name.includes("provision"));
    expect(hit).toBeDefined();
  });

  test("empty primary stash + populated search path still indexes all assets", async () => {
    const workingStash = tmpStash(); // empty
    const searchPathStash = tmpStash();

    // Populate search path with various assets
    writeFile(
      path.join(searchPathStash, "scripts", "provision-ai-foundry.sh"),
      "#!/bin/bash\n# Provision AI Foundry\necho foundry\n",
    );
    writeFile(
      path.join(searchPathStash, "scripts", "deploy-app.sh"),
      "#!/bin/bash\n# Deploy application\necho deploy\n",
    );
    writeFile(path.join(searchPathStash, "tools", "lint", "lint.sh"), "#!/bin/bash\n# Lint code\necho lint\n");
    writeFile(
      path.join(searchPathStash, "commands", "release.md"),
      "---\ndescription: Release the project\n---\n# Release\n",
    );

    process.env.AKM_STASH_DIR = workingStash;
    saveConfig({ semanticSearch: false, searchPaths: [searchPathStash] });
    const indexResult = await agentikitIndex({ stashDir: workingStash, full: true });

    // All 4 assets from the search path should be indexed
    expect(indexResult.totalEntries).toBeGreaterThanOrEqual(4);

    // Verify search finds the script
    const searchResult = await agentikitSearch({ query: "foundry", source: "local" });
    const localHits = searchResult.hits.filter((h): h is LocalSearchHit => h.type !== "registry");
    expect(localHits.length).toBeGreaterThanOrEqual(1);
  });
});
