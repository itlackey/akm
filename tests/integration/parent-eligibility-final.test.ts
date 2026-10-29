// Integration: opens a real search database; independently authored final cases for #1198.
import { afterEach, beforeEach, expect, test } from "bun:test";
import path from "node:path";
import { getDbPath } from "../../src/core/paths";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { searchLocal } from "../../src/indexer/search/db-search";
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
function put(bundle: string, name: string, fields: Partial<IndexDocument>, relevant = false) {
  const entry: IndexDocument = {
    name,
    type: "knowledge",
    description: relevant ? `tourmaline ${"background ".repeat(100)}` : "tourmaline tourmaline tourmaline",
    scope: { user: "alice", agent: "worker", run: "r2", channel: "review" },
    beliefState: "deprecated",
    ...fields,
  };
  const id = upsertEntry(
    db,
    path.join(storage.stashDir, bundle, `${name}.md`),
    entry,
    deriveEntryProvenance({ bundleId: bundle, componentId: bundle, adapterId: "akm" }, entry.type, name),
  );
  upsertEmbedding(db, id, relevant ? [0.6, 0.8] : [1, 0]);
}
for (const mode of ["off", "auto"] as const) {
  test(`compound eligibility crosses multiple candidate batches (${mode})`, async () => {
    for (let n = 0; n < 240; n++) {
      const fields: Partial<IndexDocument>[] = [
        { scope: { user: "alice", agent: "worker", run: "r1", channel: "review" } },
        { scope: { user: "alice", agent: "worker", run: "r2" } },
        { beliefState: "asserted" },
        { quality: "proposed" },
        { type: "memory" },
      ];
      put("selected", `noise-${n}`, fields[n % fields.length]!);
    }
    put("other", "same-name", {}, false);
    put("selected", "same-name", {}, true);
    for (const query of mode === "off" ? ["tourmaline"] : ["tourmaline", "unmatched-vector-query"]) {
      const result = await searchLocal({
        query,
        searchType: "knowledge",
        limit: 1,
        stashDir: storage.stashDir,
        sources: [{ path: path.join(storage.stashDir, "selected") }],
        restrictToSources: true,
        filters: { user: "alice", agent: "worker", run: "r2", channel: "review" },
        beliefFilter: "historical",
        config: { defaultBundle: "stash", semanticSearchMode: mode },
      });
      expect(result.hits.map((hit) => hit.ref)).toEqual(["selected//knowledge/same-name"]);
      expect(result.mode).toBe(mode === "off" ? "keyword" : "semantic");
    }
  });
}
