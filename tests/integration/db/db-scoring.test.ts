import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { rebuildFts, searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "db-scoring"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

function tmpDbPath(label = "db-scoring"): string {
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
    stashDir?: string;
    description?: string;
    searchText?: string;
    type?: IndexDocument["type"];
  },
): number {
  const type = opts?.type ?? "script";
  const entry = makeEntry({ name: key, type, description: opts?.description ?? `Description for ${key}` });
  return upsertEntry(
    db,
    opts?.filePath ?? `/test/dir/${key}.ts`,
    entry,
    opts?.searchText ?? `${key} ${entry.description}`,
    deriveEntryProvenance({ bundleId: "test-bundle", componentId: "test-bundle", adapterId: "akm" }, type, key),
  );
}

// ── Issue #2: Integration test — hyphenated search through searchFts ────────

describe("searchFts — hyphenated identifier search (Issue #2)", () => {
  test("searching for 'code-review' matches entry with code-review in search text", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "code-review", {
        description: "code-review skill for reviewing pull requests",
        searchText: "code-review skill for reviewing pull requests",
      });
      insertTestEntry(db, "deploy-prod", {
        description: "deploy-prod deploy to production servers",
        searchText: "deploy-prod deploy to production servers",
      });
      rebuildFts(db);

      const results = searchFts(db, "code-review", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The code-review entry should be the top result
      expect(results[0]!.itemRef).toBe("test-bundle//scripts/code-review");
    } finally {
      closeDatabase(db);
    }
  });

  test("OR semantics: any query word admits a document, more matching words rank higher", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "deploy-tool", {
        description: "deploy applications to production servers",
        searchText: "deploy applications to production servers",
      });
      insertTestEntry(db, "code-tool", {
        description: "code linting and formatting tool",
        searchText: "code linting and formatting tool",
      });
      insertTestEntry(db, "review-tool", {
        description: "review pull requests and merge code",
        searchText: "review pull requests and merge code",
      });
      rebuildFts(db);

      const refs = searchFts(db, "code review", 10).map((r) => r.itemRef);
      expect(refs).toEqual(["test-bundle//scripts/review-tool", "test-bundle//scripts/code-tool"]);
    } finally {
      closeDatabase(db);
    }
  });
});

describe("searchFts candidate limit", () => {
  test("a strict limit, with equal BM25 scores ordered by item_ref", () => {
    const db = openIndexDatabase(tmpDbPath("fts-mixed-boundary"));
    try {
      for (const name of ["better-b", "better-a"]) {
        insertTestEntry(db, name, {
          description: "needle needle needle needle",
          searchText: "needle needle needle needle",
        });
      }
      for (const name of ["boundary-c", "boundary-a", "boundary-b"]) {
        insertTestEntry(db, name, { description: "needle", searchText: "needle" });
      }
      rebuildFts(db);

      expect(searchFts(db, "needle", 3).map((row) => row.itemRef)).toEqual([
        "test-bundle//scripts/better-a",
        "test-bundle//scripts/better-b",
        "test-bundle//scripts/boundary-a",
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  test("applies typed and exclusion filters before the limit", () => {
    const db = openIndexDatabase(tmpDbPath("fts-filtered-boundary"));
    try {
      insertTestEntry(db, "skill-a", { type: "skill", description: "needle", searchText: "needle" });
      insertTestEntry(db, "skill-b", { type: "skill", description: "needle", searchText: "needle" });
      insertTestEntry(db, "knowledge-a", { type: "knowledge", description: "needle", searchText: "needle" });
      rebuildFts(db);

      expect(searchFts(db, "needle", 1, "skill").map((row) => row.itemRef)).toEqual(["test-bundle//skills/skill-a"]);
      expect(searchFts(db, "needle", 1, undefined, ["skill"]).map((row) => row.itemRef)).toEqual([
        "test-bundle//knowledge/knowledge-a",
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  test("thousands of exact BM25 ties still return exactly `limit` rows, quickly", () => {
    const db = openIndexDatabase(tmpDbPath("fts-boundary"));
    try {
      for (let index = 0; index < 3_000; index += 1) {
        insertTestEntry(db, `opaque-${index.toString().padStart(4, "0")}`, {
          description: "needle",
          searchText: "needle",
        });
      }
      rebuildFts(db);

      expect(searchFts(db, "needle", 0)).toEqual([]);

      const started = performance.now();
      const results = searchFts(db, "needle", 10);
      const elapsedMs = performance.now() - started;

      expect(results.map((row) => row.itemRef)).toEqual(
        Array.from({ length: 10 }, (_, index) => `test-bundle//scripts/opaque-000${index}`),
      );
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Issue #9: Single-character queries ──────────────────────────────────────

describe("single-character lexical queries (Issue #9)", () => {
  test("single character query returns FTS results when content matches", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "r-lang", {
        searchText: "R programming language for statistics",
      });
      insertTestEntry(db, "python-tool", {
        searchText: "Python scripting language",
      });
      rebuildFts(db);

      const results = searchFts(db, "R", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db);
    }
  });
});
