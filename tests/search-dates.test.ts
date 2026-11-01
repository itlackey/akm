// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frontmatter dates (#1228): `created`, `updated`, `observed` and `expires` are
 * indexed fields and search-hit fields, `--since`/`--until` filter on the
 * observed date (else `updated`) before candidate budgets, and recency is a
 * small tie-break inside the fused score.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmSearch } from "../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { isoDay } from "../src/core/time";
import { akmIndex } from "../src/indexer/indexer";
import { applyRecency, type FusedCandidate, RECENCY_WEIGHT } from "../src/indexer/search/ranking";
import { writeMemory } from "./_helpers/assets";
import { runCliCapture } from "./_helpers/cli";
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

async function indexStash(setup: (stash: string) => void): Promise<string> {
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-search-dates-"));
  tempDirs.push(stash);
  setup(stash);
  await withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir: stash, full: true });
  });
  return stash;
}

async function search(stash: string, input: Parameters<typeof akmSearch>[0]) {
  return withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
    resetConfigCache();
    return akmSearch(input);
  });
}

function hitNames(result: Awaited<ReturnType<typeof akmSearch>>): string[] {
  return result.hits.map((hit) => ("name" in hit ? String(hit.name) : ""));
}

/** Memories that all match "gateway", dated differently. */
function writeDatedStash(stash: string): void {
  writeMemory(
    stash,
    "observed-early",
    { observed: "2026-01-10", updated: "2026-09-01", created: "2026-01-11", expires: "2027-01-01" },
    "gateway host was alpha",
  );
  writeMemory(stash, "observed-late", { observed: "2026-09-10", updated: "2026-09-11" }, "gateway host is bravo");
  writeMemory(stash, "updated-only", { updated: "2026-05-05" }, "gateway host sits at charlie");
  writeMemory(stash, "legacy-observed", { observed_at: "2026-03-03" }, "gateway host moved to delta");
  writeMemory(stash, "undated", { description: "no dates at all" }, "gateway host unknown echo");
  writeMemory(stash, "bad-date", { observed: "last tuesday" }, "gateway host fuzzy foxtrot");
}

describe("date fields on search hits", () => {
  test("observed, created, updated and expires are returned as written", async () => {
    const stash = await indexStash(writeDatedStash);
    const { hits } = await search(stash, { query: "gateway", limit: 20 });
    const byName = new Map(hits.map((hit) => [hit.name, hit as unknown as Record<string, unknown>]));
    const early = byName.get("observed-early");
    expect(early?.observed).toBe("2026-01-10");
    expect(early?.created).toBe("2026-01-11");
    expect(early?.updated).toBe("2026-09-01");
    expect(early?.expires).toBe("2027-01-01");
  });

  test("the legacy observed_at spelling fills `observed`", async () => {
    const stash = await indexStash(writeDatedStash);
    const { hits } = await search(stash, { query: "gateway", limit: 20 });
    expect((hits.find((hit) => hit.name === "legacy-observed") as { observed?: string }).observed).toBe("2026-03-03");
  });

  test("a hit omits the dates it does not have, and a value that is not a date is not indexed", async () => {
    const stash = await indexStash(writeDatedStash);
    const { hits } = await search(stash, { query: "gateway", limit: 20 });
    for (const name of ["undated", "bad-date"]) {
      const hit = hits.find((candidate) => candidate.name === name) as unknown as Record<string, unknown>;
      expect(hit).toBeDefined();
      for (const field of ["observed", "created", "updated", "expires"]) expect(field in hit).toBe(false);
    }
    const lateOnly = hits.find((hit) => hit.name === "observed-late") as unknown as Record<string, unknown>;
    expect("created" in lateOnly).toBe(false);
    expect("expires" in lateOnly).toBe(false);
  });

  test("a timestamp is kept as written", async () => {
    const stash = await indexStash((dir) =>
      writeMemory(dir, "stamped", { observed: "'2026-04-01T09:30:00Z'" }, "gateway stamped"),
    );
    const { hits } = await search(stash, { query: "gateway" });
    expect((hits[0] as { observed?: string }).observed).toBe("2026-04-01T09:30:00Z");
  });
});

describe("--since and --until", () => {
  test("since keeps assets dated on or after the day, observed first and updated as the fallback", async () => {
    const stash = await indexStash(writeDatedStash);
    // observed-early is observed 2026-01-10 although updated 2026-09-01: observed wins.
    expect(hitNames(await search(stash, { query: "gateway", since: "2026-05-05" })).sort()).toEqual([
      "observed-late",
      "updated-only",
    ]);
    expect(hitNames(await search(stash, { query: "gateway", since: "2026-05-06" }))).toEqual(["observed-late"]);
  });

  test("until keeps assets dated on or before the day", async () => {
    const stash = await indexStash(writeDatedStash);
    expect(hitNames(await search(stash, { query: "gateway", until: "2026-03-03" })).sort()).toEqual([
      "legacy-observed",
      "observed-early",
    ]);
  });

  test("since and until together bound a range, both ends inclusive", async () => {
    const stash = await indexStash(writeDatedStash);
    expect(
      hitNames(await search(stash, { query: "gateway", since: "2026-03-03", until: "2026-05-05" })).sort(),
    ).toEqual(["legacy-observed", "updated-only"]);
  });

  test("a bound drops undated assets and no bound keeps them", async () => {
    const stash = await indexStash(writeDatedStash);
    expect(hitNames(await search(stash, { query: "gateway", limit: 20 }))).toContain("undated");
    expect(hitNames(await search(stash, { query: "gateway", since: "2000-01-01" }))).not.toContain("undated");
    expect(hitNames(await search(stash, { query: "gateway", since: "2000-01-01" }))).not.toContain("bad-date");
  });

  test("the range applies before the limit", async () => {
    const stash = await indexStash(writeDatedStash);
    const unfiltered = hitNames(await search(stash, { query: "gateway", limit: 1 }));
    expect(unfiltered).not.toEqual(["observed-early"]);
    // Whatever ranks first without the range, the one asset in the range is returned.
    expect(hitNames(await search(stash, { query: "gateway", limit: 1, until: "2026-01-31" }))).toEqual([
      "observed-early",
    ]);
  });

  test("the range also applies when browsing with an empty query", async () => {
    const stash = await indexStash(writeDatedStash);
    expect(hitNames(await search(stash, { query: "", since: "2026-09-01" }))).toEqual(["observed-late"]);
  });

  test("the CLI takes the flags and rejects a value that is not a day", async () => {
    const stash = await indexStash(writeDatedStash);
    const run = (args: string[]) =>
      withEnv({ AKM_BUNDLE_DIR: stash }, async () => {
        resetConfigCache();
        return runCliCapture(args);
      });
    const ok = await run(["search", "gateway", "--since", "2026-09-01", "--format=json"]);
    expect(ok.code).toBe(0);
    expect((JSON.parse(ok.stdout).hits as Array<{ name: string }>).map((hit) => hit.name)).toEqual(["observed-late"]);

    for (const bad of ["yesterday", "2026-02-30", "2026-9-1"]) {
      const result = await run(["search", "gateway", "--until", bad, "--format=json"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("INVALID_FLAG_VALUE");
    }
  });
});

describe("isoDay", () => {
  test("reads the day a date value starts with", () => {
    expect(isoDay("2026-06-18")).toBe("2026-06-18");
    expect(isoDay(" 2026-06-18T10:30:00Z ")).toBe("2026-06-18");
    expect(isoDay("2026-06-18 10:30")).toBe("2026-06-18");
  });

  test("rejects anything that is not a calendar day", () => {
    for (const value of ["", "soon", "2026-6-18", "2026-02-30", "2026-13-01", "2026-06-181", "x2026-06-18"]) {
      expect(isoDay(value)).toBeUndefined();
    }
  });
});

describe("recency tie-break", () => {
  const candidate = (id: number, name: string, score: number): FusedCandidate => ({
    id,
    itemRef: `stash//memories/${name}`,
    score,
    ranks: [id, undefined],
  });
  const order = (fused: FusedCandidate[]) => fused.map((c) => c.itemRef.split("/").pop());

  test("the newer of two near-equal candidates ranks first", () => {
    const fused = [candidate(1, "old", 1 / 61), candidate(2, "new", 1 / 62)];
    const days = new Map([
      [1, "2025-01-01"],
      [2, "2026-09-01"],
    ]);
    expect(order(applyRecency(fused, days))).toEqual(["new", "old"]);
  });

  test("it never outweighs a clear margin", () => {
    // Ranks 1 and 10 of one channel: the gap is far larger than the recency swing.
    const fused = [candidate(1, "old", 1 / 61), candidate(2, "new", 1 / 70)];
    const days = new Map([
      [1, "2020-01-01"],
      [2, "2026-09-01"],
    ]);
    expect(order(applyRecency(fused, days))).toEqual(["old", "new"]);
  });

  test("undated candidates keep their score, and with no dates nothing changes", () => {
    const fused = [candidate(1, "a", 1 / 61), candidate(2, "b", 1 / 62), candidate(3, "c", 1 / 63)];
    expect(applyRecency(fused, new Map())).toEqual(fused);
    const dated = applyRecency(
      fused,
      new Map([
        [2, "2026-01-01"],
        [3, "2025-01-01"],
      ]),
    );
    expect(dated.find((c) => c.id === 1)?.score).toBe(1 / 61);
  });

  test("a single date, alone or shared, changes nothing", () => {
    const fused = [candidate(1, "a", 1 / 61), candidate(2, "b", 1 / 62), candidate(3, "c", 1 / 63)];
    expect(applyRecency(fused, new Map([[2, "2026-01-01"]]))).toEqual(fused);
    expect(
      applyRecency(
        fused,
        new Map([
          [2, "2026-01-01"],
          [3, "2026-01-01"],
        ]),
      ),
    ).toEqual(fused);
  });

  test("the factor moves a score by at most half the weight either way", () => {
    const fused = [candidate(1, "old", 1), candidate(2, "new", 1)];
    const scores = applyRecency(
      fused,
      new Map([
        [1, "1990-01-01"],
        [2, "2026-09-01"],
      ]),
    );
    expect(scores.find((c) => c.id === 2)?.score).toBeCloseTo(1 + RECENCY_WEIGHT / 2, 6);
    expect(scores.find((c) => c.id === 1)?.score).toBeGreaterThan(1 - RECENCY_WEIGHT / 2 - 1e-6);
  });

  test("age is measured from the newest candidate, not the clock", () => {
    const fused = [candidate(1, "a", 1), candidate(2, "b", 1)];
    const shifted = applyRecency(
      fused,
      new Map([
        [1, "1990-01-01"],
        [2, "1990-01-05"],
      ]),
    );
    expect(order(shifted)).toEqual(["b", "a"]);
    expect(shifted[0]?.score).toBeCloseTo(1 + RECENCY_WEIGHT / 2, 3);
  });

  test("end to end, equal matches come back newest first", async () => {
    const stash = await indexStash((dir) => {
      // Same text length, so equal keyword scores; the old one sorts first by name.
      writeMemory(dir, "fact-a", { observed: "2025-01-01" }, "gateway host is alpha");
      writeMemory(dir, "fact-b", { observed: "2026-09-01" }, "gateway host is bravo");
    });
    expect(hitNames(await search(stash, { query: "gateway" }))).toEqual(["fact-b", "fact-a"]);
  });
});
