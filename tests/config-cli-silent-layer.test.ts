// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for #463: stable plugin entry-point for hook-driven
 * config writes.
 *
 * - `akm config set --silent <key> <value>` suppresses the post-write config
 *   dump on stdout so plugin hooks don't pollute their host stream, while
 *   still surfacing errors and performing the actual write.
 * - `akm config set --layer user` is the only accepted layer in 0.8.0; any
 *   other value fails fast with INVALID_FLAG_VALUE so plugins can encode
 *   intent and the surface stays stable if project-layer writes return.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cfg-silent-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  // Each invocation gets a fresh XDG triple so writes from one test don't
  // bleed into another.
  const xdg = {
    XDG_CONFIG_HOME: makeTempDir(),
    XDG_CACHE_HOME: makeTempDir(),
    XDG_DATA_HOME: makeTempDir(),
    XDG_STATE_HOME: makeTempDir(),
  };
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    env: {
      ...process.env,
      AKM_STASH_DIR: undefined,
      HOME: makeTempDir(),
      ...xdg,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

describe("akm config set --silent / --layer (#463)", () => {
  test("--silent suppresses stdout but still writes the value", () => {
    const xdgConfig = makeTempDir();
    const xdgCache = makeTempDir();
    const xdgData = makeTempDir();
    const xdgState = makeTempDir();
    const result = spawnSync("bun", [cliPath, "config", "set", "--silent", "defaults.agent", "claude"], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: repoRoot,
      env: {
        ...process.env,
        AKM_STASH_DIR: undefined,
        HOME: makeTempDir(),
        XDG_CONFIG_HOME: xdgConfig,
        XDG_CACHE_HOME: xdgCache,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
      },
    });
    expect(result.status ?? 1).toBe(0);
    expect(result.stdout ?? "").toBe("");
    // The write happened — verify by re-reading via `akm config get`.
    const getResult = spawnSync("bun", [cliPath, "config", "get", "defaults.agent"], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: repoRoot,
      env: {
        ...process.env,
        AKM_STASH_DIR: undefined,
        HOME: makeTempDir(),
        XDG_CONFIG_HOME: xdgConfig,
        XDG_CACHE_HOME: xdgCache,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
      },
    });
    expect(getResult.status ?? 1).toBe(0);
    expect(getResult.stdout).toContain("claude");
  });

  test("without --silent, the post-write config dump appears on stdout", () => {
    const { stdout, status } = runCli(["config", "set", "defaults.agent", "claude"]);
    expect(status).toBe(0);
    expect(stdout).toContain("claude");
  });

  test("--layer user is accepted (no-op alias for the current user-only model)", () => {
    const { status } = runCli(["config", "set", "--layer", "user", "--silent", "defaults.agent", "opencode"]);
    expect(status).toBe(0);
  });

  test("--layer project (or anything other than user) fails with INVALID_FLAG_VALUE", () => {
    const { stderr, status } = runCli(["config", "set", "--layer", "project", "--silent", "defaults.agent", "claude"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("INVALID_FLAG_VALUE");
    expect(stderr).toContain("Unsupported --layer");
  });

  test("--silent still reports errors (apiKey rejection #454 is visible on stderr)", () => {
    const { stderr, status } = runCli(["config", "set", "--silent", "llm.apiKey", "sk-test"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("AKM_LLM_API_KEY");
  });

  test("config unset --silent --layer user also suppresses stdout", () => {
    const xdgConfig = makeTempDir();
    const xdgCache = makeTempDir();
    const xdgData = makeTempDir();
    const xdgState = makeTempDir();
    const env = {
      ...process.env,
      AKM_STASH_DIR: undefined,
      HOME: makeTempDir(),
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    };
    // Set, then unset.
    const setResult = spawnSync("bun", [cliPath, "config", "set", "--silent", "defaults.agent", "claude"], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: repoRoot,
      env,
    });
    expect(setResult.status ?? 1).toBe(0);
    const unsetResult = spawnSync(
      "bun",
      [cliPath, "config", "unset", "--silent", "--layer", "user", "defaults.agent"],
      { encoding: "utf8", timeout: 15_000, cwd: repoRoot, env },
    );
    expect(unsetResult.status ?? 1).toBe(0);
    expect(unsetResult.stdout ?? "").toBe("");
  });
});
