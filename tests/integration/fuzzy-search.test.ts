import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { searchUnitsLexical } from "../../src/indexer/search/db-search";
import type { UnitLexicalHit } from "../../src/indexer/search/ranking";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { getEntryById, upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";
import { seedUnitsForAllEntries } from "../_helpers/seed-units";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "fuzzy"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

function tmpDbPath(label = "fuzzy"): string {
  const dir = tmpDir(label);
  return path.join(dir, "test.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<IndexDocument> & { name: string; type: IndexDocument["type"] }): IndexDocument {
  return {
    description: "A test entry",
    ...overrides,
  };
}

function insertTestEntry(
  db: Database,
  key: string,
  opts?: {
    dirPath?: string;
    filePath?: string;
    description?: string;
    searchText?: string;
    type?: IndexDocument["type"];
  },
): number {
  const type = opts?.type ?? "skill";
  const entry = makeEntry({ name: key, type, description: opts?.description ?? `Description for ${key}` });
  const dirPath = opts?.dirPath ?? "/test/dir";
  const provenance = deriveEntryProvenance(
    { bundleId: "test-bundle", componentId: "test-bundle", adapterId: "akm" },
    type,
    key,
  );
  return upsertEntry(
    db,
    opts?.filePath ?? path.join(dirPath, `${key}.ts`),
    entry,
    opts?.searchText ?? `${key} ${entry.description}`,
    provenance,
  );
}

/**
 * The units path's entry-level lexical equivalent of the old `searchFts`'s
 * `.entry.name`/`.entry.type`/`.lexicalMatch` result shape: resolve each
 * matched unit back to its owning entry via `entry_units`, optionally
 * narrowed by type (`searchUnitsLexical` itself has no type filter — that
 * narrowing lives one layer up, in `fuseByEntry`/`collectSearchSignals`).
 */
function searchEntries(
  db: Database,
  query: string,
  k: number,
  entryType?: string,
): Array<{ name: string; type: string; lexicalMatch: UnitLexicalHit["lexicalMatch"] }> {
  return searchUnitsLexical(db, query, k).flatMap((hit) => {
    const row = db.prepare("SELECT entry_id FROM entry_units WHERE unit_hash = ?").get(hit.unitHash) as
      | { entry_id: number }
      | undefined;
    if (!row) return [];
    const found = getEntryById(db, row.entry_id);
    if (!found || (entryType && found.entry.type !== entryType)) return [];
    return [{ name: found.entry.name, type: found.entry.type, lexicalMatch: hit.lexicalMatch }];
  });
}

// ── Fuzzy / prefix fallback tests ───────────────────────────────────────────

describe("Fuzzy prefix fallback in searchUnitsLexical", () => {
  test("exact match still works normally", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "kubernetes", {
        searchText: "kubernetes container orchestration platform",
      });
      seedUnitsForAllEntries(db);

      const results = searchEntries(db, "kubernetes", 10);
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe("kubernetes");
    } finally {
      closeDatabase(db);
    }
  });

  test("truncated prefix — 'kubernet' matches 'kubernetes' via prefix expansion", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "kubernetes", {
        searchText: "kubernetes container orchestration platform",
      });
      seedUnitsForAllEntries(db);

      // "kubernet" has no exact FTS match; the prefix fallback expands it to "kubernet*".
      const results = searchEntries(db, "kubernet", 10);
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe("kubernetes");
    } finally {
      closeDatabase(db);
    }
  });

  test("partial prefix match — 'kube' finds 'kubernetes' assets", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "kubernetes", {
        searchText: "kubernetes container orchestration",
      });
      insertTestEntry(db, "kubelet", {
        searchText: "kubelet node agent kubernetes",
      });
      seedUnitsForAllEntries(db);

      // "kube" should not match exactly (FTS5 uses full token matching).
      // The prefix fallback should append * and find both "kubernetes" and "kubelet".
      const results = searchEntries(db, "kube", 10);
      expect(results.length).toBe(2);
      const names = results.map((r) => r.name).sort();
      expect(names).toContain("kubernetes");
      expect(names).toContain("kubelet");
    } finally {
      closeDatabase(db);
    }
  });

  test("multiple token query with prefix fallback", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "deploy-kubernetes", {
        searchText: "deploy kubernetes production cluster",
      });
      insertTestEntry(db, "deploy-docker", {
        searchText: "deploy docker containers locally",
      });
      seedUnitsForAllEntries(db);

      // "deploy kube" — "deploy" matches exactly, "kube" needs prefix
      // fallback: "deploy-kubernetes" wins the prefix tier ("deploy"
      // "kube*"). Item 2 (search fix round 2) — the tier ladder is a
      // priority order, not an early exit — so with capacity to spare
      // (k=10) it also tops up with the relaxed tier, where "deploy-docker"
      // legitimately matches on "deploy" alone; magnitude fusion
      // (ranking.ts's fuseByEntry) is what makes surfacing it safe, since a
      // relaxed match no longer competes on RANK with the stronger prefix
      // hit the way it would have under reciprocal rank fusion.
      const results = searchEntries(db, "deploy kube", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const byName = new Map(results.map((r) => [r.name, r]));
      expect(byName.get("deploy-kubernetes")?.lexicalMatch).toBe("prefix");
      expect(byName.get("deploy-docker")?.lexicalMatch).toBe("relaxed");
    } finally {
      closeDatabase(db);
    }
  });

  test("non-matching query returns empty even with prefix fallback", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "kubernetes", {
        searchText: "kubernetes container orchestration",
      });
      seedUnitsForAllEntries(db);

      // "xyznonexist" has no prefix match in the index
      const results = searchEntries(db, "xyznonexist", 10);
      expect(results).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  test("short tokens (1-2 chars) should NOT get prefix expansion", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "kubernetes", {
        searchText: "kubernetes container orchestration",
      });
      insertTestEntry(db, "kafka", {
        searchText: "kafka streaming events",
      });
      seedUnitsForAllEntries(db);

      // "k" is a 1-char token — should NOT be prefix-expanded to "k*" which
      // would match everything starting with "k".
      // Since "k" doesn't match any full token, should return empty.
      const results = searchEntries(db, "k", 10);
      expect(results).toEqual([]);

      // "ka" is a 2-char token — also should not be prefix-expanded.
      const results2 = searchEntries(db, "ka", 10);
      expect(results2).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  test("all-short multi-token queries skip prefix expansion but still use measured OR recovery", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "golang-setup", {
        searchText: "go golang setup configuration",
      });
      insertTestEntry(db, "js-tooling", {
        searchText: "js javascript tooling bundler",
      });
      seedUnitsForAllEntries(db);

      const results = searchEntries(db, "go js", 10);
      expect(results.map((result) => result.name)).toContain("js-tooling");
      expect(results.every((result) => result.lexicalMatch === "relaxed")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("prefix fallback only triggers when exact match returns zero results", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "deploy", {
        searchText: "deploy application production",
      });
      insertTestEntry(db, "deployment-manager", {
        searchText: "deployment manager orchestration",
      });
      seedUnitsForAllEntries(db);

      // "deploy" matches exactly — should return results from exact match,
      // not the prefix fallback. FTS5 with porter stemmer may match
      // "deployment" as well through stemming, but the key point is that
      // the exact query runs first and returns results.
      const results = searchEntries(db, "deploy", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The first result should be "deploy" (exact match has best BM25)
      expect(results[0]!.name).toBe("deploy");
    } finally {
      closeDatabase(db);
    }
  });

  test("prefix fallback with entryType filter", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "kubernetes-skill", {
        type: "skill",
        searchText: "kubernetes container management skill",
      });
      insertTestEntry(db, "kubernetes-script", {
        type: "script",
        searchText: "kubernetes deployment script automation",
      });
      seedUnitsForAllEntries(db);

      // "kube" with type filter "skill" should only return the skill entry
      const results = searchEntries(db, "kube", 10, "skill");
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe("kubernetes-skill");
      expect(results[0]!.type).toBe("skill");
    } finally {
      closeDatabase(db);
    }
  });
});
