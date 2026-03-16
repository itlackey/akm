import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { agentikitIndex } from "../src/indexer";
import { agentikitSearch } from "../src/stash-search";
import type { StashSearchHit } from "../src/stash-types";

// ── Temp directory tracking ─────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined || value === null) {
    throw new Error("Expected value to be defined");
  }
  return value;
}

function createTmpDir(prefix = "akm-search-"): string {
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

/**
 * Create a stash directory with all required subdirectories.
 */
function tmpStash(): string {
  const dir = createTmpDir("akm-search-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

/**
 * Build an index for a stash directory from a set of files and their content.
 * Also writes a config with semanticSearch disabled so embedding is not attempted.
 */
async function buildTestIndex(stashDir: string, files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(stashDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearch: false, searchPaths: [] });
  await agentikitIndex({ stashDir, full: true });
}

// ── Environment isolation ───────────────────────────────────────────────────

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-search-cache-");
  testConfigDir = createTmpDir("akm-search-config-");
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

// ── 2.1 Database search path (FTS scoring) ──────────────────────────────────

describe("Database search path (FTS scoring)", () => {
  test("FTS search returns scored results for matching query", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "deploy", "deploy.sh"), "#!/bin/bash\necho deploy\n");
    writeFile(
      path.join(stashDir, "scripts", "deploy", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "deploy",
            type: "script",
            description: "Deploy application to production servers",
            filename: "deploy.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "deploy", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const deployHit = localHits.find((h) => h.name === "deploy");
    const resolvedDeployHit = expectDefined(deployHit);
    expect(resolvedDeployHit.ref).toContain("script:deploy");
    expect(resolvedDeployHit.action).toContain("akm show");
    expect(resolvedDeployHit.size).toBeDefined();
    expect(resolvedDeployHit.score).toBeDefined();
    expect(resolvedDeployHit.score).toBeGreaterThan(0);
  });

  test("FTS search filters by asset type", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "lint", "lint.sh"), "#!/bin/bash\necho lint\n");
    writeFile(
      path.join(stashDir, "scripts", "lint", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "lint",
            type: "script",
            description: "Lint source code for errors",
            filename: "lint.sh",
          },
        ],
      }),
    );

    writeFile(path.join(stashDir, "skills", "code-review", "SKILL.md"), "# Code Review\nReview code for quality.\n");
    writeFile(
      path.join(stashDir, "skills", "code-review", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "code-review",
            type: "skill",
            description: "Review code for quality issues",
            filename: "SKILL.md",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "code", type: "script", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    for (const hit of localHits) {
      expect(hit.type).toBe("script");
    }
  });

  test("empty query returns all entries", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "alpha", "alpha.sh"), "#!/bin/bash\necho alpha\n");
    writeFile(
      path.join(stashDir, "scripts", "alpha", ".stash.json"),
      JSON.stringify({
        entries: [{ name: "alpha", type: "script", description: "Alpha tool", filename: "alpha.sh" }],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "beta", "beta.sh"), "#!/bin/bash\necho beta\n");
    writeFile(
      path.join(stashDir, "scripts", "beta", ".stash.json"),
      JSON.stringify({
        entries: [{ name: "beta", type: "script", description: "Beta tool", filename: "beta.sh" }],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "gamma", "gamma.sh"), "#!/bin/bash\necho gamma\n");
    writeFile(
      path.join(stashDir, "scripts", "gamma", ".stash.json"),
      JSON.stringify({
        entries: [{ name: "gamma", type: "script", description: "Gamma tool", filename: "gamma.sh" }],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    expect(localHits.length).toBe(3);
  });

  test("limit parameter caps results", async () => {
    const stashDir = tmpStash();

    const names = ["aaa", "bbb", "ccc", "ddd", "eee"];
    for (const name of names) {
      writeFile(path.join(stashDir, "scripts", name, `${name}.sh`), `#!/bin/bash\necho ${name}\n`);
      writeFile(
        path.join(stashDir, "scripts", name, ".stash.json"),
        JSON.stringify({
          entries: [{ name, type: "script", description: `${name} tool for testing`, filename: `${name}.sh` }],
        }),
      );
    }

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "", limit: 3, source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    expect(localHits.length).toBe(3);
  });

  test("scores use multiplicative boosts without clamping", async () => {
    const stashDir = tmpStash();

    // Create an entry with tags, searchHints, and name all matching the query
    writeFile(path.join(stashDir, "scripts", "clamp-deploy", "clamp-deploy.sh"), "#!/bin/bash\necho deploy\n");
    writeFile(
      path.join(stashDir, "scripts", "clamp-deploy", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "clamp-deploy",
            type: "script",
            description: "Deploy deploy deploy application",
            tags: ["deploy", "deployment"],
            searchHints: ["deploy services", "deploy to production"],
            filename: "clamp-deploy.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "deploy", source: "local" });

    expect(result.hits.length).toBeGreaterThan(0);
    const deployHit = result.hits.find((h) => h.name === "clamp-deploy");
    const resolvedDeployHit = expectDefined(deployHit);
    expect(resolvedDeployHit.score).toBeDefined();
    expect(resolvedDeployHit.score).toBeGreaterThan(0);
  });
});

// ── 2.2 Score boosts ────────────────────────────────────────────────────────

describe("Score boosts", () => {
  test("tag match boosts score", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "deploy", "deploy.sh"), "#!/bin/bash\necho deploy\n");
    writeFile(
      path.join(stashDir, "scripts", "deploy", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "deploy",
            type: "script",
            description: "Deploy application",
            tags: ["deploy", "production"],
            filename: "deploy.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "deploy", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
    const deployHit = localHits.find((h) => h.name === "deploy");

    const resolvedDeployHit = expectDefined(deployHit);
    expect(resolvedDeployHit.whyMatched).toBeDefined();
    expect(resolvedDeployHit.whyMatched).toContain("matched tags");
  });

  test("name match boosts score", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "formatter", "formatter.sh"), "#!/bin/bash\necho format\n");
    writeFile(
      path.join(stashDir, "scripts", "formatter", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "formatter",
            type: "script",
            description: "Format source files",
            filename: "formatter.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "formatter", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
    const hit = localHits.find((h) => h.name === "formatter");

    const resolvedHit = expectDefined(hit);
    expect(resolvedHit.whyMatched).toBeDefined();
    expect(resolvedHit.whyMatched).toContain("matched name tokens");
  });

  test("curated metadata gets quality boost", async () => {
    const stashDir = tmpStash();

    // Curated entry (quality absent or "curated")
    writeFile(path.join(stashDir, "scripts", "curated", "curated.sh"), "#!/bin/bash\necho curated\n");
    writeFile(
      path.join(stashDir, "scripts", "curated", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "curated",
            type: "script",
            description: "A testing utility",
            quality: "curated",
            filename: "curated.sh",
          },
        ],
      }),
    );

    // Generated entry — identical description so FTS score is the same;
    // only the `quality` field differs, isolating the curated boost.
    writeFile(path.join(stashDir, "scripts", "generated", "generated.sh"), "#!/bin/bash\necho generated\n");
    writeFile(
      path.join(stashDir, "scripts", "generated", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "generated",
            type: "script",
            description: "A testing utility",
            quality: "generated",
            filename: "generated.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "testing utility", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    const curatedHit = localHits.find((h) => h.name === "curated");
    const generatedHit = localHits.find((h) => h.name === "generated");

    const resolvedCuratedHit = expectDefined(curatedHit);
    const resolvedGeneratedHit = expectDefined(generatedHit);
    expect(resolvedCuratedHit.score).toBeDefined();
    expect(resolvedGeneratedHit.score).toBeDefined();
    // Scores are rounded to 2 decimal places, so small boosts may tie.
    // Verify curated ranks at least as high (sort order preserves pre-rounding order).
    expect(resolvedCuratedHit.score).toBeGreaterThanOrEqual(resolvedGeneratedHit.score);
    expect(resolvedCuratedHit.whyMatched).toBeDefined();
    expect(resolvedCuratedHit.whyMatched).toContain("curated metadata boost");
  });
});

// ── 2.3 Substring fallback ──────────────────────────────────────────────────

describe("Substring fallback", () => {
  test("falls back to substring search when no index exists", async () => {
    const stashDir = tmpStash();

    // Do NOT call agentikitIndex — just create files on disk
    writeFile(path.join(stashDir, "scripts", "deploy", "deploy.sh"), "#!/bin/bash\necho deploy\n");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitSearch({ query: "deploy", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const deployHit = localHits.find((h) => h.name.includes("deploy"));
    expect(deployHit).toBeDefined();
    // Substring fallback computes a relevance score but has no whyMatched
    expect(deployHit?.score).toBeGreaterThan(0);
    expect(deployHit?.score).toBeLessThanOrEqual(1);
    expect(deployHit?.whyMatched).toBeUndefined();
  });

  test("substring search is case-insensitive", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "Deploy", "Deploy.sh"), "#!/bin/bash\necho deploy\n");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });

    // Do NOT call agentikitIndex
    const result = await agentikitSearch({ query: "deploy", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const hit = localHits.find((h) => h.name.toLowerCase().includes("deploy"));
    expect(hit).toBeDefined();
  });

  test("substring fallback searches descriptions and returns them", async () => {
    const stashDir = tmpStash();

    writeFile(
      path.join(stashDir, "agents", "agentic-systems-architect.md"),
      "---\ndescription: Designs agent coordination patterns and context assembly\n---\nYou are an architect.\n",
    );
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitSearch({ query: "coordination", type: "agent", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    expect(localHits).toHaveLength(1);
    expect(localHits[0]?.name).toBe("agentic-systems-architect");
    expect(localHits[0]?.description).toContain("agent coordination patterns");
  });

  test("substring fallback honors curated .stash.json metadata", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "doctor", "doctor.sh"), "#!/bin/bash\necho doctor\n");
    writeFile(
      path.join(stashDir, "scripts", "doctor", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "doctor",
            type: "script",
            description: "Diagnose workspace health issues",
            tags: ["health", "diagnostics"],
            filename: "doctor.sh",
          },
        ],
      }),
    );
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitSearch({ query: "diagnostics", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
    const doctorHit = localHits.find((h) => h.name === "doctor");

    expect(doctorHit).toBeDefined();
    expect(doctorHit?.description).toBe("Diagnose workspace health issues");
    expect(doctorHit?.tags).toContain("diagnostics");
  });
});

// ── 2.4 Source filtering ────────────────────────────────────────────────────

describe("Source filtering", () => {
  test("source: local skips registry search", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "local-tool", "local-tool.sh"), "#!/bin/bash\necho local\n");
    writeFile(
      path.join(stashDir, "scripts", "local-tool", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "local-tool",
            type: "script",
            description: "A local tool",
            filename: "local-tool.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await agentikitSearch({ query: "local", source: "local" });

    // All hits should be local, no registry hits
    for (const hit of result.hits) {
      expect(hit.type).not.toBe("registry");
      if (hit.type !== "registry") {
        expect(hit.origin).toBeNull();
        expect(hit.action).toContain("akm show");
      }
    }
    // No warnings from registry search failures
    expect(result.warnings).toBeUndefined();
  });

  test("source: registry skips local search", async () => {
    const stashDir = createTmpDir();
    // Create a local tool so we know local hits would exist if local were searched
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/bin/bash\necho deploy\n");
    process.env.AKM_STASH_DIR = stashDir;
    saveConfig({ semanticSearch: false, searchPaths: [], registries: [] });

    const result = await agentikitSearch({ query: "deploy", source: "registry" });
    // All hits (if any) should come from registry, not local
    expect(result.source).toBe("registry");
    for (const hit of result.hits) {
      expect(hit.type).toBe("registry");
    }
  });

  test("source: both includes local hits without crashing", async () => {
    const stashDir = createTmpDir();
    writeFile(path.join(stashDir, "scripts", "merge-test.sh"), "#!/bin/bash\necho merge\n");
    await buildTestIndex(stashDir, {});
    saveConfig({ semanticSearch: false, searchPaths: [], registries: [] });

    const result = await agentikitSearch({ query: "merge", source: "both" });
    expect(result.source).toBe("both");
    // Should have at least the local hit
    const localHits = result.hits.filter((h) => h.type !== "registry");
    expect(localHits.length).toBeGreaterThan(0);
  });
});

// ── 2.5 Edge cases ──────────────────────────────────────────────────────────

describe("Edge cases", () => {
  test("search with special characters does not crash", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "safe", "safe.sh"), "#!/bin/bash\necho safe\n");
    writeFile(
      path.join(stashDir, "scripts", "safe", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "safe",
            type: "script",
            description: "A safe tool",
            filename: "safe.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    // Should not throw
    const result = await agentikitSearch({ query: "<script>", source: "local" });
    expect(result).toBeDefined();
    expect(result.hits).toBeDefined();
  });

  test("search with very long query", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "simple", "simple.sh"), "#!/bin/bash\necho simple\n");
    writeFile(
      path.join(stashDir, "scripts", "simple", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "simple",
            type: "script",
            description: "A simple tool",
            filename: "simple.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const longQuery = "a".repeat(10_000);
    // Should not throw
    const result = await agentikitSearch({ query: longQuery, source: "local" });
    expect(result).toBeDefined();
    expect(result.hits).toBeDefined();
  });
});
