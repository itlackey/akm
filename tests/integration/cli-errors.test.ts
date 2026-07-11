import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ConfigError, NotFoundError, UsageError } from "../../src/core/errors";
import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

// Helpers.
//
// Migrated from per-test spawnSync("bun", ["src/cli.ts", ...]) to the shared
// in-process harness (tests/_helpers/cli.ts). The harness drives the akm citty
// command directly, so there is no subprocess startup cost. Output and exit
// codes are captured in-process.
//
// The preload (tests/_preload.ts) already sandboxes HOME, the XDG dirs, and the
// AKM dir overrides per test, so the explicit isolated dirs the spawn version
// passed via env are no longer needed for isolation. Env/temp-dir mutation goes
// through the allowlisted sandbox helpers (withEnv / makeStashDir /
// makeSandboxDir) to satisfy the test-isolation lint.
//
// The one case that needs to run from a project working directory (registry
// remove) still spawns a real subprocess: it asserts project-vs-user config
// layering driven by process.cwd(), and changing cwd in-process to a temp dir
// breaks Bun's bare-specifier module resolver for the CLI's lazy dynamic
// imports. That is a genuine process-level behavior, so it stays a subprocess.

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

const repoRoot = path.resolve(import.meta.dir, "..", "..");

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const { stdout, stderr, code } = await runCliCapture(args);
  return { stdout, stderr, status: code };
}

/**
 * Subprocess runner, retained only for the one cwd-sensitive test. Spawning a
 * fresh Bun process is the correct way to exercise project-directory config
 * resolution (the subprocess resolves modules from the repo regardless of cwd).
 * It passes env to spawnSync rather than mutating process.env, so it does not
 * affect the in-process tests.
 */
function spawnCli(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [path.join(repoRoot, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: options.cwd,
    env: { ...process.env, AKM_STASH_DIR: undefined, ...options.env },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

// The default sandbox (from the preload) has no stash configured, which is what
// the original spawn version achieved by passing AKM_STASH_DIR undefined.

// Tests.

describe("CLI error handling", () => {
  test("search without stash dir prints JSON error with hint", async () => {
    const { stderr, status } = await runCli("search", "test");
    expect(status).not.toBe(0);
    expect(stderr).toContain("No stash directory found");
    expect(stderr).toContain("hint");
  });

  test("show with invalid ref prints JSON error", async () => {
    const { stderr, status } = await runCli("show", "invalid-ref-no-colon");
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("search --source invalid prints hint about source", async () => {
    const { stderr, status } = await runCli("search", "test", "--source", "invalid");
    expect(status).not.toBe(0);
    // Named-source validation: unknown source names produce INVALID_SOURCE_VALUE
    // with a message that lists valid source names (or says none are configured).
    expect(stderr).toContain("Unknown source name");
    expect(stderr).toContain("INVALID_SOURCE_VALUE");
    expect(stderr).toContain("hint");
  });

  test("search --detail invalid prints hint about detail", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const { stderr, status } = await withEnv({ AKM_STASH_DIR: stash.dir }, () =>
      runCli("search", "test", "--detail", "invalid"),
    );
    expect(status).not.toBe(0);
    expect(stderr).toContain("Invalid value for --detail");
    expect(stderr).toContain("hint");
  });

  test("health --detail invalid value yields UsageError with exit 2", async () => {
    const { stderr, status } = await runCli("health", "--detail", "verbose");
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_DETAIL_VALUE");
  });

  test("health --window-compare with bad duration yields UsageError exit 2", async () => {
    const { stderr, status } = await runCli("health", "--window-compare", "bogus");
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
  });

  test("health --window-compare combined with --windows is mutually exclusive (exit 2)", async () => {
    const sinceArg = new Date(Date.now() - 3600_000).toISOString();
    const { stderr, status } = await runCli(
      "health",
      "--window-compare",
      "1h",
      "--windows",
      `name=a,since=${sinceArg}`,
    );
    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
  });

  test("error output is valid JSON", async () => {
    const { stderr } = await runCli("show", "invalid-ref-no-colon");
    const trimmed = stderr.trim();
    const parsed = JSON.parse(trimmed);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  test("config set with invalid JSON prints hint about quoting", async () => {
    const { stderr, status } = await runCli("config", "set", "embedding", "not-valid-json");
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.hint).toContain("Quote JSON values");
  });

  test("CLI hint comes from the error instance, not a regex over the message", async () => {
    // Reproduces the failure path: search without a stash dir throws ConfigError
    // with code STASH_DIR_NOT_FOUND. The CLI surfaces error.hint(), not a regex
    // against the message string.
    const { stderr, status } = await runCli("search", "test");
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("STASH_DIR_NOT_FOUND");
    expect(parsed.hint).toBe(new ConfigError("x", "STASH_DIR_NOT_FOUND").hint());
    expect(parsed.hint).toContain("akm setup");
  });
});

describe("error class hints", () => {
  test("ConfigError derives hint from code by default", () => {
    expect(new ConfigError("missing stash", "STASH_DIR_NOT_FOUND").hint()).toContain("akm setup");
    expect(new ConfigError("not a dir", "STASH_DIR_NOT_A_DIRECTORY").hint()).toContain("directory");
    expect(new ConfigError("unreadable", "STASH_DIR_UNREADABLE").hint()).toContain("permission");
    expect(new ConfigError("no embedding", "EMBEDDING_NOT_CONFIGURED").hint()).toContain("akm config set embedding");
    expect(new ConfigError("no llm", "LLM_NOT_CONFIGURED").hint()).toContain("akm config set profiles.llm");
  });

  test("ConfigError without a code-mapped hint returns undefined", () => {
    expect(new ConfigError("bad config", "INVALID_CONFIG_FILE").hint()).toBeUndefined();
    expect(new ConfigError("can't resolve", "CONFIG_DIR_UNRESOLVABLE").hint()).toBeUndefined();
  });

  test("UsageError derives hint from code by default", () => {
    expect(new UsageError("bad source", "INVALID_SOURCE_VALUE").hint()).toBe("Pick one of: stash, registry, both.");
    expect(new UsageError("bad format", "INVALID_FORMAT_VALUE").hint()).toBe("Pick one of: json, jsonl, text, yaml.");
    expect(new UsageError("bad detail", "INVALID_DETAIL_VALUE").hint()).toBe(
      "Pick one of: brief, normal, full. For agent/summary projections use --shape.",
    );
    expect(new UsageError("bad shape", "INVALID_SHAPE_VALUE").hint()).toBe(
      "Pick one of: human, agent, summary (summary is only valid on `akm show`).",
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
  test("config path prints the config file path", async () => {
    const { stdout, status } = await runCli("config", "path");
    expect(status).toBe(0);
    expect(stdout.trim()).toContain("config.json");
  });

  test("config path --all returns all path keys", async () => {
    const { stdout, status } = await runCli("config", "path", "--all", "--format=json");
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("config");
    expect(parsed).toHaveProperty("stash");
    expect(parsed).toHaveProperty("cache");
    expect(parsed).toHaveProperty("index");
  });
});

describe("registry remove", () => {
  // KEPT AS A SUBPROCESS: this test asserts project-vs-user config layering that
  // depends on the CLI running with its working directory inside a project dir.
  // Running it in-process would require process.chdir() to a temp dir, which
  // breaks Bun's bare-specifier resolution for the CLI's lazy dynamic imports
  // (manifests as "Cannot find package 'citty'"). Spawning a real subprocess is
  // the correct, faithful way to exercise this cwd-dependent behavior.
  test("does not persist project registries into user config", () => {
    const project = makeSandboxDir("akm-cli-err-project");
    const xdgConfig = makeSandboxDir("akm-cli-err-cfg");
    const xdgCache = makeSandboxDir("akm-cli-err-cache");
    const xdgData = makeSandboxDir("akm-cli-err-data");
    const home = makeSandboxDir("akm-cli-err-home");
    disposers.push(project, xdgConfig, xdgCache, xdgData, home);

    const userConfigPath = path.join(xdgConfig.dir, "akm", "config.json");
    const projectConfigPath = path.join(project.dir, ".akm", "config.json");

    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(
      userConfigPath,
      `${JSON.stringify(
        {
          configVersion: "0.9.0",
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
          configVersion: "0.9.0",
          registries: [{ url: "https://project.example/index.json", name: "project" }],
        },
        null,
        2,
      )}\n`,
    );

    const { status } = spawnCli(["registry", "remove", "user", "-y", "--format=json"], {
      cwd: project.dir,
      env: {
        HOME: home.dir,
        XDG_CONFIG_HOME: xdgConfig.dir,
        XDG_CACHE_HOME: xdgCache.dir,
        XDG_DATA_HOME: xdgData.dir,
      },
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

// Output-shape registry regression guard.
//
// On 2026-05-25 four CLI verbs (akm lint, akm tasks, akm graph, akm db) were
// each broken by the same root cause: their command name was never registered
// in src/output/shapes/passthrough.ts. Every invocation returned an
// {"ok":false,"error":"output shape not registered for command: <name>"}
// envelope with exit 0. The verbs ran their command logic correctly, then died
// at the output-rendering step.
//
// The bug class: adding a defineCommand in src/cli.ts whose handler calls
// output("X", result) without also adding "X" to PASSTHROUGH_COMMANDS (or
// registering a custom shape elsewhere) leaves the command non-functional in a
// way that no other test catches.
//
// This regression guard invokes each read-only verb against the isolated sandbox
// stash and asserts the output doesn't carry the specific error string. It's
// intentionally a curated list rather than discover-from---help: the list IS the
// contract we maintain, and adding a new verb means adding it here so the guard
// covers it.
describe("output shape registry — every CLI verb returns a registered shape", () => {
  // Verbs that take no required args and are read-only against the
  // empty/isolated temp stash. Anything that requires a ref, takes interactive
  // input, mutates external state, or needs network access belongs elsewhere.
  const READ_ONLY_VERBS: string[] = [
    "health",
    "lint",
    "info",
    "tasks",
    "graph",
    "db",
    "list",
    "config",
    "log",
    "history",
    "registry",
    "wiki",
  ];

  for (const verb of READ_ONLY_VERBS) {
    test(`akm ${verb} --format json does not return an "output shape not registered" envelope`, async () => {
      const { stdout } = await runCli(verb, "--format", "json");
      // The bug class produces this exact substring. Any future verb that calls
      // output() without a registered shape will trip this.
      expect(stdout).not.toContain("output shape not registered");
    });
  }
});
