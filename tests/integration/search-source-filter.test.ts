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
 *
 * Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process
 * harness (tests/_helpers/cli.ts). Each runCli call re-pins the test's
 * isolated XDG/stash env and resets the config cache before driving the CLI
 * in-process, then restores in finally — so the indexed stash written by
 * akmIndex is read back faithfully without subprocess startup cost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
  withEnv,
} from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function makeTempDir(prefix: string): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  // Fresh isolated XDG dirs + stash per test so the indexed DB / config live
  // in tempdirs. Chained so a single cleanup() undoes all of them.
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
  for (const d of disposers.splice(0)) d.cleanup();
});

/**
 * Drive the CLI in-process against a specific stash dir. Re-pins AKM_STASH_DIR
 * for the call and resets the config cache so the run re-reads against the
 * narrowed stash, mirroring what the spawned subprocess got via its env.
 */
async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_STASH_DIR: stashDir }, async () => {
    resetConfigCache();
    const res = await runCliCapture(args);
    return { stdout: res.stdout, stderr: res.stderr, status: res.code };
  });
}

describe("akm search --source <name> filters hits to that source", () => {
  test("named --source returns only hits whose files live under that source", async () => {
    const primary = makeTempDir("akm-src-filter-primary-");
    const library = makeTempDir("akm-src-filter-library-");
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
    const baseline = await runCli(["search", "shared-keyword", "--format=json"], primary);
    expect(baseline.status).toBe(0);
    const baselineHits = (JSON.parse(baseline.stdout).hits as Array<{ name: string; ref: string }>) ?? [];
    const baselineNames = baselineHits.map((h) => h.name);
    expect(baselineNames).toContain("primary-skill");
    expect(baselineNames).toContain("library-skill");

    // Narrowed: --source library should ONLY return hits from the library
    // source. Before this fix, primary-skill would also appear because the
    // FTS index is global across sources and the search command did not
    // post-filter by the narrowed source list.
    const narrowed = await runCli(["search", "shared-keyword", "--source", "library", "--format=json"], primary);
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
    const narrowedPrimary = await runCli(["search", "shared-keyword", "--source", "primary", "--format=json"], primary);
    expect(narrowedPrimary.status).toBe(0);
    const narrowedPrimaryHits = (JSON.parse(narrowedPrimary.stdout).hits as Array<{ name: string; ref: string }>) ?? [];
    const narrowedPrimaryNames = narrowedPrimaryHits.map((h) => h.name);
    expect(narrowedPrimaryNames).toContain("primary-skill");
    expect(narrowedPrimaryNames).not.toContain("library-skill");
  });
});
