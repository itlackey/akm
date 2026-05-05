/**
 * `akm search --include-proposed` CLI integration test (#284 GAP-HIGH 9).
 *
 * Spawns the real CLI against an indexed stash that contains both a
 * `quality: stable` and a `quality: proposed` skill, and asserts that:
 *   - default search excludes the proposed entry,
 *   - `--include-proposed` retains it in the hits list.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveConfig } from "../src/core/config";
import { akmIndex } from "../src/indexer/indexer";

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
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

const CLI = path.join(__dirname, "..", "src", "cli.ts");

function runCli(args: string[], stashDir: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm search --include-proposed (CLI)", () => {
  test("default excludes proposed entries; --include-proposed keeps them", async () => {
    const stash = makeTempDir("akm-search-proposed-stash-");
    process.env.XDG_CACHE_HOME = makeTempDir("akm-search-proposed-cache-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-search-proposed-config-");
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

    const baseline = runCli(["search", "deploy", "--format=json"], stash);
    expect(baseline.status).toBe(0);
    const baselineJson = JSON.parse(baseline.stdout);
    const baselineNames = (baselineJson.hits as Array<{ name: string }>).map((h) => h.name);
    expect(baselineNames).toContain("stable-deploy");
    expect(baselineNames).not.toContain("proposed-deploy");

    const withProposed = runCli(["search", "deploy", "--include-proposed", "--format=json"], stash);
    expect(withProposed.status).toBe(0);
    const withProposedJson = JSON.parse(withProposed.stdout);
    const withProposedNames = (withProposedJson.hits as Array<{ name: string }>).map((h) => h.name);
    expect(withProposedNames).toContain("stable-deploy");
    expect(withProposedNames).toContain("proposed-deploy");
  });
});
