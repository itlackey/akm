/**
 * remember --target tests
 *
 * Verifies the `--target` flag added to `akm remember` per v1 implementation
 * plan §6 decision 3. Resolution order is:
 *   --target → defaultWriteTarget → working stash → ConfigError
 *
 * These tests exercise the explicit-target path:
 *   - resolves to a configured filesystem source by name
 *   - errors on unknown target names (UsageError)
 *   - errors on non-writable targets (ConfigError)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(configDir: string, body: Record<string, unknown>): void {
  const akmDir = path.join(configDir, "akm");
  fs.mkdirSync(akmDir, { recursive: true });
  fs.writeFileSync(path.join(akmDir, "config.json"), JSON.stringify(body, null, 2), "utf8");
}

function runCli(args: string[], options: { stashDir?: string; configDir: string; input?: string }) {
  const stashDir = options.stashDir ?? makeTempDir("akm-remember-stash-");
  const xdgCache = makeTempDir("akm-remember-cache-");
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    input: options.input,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      AKM_CONFIG_DIR: path.join(options.configDir, "akm"),
      XDG_CACHE_HOME: xdgCache,
    },
  });
  return { stashDir, result };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("remember --target", () => {
  test("--target resolves to a configured filesystem source", () => {
    const configDir = makeTempDir("akm-remember-config-");
    const targetDir = makeTempDir("akm-remember-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "writable-target", path: targetDir, writable: true }],
    });

    const { stashDir, result } = runCli(["remember", "Pinned context for the rollout", "--target", "writable-target"], {
      configDir,
    });
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("memory:pinned-context-for-the-rollout");

    // The memory must land in the explicit target — NOT the working stash.
    const expectedPath = path.join(targetDir, "memories", "pinned-context-for-the-rollout.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories", "pinned-context-for-the-rollout.md"))).toBe(false);
  });

  test("--target with an unknown source name throws a usage error", () => {
    const configDir = makeTempDir("akm-remember-config-");
    const targetDir = makeTempDir("akm-remember-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "real-target", path: targetDir, writable: true }],
    });

    const { result } = runCli(["remember", "won't be written", "--target", "nope"], { configDir });
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain('No source named "nope" is configured');
    expect(json.error).toContain("--target must reference a source name");
  });

  test("--target on a non-writable source throws a config error", () => {
    const configDir = makeTempDir("akm-remember-config-");
    const targetDir = makeTempDir("akm-remember-target-");
    writeConfig(configDir, {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "read-only", path: targetDir, writable: false }],
    });

    const { result } = runCli(["remember", "won't be written", "--target", "read-only"], { configDir });
    expect(result.status).not.toBe(0);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("source read-only is not writable");
  });
});
