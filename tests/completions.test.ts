import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCliCapture } from "./_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

// Helpers.
//
// Migrated from per-test spawnSync("bun", ["./src/cli.ts", ...]) to the shared
// in-process harness (tests/_helpers/cli.ts). `completions` emits a pure bash
// script on stdout / exit code, so the script-content and unsupported-shell
// tests are ideal in-process candidates. Env/temp-dir mutation goes through the
// allowlisted sandbox helpers (withEnv / makeSandboxDir).
//
// The `--install` test (real subprocess, asserts user-visible stderr) moved to
// tests/integration/completions-install.test.ts.

// ── Helpers ─────────────────────────────────────────────────────────────────

const disposers: SandboxedDir[] = [];

function makeTempDir(): string {
  const d = makeSandboxDir("akm-completions-");
  disposers.push(d);
  return d.dir;
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

const xdgCache = makeTempDir();
const xdgConfig = makeTempDir();
const xdgData = makeTempDir();
const xdgState = makeTempDir();
const isolatedHome = makeTempDir();

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const { stdout, stderr, code } = await withEnv(
    {
      AKM_STASH_DIR: undefined,
      HOME: isolatedHome,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
    () => runCliCapture(args),
  );
  return { stdout, stderr, status: code };
}

// ── Unit tests (generated script content) ────────────────────────────────────

describe("completions command", () => {
  let script = "";
  let status = 1;

  beforeAll(async () => {
    const result = await runCli("completions");
    script = result.stdout;
    status = result.status;
  });

  test("exits 0 and outputs a bash script", () => {
    expect(status).toBe(0);
    expect(script).toStartWith("#!/bin/bash");
  });

  test("contains complete -F _akm akm", () => {
    expect(script).toContain("complete -F _akm akm");
  });

  test("contains all top-level subcommands", () => {
    const expected = [
      "init",
      "index",
      "add",
      "list",
      "remove",
      "update",
      "upgrade",
      "search",
      "curate",
      "show",
      "workflow",
      "remember",
      "import",
      "clone",
      "feedback",
      "registry",
      "migrate",
      "config",
      "help",
      "hints",
      "completions",
    ];
    for (const cmd of expected) {
      expect(script).toContain(cmd);
    }
  });

  test("contains nested config subcommands", () => {
    expect(script).toContain('"akm config"');
    for (const sub of ["path", "list", "get", "set", "unset"]) {
      expect(script).toContain(sub);
    }
  });

  test("contains nested registry subcommands", () => {
    expect(script).toContain('"akm registry"');
    for (const sub of ["list", "add", "remove", "search", "build-index"]) {
      expect(script).toContain(sub);
    }
  });

  test("contains flag value completions for --format", () => {
    expect(script).toContain("--format)");
    expect(script).toContain("json text yaml jsonl");
  });

  test("contains flag value completions for --detail", () => {
    expect(script).toContain("--detail)");
    expect(script).toContain("brief normal full summary");
  });

  test("contains flag value completions for --type", () => {
    expect(script).toContain("--type)");
    expect(script).toContain(
      "skill command agent knowledge workflow script memory env secret lesson task session fact any",
    );
  });

  test("contains flag value completions for --source", () => {
    expect(script).toContain("--source)");
    expect(script).toContain("stash registry both");
  });
});

// The `--install` real-subprocess test lives in
// tests/integration/completions-install.test.ts — real spawns are banned from
// the unit suite (a stalled sync spawn freezes the shard past every JS-level
// timeout).

// ── Unsupported shell ────────────────────────────────────────────────────────

describe("completions unsupported shell", () => {
  test("rejects unsupported shell type", async () => {
    const { stderr, status } = await runCli("completions", "--shell", "zsh");
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unsupported shell");
  });
});
