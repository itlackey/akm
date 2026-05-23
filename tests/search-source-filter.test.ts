/**
 * Regression test for `akm search --source <name>` leak bug.
 *
 * The FTS+vector index spans every configured source. Before this fix,
 * `akm search "query" --source library` would still return hits from
 * other sources because `searchDatabase` never filtered scored items by
 * the narrowed source list — the narrowing only affected graph-context
 * loading and the per-hit ref formatting.
 *
 * The fix gates a `restrictToSources` flag on the named-source code path
 * and drops scored items whose filePath does not live under any of the
 * provided sources.
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
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
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
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
  if (savedEnv.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm search --source <name> filters hits to that source", () => {
  test("named --source returns only hits whose files live under that source", async () => {
    const primary = makeTempDir("akm-src-filter-primary-");
    const library = makeTempDir("akm-src-filter-library-");
    process.env.XDG_CACHE_HOME = makeTempDir("akm-src-filter-cache-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-src-filter-config-");
    process.env.XDG_DATA_HOME = makeTempDir("akm-src-filter-data-");
    process.env.XDG_STATE_HOME = makeTempDir("akm-src-filter-state-");
    for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
      fs.mkdirSync(path.join(primary, sub), { recursive: true });
      fs.mkdirSync(path.join(library, sub), { recursive: true });
    }

    // Both sources have a skill matching the query "shared-keyword".
    writeFile(
      path.join(primary, "skills", "primary-skill", "SKILL.md"),
      "---\ndescription: shared-keyword in the primary stash\ntags:\n  - shared-keyword\n---\n# Primary\n",
    );
    writeFile(
      path.join(library, "skills", "library-skill", "SKILL.md"),
      "---\ndescription: shared-keyword in the library stash\ntags:\n  - shared-keyword\n---\n# Library\n",
    );

    process.env.AKM_STASH_DIR = primary;
    saveConfig({
      semanticSearchMode: "off",
      sources: [
        { type: "filesystem", name: "primary", path: primary, writable: true },
        { type: "filesystem", name: "library", path: library, writable: false },
      ],
    });
    await akmIndex({ stashDir: primary, full: true });

    // Baseline: no --source filter. Both sources should contribute hits.
    const baseline = runCli(["search", "shared-keyword", "--format=json"], primary);
    expect(baseline.status).toBe(0);
    const baselineHits = (JSON.parse(baseline.stdout).hits as Array<{ name: string; ref: string }>) ?? [];
    const baselineNames = baselineHits.map((h) => h.name);
    expect(baselineNames).toContain("primary-skill");
    expect(baselineNames).toContain("library-skill");

    // Narrowed: --source library should ONLY return hits from the library
    // source. Before this fix, primary-skill would also appear because the
    // FTS index is global across sources and the search command did not
    // post-filter by the narrowed source list.
    const narrowed = runCli(["search", "shared-keyword", "--source", "library", "--format=json"], primary);
    expect(narrowed.status).toBe(0);
    const narrowedHits = (JSON.parse(narrowed.stdout).hits as Array<{ name: string; ref: string }>) ?? [];
    const narrowedNames = narrowedHits.map((h) => h.name);
    expect(narrowedNames).toContain("library-skill");
    expect(narrowedNames).not.toContain("primary-skill");

    // And vice versa — `--source primary` returns only the primary hit.
    // Regression for a related bug: `resolveSourceEntries` injects the primary
    // stash into `sources[0]` before iterating the config sources. The dedupe
    // loop used to skip the matching config entry, so the primary stash entry
    // never received its config name and `--source <primary-name>` matched
    // zero entries. addSource now enriches the existing entry with config
    // metadata when the path is already in the source list.
    const narrowedPrimary = runCli(["search", "shared-keyword", "--source", "primary", "--format=json"], primary);
    expect(narrowedPrimary.status).toBe(0);
    const narrowedPrimaryHits = (JSON.parse(narrowedPrimary.stdout).hits as Array<{ name: string; ref: string }>) ?? [];
    const narrowedPrimaryNames = narrowedPrimaryHits.map((h) => h.name);
    expect(narrowedPrimaryNames).toContain("primary-skill");
    expect(narrowedPrimaryNames).not.toContain("library-skill");
  });
});
