/**
 * remember --bundle tests
 *
 * Verifies the write-destination flag added to `akm remember` per v1
 * implementation plan §6 decision 3 (renamed `--target` → `--bundle` in the
 * 0.9 CLI overhaul, S8). Resolution order is:
 *   --bundle → defaultWriteTarget → defaultBundle → ConfigError
 *
 * These tests exercise the explicit-target path:
 *   - resolves to a configured filesystem source by name
 *   - errors on unknown target names (UsageError)
 *   - errors on non-writable targets (ConfigError)
 *
 * The shared write-target resolvers (`resolveWriteTarget` and
 * `resolveMutationTarget`) spell whatever flag their caller names, and
 * `--target` by default. `remember` takes `--bundle`, so its errors must say
 * `--bundle`, never the retired `--target` (still what `import`, env and secret
 * take).
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
// own stash/XDG dirs; in-process we sandbox AKM_BUNDLE_DIR via the allowlisted
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

describe("remember --bundle", () => {
  test("--bundle resolves to a configured filesystem source", async () => {
    const targetDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      bundles: { "writable-target": { path: targetDir, writable: true } },
    });

    const { stashDir, result } = await runCli([
      "remember",
      "Pinned context for the rollout",
      "--bundle",
      "writable-target",
    ]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("writable-target//memories/pinned-context-for-the-rollout");

    // The memory must land in the explicit target — NOT the working stash.
    const expectedPath = path.join(targetDir, "memories", "pinned-context-for-the-rollout.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories", "pinned-context-for-the-rollout.md"))).toBe(false);
  });

  test("--bundle with an unknown source name throws a usage error", async () => {
    const targetDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      bundles: { "real-target": { path: targetDir, writable: true } },
    });

    const { result } = await runCli(["remember", "won't be written", "--bundle", "nope"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain('No source named "nope" is configured');
    expect(json.error).toContain("--bundle must reference a source name");
    expect(json.error).not.toContain("--target");
  });

  test("--bundle with an unknown source name still names --bundle when --xref needs the write target", async () => {
    writeConfig({ semanticSearchMode: "off", bundles: { real: { path: makeTargetDir(), writable: true } } });

    const { result } = await runCli(["remember", "won't be written", "--bundle", "nope", "--xref", "knowledge/guide"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("--bundle must reference a source name");
    expect(json.error).not.toContain("--target");
  });

  test("a qualified --supersedes ref that names a different bundle conflicts with --bundle, not --target", async () => {
    writeConfig({
      semanticSearchMode: "off",
      bundles: {
        stash: { path: currentStashDir, writable: true },
        team: { path: makeTargetDir(), writable: true },
      },
      defaultBundle: "stash",
    });

    const { result } = await runCli([
      "remember",
      "won't be written",
      "--bundle",
      "stash",
      "--supersedes",
      "team//memories/old-note",
    ]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string; hint?: string };
    expect(json.error).toContain('conflicts with --bundle "stash"');
    expect(json.hint).toContain("Drop --bundle");
    expect(json.error).not.toContain("--target");
    expect(json.hint).not.toContain("--target");
  });

  test("--bundle on a non-writable source throws a config error", async () => {
    const targetDir = makeTargetDir();
    writeConfig({
      semanticSearchMode: "off",
      bundles: { "read-only": { path: targetDir, writable: false } },
    });

    const { result } = await runCli(["remember", "won't be written", "--bundle", "read-only"]);
    // VALUE-17: pin the exact classified failure (ConfigError -> exit 78,
    // code INVALID_CONFIG_FILE — see src/core/write-source.ts's
    // `resolveWriteTarget` non-writable-target branch and
    // src/cli/shared.ts's `classifyExitCode`), not merely "some failure".
    // `not.toBe(0)` would also pass for a crash, which defeats the point of
    // this test.
    expect(result.status).toBe(78);

    const json = JSON.parse(result.stderr) as { error: string; code?: string; hint?: string };
    expect(json.code).toBe("INVALID_CONFIG_FILE");
    expect(json.error).toContain("source read-only is not writable");
    expect(json.hint).toContain("or pass --bundle to a different source");
    expect(json.hint).not.toContain("--target");
  });
});

describe("remember --bundle", () => {
  test("default bundle is used when --bundle is omitted", async () => {
    writeConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: currentStashDir, writable: true } },
      defaultBundle: "stash",
    });

    const { stashDir, result } = await runCli(["remember", "Memory without target flag"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.path.startsWith(stashDir)).toBe(true);
  });
});

// R-062: `showSimilar` was renamed to the kebab-case `show-similar` for
// consistency with every other multi-word flag in the CLI. citty registers
// BOTH the camelCase and kebab-case spelling of any declared flag name
// automatically (verified against the pinned citty@^0.2.2 dependency), so
// this is a pure rename — `--showSimilar` is kept as an explicit, documented
// alias rather than becoming a silent accident, and both spellings must
// keep behaving identically.
describe("remember --show-similar / --showSimilar (R-062 rename, both spellings work)", () => {
  test("--show-similar (canonical kebab-case spelling) includes a similar[] array", async () => {
    const { result } = await runCli(["remember", "pinned note about deploy pipelines", "--show-similar"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ok: boolean; similar?: unknown[] };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.similar)).toBe(true);
  });

  test("--showSimilar (legacy camelCase spelling) behaves identically", async () => {
    const { result } = await runCli(["remember", "pinned note about deploy pipelines", "--showSimilar"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ok: boolean; similar?: unknown[] };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.similar)).toBe(true);
  });

  test("omitting the flag entirely omits `similar` from the result", async () => {
    const { result } = await runCli(["remember", "pinned note about deploy pipelines"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ok: boolean; similar?: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.similar).toBeUndefined();
  });
});
