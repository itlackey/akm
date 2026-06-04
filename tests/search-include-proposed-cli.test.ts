/**
 * `akm search --include-proposed` CLI integration test (#284 GAP-HIGH 9).
 *
 * Drives the CLI against an indexed stash that contains both a
 * `quality: stable` and a `quality: proposed` skill, and asserts that:
 *   - default search excludes the proposed entry,
 *   - `--include-proposed` retains it in the hits list.
 *
 * Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process
 * harness (tests/_helpers/cli.ts). Each runCli call re-pins AKM_STASH_DIR for
 * the indexed stash and resets the config cache before the in-process run,
 * restoring env in finally — so the freshly indexed stash is read back without
 * subprocess startup cost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetConfigCache, saveConfig } from "../src/core/config";
import { akmIndex } from "../src/indexer/indexer";
import { runCliCapture } from "./_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "./_helpers/sandbox";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_STASH_DIR: stashDir }, async () => {
    resetConfigCache();
    const res = await runCliCapture(args);
    return { stdout: res.stdout, stderr: res.stderr, status: res.code };
  });
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  const stashResult = sandboxStashDir(dataResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm search --include-proposed (CLI)", () => {
  test("default excludes proposed entries; --include-proposed keeps them", async () => {
    const stash = makeTempDir("akm-search-proposed-stash-");
    for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
      fs.mkdirSync(path.join(stash, sub), { recursive: true });
    }

    // Curated entry
    writeFile(
      path.join(stash, "skills", "stable-deploy", "SKILL.md"),
      "---\ndescription: deploy widgets uniformly\ntags:\n  - deploy\nquality: curated\n---\n# Stable deploy\n",
    );
    // Proposed entry
    writeFile(
      path.join(stash, "skills", "proposed-deploy", "SKILL.md"),
      "---\ndescription: deploy widgets experimentally\ntags:\n  - deploy\nquality: proposed\n---\n# Proposed deploy\n",
    );

    process.env.AKM_STASH_DIR = stash;
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir: stash, full: true });

    const baseline = await runCli(["search", "deploy", "--format=json"], stash);
    expect(baseline.status).toBe(0);
    const baselineJson = JSON.parse(baseline.stdout);
    const baselineNames = (baselineJson.hits as Array<{ name: string }>).map((h) => h.name);
    expect(baselineNames).toContain("stable-deploy");
    expect(baselineNames).not.toContain("proposed-deploy");

    const withProposed = await runCli(["search", "deploy", "--include-proposed", "--format=json"], stash);
    expect(withProposed.status).toBe(0);
    const withProposedJson = JSON.parse(withProposed.stdout);
    const withProposedNames = (withProposedJson.hits as Array<{ name: string }>).map((h) => h.name);
    expect(withProposedNames).toContain("stable-deploy");
    expect(withProposedNames).toContain("proposed-deploy");
  });
});
