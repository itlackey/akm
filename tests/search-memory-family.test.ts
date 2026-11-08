/** Search returns one result per memory family: a `.derived` twin is dropped when its parent is a hit. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmSearch } from "../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { writeMemory } from "./_helpers/assets";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "./_helpers/sandbox";

const tempDirs: string[] = [];
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  envCleanup = sandboxStashDir(dataResult.cleanup).cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const twin = (parent: string) => ({ inferred: true, source: `memories/${parent}` });

async function index(build: (stash: string) => void): Promise<string> {
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-search-family-"));
  tempDirs.push(stash);
  build(stash);
  await withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir: stash, full: true });
  });
  return stash;
}

async function search(stash: string, input: Partial<Parameters<typeof akmSearch>[0]>) {
  return withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    const result = await akmSearch({ query: "gateway", ...input });
    return result.hits.map((hit) => ("name" in hit ? String(hit.name) : ""));
  });
}

describe("akmSearch memory families", () => {
  test("parent and twin both match: only the parent, and the freed slot backfills", async () => {
    const stash = await index((s) => {
      writeMemory(s, "alpha", {}, "gateway gateway gateway timeout notes");
      writeMemory(s, "alpha.derived", twin("alpha"), "gateway gateway lesson about timeouts");
      writeMemory(s, "beta", {}, "gateway retry notes");
      writeMemory(s, "gamma", {}, "gateway auth notes");
    });
    const all = await search(stash, { limit: 10 });
    expect(all).not.toContain("alpha.derived");
    expect(all).toContain("alpha");
    expect(all).toHaveLength(3);
    const two = await search(stash, { limit: 2 });
    expect(two).toHaveLength(2);
    expect(two).not.toContain("alpha.derived");
  });

  test("a parent ranked below its twin takes the twin's place and keeps expandTo", async () => {
    const stash = await index((s) => {
      writeMemory(s, "alpha", {}, `gateway ${"filler ".repeat(40)}`);
      writeMemory(s, "alpha.derived", twin("alpha"), "gateway gateway gateway gateway");
      writeMemory(s, "beta", {}, "gateway gateway gateway");
      writeMemory(s, "gamma", {}, "gateway gateway");
    });
    const hits = await withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
      resetConfigCache();
      return (await akmSearch({ query: "gateway", limit: 10 })).hits as Array<{ name: string; expandTo?: string }>;
    });
    expect(hits.map((h) => h.name)).toEqual(["beta", "alpha", "gamma"]);
    expect(hits[1]?.expandTo).toContain("alpha.derived");
  });

  test("twin alone matching is kept", async () => {
    const stash = await index((s) => {
      writeMemory(s, "alpha", {}, "unrelated words only");
      writeMemory(s, "alpha.derived", twin("alpha"), "gateway lesson about timeouts");
    });
    expect(await search(stash, {})).toEqual(["alpha.derived"]);
  });
});
