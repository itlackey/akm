/**
 * Phase 7A / Advantage D4c — `akm lessons coverage` subcommand.
 *
 * Reports tags that appear on indexed assets but are NOT yet covered by any
 * lesson-type entry. Used by humans/agents to identify topics where the
 * stash has tacit knowledge worth crystallizing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/core/config";
import { akmIndex } from "../src/indexer/indexer";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function buildIndex(stashDir: string): Promise<void> {
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    else process.env[key as keyof NodeJS.ProcessEnv] = val;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm lessons coverage (Phase 7A)", () => {
  test("reports tags present on non-lesson assets that no lesson covers", async () => {
    const stashDir = makeTempDir("akm-lessons-cov-");
    process.env.XDG_CACHE_HOME = makeTempDir("akm-lc-cache-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-lc-config-");
    process.env.XDG_DATA_HOME = makeTempDir("akm-lc-data-");
    process.env.XDG_STATE_HOME = makeTempDir("akm-lc-state-");

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

    const result = runCli(["lessons", "coverage", "--format=json"]);
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
    process.env.XDG_CACHE_HOME = makeTempDir("akm-lcall-cache-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-lcall-config-");
    process.env.XDG_DATA_HOME = makeTempDir("akm-lcall-data-");
    process.env.XDG_STATE_HOME = makeTempDir("akm-lcall-state-");

    writeFile(
      path.join(stashDir, "skills", "deploy.md"),
      "---\ndescription: deploy skill\ntags: [deploy]\n---\nBody.\n",
    );
    writeFile(
      path.join(stashDir, "lessons", "deploy.md"),
      "---\ndescription: deploy lesson\ntags: [deploy]\n---\nBody.\n",
    );

    await buildIndex(stashDir);

    const result = runCli(["lessons", "coverage", "--format=json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { uncoveredTags: string[] };
    expect(parsed.uncoveredTags).toEqual([]);
  });
});
