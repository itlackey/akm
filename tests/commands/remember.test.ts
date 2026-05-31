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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  writeSandboxConfig,
} from "../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process harness
// (tests/_helpers/cli.ts). None of these tests feed stdin, so there is no
// harness gap. The spawn version wrote config via AKM_CONFIG_DIR and minted its
// own stash/XDG dirs; in-process we sandbox AKM_STASH_DIR via the allowlisted
// sandboxStashDir helper in beforeEach and write config through
// writeSandboxConfig (XDG_CONFIG_HOME/akm/config.json, which getConfigDir
// resolves once the preload has cleared AKM_CONFIG_DIR). Extra `--target`
// sources are isolated dirs from makeSandboxDir.

const disposers: SandboxedDir[] = [];
let stashCleanup: Cleanup = () => {};
let currentStashDir = "";

function makeTargetDir(): string {
  const d = makeSandboxDir("akm-remember-target-");
  disposers.push(d);
  return d.dir;
}

function writeConfig(body: Record<string, unknown>): void {
  writeSandboxConfig(body);
}

async function runCli(
  args: string[],
): Promise<{ stashDir: string; result: { status: number; stdout: string; stderr: string } }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { stashDir: currentStashDir, result: { status: code, stdout, stderr } };
}

beforeEach(() => {
  const stash = sandboxStashDir();
  currentStashDir = stash.dir;
  stashCleanup = stash.cleanup;
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  currentStashDir = "";
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("remember --target", () => {
  test("--target resolves to a configured filesystem source", async () => {
    const targetDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "writable-target", path: targetDir, writable: true }],
    });

    const { stashDir, result } = await runCli([
      "remember",
      "Pinned context for the rollout",
      "--target",
      "writable-target",
    ]);
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

  test("--target with an unknown source name throws a usage error", async () => {
    const targetDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "real-target", path: targetDir, writable: true }],
    });

    const { result } = await runCli(["remember", "won't be written", "--target", "nope"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain('No source named "nope" is configured');
    expect(json.error).toContain("--target must reference a source name");
  });

  test("--target on a non-writable source throws a config error", async () => {
    const targetDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "read-only", path: targetDir, writable: false }],
    });

    const { result } = await runCli(["remember", "won't be written", "--target", "read-only"]);
    expect(result.status).not.toBe(0);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("source read-only is not writable");
  });
});

describe("remember --target", () => {
  test("default stash is used when --target is omitted", async () => {
    writeConfig({ semanticSearchMode: "off" });

    const { stashDir, result } = await runCli(["remember", "Memory without target flag"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.path.startsWith(stashDir)).toBe(true);
  });

  test("--target routes memory to the named writable secondary stash", async () => {
    const secondaryDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "secondary", path: secondaryDir, writable: true }],
    });

    const { stashDir, result } = await runCli(["remember", "Pinned note for secondary stash", "--target", "secondary"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("memory:pinned-note-for-secondary-stash");

    // Must land in the explicit secondary stash, NOT the working stash.
    const expectedPath = path.join(secondaryDir, "memories", "pinned-note-for-secondary-stash.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories", "pinned-note-for-secondary-stash.md"))).toBe(false);
  });

  test("--target with an unknown source name throws a usage error", async () => {
    const targetDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "real-stash", path: targetDir, writable: true }],
    });

    const { result } = await runCli(["remember", "won't be written", "--target", "ghost-stash"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain('No source named "ghost-stash" is configured');
    expect(json.error).toContain("--target must reference a source name");
  });

  test("--target on a non-writable source throws a config error", async () => {
    const targetDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "frozen-stash", path: targetDir, writable: false }],
    });

    const { result } = await runCli(["remember", "won't be written", "--target", "frozen-stash"]);
    expect(result.status).not.toBe(0);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("source frozen-stash is not writable");
  });
});
