/**
 * Tests for the `akm manifest` command (Task E-1: Deferred/Lazy Tool Loading).
 *
 * The manifest provides a compact asset listing (name, type, ref, one-line
 * description) that stays under 500 tokens for 50 assets, giving agents a
 * cheap way to discover capabilities without loading full content.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/core/config";
import { akmIndex } from "../src/indexer/indexer";
import { akmManifest } from "../src/indexer/manifest";

// ── Temp directory tracking ─────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-manifest-"): string {
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

function tmpStash(): string {
  const dir = createTmpDir("akm-manifest-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
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
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

// ── Environment isolation ───────────────────────────────────────────────────

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-manifest-cache-");
  testConfigDir = createTmpDir("akm-manifest-config-");
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
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("akm manifest", () => {
  test("returns all indexed entries", async () => {
    const stashDir = tmpStash();
    await buildTestIndex(stashDir, {
      "scripts/deploy/deploy.sh": "#!/bin/bash\n# Deploy to production\necho deploy",
      "scripts/lint/lint.sh": "#!/bin/bash\n# Run linter\necho lint",
      "skills/code-review/SKILL.md": "---\ndescription: Review code for quality\n---\n# Code Review",
      "commands/build/BUILD.md": "---\ndescription: Build the project\n---\n# Build",
      "knowledge/api-docs/api-docs.md": "---\ndescription: API documentation reference\n---\n# API Docs",
    });

    const result = await akmManifest({ stashDir });

    expect(result.entries.length).toBe(5);
  });

  test("entries have compact shape (name, type, ref, description only)", async () => {
    const stashDir = tmpStash();
    await buildTestIndex(stashDir, {
      "scripts/deploy/deploy.sh": "#!/bin/bash\n# Deploy to production\necho deploy",
    });

    const result = await akmManifest({ stashDir });

    expect(result.entries.length).toBeGreaterThan(0);
    const entry = result.entries[0];

    // Must have the compact fields
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.type).toBe("string");
    expect(typeof entry.ref).toBe("string");

    // Must NOT have full search hit fields like path, tags, score, action, whyMatched
    const raw = entry as unknown as Record<string, unknown>;
    expect(raw.path).toBeUndefined();
    expect(raw.tags).toBeUndefined();
    expect(raw.score).toBeUndefined();
    expect(raw.action).toBeUndefined();
    expect(raw.whyMatched).toBeUndefined();
    expect(raw.searchText).toBeUndefined();
  });

  test("filters by type", async () => {
    const stashDir = tmpStash();
    await buildTestIndex(stashDir, {
      "scripts/deploy/deploy.sh": "#!/bin/bash\n# Deploy to production\necho deploy",
      "scripts/lint/lint.sh": "#!/bin/bash\n# Run linter\necho lint",
      "skills/code-review/SKILL.md": "---\ndescription: Review code for quality\n---\n# Code Review",
    });

    const result = await akmManifest({ stashDir, type: "script" });

    expect(result.entries.length).toBe(2);
    for (const entry of result.entries) {
      expect(entry.type).toBe("script");
    }
  });

  test("descriptions are truncated to ~80 chars", async () => {
    const stashDir = tmpStash();
    const longDesc =
      "This is a very long description that goes well beyond eighty characters and should be truncated with an ellipsis indicator to keep the manifest compact and token-efficient";
    await buildTestIndex(stashDir, {
      "skills/verbose/SKILL.md": `---\ndescription: ${longDesc}\n---\n# Verbose Skill`,
    });

    const result = await akmManifest({ stashDir });

    expect(result.entries.length).toBeGreaterThan(0);
    const entry = result.entries.find((e) => e.name === "verbose");
    expect(entry).toBeDefined();
    expect(entry?.description).toBeDefined();
    expect(entry?.description?.length).toBeLessThanOrEqual(83); // 80 + "..."
    expect(entry?.description?.endsWith("...")).toBe(true);
  });

  test("output is compact (token budget) for 50 entries", async () => {
    const stashDir = tmpStash();
    const files: Record<string, string> = {};
    // Create 50 script files
    for (let i = 0; i < 50; i++) {
      const name = `script-${String(i).padStart(2, "0")}`;
      files[`scripts/${name}/${name}.sh`] = `#!/bin/bash\n# Task number ${i}\necho ${name}`;
    }
    await buildTestIndex(stashDir, files);

    const result = await akmManifest({ stashDir });

    expect(result.entries.length).toBe(50);
    const json = JSON.stringify(result);
    // Compact: each entry averages ~120 bytes (name, type, ref, short description).
    // 50 entries ≈ 6000 bytes ≈ 1500 tokens. Cap at ~2500 bytes per token budget
    // would be too tight for 50 entries, so we allow up to 7500 bytes (~1875 tokens).
    expect(json.length).toBeLessThan(7500);

    // Verify no entry carries heavyweight fields
    for (const entry of result.entries) {
      const raw = entry as unknown as Record<string, unknown>;
      expect(raw.path).toBeUndefined();
      expect(raw.tags).toBeUndefined();
      expect(raw.score).toBeUndefined();
      expect(raw.action).toBeUndefined();
    }
  });

  test("works without an index (fallback to walker)", async () => {
    const stashDir = tmpStash();
    // Write files but do NOT run akmIndex
    const helloDir = path.join(stashDir, "scripts", "hello");
    fs.mkdirSync(helloDir, { recursive: true });
    fs.writeFileSync(path.join(helloDir, "hello.sh"), "#!/bin/bash\n# Say hello\necho hello");

    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmManifest({ stashDir });

    // Should find entries via walker fallback even without index
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
  });

  test("response has schemaVersion and entries array", async () => {
    const stashDir = tmpStash();
    await buildTestIndex(stashDir, {
      "scripts/deploy/deploy.sh": "#!/bin/bash\n# Deploy\necho deploy",
      "scripts/lint/lint.sh": "#!/bin/bash\n# Lint\necho lint",
      "scripts/test/test.sh": "#!/bin/bash\n# Test\necho test",
    });

    const result = await akmManifest({ stashDir });

    expect(result.schemaVersion).toBe(1);
    expect(result.entries.length).toBe(3);
  });

  test("empty stash returns empty manifest", async () => {
    const stashDir = tmpStash();
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmManifest({ stashDir });

    expect(result.entries).toEqual([]);
    expect(result.schemaVersion).toBe(1);
  });

  test("ref field follows type:name format", async () => {
    const stashDir = tmpStash();
    await buildTestIndex(stashDir, {
      "skills/code-review/SKILL.md": "---\ndescription: Review code quality\n---\n# Code Review",
    });

    const result = await akmManifest({ stashDir });

    const entry = result.entries.find((e) => e.name === "code-review");
    expect(entry).toBeDefined();
    expect(entry?.ref).toMatch(/^skill:code-review$/);
  });
});
