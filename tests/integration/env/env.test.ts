import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildShellExportScript, createEnv, listKeys, loadEnv } from "../../../src/commands/env/env";
import { sensitiveMarkerPath } from "../../../src/core/env-secret-ref";
import { getDbPath } from "../../../src/core/paths";
import { resetGraphBoostCache } from "../../../src/indexer/graph/graph-boost";
import { akmIndex } from "../../../src/indexer/indexer";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../../src/llm/embedder";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../../src/storage/repositories/index-entries-repository";
import { runCliCapture } from "../../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withEnv,
} from "../../_helpers/sandbox";

// ── Test fixtures ───────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "env"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "envcli"): string {
  return tmpDir(prefix);
}

const cliXdgConfig = makeTempDir("env-config");
const xdgConfig = cliXdgConfig;

/**
 * In-process CLI runner. Pins the AKM env (stash + any extra vars) for the
 * duration of the call and resets the embedder/graph singletons so the run
 * reads the pinned env.
 */
async function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_BUNDLE_DIR: undefined, AKM_CONFIG_DIR: undefined, ...extraEnv }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

// ── listKeys ────────────────────────────────────────────────────────────────

describe("listKeys", () => {
  test("returns key names only — no values, no comment text", () => {
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
    expect(Object.keys(result)).toEqual(["keys"]);
    const json = JSON.stringify(result);
    expect(json).not.toContain("secret-value-do-not-leak");
    expect(json).not.toContain("top comment");
    expect(json).not.toContain("bottom comment");
  });

  test("comment text is never extracted — commented-out credentials stay private", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(
      fp,
      [
        "# OLD_GITEA_TOKEN=zqxcommentedoutcredential",
        "  # webhook: https://hooks.example.com/services/zqxfreetexttoken",
        "FOO=bar # trailing-comment-not-extracted",
        "BAZ=qux",
      ].join("\n"),
    );
    const result = listKeys(fp);
    expect(result.keys).toEqual(["FOO", "BAZ"]);
    const json = JSON.stringify(result);
    expect(json).not.toContain("zqxcommentedoutcredential");
    expect(json).not.toContain("zqxfreetexttoken");
    expect(json).not.toContain("trailing-comment-not-extracted");
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
    expect(result).toEqual({ keys: [] });
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

// ── createEnv ─────────────────────────────────────────────────────────────

describe("createEnv", () => {
  test("creates an empty file", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "env", "prod.env");
    createEnv(fp);
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp, "utf8")).toBe("");
  });

  test("does not overwrite an existing file", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "FOO=existing\n");
    createEnv(fp);
    expect(loadEnv(fp).FOO).toBe("existing");
  });

  test("creates the file with mode 0600", () => {
    if (process.platform === "win32") return; // chmod is best-effort on win32
    const dir = tmpDir();
    const fp = path.join(dir, "env", "secrets.env");
    createEnv(fp);
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
  });
});

// ── buildShellExportScript (read-path trust boundary) ───────────────────────
//
// With entry management removed, env files may be hand-edited or migrated and
// can therefore contain raw shell-substitution syntax. The export script is the
// trust boundary: dotenv parses values literally and we re-emit them single-
// quoted, so `eval`-ing the output never executes a payload — even when the
// raw `.env` was crafted to do so.

describe("buildShellExportScript", () => {
  test("emits single-quoted export lines with `'\\''` escaping; no expansion syntax", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    fs.writeFileSync(fp, "PLAIN=hello\nDOLLAR='abc$HOME'\nAPOS=\"it's fine\"\n");
    const script = buildShellExportScript(fp);
    for (const line of script.split("\n").filter(Boolean)) {
      expect(line).toMatch(/^export [A-Za-z_][A-Za-z0-9_]*='.*'$/);
    }
    expect(script).toContain("export PLAIN='hello'");
    expect(script).toContain("export DOLLAR='abc$HOME'");
    expect(script).toContain("export APOS='it'\\''s fine'");
  });

  // NOTE: the real-bash sourcing test ("eval-ing the emitted script populates
  // env without executing payloads") lives in
  // tests/integration/env-export-bash.test.ts — it requires a real subprocess.

  test("round-trips shell-metachar values through dotenv.parse", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "v.env");
    // Seed the file the way a user would: each value single-quoted so dotenv
    // returns it literally, mirroring what export then re-emits.
    const payloads: Record<string, string> = {
      DOLLAR: "abc$HOME",
      BACKTICK: "pre`whoami`",
      CMDSUB: "pre$(rm -rf /tmp/shouldnothappen)post",
      GLOB: "*.env",
      TILDE: "~/root",
      SEMI: "a;b",
      AMPERSAND: "x && y",
    };
    const raw = Object.entries(payloads)
      .map(([k, v]) => `${k}='${v}'`)
      .join("\n");
    fs.writeFileSync(fp, `${raw}\n`);
    const env = loadEnv(fp);
    for (const [k, v] of Object.entries(payloads)) {
      expect(env[k]).toBe(v);
    }
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

describe("env indexer safety", () => {
  test("env values never appear in the FTS index, search_text, or document_json", async () => {
    const stashDir = currentStashDir;
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });

    const envPath = path.join(stashDir, "env", "prod.env");
    fs.writeFileSync(
      envPath,
      [
        "# Production secrets",
        "# OLD_TOKEN=zqxoldcredleak",
        `SECRET_TOKEN=${SECRET_VALUE}`,
        "DB_PASSWORD=another-secret-pa55w0rd",
        "# hook: https://hooks.example.com/services/zqxcommentleak",
        "# Last rotated 2026-04-01",
      ].join("\n"),
    );

    const result = await akmIndex({ stashDir, full: true });
    expect(result.totalEntries).toBe(1);

    const db = openIndexDatabase();
    try {
      const entries = getAllEntries(db);
      expect(entries.length).toBe(1);
      const envEntry = entries[0];

      // 1. The entry is classified as env
      expect(envEntry!.entry.type).toBe("env");
      expect(envEntry!.entry.name).toBe("prod");

      // 2. Keys are exposed via searchHints
      expect(envEntry!.entry.searchHints).toContain("SECRET_TOKEN");
      expect(envEntry!.entry.searchHints).toContain("DB_PASSWORD");

      // 3. CRITICAL: comment text is never surfaced — comments carry
      // commented-out credentials and free-text secrets
      expect(envEntry!.entry.description ?? "").not.toContain("Production secrets");

      // 4. CRITICAL: neither values NOR comment text are anywhere in the
      // persisted record
      const json = JSON.stringify(envEntry);
      expect(json).not.toContain(SECRET_VALUE);
      expect(json).not.toContain("another-secret-pa55w0rd");
      expect(json).not.toContain("zqxoldcredleak");
      expect(json).not.toContain("zqxcommentleak");
      expect(json).not.toContain("Production secrets");

      // 5. CRITICAL: neither values nor comment text are in entries.search_text
      type Row = { search_text: string | null; document_json: string };
      const rows = db.prepare("SELECT search_text, document_json FROM entries WHERE type = ?").all("env") as Row[];
      expect(rows.length).toBe(1);
      const searchText = rows[0]!.search_text ?? "";
      expect(searchText).not.toContain(SECRET_VALUE);
      expect(searchText).not.toContain("zqxoldcredleak");
      expect(searchText).not.toContain("zqxcommentleak");
      expect(rows[0]!.document_json).not.toContain(SECRET_VALUE);
      expect(rows[0]!.document_json).not.toContain("zqxoldcredleak");
      expect(rows[0]!.document_json).not.toContain("zqxcommentleak");

      // 6. CRITICAL: neither values nor comment text can be retrieved via FTS5
      type FtsRow = { c: number };
      for (const term of ["correct", "zqxoldcredleak", "zqxcommentleak"]) {
        const ftsHit = db
          .prepare("SELECT count(*) AS c FROM entries_fts WHERE entries_fts MATCH ?")
          .get(term) as FtsRow;
        expect(ftsHit.c).toBe(0);
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("env entries are searchable by key name", async () => {
    const stashDir = currentStashDir;
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "STRIPE_API_KEY=sk_test_xxx\n");

    await akmIndex({ stashDir, full: true });

    const db = openIndexDatabase();
    try {
      type FtsRow = { c: number };
      const hit = db
        .prepare("SELECT count(*) AS c FROM entries_fts WHERE entries_fts MATCH ?")
        .get("STRIPE_API_KEY") as FtsRow;
      expect(hit.c).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("frozen vaults/ is not indexed once env/ exists (no double-surfacing)", async () => {
    const stashDir = currentStashDir;
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=fresh\n");
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "API_KEY=frozen\n");

    const result = await akmIndex({ stashDir, full: true });
    // Only the env/ copy is indexed; the frozen vaults/ copy is skipped.
    expect(result.totalEntries).toBe(1);

    const db = openIndexDatabase();
    try {
      const entries = getAllEntries(db);
      expect(entries.length).toBe(1);
      expect(entries[0]!.entry.type).toBe("env");
    } finally {
      closeDatabase(db);
    }
  });
});

// ── env CLI ──────────────────────────────────────────────────────────────────

describe("env list", () => {
  test("env list --format json returns all envs with key names (no path, no values)", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=secret\n", "utf8");

    const result = await runCli(["env", "list", "--format", "json"], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.envs).toEqual([
      expect.objectContaining({
        ref: "env/prod",
        keys: ["API_KEY"],
      }),
    ]);
    // path must not leak into structured JSON output
    expect(parsed.envs[0]).not.toHaveProperty("path");
    // value must never appear
    expect(result.stdout).not.toContain("secret");
  });

  test("env list aggregates env files across configured stashes", async () => {
    const primaryStash = makeTempDir("akm-envcli-primary-");
    const teamStash = makeTempDir("akm-envcli-team-");
    fs.mkdirSync(path.join(primaryStash, "env"), { recursive: true });
    fs.mkdirSync(path.join(teamStash, "env"), { recursive: true });
    fs.writeFileSync(path.join(primaryStash, "env", "prod.env"), "API_KEY=secret\n", "utf8");
    fs.writeFileSync(path.join(teamStash, "env", "shared.env"), "TOKEN=hidden\n", "utf8");
    fs.mkdirSync(path.join(xdgConfig, "akm"), { recursive: true });
    fs.writeFileSync(
      path.join(xdgConfig, "akm", "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        bundles: { stash: { path: primaryStash }, team: { path: teamStash } },
        defaultBundle: "stash",
      }),
      "utf8",
    );

    const result = await runCli(["env", "list", "--format", "json"], {
      AKM_BUNDLE_DIR: primaryStash,
      AKM_CONFIG_DIR: path.join(xdgConfig, "akm"),
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.envs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "env/prod", keys: ["API_KEY"] }),
        expect.objectContaining({ ref: "team//env/shared", keys: ["TOKEN"] }),
      ]),
    );
  });

  test("env list text output uses markdown headings and bullets", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "json.env"), "# json env\nAPI_KEY=secret\nSECOND=value\n", "utf8");

    const result = await runCli(["env", "list", "--format", "text"], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## env/json");
    expect(result.stdout).toContain("- API_KEY");
    expect(result.stdout).toContain("- SECOND");
  });
});

describe("env export / path (read-path safety)", () => {
  test("env export writes safe single-quoted lines to --out, never to stdout", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "EVIL=$(touch /tmp/shouldnothappen)\nOK=fine\n", "utf8");
    const outFile = path.join(stashDir, "out.sh");

    const result = await runCli(["env", "export", "env/prod", "--out", outFile], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(0);
    // Values are NEVER on stdout — only the written file path is reported.
    expect(result.stdout).not.toContain("$(touch");
    expect(result.stdout).not.toContain("fine");
    const script = fs.readFileSync(outFile, "utf8");
    expect(script).toContain("export EVIL='$(touch /tmp/shouldnothappen)'");
    expect(script).toContain("export OK='fine'");
    if (process.platform !== "win32") {
      expect(fs.statSync(outFile).mode & 0o777).toBe(0o600);
    }
  });

  test("env export without --out errors and points at env run", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=secret\n", "utf8");

    const result = await runCli(["env", "export", "env/prod"], { AKM_BUNDLE_DIR: stashDir });

    // Usage error (missing --out) -> exit 2 / MISSING_REQUIRED_ARGUMENT.
    // Ground-truthed by probing the actual CLI output before pinning.
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { code?: string };
    expect(json.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(result.stderr).toContain("--out");
    expect(result.stderr).toContain("akm env run");
    expect(result.stdout).not.toContain("secret");
  });

  test("env path prints the path on stdout and the unsafe-source warning on stderr", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=secret\n", "utf8");

    const result = await runCli(["env", "path", "env/prod"], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().endsWith(path.join("env", "prod.env"))).toBe(true);
    expect(result.stderr).toContain("akm env run");

    // --quiet suppresses the warning (for the _FILE / --env-file convention).
    const quiet = await runCli(["env", "path", "env/prod", "--quiet"], { AKM_BUNDLE_DIR: stashDir });
    expect(quiet.status).toBe(0);
    expect(quiet.stderr.trim()).toBe("");
  });
});

describe("env create --from-file / --from-stdin", () => {
  test("--from-file ingests an existing .env at mode 0600", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    const srcFile = path.join(stashDir, "source.env");
    fs.writeFileSync(srcFile, "# seeded\nDB_URL=postgres://x\nAPI_KEY=k\n", "utf8");

    const result = await runCli(["env", "create", "prod", "--from-file", srcFile], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(0);
    const dest = path.join(stashDir, "env", "prod.env");
    expect(fs.readFileSync(dest, "utf8")).toContain("DB_URL=postgres://x");
    if (process.platform !== "win32") {
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    }
  });

  test("--from-file refuses to clobber an existing env", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "KEEP=me\n", "utf8");
    const srcFile = path.join(stashDir, "source.env");
    fs.writeFileSync(srcFile, "NEW=val\n", "utf8");

    const result = await runCli(["env", "create", "prod", "--from-file", srcFile], { AKM_BUNDLE_DIR: stashDir });

    // Usage error (env already exists) -> exit 2 / RESOURCE_ALREADY_EXISTS.
    // Ground-truthed by probing the actual CLI output before pinning.
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { code?: string };
    expect(json.code).toBe("RESOURCE_ALREADY_EXISTS");
    expect(result.stderr).toContain("already exists");
    // Original preserved.
    expect(fs.readFileSync(path.join(stashDir, "env", "prod.env"), "utf8")).toBe("KEEP=me\n");
  });
});

describe("env remove", () => {
  test("removes an env file (and its .sensitive marker)", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    const dest = path.join(stashDir, "env", "prod.env");
    const marker = sensitiveMarkerPath(dest, "env");
    fs.writeFileSync(dest, "API_KEY=secret\n", "utf8");
    fs.writeFileSync(marker, "", "utf8");

    const result = await runCli(["env", "remove", "env/prod", "--yes"], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(0);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("never deletes the frozen vaults/ copy", async () => {
    const stashDir = makeTempDir("akm-envcli-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "API_KEY=secret\n", "utf8");

    // No env/ copy exists → remove targets env/ and reports not found, leaving vaults/ intact.
    const result = await runCli(["env", "remove", "env/prod", "--yes"], { AKM_BUNDLE_DIR: stashDir });

    // NotFoundError (no env/ copy to remove) -> exit 1 / ASSET_NOT_FOUND.
    // Ground-truthed by probing the actual CLI output before pinning.
    expect(result.status).toBe(1);
    const json = JSON.parse(result.stderr) as { code?: string };
    expect(json.code).toBe("ASSET_NOT_FOUND");
    expect(fs.existsSync(path.join(stashDir, "vaults", "prod.env"))).toBe(true);
  });
});

describe("vault removed in 0.9.0", () => {
  test("the `akm vault` verb no longer exists", async () => {
    const stashDir = makeTempDir("akm-vault-removed-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=secret\n", "utf8");

    const result = await runCli(["vault", "list", "--format", "json"], { AKM_BUNDLE_DIR: stashDir });

    // Usage error (unknown top-level command) -> exit 2 / UNKNOWN_COMMAND.
    // Ground-truthed by probing the actual CLI output before pinning.
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { code?: string };
    expect(json.code).toBe("UNKNOWN_COMMAND");
  });

  test("a `vault:` ref is an unknown-type error pointing at env", async () => {
    const stashDir = makeTempDir("akm-vault-removed-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "API_KEY=secret\n", "utf8");
    const outFile = path.join(stashDir, "out.sh");

    const result = await runCli(["env", "export", "vault:prod", "--out", outFile], { AKM_BUNDLE_DIR: stashDir });

    // Usage error (retired `vault:` prefix) -> exit 2 / INVALID_FLAG_VALUE.
    // Ground-truthed by probing the actual CLI output before pinning.
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { code?: string };
    expect(json.code).toBe("INVALID_FLAG_VALUE");
    expect(result.stderr).toContain("was removed");
    // Q-08: the vault-removal signpost points at the slash spelling, not the
    // retired `env:`/`secret:` colon grammar.
    expect(result.stderr).toContain("env/");
    expect(fs.existsSync(outFile)).toBe(false);
  });
});

describe("colon ref spelling removed (Q-08)", () => {
  test("`env:<name>` fails loudly naming the slash replacement, instead of a confusing not-found", async () => {
    const stashDir = makeTempDir("akm-colon-removed-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=secret\n", "utf8");

    const result = await runCli(["env", "path", "env:prod"], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("env:");
    expect(parsed.error).toContain("was removed");
    expect(parsed.error).toContain("env/prod");
    // Never silently resolves to nothing: no `env:prod`-named file was probed.
    expect(fs.existsSync(path.join(stashDir, "env", "env:prod.env"))).toBe(false);
  });

  test("`environment:<name>` (the alias implied by stale docs) is rejected the same way", async () => {
    const stashDir = makeTempDir("akm-colon-removed-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });

    const result = await runCli(["env", "path", "environment:prod"], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("env/prod");
  });

  test("the slash form `env/<name>` still resolves normally", async () => {
    const stashDir = makeTempDir("akm-colon-removed-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    const envPath = path.join(stashDir, "env", "prod.env");
    fs.writeFileSync(envPath, "API_KEY=secret\n", "utf8");

    const result = await runCli(["env", "path", "env/prod", "--quiet"], { AKM_BUNDLE_DIR: stashDir });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(envPath);
  });

  test("`akm env run env:<name> -- <cmd>` (the register's verified-live 404 case) now fails loudly pre-spawn", async () => {
    const stashDir = makeTempDir("akm-colon-removed-");
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\n", "utf8");

    const result = await runCli(["env", "run", "env:prod", "--", "echo", "should-not-run"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("env/prod");
    // The child command must never have been spawned.
    expect(result.stdout).not.toContain("should-not-run");
  });
});
