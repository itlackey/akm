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
// KEPT SPAWNING (real-process behavior): the `--install` test asserts the
// install-path message that `akm completions --install` emits via `warn()`
// (src/core/warn.ts → console.error). Under the suite-wide test preload that
// path does not surface to the harness's captured stderr, so to faithfully
// exercise the user-visible stderr message the test runs a real subprocess.

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
const isolatedHome = makeTempDir();

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const { stdout, stderr, code } = await withEnv(
    {
      AKM_STASH_DIR: undefined,
      HOME: isolatedHome,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: undefined,
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
      "skill command agent knowledge workflow script memory env secret wiki lesson task session fact any",
    );
  });

  test("contains flag value completions for --source", () => {
    expect(script).toContain("--source)");
    expect(script).toContain("stash registry both");
  });
});

// The `completions --install` subprocess test lives in
// tests/integration/completions-install.test.ts — it asserts the install-path
// message emitted via warn() → stderr, which the in-process harness cannot
// surface under the suite-wide test preload, so it needs a real subprocess.

// ── Unsupported shell ────────────────────────────────────────────────────────

describe("completions unsupported shell", () => {
  test("rejects unsupported shell type", async () => {
    const { stderr, status } = await runCli("completions", "--shell", "zsh");
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unsupported shell");
  });
});
