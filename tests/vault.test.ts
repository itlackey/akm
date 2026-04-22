import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, getAllEntries, openDatabase } from "../src/db";
import { akmIndex } from "../src/indexer";
import { getDbPath } from "../src/paths";
import { createVault, injectIntoEnv, listKeys, loadEnv, setKey, unsetKey } from "../src/vault";

// ── Test fixtures ───────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "vault"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── listKeys ────────────────────────────────────────────────────────────────

describe("listKeys", () => {
  test("returns keys + comments only, no values", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(
      fp,
      ["# top comment", "DB_URL=postgres://example", "API_TOKEN=secret-value-do-not-leak", "# bottom comment"].join(
        "\n",
      ),
    );
    const result = listKeys(fp);
    expect(result.keys).toEqual(["DB_URL", "API_TOKEN"]);
    expect(result.comments).toEqual(["top comment", "bottom comment"]);
    // Sanity: the function's return shape has no value-bearing field
    expect(Object.keys(result).sort()).toEqual(["comments", "keys"]);
  });

  test("captures only start-of-line comments, never trailing/inline", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(
      fp,
      [
        "# header comment",
        "  # indented comment",
        "FOO=bar # trailing-comment-not-extracted",
        "BAZ=qux",
        "# footer comment",
      ].join("\n"),
    );
    const result = listKeys(fp);
    expect(result.comments).toEqual(["header comment", "indented comment", "footer comment"]);
    // The trailing-comment text must not leak in via comments
    expect(result.comments.join(" ")).not.toContain("trailing-comment-not-extracted");
  });

  test("preserves key order and de-duplicates", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=first\nBAR=middle\nFOO=second\n");
    expect(listKeys(fp).keys).toEqual(["FOO", "BAR"]);
  });

  test("recognises `export KEY=value`", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "export FOO=bar\n");
    expect(listKeys(fp).keys).toEqual(["FOO"]);
  });

  test("returns empty result for missing file", () => {
    const result = listKeys(path.join(tmpDir(), "missing.env"));
    expect(result).toEqual({ keys: [], comments: [] });
  });
});

// ── loadEnv (delegates to dotenv) ───────────────────────────────────────────

describe("loadEnv", () => {
  test("returns parsed key/value pairs via dotenv", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, 'FOO=bar\nQUOTED="hello world"\nMULTI="line1\\nline2"\n');
    const env = loadEnv(fp);
    expect(env.FOO).toBe("bar");
    expect(env.QUOTED).toBe("hello world");
    expect(env.MULTI).toBe("line1\nline2");
  });

  test("returns empty object for missing file", () => {
    expect(loadEnv(path.join(tmpDir(), "missing.env"))).toEqual({});
  });
});

// ── setKey / unsetKey ───────────────────────────────────────────────────────

describe("setKey", () => {
  test("creates the file and parent directory if missing", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "vaults", "new.env");
    setKey(fp, "FOO", "bar");
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp, "utf8")).toContain("FOO=bar");
  });

  test("preserves comments and order when adding a new key", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "# top\nFOO=one\n# middle\nBAR=two\n");
    setKey(fp, "BAZ", "three");
    const text = fs.readFileSync(fp, "utf8");
    expect(text).toContain("# top");
    expect(text).toContain("# middle");
    expect(text).toContain("FOO=one");
    expect(text).toContain("BAR=two");
    expect(text).toContain("BAZ=three");
    // New key appended after existing content (order preserved)
    expect(text.indexOf("BAR=two")).toBeLessThan(text.indexOf("BAZ=three"));
  });

  test("replaces existing key in place", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=old\nBAR=keep\n");
    setKey(fp, "FOO", "new");
    const result = listKeys(fp);
    expect(result.keys).toEqual(["FOO", "BAR"]);
    expect(loadEnv(fp).FOO).toBe("new");
    expect(loadEnv(fp).BAR).toBe("keep");
  });

  test("round-trips values containing whitespace, quotes, and special characters", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    setKey(fp, "FOO", "hello world");
    setKey(fp, "BAR", 'has"quote');
    setKey(fp, "BAZ", "trailing # not a comment");
    setKey(fp, "EQ", "a=b=c");
    setKey(fp, "BACK", "C:\\path\\to\\file");
    setKey(fp, "APOS", "it's fine");
    const env = loadEnv(fp);
    expect(env.FOO).toBe("hello world");
    expect(env.BAR).toBe('has"quote');
    expect(env.BAZ).toBe("trailing # not a comment");
    expect(env.EQ).toBe("a=b=c");
    expect(env.BACK).toBe("C:\\path\\to\\file");
    expect(env.APOS).toBe("it's fine");
  });

  test("rejects values containing newlines", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    expect(() => setKey(fp, "FOO", "line1\nline2")).toThrow();
  });

  test("rejects values containing both single and double quotes", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    expect(() => setKey(fp, "FOO", 'it\'s "complicated"')).toThrow();
  });

  test("rejects invalid key names", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    expect(() => setKey(fp, "1BAD", "x")).toThrow();
    expect(() => setKey(fp, "WITH-DASH", "x")).toThrow();
    expect(() => setKey(fp, "WITH SPACE", "x")).toThrow();
  });

  test("file is written with mode 0600", () => {
    if (process.platform === "win32") return; // chmod is best-effort on win32
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    setKey(fp, "FOO", "bar");
    const stat = fs.statSync(fp);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("unsetKey", () => {
  test("removes a key and returns true", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=one\nBAR=two\n");
    expect(unsetKey(fp, "FOO")).toBe(true);
    expect(listKeys(fp).keys).toEqual(["BAR"]);
  });

  test("returns false when the key is absent", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=one\n");
    expect(unsetKey(fp, "NOPE")).toBe(false);
  });

  test("returns false when the file does not exist", () => {
    expect(unsetKey(path.join(tmpDir(), "missing.env"), "FOO")).toBe(false);
  });
});

// ── createVault ─────────────────────────────────────────────────────────────

describe("createVault", () => {
  test("creates an empty file", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "vaults", "prod.env");
    createVault(fp);
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp, "utf8")).toBe("");
  });

  test("does not overwrite an existing file", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=existing\n");
    createVault(fp);
    expect(loadEnv(fp).FOO).toBe("existing");
  });
});

// ── injectIntoEnv ───────────────────────────────────────────────────────────

describe("injectIntoEnv", () => {
  test("assigns values into the supplied target and returns the list of keys set", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "ALPHA=one\nBETA=two\n");
    const target: Record<string, string | undefined> = { PRE_EXISTING: "kept" };
    const keys = injectIntoEnv(fp, target);
    expect(keys.sort()).toEqual(["ALPHA", "BETA"]);
    expect(target.ALPHA).toBe("one");
    expect(target.BETA).toBe("two");
    expect(target.PRE_EXISTING).toBe("kept");
  });

  test("returns empty list when the file is missing", () => {
    const target: Record<string, string | undefined> = {};
    expect(injectIntoEnv(path.join(tmpDir(), "missing.env"), target)).toEqual([]);
    expect(target).toEqual({});
  });
});

// ── Indexer leakage safety (the critical security test) ─────────────────────

const originalXdgConfig = process.env.XDG_CONFIG_HOME;
const originalXdgCache = process.env.XDG_CACHE_HOME;
const originalAkmStash = process.env.AKM_STASH_DIR;
let testConfigDir = "";
let testCacheDir = "";

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-vault-config-"));
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-vault-cache-"));
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_CACHE_HOME = testCacheDir;

  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfig;
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCache;
  if (originalAkmStash === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStash;
  if (testConfigDir) fs.rmSync(testConfigDir, { recursive: true, force: true });
  if (testCacheDir) fs.rmSync(testCacheDir, { recursive: true, force: true });
});

const SECRET_VALUE = "correct-horse-battery-staple-do-not-leak";

describe("vault indexer safety", () => {
  test("vault values never appear in the FTS index, search_text, or entry_json", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-vault-stash-"));
    createdTmpDirs.push(stashDir);
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    fs.writeFileSync(
      vaultPath,
      [
        "# Production secrets",
        `SECRET_TOKEN=${SECRET_VALUE}`,
        "DB_PASSWORD=another-secret-pa55w0rd",
        "# Last rotated 2026-04-01",
      ].join("\n"),
    );

    process.env.AKM_STASH_DIR = stashDir;
    const result = await akmIndex({ stashDir, full: true });
    expect(result.totalEntries).toBe(1);

    const db = openDatabase();
    try {
      const entries = getAllEntries(db);
      expect(entries.length).toBe(1);
      const vaultEntry = entries[0];

      // 1. The entry is classified as vault
      expect(vaultEntry.entry.type).toBe("vault");
      expect(vaultEntry.entry.name).toBe("prod");

      // 2. Keys are exposed via searchHints
      expect(vaultEntry.entry.searchHints).toContain("SECRET_TOKEN");
      expect(vaultEntry.entry.searchHints).toContain("DB_PASSWORD");

      // 3. Comments are surfaced in the description
      expect(vaultEntry.entry.description).toContain("Production secrets");

      // 4. CRITICAL: the secret value is nowhere in the persisted record
      const json = JSON.stringify(vaultEntry);
      expect(json).not.toContain(SECRET_VALUE);
      expect(json).not.toContain("another-secret-pa55w0rd");

      // 5. CRITICAL: the secret value is not in entries.search_text
      type Row = { search_text: string | null; entry_json: string };
      const rows = db.query("SELECT search_text, entry_json FROM entries WHERE entry_type = ?").all("vault") as Row[];
      expect(rows.length).toBe(1);
      expect(rows[0].search_text ?? "").not.toContain(SECRET_VALUE);
      expect(rows[0].entry_json).not.toContain(SECRET_VALUE);

      // 6. CRITICAL: the secret value cannot be retrieved via FTS5 search
      type FtsRow = { c: number };
      const ftsHit = db
        .query("SELECT count(*) AS c FROM entries_fts WHERE entries_fts MATCH ?")
        .get("correct") as FtsRow;
      expect(ftsHit.c).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("vault entries are searchable by key name", async () => {
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-vault-stash-"));
    createdTmpDirs.push(stashDir);
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "STRIPE_API_KEY=sk_test_xxx\n");

    process.env.AKM_STASH_DIR = stashDir;
    await akmIndex({ stashDir, full: true });

    const db = openDatabase();
    try {
      type FtsRow = { c: number };
      const hit = db
        .query("SELECT count(*) AS c FROM entries_fts WHERE entries_fts MATCH ?")
        .get("STRIPE_API_KEY") as FtsRow;
      expect(hit.c).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });
});
