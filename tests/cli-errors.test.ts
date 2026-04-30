import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, NotFoundError, UsageError } from "../src/core/errors";

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
const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCliWithOptions(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string | undefined> },
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: options?.cwd ?? repoRoot,
    env: {
      ...process.env,
      AKM_STASH_DIR: undefined,
      HOME: isolatedHome,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      ...options?.env,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  return runCliWithOptions(args);
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

  test("CLI hint comes from the error instance, not a regex over the message", () => {
    // Reproduces the failure path: search without a stash dir throws ConfigError
    // with code STASH_DIR_NOT_FOUND. The CLI surfaces error.hint(), not a regex
    // against the message string.
    const { stderr, status } = runCli("search", "test");
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("STASH_DIR_NOT_FOUND");
    expect(parsed.hint).toBe(new ConfigError("x", "STASH_DIR_NOT_FOUND").hint());
    expect(parsed.hint).toContain("akm init");
  });
});

describe("error class hints", () => {
  test("ConfigError derives hint from code by default", () => {
    expect(new ConfigError("missing stash", "STASH_DIR_NOT_FOUND").hint()).toContain("akm init");
    expect(new ConfigError("not a dir", "STASH_DIR_NOT_A_DIRECTORY").hint()).toContain("directory");
    expect(new ConfigError("unreadable", "STASH_DIR_UNREADABLE").hint()).toContain("permission");
    expect(new ConfigError("no embedding", "EMBEDDING_NOT_CONFIGURED").hint()).toContain("akm config set embedding");
    expect(new ConfigError("no llm", "LLM_NOT_CONFIGURED").hint()).toContain("akm config set llm");
  });

  test("ConfigError without a code-mapped hint returns undefined", () => {
    expect(new ConfigError("bad config", "INVALID_CONFIG_FILE").hint()).toBeUndefined();
    expect(new ConfigError("can't resolve", "CONFIG_DIR_UNRESOLVABLE").hint()).toBeUndefined();
  });

  test("UsageError derives hint from code by default", () => {
    expect(new UsageError("bad source", "INVALID_SOURCE_VALUE").hint()).toBe("Pick one of: stash, registry, both.");
    expect(new UsageError("bad format", "INVALID_FORMAT_VALUE").hint()).toBe("Pick one of: json, jsonl, text, yaml.");
    expect(new UsageError("bad detail", "INVALID_DETAIL_VALUE").hint()).toBe(
      "Pick one of: brief, normal, full, summary, agent.",
    );
    expect(new UsageError("bad json", "INVALID_JSON_CONFIG_VALUE").hint()).toContain("Quote JSON values");
    expect(new UsageError("bad target", "MISSING_OR_AMBIGUOUS_TARGET").hint()).toContain("akm update --all");
    expect(new UsageError("not updatable", "TARGET_NOT_UPDATABLE").hint()).toContain("akm list");
  });

  test("UsageError without a code-mapped hint returns undefined", () => {
    // INVALID_FLAG_VALUE is intentionally a generic fallback — points at --help.
    expect(new UsageError("bad flag", "INVALID_FLAG_VALUE").hint()).toContain("akm <command> --help");
    expect(new UsageError("unknown key", "UNKNOWN_CONFIG_KEY").hint()).toBeUndefined();
    expect(new UsageError("bad json arg", "INVALID_JSON_ARGUMENT").hint()).toBeUndefined();
  });

  test("NotFoundError derives hint from code by default", () => {
    // Wave C #284 added canned hints for the remaining codes.
    expect(new NotFoundError("missing source", "SOURCE_NOT_FOUND").hint()).toContain("akm list");
    expect(new NotFoundError("missing asset", "ASSET_NOT_FOUND").hint()).toContain("akm search");
    expect(new NotFoundError("missing wf", "WORKFLOW_NOT_FOUND").hint()).toContain("akm workflow list");
    expect(new NotFoundError("missing file", "FILE_NOT_FOUND").hint()).toContain("path exists");
  });

  test("explicit hint at construction overrides the code-derived default", () => {
    const explicit = new UsageError("oops", "INVALID_FLAG_VALUE", "do this instead");
    expect(explicit.hint()).toBe("do this instead");

    const overrideMapped = new UsageError("oops", "INVALID_SOURCE_VALUE", "custom");
    expect(overrideMapped.hint()).toBe("custom");

    const cfg = new ConfigError("oops", "STASH_DIR_NOT_FOUND", "custom config hint");
    expect(cfg.hint()).toBe("custom config hint");

    const nf = new NotFoundError("oops", "ASSET_NOT_FOUND", "find it here");
    expect(nf.hint()).toBe("find it here");
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

describe("registry remove", () => {
  test("does not persist project registries into user config", () => {
    const projectDir = makeTempDir();
    const userConfigPath = path.join(xdgConfig, "akm", "config.json");
    const projectConfigPath = path.join(projectDir, ".akm", "config.json");

    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(
      userConfigPath,
      `${JSON.stringify(
        {
          registries: [{ url: "https://user.example/index.json", name: "user" }],
        },
        null,
        2,
      )}\n`,
    );

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      `${JSON.stringify(
        {
          registries: [{ url: "https://project.example/index.json", name: "project" }],
        },
        null,
        2,
      )}\n`,
    );

    const { status } = runCliWithOptions(["registry", "remove", "user", "--format=json"], {
      cwd: projectDir,
    });

    expect(status).toBe(0);

    const savedUserConfig = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    expect(savedUserConfig.registries).toEqual([]);
    expect(savedUserConfig.registries).not.toContainEqual({
      url: "https://project.example/index.json",
      name: "project",
    });
  });
});
