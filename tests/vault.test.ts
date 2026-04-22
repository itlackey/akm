import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, getAllEntries, openDatabase } from "../src/db";
import { akmIndex } from "../src/indexer";
import { getDbPath } from "../src/paths";
import { createVault, formatAsExport, getKey, listKeys, loadEnv, parseEnvFile, setKey, unsetKey } from "../src/vault";

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

// ── parseEnvFile ────────────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  test("parses simple KEY=value lines", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(result.keys).toEqual(["FOO", "BAZ"]);
    expect(result.entries.get("FOO")).toBe("bar");
    expect(result.entries.get("BAZ")).toBe("qux");
  });

  test("strips double quotes and decodes escapes", () => {
    const result = parseEnvFile('FOO="hello world"\nMULTI="line1\\nline2"\n');
    expect(result.entries.get("FOO")).toBe("hello world");
    expect(result.entries.get("MULTI")).toBe("line1\nline2");
  });

  test("strips single quotes literally (no escape processing)", () => {
    const result = parseEnvFile("FOO='hello \\n world'\n");
    expect(result.entries.get("FOO")).toBe("hello \\n world");
  });

  test("captures only start-of-line comments", () => {
    const result = parseEnvFile(
      [
        "# header comment",
        "  # indented comment",
        "FOO=bar # trailing-comment-not-extracted",
        "BAZ=qux",
        "# footer comment",
      ].join("\n"),
    );
    expect(result.comments).toEqual(["header comment", "indented comment", "footer comment"]);
  });

  test("inline # after whitespace strips trailing comment from unquoted value", () => {
    const result = parseEnvFile("FOO=value # trailing\n");
    expect(result.entries.get("FOO")).toBe("value");
    // Critically: the trailing portion is NOT in comments
    expect(result.comments).toEqual([]);
  });

  test("inline # inside quoted value is preserved", () => {
    const result = parseEnvFile('FOO="value # not a comment"\n');
    expect(result.entries.get("FOO")).toBe("value # not a comment");
  });

  test("supports `export KEY=value`", () => {
    const result = parseEnvFile("export FOO=bar\n");
    expect(result.keys).toEqual(["FOO"]);
    expect(result.entries.get("FOO")).toBe("bar");
  });

  test("ignores blank lines and malformed lines", () => {
    const result = parseEnvFile("\n\nFOO=bar\nthis is not a valid line\nBAZ=qux\n");
    expect(result.keys).toEqual(["FOO", "BAZ"]);
  });

  test("later assignment overwrites earlier value but key order is preserved", () => {
    const result = parseEnvFile("FOO=first\nBAR=middle\nFOO=second\n");
    expect(result.keys).toEqual(["FOO", "BAR"]);
    expect(result.entries.get("FOO")).toBe("second");
  });
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

  test("returns empty result for missing file", () => {
    const result = listKeys(path.join(tmpDir(), "missing.env"));
    expect(result).toEqual({ keys: [], comments: [] });
  });
});

// ── setKey / unsetKey / getKey ──────────────────────────────────────────────

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

  test("quotes values that contain whitespace or special characters", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    setKey(fp, "FOO", "hello world");
    setKey(fp, "BAR", 'has"quote');
    const env = loadEnv(fp);
    expect(env.FOO).toBe("hello world");
    expect(env.BAR).toBe('has"quote');
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

describe("getKey", () => {
  test("returns the value for a present key", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=bar\n");
    expect(getKey(fp, "FOO")).toBe("bar");
  });

  test("returns undefined for a missing key", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=bar\n");
    expect(getKey(fp, "NOPE")).toBeUndefined();
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

// ── formatAsExport ──────────────────────────────────────────────────────────

describe("formatAsExport", () => {
  test("emits eval-safe export lines with single-quote escaping", () => {
    const out = formatAsExport({ FOO: "bar", QUOTED: "it's fine" });
    expect(out).toContain("export FOO='bar'");
    expect(out).toContain("export QUOTED='it'\\''s fine'");
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
