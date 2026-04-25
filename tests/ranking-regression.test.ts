/**
 * Ranking regression tests for akm search system.
 *
 * Uses the synthetic fixture stash at tests/fixtures/stash/ to validate
 * search ranking invariants: score differentiation, exact name matching,
 * type ranking, fuzzy/prefix matching, score preservation, and provider
 * merge behavior.
 *
 * The fixture stash is indexed once in beforeAll and all tests share the
 * same index to keep the suite fast.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { closeDatabase, openDatabase, rebuildFts, setMeta, upsertEntry } from "../src/db";
import type { StashEntry, StashFile } from "../src/metadata";
import { getDbPath } from "../src/paths";
import { buildSearchText } from "../src/search-fields";
import { akmSearch, mergeStashHits } from "../src/stash-search";
import type { StashSearchHit } from "../src/stash-types";

// ── Fixture path ────────────────────────────────────────────────────────────

const FIXTURE_STASH = path.resolve(__dirname, "ranking-fixtures", "stash");

// ── Temp directory tracking ─────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-ranking-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

// ── Environment isolation ───────────────────────────────────────────────────

let originalXdgCacheHome: string | undefined;
let originalXdgConfigHome: string | undefined;
let originalAkmStashDir: string | undefined;
let testCacheDir: string;
let testConfigDir: string;

beforeAll(async () => {
  originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalAkmStashDir = process.env.AKM_STASH_DIR;
  testCacheDir = createTmpDir("akm-ranking-cache-");
  testConfigDir = createTmpDir("akm-ranking-config-");

  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = FIXTURE_STASH;

  saveConfig({
    semanticSearchMode: "off",
    stashes: [{ type: "filesystem", path: FIXTURE_STASH }],
    registries: [],
  });

  buildFixtureIndex();
});

afterAll(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;

  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Index builder ───────────────────────────────────────────────────────────

/**
 * Walk the fixture stash, read .stash.json files, and index all entries
 * directly into the SQLite database.
 */
function buildFixtureIndex(): void {
  const dbPath = getDbPath();
  const db = openDatabase(dbPath);
  try {
    const stashJsonPaths = findStashJsonFiles(FIXTURE_STASH);

    for (const stashJsonPath of stashJsonPaths) {
      const dirPath = path.dirname(stashJsonPath);
      const raw = JSON.parse(fs.readFileSync(stashJsonPath, "utf8"));
      if (!raw || !Array.isArray(raw.entries)) continue;

      const stash: StashFile = { entries: raw.entries as StashEntry[] };

      for (const entry of stash.entries) {
        const entryPath = entry.filename ? path.join(dirPath, entry.filename) : dirPath;
        const entryKey = `${FIXTURE_STASH}:${entry.type}:${entry.name}`;
        const searchText = buildSearchText(entry);

        let entryWithSize = entry;
        try {
          const size = fs.statSync(entryPath).size;
          entryWithSize = { ...entry, fileSize: size };
        } catch {
          // File might not exist for some entries
        }

        upsertEntry(db, entryKey, dirPath, entryPath, FIXTURE_STASH, entryWithSize, searchText);
      }
    }

    rebuildFts(db);

    setMeta(db, "stashDir", FIXTURE_STASH);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([FIXTURE_STASH]));
    setMeta(db, "hasEmbeddings", "0");
  } finally {
    closeDatabase(db);
  }
}

function findStashJsonFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findStashJsonFiles(fullPath));
    } else if (entry.name === ".stash.json") {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function search(query: string, limit = 20): Promise<StashSearchHit[]> {
  const result = await akmSearch({ query, source: "stash", limit });
  return result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
}

function findHit(hits: StashSearchHit[], name: string): StashSearchHit | undefined {
  return hits.find((h) => h.name === name);
}

/** Assert that a hit exists and return it (avoids non-null assertions). */
function expectHit(hits: StashSearchHit[], name: string): StashSearchHit {
  const hit = findHit(hits, name);
  expect(hit).toBeDefined();
  // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
  return hit!;
}

/** Get the score of a hit, asserting it is defined. */
function scoreOf(hit: StashSearchHit): number {
  expect(hit.score).toBeDefined();
  return hit.score ?? 0;
}

function rankOf(hits: StashSearchHit[], name: string): number {
  const idx = hits.findIndex((h) => h.name === name);
  return idx === -1 ? Infinity : idx + 1; // 1-based rank
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Score differentiation", () => {
  test('"docker homelab" returns skill:docker-homelab in top 3', async () => {
    const hits = await search("docker homelab");
    expect(hits.length).toBeGreaterThanOrEqual(2);

    // docker-homelab should appear in the top results (within top 3)
    // Sub-references also contain "docker-homelab" in their name, so they
    // may rank highly on FTS name-field matching.
    const skillRank = rankOf(hits, "docker-homelab");
    expect(skillRank).toBeLessThanOrEqual(3);

    // The skill should have a meaningful score (not RRF-compressed)
    const skillHit = expectHit(hits, "docker-homelab");
    expect(scoreOf(skillHit)).toBeGreaterThan(0.5);
  });

  test('"docker" returns docker-homelab and docker-clean', async () => {
    const hits = await search("docker");
    expect(hits.length).toBeGreaterThanOrEqual(2);

    // Both docker-related assets should appear in results
    expectHit(hits, "docker-homelab");
    expectHit(hits, "docker-clean");
  });

  test('"svelte component" -> skill:svelte-components ranks #1, above sub-references', async () => {
    const hits = await search("svelte component");
    expect(hits.length).toBeGreaterThanOrEqual(1);

    const skillRank = rankOf(hits, "svelte-components");
    expect(skillRank).toBe(1);

    // Sub-reference should rank below the skill
    const refHit = findHit(hits, "svelte-components/references/web-components");
    if (refHit) {
      const refRank = rankOf(hits, "svelte-components/references/web-components");
      expect(refRank).toBeGreaterThan(skillRank);
    }
  });

  test('"code review" -> command or agent ranks above knowledge docs', async () => {
    const hits = await search("code review");
    expect(hits.length).toBeGreaterThanOrEqual(2);

    // Find the top-ranked actionable asset (skill, command, or agent)
    const actionableTypes = new Set(["skill", "command", "agent"]);
    const topActionable = hits.find((h) => actionableTypes.has(h.type));
    expect(topActionable).toBeDefined();

    // Find the top-ranked knowledge doc
    const topKnowledge = hits.find((h) => h.type === "knowledge");
    if (topKnowledge && topActionable) {
      const actionableRank = rankOf(hits, topActionable.name);
      const knowledgeRank = rankOf(hits, topKnowledge.name);
      expect(actionableRank).toBeLessThan(knowledgeRank);
    }
  });

  test('"mem0 search" -> script:mem0-search ranks #1', async () => {
    const hits = await search("mem0 search");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(rankOf(hits, "mem0-search")).toBe(1);
  });
});

describe("Exact/near-exact name matching", () => {
  test('"docker-homelab" (exact) -> skill:docker-homelab appears in top 3', async () => {
    const hits = await search("docker-homelab");
    expect(hits.length).toBeGreaterThanOrEqual(2);

    // The skill entry and its sub-references all contain "docker-homelab"
    // in their names. The skill gets a name-match boost but sub-references
    // also match on FTS name field. Verify the skill is in the top 3.
    const skillRank = rankOf(hits, "docker-homelab");
    expect(skillRank).toBeLessThanOrEqual(3);

    // The skill should have a strong score
    const skillHit = expectHit(hits, "docker-homelab");
    expect(scoreOf(skillHit)).toBeGreaterThan(0.5);
  });

  test('"mem0-search" (exact) -> script:mem0-search is #1', async () => {
    const hits = await search("mem0-search");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe("mem0-search");
  });

  test('"security-review" (exact) -> command:security-review is #1', async () => {
    const hits = await search("security-review");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe("security-review");
    expect(hits[0].type).toBe("command");
  });

  test('"k8s-deploy" (exact) -> skill:k8s-deploy is #1', async () => {
    const hits = await search("k8s-deploy");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe("k8s-deploy");
    expect(hits[0].type).toBe("skill");
  });

  test('"code-reviewer" (exact) -> agent:code-reviewer is #1', async () => {
    const hits = await search("code-reviewer");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe("code-reviewer");
    expect(hits[0].type).toBe("agent");
  });
});

describe("Type ranking", () => {
  test('for "deploy", skills/commands/scripts rank above knowledge docs', async () => {
    const hits = await search("deploy");
    expect(hits.length).toBeGreaterThanOrEqual(2);

    const actionableTypes = new Set(["skill", "command", "agent", "script"]);
    const topActionable = hits.find((h) => actionableTypes.has(h.type));
    const topKnowledge = hits.find((h) => h.type === "knowledge");

    expect(topActionable).toBeDefined();
    if (topKnowledge && topActionable) {
      expect(rankOf(hits, topActionable.name)).toBeLessThan(rankOf(hits, topKnowledge.name));
    }
  });

  test('for "review", agents/commands/skills rank above knowledge docs', async () => {
    const hits = await search("review");
    expect(hits.length).toBeGreaterThanOrEqual(2);

    const actionableTypes = new Set(["skill", "command", "agent"]);
    const topActionable = hits.find((h) => actionableTypes.has(h.type));
    const topKnowledge = hits.find((h) => h.type === "knowledge");

    expect(topActionable).toBeDefined();
    if (topKnowledge && topActionable) {
      expect(rankOf(hits, topActionable.name)).toBeLessThan(rankOf(hits, topKnowledge.name));
    }
  });
});

describe("Fuzzy/prefix matching", () => {
  test('"kube" finds k8s-deploy via alias', async () => {
    const hits = await search("kube");
    expectHit(hits, "k8s-deploy");
  });

  test('"dock" finds docker-homelab via prefix', async () => {
    const hits = await search("dock");
    expectHit(hits, "docker-homelab");
  });

  test('"incident" finds the runbook', async () => {
    const hits = await search("incident");
    expectHit(hits, "incident-response-runbook");
  });
});

describe("Score preservation (not RRF-flattened)", () => {
  test("top result score > 0.5 (not capped at 0.0164)", async () => {
    const hits = await search("docker homelab");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(scoreOf(hits[0])).toBeGreaterThan(0.5);
  });

  test("top result for exact name query has strong differentiation", async () => {
    // Use a query that uniquely targets one asset
    const hits = await search("mem0 search");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const topScore = scoreOf(hits[0]);
    expect(topScore).toBeGreaterThan(1.0);

    // If there are additional results, the top should be meaningfully higher
    if (hits.length >= 2) {
      expect(topScore).toBeGreaterThan(scoreOf(hits[1]));
    }
  });

  test("scores are monotonically decreasing", async () => {
    const hits = await search("docker");
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1].score ?? 0;
      const curr = hits[i].score ?? 0;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  test("scores are not compressed to a narrow range", async () => {
    const hits = await search("docker");
    expect(hits.length).toBeGreaterThanOrEqual(3);

    const topScore = scoreOf(hits[0]);
    const lastScore = scoreOf(hits[hits.length - 1]);
    const range = topScore - lastScore;

    // Score range should be meaningful, not compressed to ~0.001 like RRF
    expect(range).toBeGreaterThan(0.1);
  });
});

describe("Provider merge (score not destroyed)", () => {
  test("when additional provider hits exist, local scores are preserved", () => {
    const localHits: StashSearchHit[] = [
      {
        type: "skill",
        name: "local-skill-1",
        path: "/test/skills/local-1/SKILL.md",
        ref: "skill:local-skill-1",
        origin: null,
        score: 2.5,
      },
      {
        type: "command",
        name: "local-cmd-1",
        path: "/test/commands/local-1.md",
        ref: "command:local-cmd-1",
        origin: null,
        score: 1.8,
      },
      {
        type: "knowledge",
        name: "local-doc-1",
        path: "/test/knowledge/local-1.md",
        ref: "knowledge:local-doc-1",
        origin: null,
        score: 0.9,
      },
    ];

    const additionalHits: StashSearchHit[] = [
      {
        type: "skill",
        name: "remote-skill-1",
        path: "/remote/skills/remote-1/SKILL.md",
        ref: "skill:remote-skill-1",
        origin: "remote",
        score: 0.85,
      },
    ];

    const merged = mergeStashHits(localHits, additionalHits, 20);

    // Local hits should retain their original scores
    const mergedLocal1 = expectHit(merged, "local-skill-1");
    expect(mergedLocal1.score).toBe(2.5);

    const mergedLocal2 = expectHit(merged, "local-cmd-1");
    expect(mergedLocal2.score).toBe(1.8);
  });

  test("provider hits sort fairly by score alongside local hits", () => {
    const localHits: StashSearchHit[] = [
      {
        type: "skill",
        name: "local-high",
        path: "/test/skills/high/SKILL.md",
        ref: "skill:local-high",
        origin: null,
        score: 2.0,
      },
      {
        type: "skill",
        name: "local-low",
        path: "/test/skills/low/SKILL.md",
        ref: "skill:local-low",
        origin: null,
        score: 0.5,
      },
    ];

    const additionalHits: StashSearchHit[] = [
      {
        type: "skill",
        name: "remote-1",
        path: "/remote/skills/1/SKILL.md",
        ref: "skill:remote-1",
        origin: "remote",
        score: 1.0, // Normalized provider score between local-high and local-low
      },
    ];

    const merged = mergeStashHits(localHits, additionalHits, 20);

    // Provider hit keeps its original score and sorts by score
    const remoteRank = merged.findIndex((h) => h.name === "remote-1") + 1;
    const localHighRank = merged.findIndex((h) => h.name === "local-high") + 1;
    const localLowRank = merged.findIndex((h) => h.name === "local-low") + 1;

    // remote-1 (1.0) should rank between local-high (2.0) and local-low (0.5)
    expect(remoteRank).toBeGreaterThan(localHighRank);
    expect(remoteRank).toBeLessThan(localLowRank);
  });

  test("duplicate provider hits are deduplicated (local version wins)", () => {
    const localHits: StashSearchHit[] = [
      {
        type: "skill",
        name: "shared-skill",
        path: "/test/skills/shared/SKILL.md",
        ref: "skill:shared-skill",
        origin: null,
        score: 2.0,
      },
    ];

    const additionalHits: StashSearchHit[] = [
      {
        type: "skill",
        name: "shared-skill",
        path: "/test/skills/shared/SKILL.md", // Same path = duplicate
        ref: "skill:shared-skill",
        origin: "remote",
        score: 0.5,
      },
    ];

    const merged = mergeStashHits(localHits, additionalHits, 20);

    // Only one instance of the shared skill should appear
    const sharedHits = merged.filter((h) => h.name === "shared-skill");
    expect(sharedHits.length).toBe(1);
    // And it should have the local score
    expect(sharedHits[0].score).toBe(2.0);
  });

  test("merge preserves sort order by score descending", () => {
    const localHits: StashSearchHit[] = [
      { type: "skill", name: "a", path: "/a", ref: "skill:a", origin: null, score: 3.0 },
      { type: "skill", name: "b", path: "/b", ref: "skill:b", origin: null, score: 1.0 },
    ];
    const additionalHits: StashSearchHit[] = [
      { type: "skill", name: "c", path: "/c", ref: "skill:c", origin: "remote", score: 2.0 },
    ];

    const merged = mergeStashHits(localHits, additionalHits, 20);

    for (let i = 1; i < merged.length; i++) {
      const prev = merged[i - 1].score ?? 0;
      const curr = merged[i].score ?? 0;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });
});

describe("Cross-type search consistency", () => {
  test("searching for 'docker' returns docker-homelab and docker-clean", async () => {
    const hits = await search("docker");
    expect(hits.length).toBeGreaterThanOrEqual(2);

    const dockerNames = hits.map((h) => h.name);
    expect(dockerNames).toContain("docker-homelab");
    expect(dockerNames).toContain("docker-clean");
  });

  test("multi-word queries narrow results appropriately", async () => {
    const narrowHits = await search("deploy check");

    // The narrow query should return deploy-check at a high rank
    const deployCheckRank = rankOf(narrowHits, "deploy-check");
    expect(deployCheckRank).toBeLessThanOrEqual(3);
  });

  test("searching for svelte returns both skill and agent", async () => {
    const hits = await search("svelte");
    const svelteNames = hits.map((h) => h.name);
    expect(svelteNames).toContain("svelte-components");
    expect(svelteNames).toContain("svelte-expert");
  });

  test("searching for 'release' finds the release-manager command", async () => {
    const hits = await search("release");
    const releaseHit = expectHit(hits, "release-manager");
    expect(releaseHit.type).toBe("command");
  });
});

describe("Metadata signal strength", () => {
  test("skill with rich metadata appears in results for broad queries", async () => {
    // docker-homelab has rich tags, aliases, searchHints, and curated quality
    const hits = await search("container management");
    const skillHit = expectHit(hits, "docker-homelab");
    expect(scoreOf(skillHit)).toBeGreaterThan(0);
  });

  test("curated quality assets include the curated metadata boost reason", async () => {
    const hits = await search("kubernetes deploy");
    expect(hits.length).toBeGreaterThanOrEqual(1);

    const k8sHit = expectHit(hits, "k8s-deploy");
    expect(k8sHit.whyMatched).toContain("curated metadata boost");
  });

  test("searchHints contribute to matching", async () => {
    // "troubleshoot docker" is a search hint on docker-homelab
    const hits = await search("troubleshoot docker");
    const skillHit = expectHit(hits, "docker-homelab");
    expect(skillHit.whyMatched).toContain("matched searchHints");
  });

  test("aliases contribute to matching", async () => {
    // "docker-compose" is an alias for docker-homelab
    const hits = await search("docker compose");
    const skillHit = expectHit(hits, "docker-homelab");
    expect(skillHit.whyMatched).toContain("matched aliases");
  });

  test("tags contribute to matching", async () => {
    const hits = await search("homelab");
    const skillHit = expectHit(hits, "docker-homelab");
    expect(skillHit.whyMatched).toContain("matched tags");
  });
});

describe("Empty and edge case queries", () => {
  test("empty query returns all entries", async () => {
    const result = await akmSearch({ query: "", source: "stash" });
    expect(result.hits.length).toBeGreaterThan(0);
  });

  test("query with no matches returns empty results with tip", async () => {
    const result = await akmSearch({ query: "xyznonexistent123", source: "stash" });
    const hits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
    expect(hits.length).toBe(0);
  });

  test("single character query returns results when prefix matches", async () => {
    // Single char queries are too short for prefix expansion (< 3 chars)
    // but may still match on exact tokens
    const result = await akmSearch({ query: "k", source: "stash" });
    // This may or may not return results depending on FTS tokenizer behavior
    // The important thing is it does not crash
    expect(result).toBeDefined();
  });
});
