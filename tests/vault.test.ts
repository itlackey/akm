import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildShellExportScript,
  createVault,
  injectIntoEnv,
  listKeys,
  loadEnv,
  setKey,
  unsetKey,
} from "../src/commands/vault";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, getAllEntries, openDatabase } from "../src/indexer/db";
import { akmIndex } from "../src/indexer/indexer";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "./_helpers/sandbox";

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

// ── CLI helpers (shared by the folded "vault CLI — *" describe blocks) ────────
//
// These blocks spawn `bun src/cli.ts vault ...` as a subprocess to exercise the
// command surface (folded from the former vault-qa-fixes.test.ts and
// vault-set-legacy-form.test.ts). They use a single isolated HOME + XDG sandbox
// and pass per-test AKM_STASH_DIR via the runCli env argument.

function makeTempDir(prefix = "vqa"): string {
  // Reuse tmpDir's tracked-cleanup list; the cosmetic prefix is preserved.
  return tmpDir(prefix);
}

const cliXdgCache = makeTempDir("vqa-cache");
const cliXdgConfig = makeTempDir("vqa-config");
const cliXdgData = makeTempDir("vqa-data");
const cliXdgState = makeTempDir("vqa-state");
const cliHome = makeTempDir("vqa-home");
// Alias kept so folded test bodies that reference `xdgConfig` resolve correctly.
const xdgConfig = cliXdgConfig;

const cliRepoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(cliRepoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  stdinInput?: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: cliRepoRoot,
    input: stdinInput,
    env: {
      ...process.env,
      HOME: cliHome,
      XDG_CACHE_HOME: cliXdgCache,
      XDG_CONFIG_HOME: cliXdgConfig,
      XDG_DATA_HOME: cliXdgData,
      XDG_STATE_HOME: cliXdgState,
      AKM_STASH_DIR: undefined,
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

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

// ── quoteValue hardening (shell-metachar defence-in-depth) ──────────────────
//
// Even though vault usage no longer relies on sourcing the raw vault file (the
// parses with dotenv and sources a safely-escaped temp file), the on-disk
// vault format itself must be robust to direct `source` by any future
// caller. These tests lock in that every non-trivial value is quoted.

describe("setKey: shell-metachar hardening", () => {
  test("values containing $, backticks, or $(...) are quoted on disk", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    setKey(fp, "DOLLAR", "abc$DEF");
    setKey(fp, "BACKTICK", "pre`whoami`post");
    setKey(fp, "CMDSUB", "pre$(id)post");
    const raw = fs.readFileSync(fp, "utf8");
    // None of these should appear as an unquoted assignment that a shell
    // would expand on `source`. Our impl single-quotes them.
    expect(raw).toMatch(/^DOLLAR='abc\$DEF'$/m);
    expect(raw).toMatch(/^BACKTICK='pre`whoami`post'$/m);
    expect(raw).toMatch(/^CMDSUB='pre\$\(id\)post'$/m);
  });

  test("values with shell-special chars ; & | * ? ( ) { } [ ] > < ~ ! are quoted", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    for (const [k, v] of Object.entries({
      SEMI: "a;b",
      AMP: "a&b",
      PIPE: "a|b",
      GLOB: "abc*",
      QMARK: "abc?",
      PAREN: "a(b)c",
      BRACE: "a{b}c",
      BRACK: "a[b]c",
      REDIR: "a>b",
      REDIR2: "a<b",
      TILDE: "~/foo",
      BANG: "a!b",
    })) {
      setKey(fp, k, v);
    }
    const raw = fs.readFileSync(fp, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.includes("=")) continue;
      const [, val] = line.match(/^[A-Z_]+=(.*)$/) ?? [];
      if (!val) continue;
      // Any non-empty value must be quoted (either '...' or "...").
      expect(val[0] === "'" || val[0] === '"').toBe(true);
    }
  });

  test("round-trip preserves exact values through dotenv.parse", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    const payloads = {
      DOLLAR: "abc$HOME",
      BACKTICK: "pre`whoami`",
      CMDSUB: "pre$(rm -rf /tmp/shouldnothappen)post",
      GLOB: "*.env",
      TILDE: "~/root",
      SEMI: "a;b",
      BANG: "echo!123",
      AMPERSAND: "x && y",
      NESTED: 'it has "double" quotes only',
    };
    for (const [k, v] of Object.entries(payloads)) setKey(fp, k, v);
    const env = loadEnv(fp);
    for (const [k, v] of Object.entries(payloads)) {
      expect(env[k]).toBe(v);
    }
  });
});

// ── buildShellExportScript (export-script safety) ───────────────────────────

describe("buildShellExportScript", () => {
  test("emits export lines with `'\\''` escaping; no expansion-triggering syntax", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    setKey(fp, "PLAIN", "hello");
    setKey(fp, "DOLLAR", "abc$HOME");
    setKey(fp, "APOS", "it's fine");
    const script = buildShellExportScript(fp);
    // Every line must be a single-quoted export assignment.
    for (const line of script.split("\n").filter(Boolean)) {
      expect(line).toMatch(/^export [A-Za-z_][A-Za-z0-9_]*='.*'$/);
    }
    expect(script).toContain("export PLAIN='hello'");
    expect(script).toContain("export DOLLAR='abc$HOME'");
    // Single quote inside value must be encoded as '\''
    expect(script).toContain("export APOS='it'\\''s fine'");
  });

  test("sourcing the emitted script populates env without executing payloads", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    // The "value" is designed to execute `touch evidence` if it ever
    // reaches a shell without quoting; a safe implementation must keep it
    // literal.
    const evidence = path.join(dir, "evidence");
    setKey(fp, "EVIL", `$(touch ${evidence})`);
    setKey(fp, "OK", "ok-value");
    const script = buildShellExportScript(fp);
    const scriptPath = path.join(dir, "source-me.sh");
    fs.writeFileSync(scriptPath, script);

    const { spawnSync } = require("node:child_process");
    const result = spawnSync("bash", ["-c", `set -eu; . '${scriptPath}'; printf '%s\\n' "$EVIL" "$OK"`], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const [evilOut, okOut] = (result.stdout ?? "").split("\n");
    // EVIL must come back as the literal string — not executed.
    expect(evilOut).toBe(`$(touch ${evidence})`);
    expect(okOut).toBe("ok-value");
    // The command substitution must NOT have run.
    expect(fs.existsSync(evidence)).toBe(false);
  });
});

// ── Indexer leakage safety (the critical security test) ─────────────────────

let currentStashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  currentStashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;

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
  envCleanup();
  envCleanup = () => {};
  currentStashDir = "";
});

const SECRET_VALUE = "correct-horse-battery-staple-do-not-leak";

describe("vault indexer safety", () => {
  test("vault values never appear in the FTS index, search_text, or entry_json", async () => {
    const stashDir = currentStashDir;
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
    const stashDir = currentStashDir;
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "STRIPE_API_KEY=sk_test_xxx\n");

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

describe("vault CLI — qa fixes", () => {
  test("1. writes a new key with a leading comment line when comment provided", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "v.env");
    setKey(fp, "DB_URL", "postgres://localhost/mydb", "database connection string");
    const text = fs.readFileSync(fp, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    const commentIdx = lines.indexOf("# database connection string");
    const keyIdx = lines.findIndex((l) => l.startsWith("DB_URL="));
    expect(commentIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBe(commentIdx + 1);
    expect(loadEnv(fp).DB_URL).toBe("postgres://localhost/mydb");
  });

  test("2. updates an existing comment line in-place when the key is overwritten with a new comment", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "# old comment\nDB_URL=postgres://old\n");
    setKey(fp, "DB_URL", "postgres://new", "new comment");
    const text = fs.readFileSync(fp, "utf8");
    expect(text).toContain("# new comment");
    expect(text).not.toContain("# old comment");
    expect(loadEnv(fp).DB_URL).toBe("postgres://new");
    // Comment line should immediately precede the key line
    const lines = text.split("\n").filter((l) => l.length > 0);
    const commentIdx = lines.indexOf("# new comment");
    const keyIdx = lines.findIndex((l) => l.startsWith("DB_URL="));
    expect(keyIdx).toBe(commentIdx + 1);
  });

  test("3. inserts a new comment before an existing key that lacks one", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=bar\nDB_URL=postgres://old\nBAZ=qux\n");
    setKey(fp, "DB_URL", "postgres://new", "injected comment");
    const text = fs.readFileSync(fp, "utf8");
    expect(text).toContain("# injected comment");
    const lines = text.split("\n").filter((l) => l.length > 0);
    const commentIdx = lines.indexOf("# injected comment");
    const keyIdx = lines.findIndex((l) => l.startsWith("DB_URL="));
    expect(keyIdx).toBe(commentIdx + 1);
    // Other keys preserved
    expect(loadEnv(fp).FOO).toBe("bar");
    expect(loadEnv(fp).BAZ).toBe("qux");
  });

  test("4. without comment does not modify surrounding comments", () => {
    const dir = makeTempDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "# original comment\nDB_URL=old\n");
    setKey(fp, "DB_URL", "new");
    const text = fs.readFileSync(fp, "utf8");
    expect(text).toContain("# original comment");
    expect(loadEnv(fp).DB_URL).toBe("new");
  });
});

describe("vault list", () => {
  test("5. vault list --format json returns all vaults with key names", () => {
    const stashDir = makeTempDir("akm-vqa-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "API_KEY=secret\n", "utf8");

    const result = runCli(["vault", "list", "--format", "json"], { AKM_STASH_DIR: stashDir });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Vault not found: vault:json");

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.vaults).toEqual([
      expect.objectContaining({
        ref: "vault:prod",
        keys: ["API_KEY"],
      }),
    ]);
    // path must not leak into structured JSON output (security fix M3)
    expect(parsed.vaults[0]).not.toHaveProperty("path");
  });

  test("6. vault list aggregates vaults across configured stashes", () => {
    const primaryStash = makeTempDir("akm-vqa-stash-primary-");
    const teamStash = makeTempDir("akm-vqa-stash-team-");
    fs.mkdirSync(path.join(primaryStash, "vaults"), { recursive: true });
    fs.mkdirSync(path.join(teamStash, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(primaryStash, "vaults", "prod.env"), "API_KEY=secret\n", "utf8");
    fs.writeFileSync(path.join(teamStash, "vaults", "shared.env"), "TOKEN=hidden\n", "utf8");
    fs.mkdirSync(path.join(xdgConfig, "akm"), { recursive: true });
    fs.writeFileSync(
      path.join(xdgConfig, "akm", "config.json"),
      JSON.stringify({
        stashDir: primaryStash,
        sources: [{ type: "filesystem", path: teamStash, name: "team" }],
      }),
      "utf8",
    );

    const result = runCli(["vault", "list", "--format", "json"], { AKM_STASH_DIR: primaryStash });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.vaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "vault:prod", keys: ["API_KEY"] }),
        expect.objectContaining({ ref: "team//vault:shared", keys: ["TOKEN"] }),
      ]),
    );
  });

  test("7. vault list text output uses markdown headings and bullets", () => {
    const stashDir = makeTempDir("akm-vqa-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "json.env"), "# json vault\nAPI_KEY=secret\nSECOND=value\n", "utf8");

    const result = runCli(["vault", "list", "--format", "text"], { AKM_STASH_DIR: stashDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## vault:json");
    expect(result.stdout).toContain("- API_KEY");
    expect(result.stdout).toContain("- SECOND");
  });
});

// ── vault set --comment flag (CLI tests) ─────────────────────────────────────

describe("vault set: --comment flag", () => {
  test("11. vault set prod KEY val --comment writes a comment line above the key", () => {
    const stashDir = makeTempDir("akm-vqa-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const result = runCli(
      ["vault", "set", "prod", "AUTH_TOKEN", "--comment", "auth secret"],
      {
        AKM_STASH_DIR: stashDir,
      },
      "tok123",
    );
    expect(result.status).toBe(0);

    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    const text = fs.readFileSync(vaultPath, "utf8");
    expect(text).toContain("# auth secret");
    const lines = text.split("\n").filter((l) => l.length > 0);
    const commentIdx = lines.indexOf("# auth secret");
    const keyIdx = lines.findIndex((l) => l.startsWith("AUTH_TOKEN="));
    expect(commentIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBe(commentIdx + 1);
    expect(loadEnv(vaultPath).AUTH_TOKEN).toBe("tok123");
  });
});

describe("vault CLI — set legacy positional form", () => {
  test("rejects 3-positional form `vault set <ref> <KEY> <VALUE>` with exit 2 and migration hint", () => {
    const stashDir = makeTempDir("akm-vault-legacy-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    // Pre-existing secret — must NOT be clobbered by the rejected call.
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    const originalContent = "API_KEY=preexisting-secret\n";
    fs.writeFileSync(vaultPath, originalContent, "utf8");

    const result = runCli(
      ["vault", "set", "prod", "API_KEY", "newvalue"],
      { AKM_STASH_DIR: stashDir },
      // No stdin — simulates cron/CI invocation.
      "",
    );

    expect(result.status).toBe(2);
    // Migration hint must mention the supported alternatives.
    expect(result.stderr).toContain("no longer accepts the value via argv");
    expect(result.stderr).toContain("--from-env");
    // Vault file must be byte-identical to before the call.
    expect(fs.readFileSync(vaultPath, "utf8")).toBe(originalContent);
  });

  test("rejects KEY=VALUE form `vault set <ref> KEY=VALUE` with exit 2 and migration hint", () => {
    const stashDir = makeTempDir("akm-vault-legacy-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    const originalContent = "API_KEY=preexisting-secret\n";
    fs.writeFileSync(vaultPath, originalContent, "utf8");

    const result = runCli(["vault", "set", "prod", "API_KEY=newvalue"], { AKM_STASH_DIR: stashDir }, "");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no longer accepts the value via argv");
    expect(result.stderr).toContain("--from-env");
    // Vault file unchanged — the rejected call must not write through stdin.
    expect(fs.readFileSync(vaultPath, "utf8")).toBe(originalContent);
  });

  test("supported --from-env form still succeeds", () => {
    const stashDir = makeTempDir("akm-vault-legacy-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const result = runCli(["vault", "set", "prod", "API_KEY", "--from-env", "AKM_TEST_VALUE"], {
      AKM_STASH_DIR: stashDir,
      AKM_TEST_VALUE: "supplied-via-env",
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "vaults", "prod.env"), "utf8")).toContain("API_KEY=supplied-via-env");
  });

  test("supported stdin form still succeeds", () => {
    const stashDir = makeTempDir("akm-vault-legacy-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const result = runCli(["vault", "set", "prod", "API_KEY"], { AKM_STASH_DIR: stashDir }, "supplied-via-stdin");

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "vaults", "prod.env"), "utf8")).toContain("API_KEY=supplied-via-stdin");
  });
});
