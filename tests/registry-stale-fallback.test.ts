// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Registry stale-cache fallback past TTL (§24.2 "Durability" release gate).
 *
 * The fetch skeleton's stale fallback used to consult only the TTL-filtered
 * row: once the cached index aged past `ttlMs`, an unreachable registry
 * hard-failed `akm search --from registry` / `akm registry list` even though
 * a perfectly serviceable index sat in the cache. A failed fetch now serves
 * the expired row too — loudly, via warn().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setWarnSinkForTests } from "../src/core/warn";
import { fetchCachedJson, withRegistryCacheDb } from "../src/storage/repositories/registry-index-cache-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

const KEY = "https://registry.example/index.json";

function opts(fetchFresh: () => Promise<{ value: string; cacheJson: string }>, ttlMs = 60_000) {
  return {
    cacheKey: KEY,
    ttlMs,
    parseCache: (json: string) => (JSON.parse(json) as { v: string }).v,
    fetchFresh,
  };
}

async function backdateCacheRow(ageMs: number): Promise<void> {
  await withRegistryCacheDb(async (db) => {
    if (!db) throw new Error("expected a cache db in the sandbox");
    db.prepare("UPDATE registry_index_cache SET fetched_at = ? WHERE registry_url = ?").run(
      new Date(Date.now() - ageMs).toISOString(),
      KEY,
    );
  });
}

describe("registry cache fallback past TTL", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("a failed fetch serves the EXPIRED cached index with a warning instead of throwing", async () => {
    // Seed the cache with a successful fetch, then age it past the TTL.
    await fetchCachedJson(opts(async () => ({ value: "seeded", cacheJson: JSON.stringify({ v: "seeded" }) })));
    await backdateCacheRow(2 * 60_000);

    const warned: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warned.push(args.map(String).join(" "));
    });

    const result = await fetchCachedJson(
      opts(async () => {
        throw new Error("ECONNREFUSED registry.example");
      }),
    );
    expect(result).toBe("seeded");
    expect(warned.some((w) => w.includes("registry.example"))).toBe(true);
  });

  test("with no cached row at all, the fetch failure still propagates", async () => {
    await expect(
      fetchCachedJson(
        opts(async () => {
          throw new Error("ECONNREFUSED registry.example");
        }),
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
