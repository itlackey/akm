/**
 * Migrated from per-test spawnSync("bun", ["src/cli.ts", ...]) to the shared
 * in-process harness (tests/_helpers/cli.ts) where possible.
 *
 * Two categories of test MUST keep spawning a real subprocess:
 *   1. `vault run` — the CLI itself spawns the target command with stdout/stderr
 *      inherited to the real file descriptors. The injected-env output is the
 *      child's, not the parent's, so the in-process console-capture harness
 *      cannot observe it. A real process boundary is the whole point.
 *   2. `vault set` reading from process.stdin — the in-process harness has no
 *      way to feed process.stdin; these tests pipe the value in.
 *
 * The pure path-resolution and --from-env tests (which read from an env var,
 * never stdin, and never spawn a child) run in-process.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resetGraphBoostCache } from "../src/indexer/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../src/llm/embedder";
import { runCliCapture } from "./_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function makeStash(): string {
  const stash = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

/**
 * In-process CLI runner. Pins the AKM env (stash + any extra vars) for the
 * duration of the call via the allowlisted withEnv helper and resets the
 * embedder/graph singletons so the run reads the pinned env. runCliCapture
 * resets the config and output-mode singletons itself.
 */
async function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_CONFIG_DIR: undefined, ...extraEnv }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

/**
 * Subprocess runner, retained for `vault run` (child-process stdout) and
 * `vault set` stdin tests. Passes env to spawnSync rather than mutating
 * process.env, so it does not affect the in-process tests.
 */
function spawnCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  stdinInput?: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    input: stdinInput,
    env: {
      ...process.env,
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

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});

afterEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});

describe("vault path", () => {
  test("returns {ok:false, error} JSON on stderr and exits 1 when vault does not exist", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });

    const { stdout, stderr, status } = await runCli(["vault", "path", "vault:does-not-exist"], {
      AKM_STASH_DIR: stashDir,
    });

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toContain("Vault not found");
    expect(stdout.trim()).toBe("");
  });

  test("prints the absolute vault path on stdout when the vault exists", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "myvault.env");
    fs.writeFileSync(vaultPath, "FOO=bar\n", "utf8");

    const { stdout, stderr, status } = await runCli(["vault", "path", "vault:myvault"], {
      AKM_STASH_DIR: stashDir,
    });

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(vaultPath);
    expect(stderr.trim()).toBe("");
  });
});

describe("vault run", () => {
  // KEPT AS A SUBPROCESS: `vault run` spawns the target command with stdout
  // inherited to the real fd; the injected-env output is the child's and is not
  // visible to the in-process console-capture harness.
  test("runs a command with all vault vars injected", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "FOO=bar\nBAR=baz\n", "utf8");

    const { stdout, stderr, status } = spawnCli(
      ["vault", "run", "vault:prod", "--", "bash", "-lc", 'printf \'%s %s\' "$FOO" "$BAR"'],
      {
        AKM_STASH_DIR: stashDir,
      },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bar baz");
    expect(stderr.trim()).toBe("");
  });

  // KEPT AS A SUBPROCESS: same as above — child-process stdout boundary.
  test("runs a command with only the requested key injected", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "FOO=bar\nBAR=baz\n", "utf8");

    const { stdout, stderr, status } = spawnCli(
      [
        "vault",
        "run",
        "vault:prod/FOO",
        "--",
        "bash",
        "-lc",
        `printf '%s|%s' "{FOO-}" "{BAR-}"`.replace(/\u007f/g, "$"),
      ],
      { AKM_STASH_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bar|");
    expect(stderr.trim()).toBe("");
  });
});

describe("vault set (stdin default)", () => {
  // KEPT AS A SUBPROCESS: reads the value from process.stdin (no harness stdin).
  test("reads value from stdin and writes it to the vault", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    fs.writeFileSync(vaultPath, "", "utf8");

    const { stdout, stderr, status } = spawnCli(
      ["vault", "set", "vault:prod", "DB_URL"],
      { AKM_STASH_DIR: stashDir },
      "postgres://secret@host/db",
    );

    expect(status).toBe(0);
    expect(stderr.trim()).toBe("");
    const contents = fs.readFileSync(vaultPath, "utf8");
    expect(contents).toContain("DB_URL=");
    expect(contents).toContain("postgres://secret@host/db");
    const out = JSON.parse(stdout.trim());
    expect(out.key).toBe("DB_URL");
  });

  // KEPT AS A SUBPROCESS: reads the value from process.stdin.
  test("strips trailing newline from stdin value", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    fs.writeFileSync(vaultPath, "", "utf8");

    spawnCli(["vault", "set", "vault:prod", "KEY"], { AKM_STASH_DIR: stashDir }, "myvalue\n");

    const contents = fs.readFileSync(vaultPath, "utf8");
    expect(contents).not.toContain("myvalue\n=");
    expect(contents).toContain("KEY=myvalue");
  });

  // moved from vault-qa-fixes.test.ts test 8
  // KEPT AS A SUBPROCESS: reads the value from process.stdin.
  test("vault set accepts bare vault name without type prefix", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    fs.writeFileSync(vaultPath, "", "utf8");

    const { status } = spawnCli(["vault", "set", "prod", "MY_KEY"], { AKM_STASH_DIR: stashDir }, "myvalue");
    expect(status).toBe(0);
    expect(fs.readFileSync(vaultPath, "utf8")).toContain("MY_KEY=myvalue");
  });

  // moved from vault-qa-fixes.test.ts test 10
  // KEPT AS A SUBPROCESS: reads the value from process.stdin.
  test("vault set stdin value containing = is stored without data loss", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    fs.writeFileSync(vaultPath, "", "utf8");

    const { status } = spawnCli(["vault", "set", "prod", "COMPLEX_KEY"], { AKM_STASH_DIR: stashDir }, "val1=val2");
    expect(status).toBe(0);
    // The value may be quoted in the .env file; assert the key exists and the
    // file contains "val1=val2" somewhere (either raw or shell-quoted).
    const raw = fs.readFileSync(vaultPath, "utf8");
    expect(raw).toContain("COMPLEX_KEY=");
    expect(raw).toContain("val1=val2");
  });
});

describe("vault set stale lock recovery", () => {
  // KEPT AS A SUBPROCESS: reads the value from process.stdin.
  test("succeeds when a .lock file containing a dead PID is present", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    fs.writeFileSync(vaultPath, "", "utf8");

    // Write a stale lock file containing a PID that is guaranteed not to exist.
    const lockPath = `${vaultPath}.lock`;
    fs.writeFileSync(lockPath, "999999999", "utf8");

    const { stdout, stderr, status } = spawnCli(
      ["vault", "set", "vault:prod", "STALE_KEY"],
      { AKM_STASH_DIR: stashDir },
      "stale-value",
    );

    expect(status).toBe(0);
    expect(stderr.trim()).toBe("");
    const contents = fs.readFileSync(vaultPath, "utf8");
    expect(contents).toContain("STALE_KEY=stale-value");
    const out = JSON.parse(stdout.trim());
    expect(out.key).toBe("STALE_KEY");

    // Verify the stale lock was cleaned up.
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe("vault set --from-env", () => {
  test("reads value from the named env var and writes it to the vault", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    fs.writeFileSync(vaultPath, "", "utf8");

    const { stdout, stderr, status } = await runCli(
      ["vault", "set", "vault:prod", "API_TOKEN", "--from-env", "AKM_VALUE"],
      {
        AKM_STASH_DIR: stashDir,
        AKM_VALUE: "supersecret",
      },
    );

    expect(status).toBe(0);
    expect(stderr.trim()).toBe("");
    const contents = fs.readFileSync(vaultPath, "utf8");
    expect(contents).toContain("API_TOKEN=");
    expect(contents).toContain("supersecret");
    const out = JSON.parse(stdout.trim());
    expect(out.key).toBe("API_TOKEN");
  });

  test("errors when the named env var is not set", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "vaults", "prod.env"), "", "utf8");

    const { stderr, status } = await runCli(["vault", "set", "vault:prod", "KEY", "--from-env", "DOES_NOT_EXIST_XYZ"], {
      AKM_STASH_DIR: stashDir,
      DOES_NOT_EXIST_XYZ: undefined,
    });

    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("DOES_NOT_EXIST_XYZ");
  });

  // moved from vault-qa-fixes.test.ts test 9
  test("vault set --from-env accepts bare vault name without type prefix", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "vaults"), { recursive: true });
    const vaultPath = path.join(stashDir, "vaults", "prod.env");
    fs.writeFileSync(vaultPath, "", "utf8");

    const { status } = await runCli(["vault", "set", "prod", "ANOTHER_KEY", "--from-env", "AKM_VALUE"], {
      AKM_STASH_DIR: stashDir,
      AKM_VALUE: "anothervalue",
    });
    expect(status).toBe(0);
    expect(fs.readFileSync(vaultPath, "utf8")).toContain("ANOTHER_KEY=anothervalue");
  });
});
