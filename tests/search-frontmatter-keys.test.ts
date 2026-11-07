/**
 * `--filter` / `--prefer` select on any frontmatter key (#1453): `team`, `project`, `tag`, and an
 * asset without the key is simply not a match.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmSearch, parseScopeFilterFlags } from "../src/commands/read/search";
import type { IndexDocument } from "../src/core/adapter/types";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { applyCuratedFrontmatter, scopeMatchesFilters } from "../src/indexer/passes/metadata";
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

/** Five memories that all match "gateway", ranked m1..m5 by how often they say it. */
async function indexStash(): Promise<string> {
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-frontmatter-keys-"));
  tempDirs.push(stash);
  const metas: Record<string, unknown>[] = [
    { team: "platform", project: "openpalm", tags: ["Auth-Service"] },
    { team: "data", project: "openpalm" },
    { team: "platform", project: "akm", tags: ["billing"] },
    { team: ["data", "platform"], project: "akm" },
    {},
  ];
  metas.forEach((meta, i) => {
    writeMemory(stash, `m${i + 1}`, meta, `${"gateway ".repeat(5 - i)}${"filler ".repeat(i * 4)}`);
  });
  await withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir: stash, full: true });
  });
  return stash;
}

async function names(stash: string, input: Partial<Parameters<typeof akmSearch>[0]>, query = "gateway") {
  return withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    const result = await akmSearch({ query, ...input });
    return result.hits.map((hit) => ("name" in hit ? String(hit.name) : ""));
  });
}

const flags = (...tokens: string[]) => parseScopeFilterFlags(tokens);

describe("filter on any frontmatter key", () => {
  test("an arbitrary key narrows the result", async () => {
    const stash = await indexStash();
    expect(await names(stash, { filters: flags("team=platform") })).toEqual(["m1", "m3", "m4"]);
  });

  test("a repeated key is OR, different keys are AND", async () => {
    const stash = await indexStash();
    expect(await names(stash, { filters: flags("team=data", "team=platform", "project=akm") })).toEqual(["m3", "m4"]);
    expect(await names(stash, { filters: flags("team=data", "project=akm") })).toEqual(["m4"]);
  });

  test("tag is normalised like indexed tags", async () => {
    const stash = await indexStash();
    expect(await names(stash, { filters: flags("tag=auth-service") })).toEqual(["m1"]);
    expect(await names(stash, { filters: flags("tag=Auth_Service") })).toEqual(["m1"]);
  });

  test("an asset without the key, or an unknown key, is no match and no error", async () => {
    const stash = await indexStash();
    expect(await names(stash, { filters: flags("team=nobody") })).toEqual([]);
    expect(await names(stash, { filters: flags("nokey=x") })).toEqual([]);
  });

  test("the values are not searchable text", async () => {
    const stash = await indexStash();
    expect(await names(stash, {}, "openpalm")).toEqual([]);
  });
});

describe("an empty filter value matches assets without the key (#1459)", () => {
  test("alone it keeps only assets without the key", async () => {
    const stash = await indexStash();
    expect(await names(stash, { filters: flags("project=") })).toEqual(["m5"]);
    expect(await names(stash, { filters: flags("nokey=") })).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  test("with a value it keeps that value plus the assets without the key", async () => {
    const stash = await indexStash();
    expect(await names(stash, { filters: flags("team=data", "team=") })).toEqual(["m2", "m4", "m5"]);
  });

  test("tag= means no tags", () => {
    expect(scopeMatchesFilters({ tags: undefined }, { tag: [""] })).toBe(true);
    expect(scopeMatchesFilters({ tags: [] }, { tag: [""] })).toBe(true);
    expect(scopeMatchesFilters({ tags: ["billing"] }, { tag: [""] })).toBe(false);
    expect(scopeMatchesFilters({ tags: ["billing"] }, { tag: ["Billing", ""] })).toBe(true);
    expect(scopeMatchesFilters({ tags: [] }, { tag: ["billing"] })).toBe(false);
  });

  test("scope keys work, and different keys still AND", async () => {
    const stash = await indexStash();
    expect(await names(stash, { filters: flags("channel=") })).toHaveLength(5);
    expect(await names(stash, { filters: flags("channel=", "project=akm") })).toEqual(["m3", "m4"]);
  });
});

describe("prefer on any frontmatter key", () => {
  test("matches rank first and nothing is dropped", async () => {
    const stash = await indexStash();
    expect(await names(stash, {})).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    const boosted = await names(stash, { prefer: flags("project=akm") });
    expect([...boosted].sort()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(boosted.indexOf("m3")).toBeLessThan(2);
  });

  test("tag preference never drops the assets without the tag", async () => {
    const stash = await indexStash();
    const boosted = await names(stash, { prefer: flags("tag=billing") });
    expect(boosted).toHaveLength(5);
    expect(boosted[1]).toBe("m3");
  });
});

describe("a __proto__ frontmatter key", () => {
  test("is kept as an ordinary key and never touches the prototype", () => {
    const entry = { type: "memory", name: "m", filename: "m.md" } as unknown as IndexDocument;
    applyCuratedFrontmatter(entry, JSON.parse('{"__proto__": "x", "team": "core"}'));
    expect(Object.getPrototypeOf(entry.frontmatter)).toBeNull();
    expect(Object.hasOwn(entry.frontmatter ?? {}, "__proto__")).toBe(true);
    expect(scopeMatchesFilters(entry, { team: "core" })).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
