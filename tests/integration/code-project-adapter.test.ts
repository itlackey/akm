/**
 * `code-project` adapter (#1411) through the real indexer and search: a git
 * repository added with `adapter: "code-project"` indexes eligible files,
 * reconciles add/change/delete/rename, and never indexes ignored `secrets/`,
 * `.env`, generated or vendored files. `.github/` instructions are visible.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified } from "../../src/commands/read/show";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import type { SourceSearchHit } from "../../src/sources/types";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

const tmpDirs: string[] = [];
let stashDir = "";
let envCleanup: Cleanup = () => {};

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(root: string, ...args: string[]): void {
  expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
}

function makeRepo(useGit: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-code-project-"));
  tmpDirs.push(root);
  write(root, "src/auth/oauth.ts", "export function authenticateWithPkceVerifier() {}\n");
  write(root, "README.md", "# Sample\n\nZebrafish overview.\n");
  write(root, ".github/AGENTS.md", "# Agents\n\nQuokka instructions.\n");
  write(root, "node_modules/pkg/index.js", "export const wombatVendored = 1;\n");
  write(root, "dist/bundle.js", "export const platypusGenerated = 1;\n");
  write(root, "package-lock.json", '{"name":"lockfile-marker"}\n');
  write(root, ".env", "TOKEN=narwhalsecret\n");
  write(root, "secrets/key.ts", "export const okapiSecret = 1;\n");
  if (useGit) {
    write(root, ".gitignore", "secrets/\n.env\ndist/\nnode_modules/\n");
    git(root, "init", "-q");
  }
  return root;
}

async function indexRepo(root: string): Promise<void> {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "local",
    bundles: {
      local: { path: stashDir, writable: true, components: { main: { root: ".", adapter: "akm", writable: true } } },
      proj: { path: root, components: { main: { root: ".", adapter: "code-project" } } },
    },
  });
  resetConfigCache();
  await akmIndex({ stashDir, full: true });
}

async function refs(query: string): Promise<string[]> {
  const result = await akmSearch({ query, source: "proj", skipLogging: true });
  return result.hits.filter((hit): hit is SourceSearchHit => "path" in hit).map((hit) => hit.ref);
}

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
  resetConfigCache();
});

afterEach(() => {
  envCleanup();
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("code-project adapter (#1411)", () => {
  test.each([
    true,
    false,
  ])("git=%p: indexes source and docs, skips generated, vendored and secret files", async (useGit) => {
    await indexRepo(makeRepo(useGit));

    expect(await refs("authenticateWithPkceVerifier")).toEqual(["proj//src/auth/oauth.ts"]);
    expect(await refs("zebrafish")).toEqual(["proj//README.md"]);
    expect(await refs("quokka")).toEqual(["proj//.github/AGENTS.md"]);
    for (const secretOrGenerated of ["wombatVendored", "platypusGenerated", "lockfile-marker", "narwhalsecret"]) {
      expect(await refs(secretOrGenerated)).toEqual([]);
    }
    if (useGit) expect(await refs("okapiSecret")).toEqual([]);
  });

  test("show resolves a source file by its path ref", async () => {
    await indexRepo(makeRepo(true));
    const shown = await akmShowUnified({ ref: "proj//src/auth/oauth.ts", skipLogging: true });
    expect(shown).toMatchObject({ type: "source", ref: "proj//src/auth/oauth.ts" });
    expect(String((shown as { content?: string }).content)).toContain("authenticateWithPkceVerifier");
  });

  test("reindex reconciles change, delete and rename without stale or duplicate refs", async () => {
    const root = makeRepo(true);
    await indexRepo(root);

    write(root, "src/auth/oauth.ts", "export function rotatedHeronToken() {}\n");
    fs.renameSync(path.join(root, "README.md"), path.join(root, "OVERVIEW.md"));
    fs.rmSync(path.join(root, ".github/AGENTS.md"));
    await akmIndex({ stashDir });

    expect(await refs("authenticateWithPkceVerifier")).toEqual([]);
    expect(await refs("rotatedHeronToken")).toEqual(["proj//src/auth/oauth.ts"]);
    expect(await refs("zebrafish")).toEqual(["proj//OVERVIEW.md"]);
    expect(await refs("quokka")).toEqual([]);
  });
});
