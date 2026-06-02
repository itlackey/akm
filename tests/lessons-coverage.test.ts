/**
 * Phase 7A / Advantage D4c — `akm lessons coverage` subcommand.
 *
 * Reports tags that appear on indexed assets but are NOT yet covered by any
 * lesson-type entry. Used by humans/agents to identify topics where the
 * stash has tacit knowledge worth crystallizing.
 *
 * Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process
 * harness (tests/_helpers/cli.ts). Each test allocates fresh isolated
 * XDG/stash dirs through the allowlisted sandbox helpers; buildIndex indexes
 * the stash and runCli reads it back in-process (resetting the config cache so
 * the run re-reads the sandboxed env), with no subprocess startup cost.
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
  sandboxXdgStateHome,
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

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  resetConfigCache();
  const res = await runCliCapture(args);
  return { status: res.code, stdout: res.stdout, stderr: res.stderr };
}

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  const stateResult = sandboxXdgStateHome(dataResult.cleanup);
  const stashResult = sandboxStashDir(stateResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm lessons coverage (Phase 7A)", () => {
  test("reports tags present on non-lesson assets that no lesson covers", async () => {
    const stashDir = makeTempDir("akm-lessons-cov-");

    // Non-lesson assets touch four tags: deploy, networking, auth, observability.
    writeFile(
      path.join(stashDir, "skills", "deploy.md"),
      "---\ndescription: deploy skill\ntags: [deploy, networking]\n---\nDeploy steps.\n",
    );
    writeFile(
      path.join(stashDir, "memories", "auth-tips.md"),
      "---\ndescription: auth memory\ntags: [auth]\n---\nAuth tips body.\n",
    );
    writeFile(
      path.join(stashDir, "scripts", "monitor.sh"),
      "#!/usr/bin/env bash\n# @description Monitor svc\n# @tags observability\necho monitor\n",
    );
    // A single lesson covers ONLY the "deploy" tag — leaving networking, auth,
    // observability as uncovered.
    writeFile(
      path.join(stashDir, "lessons", "deploy-safely.md"),
      "---\ndescription: deploy lesson\ntags: [deploy]\n---\nAlways check VPN before deploy.\n",
    );

    await buildIndex(stashDir);

    const result = await runCli(["lessons", "coverage", "--format=json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      uncoveredTags: string[];
      lessonTagCount: number;
      totalTagCount: number;
    };
    expect(parsed.uncoveredTags).toEqual(["auth", "networking", "observability"]);
    expect(parsed.lessonTagCount).toBe(1);
    expect(parsed.totalTagCount).toBeGreaterThanOrEqual(4);
  });

  test("returns an empty list when every tag is covered by a lesson", async () => {
    const stashDir = makeTempDir("akm-lessons-allcov-");

    writeFile(
      path.join(stashDir, "skills", "deploy.md"),
      "---\ndescription: deploy skill\ntags: [deploy]\n---\nBody.\n",
    );
    writeFile(
      path.join(stashDir, "lessons", "deploy.md"),
      "---\ndescription: deploy lesson\ntags: [deploy]\n---\nBody.\n",
    );

    await buildIndex(stashDir);

    const result = await runCli(["lessons", "coverage", "--format=json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { uncoveredTags: string[] };
    expect(parsed.uncoveredTags).toEqual([]);
  });

  test("singular `akm lesson` alias resolves to the same command", async () => {
    const stashDir = makeTempDir("akm-lessons-alias-");

    writeFile(
      path.join(stashDir, "skills", "deploy.md"),
      "---\ndescription: deploy skill\ntags: [deploy]\n---\nBody.\n",
    );
    writeFile(
      path.join(stashDir, "lessons", "deploy.md"),
      "---\ndescription: deploy lesson\ntags: [deploy]\n---\nBody.\n",
    );

    await buildIndex(stashDir);

    const result = await runCli(["lesson", "coverage", "--format=json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { uncoveredTags: string[] };
    expect(parsed.uncoveredTags).toEqual([]);
  });
});
