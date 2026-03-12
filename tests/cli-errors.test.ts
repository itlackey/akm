import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cli-err-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Isolated temp dirs so the CLI never touches real user config/cache/home. */
const xdgCache = makeTempDir();
const xdgConfig = makeTempDir();
const isolatedHome = makeTempDir();

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", ["./src/cli.ts", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      AKM_STASH_DIR: undefined,
      HOME: isolatedHome,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CLI error handling", () => {
  test("search without stash dir prints JSON error with hint", () => {
    const { stderr, status } = runCli("search", "test");
    expect(status).not.toBe(0);
    expect(stderr).toContain("No stash directory found");
    expect(stderr).toContain("hint");
  });

  test("show with invalid ref prints JSON error", () => {
    const { stderr, status } = runCli("show", "invalid-ref-no-colon");
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  test("search --source invalid prints hint about source", () => {
    const { stderr, status } = runCli("search", "test", "--source", "invalid");
    expect(status).not.toBe(0);
    expect(stderr).toContain("Invalid value for --source");
    expect(stderr).toContain("hint");
  });

  test("search --detail invalid prints hint about detail", () => {
    const stashDir = makeTempDir();
    for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
      fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
    }
    const result = spawnSync("bun", ["./src/cli.ts", "search", "test", "--detail", "invalid"], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        AKM_STASH_DIR: stashDir,
        HOME: isolatedHome,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
      },
    });
    const stderr = result.stderr ?? "";
    const status = result.status ?? 1;
    expect(status).not.toBe(0);
    expect(stderr).toContain("Invalid value for --detail");
    expect(stderr).toContain("hint");
  });

  test("error output is valid JSON", () => {
    const { stderr } = runCli("show", "invalid-ref-no-colon");
    const trimmed = stderr.trim();
    const parsed = JSON.parse(trimmed);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  test("config set with invalid JSON prints hint about quoting", () => {
    const { stderr, status } = runCli("config", "set", "embedding", "not-valid-json");
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.hint).toContain("Quote JSON values");
  });
});

describe("config path subcommand", () => {
  test("config path prints the config file path", () => {
    const { stdout, status } = runCli("config", "path");
    expect(status).toBe(0);
    expect(stdout.trim()).toContain("config.json");
  });

  test("config path --all returns all path keys", () => {
    const { stdout, status } = runCli("config", "path", "--all", "--format=json");
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("config");
    expect(parsed).toHaveProperty("stash");
    expect(parsed).toHaveProperty("cache");
    expect(parsed).toHaveProperty("index");
  });
});
