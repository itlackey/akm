// Opens a real index.db and exercises both candidate channels with controlled vectors.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { type SearchLocalInput, searchLocal } from "../../src/indexer/search/db-search";
import { _setEmbedderForTests } from "../../src/llm/embedder";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { setMeta } from "../../src/storage/repositories/index-meta-repository";
import { upsertEmbedding } from "../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;
let db: Database;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
  db = openIndexDatabase(getDbPath());
  setMeta(db, "stashDir", storage.stashDir);
  overrideSeam(_setEmbedderForTests, { embed: async () => [1, 0] });
});
afterEach(() => {
  closeDatabase(db);
  storage.cleanup();
});

function put(name: string, fields: Partial<IndexDocument>, eligible: boolean, bundle = "stash", vector = true) {
  const entry: IndexDocument = {
    name,
    type: "memory",
    description: eligible ? `quartz ${"background ".repeat(60)}` : "quartz quartz quartz",
    ...fields,
  };
  const id = upsertEntry(
    db,
    path.join(storage.stashDir, bundle, `${name}.md`),
    entry,
    deriveEntryProvenance({ bundleId: bundle, componentId: bundle, adapterId: "akm" }, entry.type, name),
  );
  if (vector) upsertEmbedding(db, id, eligible ? [0.6, 0.8] : [1, 0]);
  return id;
}

function search(channel: string, options: Partial<SearchLocalInput> = {}) {
  return searchLocal({
    query: channel === "vector" ? "noexactword" : "quartz",
    searchType: "any",
    limit: 1,
    stashDir: storage.stashDir,
    sources: [{ path: storage.stashDir }],
    config: { defaultBundle: "stash", semanticSearchMode: channel === "lexical" ? "off" : "auto" },
    ...options,
  });
}

type Scenario = {
  name: string;
  rejected: Partial<IndexDocument>;
  accepted: Partial<IndexDocument>;
  options: Partial<SearchLocalInput>;
  rejectedBundle?: string;
};
const cases: Scenario[] = [
  ...(["user", "agent", "run", "channel"] as const).map((key) => ({
    name: `scope ${key}`,
    rejected: { scope: { [key]: "bob" } },
    accepted: { scope: { [key]: "alice" } },
    options: { filters: { [key]: "alice" } },
  })),
  { name: "explicit type", rejected: { type: "knowledge" }, accepted: {}, options: { searchType: "memory" } },
  { name: "default excluded type", rejected: { type: "session" }, accepted: {}, options: {} },
  { name: "proposed quality", rejected: { quality: "proposed" }, accepted: {}, options: {} },
  {
    name: "current belief",
    rejected: { beliefState: "superseded" },
    accepted: {},
    options: { beliefFilter: "current" },
  },
  {
    name: "historical belief",
    rejected: { beliefState: "asserted" },
    accepted: { beliefState: "deprecated" },
    options: { beliefFilter: "historical" },
  },
  {
    name: "source narrowing",
    rejected: {},
    accepted: {},
    rejectedBundle: "other",
    options: { restrictToSources: true },
  },
];

for (const channel of ["lexical", "vector", "combined"]) {
  describe(`${channel} eligibility before the channel depth`, () => {
    for (const scenario of cases) {
      test(scenario.name, async () => {
        for (let n = 0; n < 120; n++) put(`reject-${n}`, scenario.rejected, false, scenario.rejectedBundle);
        put("accepted", scenario.accepted, true);
        const options = { ...scenario.options };
        if (scenario.rejectedBundle) options.sources = [{ path: path.join(storage.stashDir, "stash") }];
        const result = await search(channel, options);
        expect(result.hits.map((hit) => hit.name)).toEqual(["accepted"]);
        expect(result.mode).toBe(channel === "lexical" ? "keyword" : "semantic");
      });
    }
    test("derived twins inherit the demoted base from their own bundle", async () => {
      for (let n = 0; n < 120; n++) {
        put(`reject-${n}`, { description: "base unrelated", beliefState: "archived" }, false, "stash", false);
        put(`reject-${n}.derived`, {}, false);
      }
      // Same concept in another bundle must not inherit the archived base.
      put("reject-0.derived", {}, true, "other");
      const result = await search(channel, { beliefFilter: "current" });
      expect(result.hits.map((hit) => hit.ref)).toEqual(["other//memories/reject-0.derived"]);
    });
  });
}

test("zero/multiple eligible, compound scopes, browse and prefix semantics", async () => {
  for (let n = 0; n < 120; n++) put(`reject-${n}`, { scope: { user: "bob", run: "run" } }, false);
  put("accepted-a", { scope: { user: "alice", run: "run" } }, true);
  put("accepted-b", { scope: { user: "alice", run: "run" } }, true);
  for (const query of ["quartz", "", ".", "memories/", "stash//memories/"]) {
    const result = await search("combined", { query, limit: 2, filters: { user: "alice", run: "run" } });
    expect(result.hits.map((hit) => hit.name).sort()).toEqual(["accepted-a", "accepted-b"]);
    expect((await search("combined", { query, filters: { user: "nobody" } })).hits).toEqual([]);
  }
});

test("missing embeddings and an actual failed embedding retain filtered keyword hits", async () => {
  for (let n = 0; n < 120; n++) put(`reject-${n}`, { scope: { user: "bob" } }, false, "stash", false);
  put("accepted", { scope: { user: "alice" } }, true, "stash", false);
  const options = { filters: { user: "alice" } };
  const keyword = await search("combined", options);
  expect(keyword.mode).toBe("keyword");
  expect(keyword.hits.map((hit) => hit.name)).toEqual(["accepted"]);
  put("unrelated", { description: "unrelated", scope: { user: "bob" } }, false);
  overrideSeam(_setEmbedderForTests, {
    embed: async () => {
      throw new Error("fetch failed");
    },
  });
  const fallback = await search("combined", options);
  expect(fallback.mode).toBe("fts-fallback");
  expect(fallback.hits.map((hit) => hit.name)).toEqual(["accepted"]);
  expect(fallback.warnings?.join(" ")).toContain("falling back to keyword");
});

test("explicit hidden-type/proposed opt-ins and normalized CLI scopes retain their contracts", async () => {
  for (let n = 0; n < 120; n++)
    put(`hidden-${n}`, { type: "session", quality: "proposed", scope: { user: "alice" } }, false);
  put("accepted", { scope: { user: "alice" } }, true);
  for (const channel of ["lexical", "vector", "combined"]) {
    expect((await search(channel, { includeExcludedTypes: true, includeProposed: true })).hits[0]?.type).toBe(
      "session",
    );
    expect(
      (await search(channel, { searchType: "memory", includeExcludedTypes: true, includeProposed: true })).hits[0]
        ?.name,
    ).toBe("accepted");
  }
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: {
      stash: { path: storage.stashDir },
      disabled: { path: path.join(storage.stashDir, "disabled"), enabled: false },
    },
  });
  const normalized = await akmSearch({ query: "quartz", filters: { user: " alice " }, limit: 1, skipLogging: true });
  expect(normalized.hits.map((hit) => hit.name)).toEqual(["accepted"]);
  await expect(akmSearch({ query: "quartz", source: "disabled", skipLogging: true })).rejects.toThrow(
    'Source "disabled" is disabled',
  );
});
