import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-completions-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
      XDG_DATA_HOME: undefined,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

// ── Unit tests (generated script content) ────────────────────────────────────

describe("completions command", () => {
  const { stdout, status } = runCli("completions");
  const script = stdout;

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
      "clone",
      "registry",
      "config",
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
    expect(script).toContain("json text yaml");
  });

  test("contains flag value completions for --detail", () => {
    expect(script).toContain("--detail)");
    expect(script).toContain("brief normal full");
  });

  test("contains flag value completions for --type", () => {
    expect(script).toContain("--type)");
    expect(script).toContain("skill command agent knowledge script memory any");
  });

  test("contains flag value completions for --source", () => {
    expect(script).toContain("--source)");
    expect(script).toContain("stash registry both");
  });
});

// ── Integration: --install ───────────────────────────────────────────────────

describe("completions --install", () => {
  test("writes completion file to XDG_DATA_HOME path", () => {
    const xdgData = makeTempDir();
    const result = spawnSync("bun", ["./src/cli.ts", "completions", "--install"], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        AKM_STASH_DIR: undefined,
        HOME: isolatedHome,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
      },
    });

    expect(result.status).toBe(0);
    const expectedPath = path.join(xdgData, "bash-completion", "completions", "akm");
    expect(result.stderr).toContain(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const content = fs.readFileSync(expectedPath, "utf8");
    expect(content).toStartWith("#!/bin/bash");
    expect(content).toContain("complete -F _akm akm");
  });
});

// ── Unsupported shell ────────────────────────────────────────────────────────

describe("completions unsupported shell", () => {
  test("rejects unsupported shell type", () => {
    const { stderr, status } = runCli("completions", "--shell", "zsh");
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unsupported shell");
  });
});
