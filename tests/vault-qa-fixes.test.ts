import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv, setKey } from "../src/commands/vault";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-vqa-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const xdgCache = makeTempDir("akm-vqa-cache-");
const xdgConfig = makeTempDir("akm-vqa-config-");
const isolatedHome = makeTempDir("akm-vqa-home-");

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  stdinInput?: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: repoRoot,
    input: stdinInput,
    env: {
      ...process.env,
      HOME: isolatedHome,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
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

// ── setKey comment parameter (unit tests) ────────────────────────────────────

describe("setKey: comment parameter", () => {
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
        path: path.join(stashDir, "vaults", "prod.env"),
        keys: ["API_KEY"],
      }),
    ]);
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

// ── vault set stdin / --from-env forms (CLI tests) ───────────────────────────
// KEY=VALUE combined form and positional value were removed in 0.8.0 to
// eliminate /proc/cmdline secret exposure. Values must come from stdin or --from-env.

describe("vault set: stdin and --from-env forms", () => {
  test("8. vault set reads value from stdin (default)", () => {
    const stashDir = makeTempDir("akm-vqa-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const result = runCli(["vault", "set", "prod", "MY_KEY"], { AKM_STASH_DIR: stashDir }, "myvalue");
    expect(result.status).toBe(0);

    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    expect(loadEnv(vaultPath).MY_KEY).toBe("myvalue");
  });

  test("9. vault set --from-env reads value from named env var", () => {
    const stashDir = makeTempDir("akm-vqa-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const result = runCli(["vault", "set", "prod", "ANOTHER_KEY", "--from-env", "AKM_VALUE"], {
      AKM_STASH_DIR: stashDir,
      AKM_VALUE: "anothervalue",
    });
    expect(result.status).toBe(0);

    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    expect(loadEnv(vaultPath).ANOTHER_KEY).toBe("anothervalue");
  });

  test("10. vault set stdin value containing = is stored verbatim", () => {
    const stashDir = makeTempDir("akm-vqa-stash-");
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const result = runCli(["vault", "set", "prod", "COMPLEX_KEY"], { AKM_STASH_DIR: stashDir }, "val1=val2");
    expect(result.status).toBe(0);

    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    expect(loadEnv(vaultPath).COMPLEX_KEY).toBe("val1=val2");
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
