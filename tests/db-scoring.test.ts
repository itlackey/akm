import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase, rebuildFts, sanitizeFtsQuery, searchFts, upsertEntry } from "../src/db";
import type { StashEntry } from "../src/metadata";

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

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CACHE_HOME = tmpDir("cache");
  process.env.XDG_CONFIG_HOME = tmpDir("config");
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<StashEntry> & { name: string; type: StashEntry["type"] }): StashEntry {
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
    type?: StashEntry["type"];
  },
): number {
  const type = opts?.type ?? "script";
  const entry = makeEntry({ name: key, type, description: opts?.description ?? `Description for ${key}` });
  return upsertEntry(
    db,
    key,
    opts?.dirPath ?? "/test/dir",
    opts?.filePath ?? `/test/dir/${key}.ts`,
    opts?.stashDir ?? "/test/stash",
    entry,
    opts?.searchText ?? `${key} ${entry.description}`,
  );
}

// ── Issue #2: sanitizeFtsQuery preserves identifier tokens ──────────────────

describe("sanitizeFtsQuery — identifier preservation (Issue #2)", () => {
  test("hyphenated query becomes AND of component tokens", () => {
    const result = sanitizeFtsQuery("code-review");
    // Hyphens are replaced with spaces — FTS5 treats hyphen as NOT in
    // query context. The result is implicit AND: "code review".
    expect(result).toContain("code");
    expect(result).toContain("review");
    // Must NOT use OR join
    expect(result).not.toContain(" OR ");
  });

  test("dotted query becomes AND of component tokens", () => {
    const result = sanitizeFtsQuery("k8s.setup");
    // Dots cause FTS5 syntax errors; replaced with spaces
    expect(result).toContain("k8s");
    expect(result).toContain("setup");
    expect(result).not.toContain(".");
  });

  test("preserves underscores in identifiers like deploy_prod", () => {
    const result = sanitizeFtsQuery("deploy_prod");
    // Underscores are valid in FTS5 queries (unicode61 treats them as
    // token separators on both index and query sides)
    expect(result).toContain("deploy_prod");
  });

  test("strips FTS5 syntax characters (quotes, parens, asterisks, colons, carets)", () => {
    const result = sanitizeFtsQuery('"hello" (world) test*');
    // The dangerous FTS5 syntax chars should be removed
    expect(result).not.toContain('"');
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
    expect(result).not.toContain("*");
    // But the actual words should remain
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("test");
  });

  test("strips NEAR operator from query", () => {
    // NEAR is a special FTS5 operator that should be neutralized
    const result = sanitizeFtsQuery("NEAR foo bar");
    expect(result).not.toMatch(/\bNEAR\b/);
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  test("uses AND (implicit space-separated) rather than OR", () => {
    const result = sanitizeFtsQuery("deploy production");
    // Should NOT contain OR — tokens should be AND-joined (space-separated)
    expect(result).not.toContain(" OR ");
    // Both tokens should be present
    expect(result).toContain("deploy");
    expect(result).toContain("production");
  });

  test("returns empty string for empty query", () => {
    expect(sanitizeFtsQuery("")).toBe("");
  });

  test("returns empty string for only-syntax-chars query", () => {
    expect(sanitizeFtsQuery('"()*:^{}')).toBe("");
  });

  test("handles mixed valid and syntax chars", () => {
    const result = sanitizeFtsQuery('deploy:prod "code-review"');
    expect(result).not.toContain(":");
    expect(result).not.toContain('"');
    expect(result).toContain("deploy");
    expect(result).toContain("prod");
    // code-review becomes "code review" (space-separated AND)
    expect(result).toContain("code");
    expect(result).toContain("review");
  });
});

// ── Issue #2: Integration test — hyphenated search through searchFts ────────

describe("searchFts — hyphenated identifier search (Issue #2)", () => {
  test("searching for 'code-review' matches entry with code-review in search text", () => {
    const db = openDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "code-review", {
        searchText: "code-review skill for reviewing pull requests",
      });
      insertTestEntry(db, "deploy-prod", {
        searchText: "deploy-prod deploy to production servers",
      });
      rebuildFts(db);

      const results = searchFts(db, "code-review", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      // The code-review entry should be the top result
      expect(results[0].entry.name).toBe("code-review");
    } finally {
      closeDatabase(db);
    }
  });

  test("AND semantics: multi-word query only matches entries containing all terms", () => {
    const db = openDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "deploy-tool", {
        searchText: "deploy applications to production servers",
      });
      insertTestEntry(db, "code-tool", {
        searchText: "code linting and formatting tool",
      });
      insertTestEntry(db, "review-tool", {
        searchText: "review pull requests and merge code",
      });
      rebuildFts(db);

      // With AND semantics, "code review" should NOT match "deploy-tool"
      // (which has neither "code" nor "review")
      // "review-tool" has both "review" and "code" in its search text
      const results = searchFts(db, "code review", 10);
      const names = results.map((r) => r.entry.name);
      expect(names).not.toContain("deploy-tool");
      // review-tool should match (it contains both "code" and "review")
      expect(names).toContain("review-tool");
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Issue #9: Single-character queries ──────────────────────────────────────

describe("sanitizeFtsQuery — single-char tokens (Issue #9)", () => {
  test("single character token is preserved", () => {
    const result = sanitizeFtsQuery("R");
    expect(result).toBe("R");
  });

  test("single character query returns FTS results when content matches", () => {
    const db = openDatabase(tmpDbPath());
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

  test("mixed single and multi-char tokens are all preserved", () => {
    const result = sanitizeFtsQuery("R language");
    expect(result).toContain("R");
    expect(result).toContain("language");
  });
});
