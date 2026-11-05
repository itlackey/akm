/**
 * `--prefer`: a scope preference that boosts matching hits (×PREFER_WEIGHT on the fused score,
 * a stable reorder when browsing) and never drops or admits a hit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmSearch, parseScopeFilterFlags } from "../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { applyPrefer, type FusedCandidate, PREFER_WEIGHT, reciprocalRankFusion } from "../src/indexer/search/ranking";
import { writeMemory } from "./_helpers/assets";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "./_helpers/sandbox";

describe("applyPrefer", () => {
  const ref = (id: number) => ({ id, itemRef: `stash//knowledge/n${id}` });
  const fused = reciprocalRankFusion([[ref(1), ref(2), ref(3), ref(4)], []]);

  test("multiplies only preferred scores by PREFER_WEIGHT and reorders", () => {
    const out = applyPrefer(fused, new Set(["stash//knowledge/n3"]));
    expect(out.map((c: FusedCandidate) => c.itemRef.slice(-2))).toEqual(["n1", "n3", "n2", "n4"]);
    expect(out[1]?.score).toBeCloseTo((fused[2]?.score as number) * PREFER_WEIGHT, 12);
    expect(out[0]?.score).toBe(fused[0]?.score as number);
  });

  test("an empty preferred set changes nothing", () => {
    expect(applyPrefer(fused, new Set())).toEqual(fused);
  });
});

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

/** Six memories that all match "gateway", ranked by how often they say it; each has its own scope. */
async function indexStash(): Promise<string> {
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-search-prefer-"));
  tempDirs.push(stash);
  const scopes = [
    { scope_user: "u1", scope_channel: "ops" },
    { scope_user: "u2", scope_channel: "dev" },
    { scope_user: "u3", scope_channel: "ops" },
    { scope_user: "u4", scope_channel: "dev" },
    { scope_user: "u5", scope_channel: "ops" },
    { scope_user: "u6", scope_channel: "dev" },
  ];
  scopes.forEach((scope, i) => {
    writeMemory(stash, `m${i + 1}`, scope, `${"gateway ".repeat(6 - i)}${"filler ".repeat(i * 4)}`);
  });
  await withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir: stash, full: true });
  });
  return stash;
}

async function names(stash: string, input: Partial<Parameters<typeof akmSearch>[0]>): Promise<string[]> {
  return withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    const result = await akmSearch({ query: "gateway", ...input });
    return result.hits.map((hit) => ("name" in hit ? String(hit.name) : ""));
  });
}

const prefer = (...tokens: string[]) => parseScopeFilterFlags(tokens, "--prefer");

describe("akmSearch prefer", () => {
  test("without prefer the result is the plain ranking", async () => {
    const stash = await indexStash();
    expect(await names(stash, { prefer: undefined })).toEqual(await names(stash, {}));
  });

  test("a matching hit passes the hit above it and nothing is dropped", async () => {
    const stash = await indexStash();
    const base = await names(stash, {});
    expect(base).toHaveLength(6);
    const user = `u${Number(base[2]?.slice(1))}`;
    const boosted = await names(stash, { prefer: prefer(`user=${user}`) });
    expect(boosted).toEqual([base[0], base[2], base[1], ...base.slice(3)] as string[]);
  });

  test("a repeated key boosts any of its values", async () => {
    const stash = await indexStash();
    const base = await names(stash, {});
    const u = (i: number) => `user=u${Number(base[i]?.slice(1))}`;
    const boosted = await names(stash, { prefer: prefer(u(2), u(4)) });
    expect(boosted).toEqual([base[0], base[2], base[1], base[4], base[3], base[5]] as string[]);
  });

  test("different keys must all match", async () => {
    const stash = await indexStash();
    const base = await names(stash, {});
    const n = Number(base[2]?.slice(1));
    const channel = n % 2 === 1 ? "ops" : "dev";
    const other = channel === "ops" ? "dev" : "ops";
    const both = await names(stash, { prefer: prefer(`user=u${n}`, `channel=${channel}`) });
    expect(both[1]).toBe(base[2] as string);
    const mismatch = await names(stash, { prefer: prefer(`user=u${n}`, `channel=${other}`) });
    expect(mismatch).toEqual(base);
  });

  test("filter still limits, and prefer reorders only what filter leaves", async () => {
    const stash = await indexStash();
    const filters = parseScopeFilterFlags(["channel=ops"], "--filter");
    const base = await names(stash, { filters });
    expect(base).toHaveLength(3);
    const user = `u${Number(base[1]?.slice(1))}`;
    const boosted = await names(stash, { filters, prefer: prefer(`user=${user}`) });
    expect(boosted).toEqual([base[1], base[0], base[2]] as string[]);
  });

  test("browsing puts matches first and keeps the listing order otherwise", async () => {
    const stash = await indexStash();
    const base = await names(stash, { query: "" });
    expect(base).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    const boosted = await names(stash, { query: "", prefer: prefer("user=u5", "user=u3") });
    expect(boosted).toEqual(["m3", "m5", "m1", "m2", "m4", "m6"]);
    const limited = await names(stash, { query: "", limit: 2, prefer: prefer("user=u6") });
    expect(limited).toEqual(["m6", "m1"]);
  });
});
