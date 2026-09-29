// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The retirement continuity check (0.9.17-alpha.9 plan §5.4, rule R3;
 * item 1), against a real state.db `usage_events` table and a fake `search`
 * seam — never the real `searchLocal` (no embedding provider in tests).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CONTINUITY_MAX_QUERIES,
  CONTINUITY_TOP_N,
  type ContinuitySearchResult,
  checkRetirementContinuity,
  createContinuitySearch,
} from "../../../../src/commands/improve/consolidate/continuity-check";
import type { AkmConfig } from "../../../../src/core/config/config";
import { getDbPath } from "../../../../src/core/paths";
import { openStateDatabase } from "../../../../src/core/state-db";
import { deriveEntryProvenance } from "../../../../src/indexer/installations";
import type { IndexDocument } from "../../../../src/indexer/passes/metadata";
import { insertUsageEvent } from "../../../../src/indexer/usage/usage-events";
import { _setEmbedderForTests } from "../../../../src/llm/embedder";
import type { SearchExecutionMode } from "../../../../src/sources/types";
import { closeDatabase, openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../../src/storage/repositories/index-entries-repository";
import { rebuildFts } from "../../../../src/storage/repositories/index-fts-repository";
import { setMeta } from "../../../../src/storage/repositories/index-meta-repository";
import { upsertEmbedding } from "../../../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";
import { overrideSeam } from "../../../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

/** A user `search` event that returned `ref` for `query` — what `listRetrievalQueries` reads. */
function recordQuery(ref: string, query: string): void {
  const db = openStateDatabase();
  try {
    insertUsageEvent(db, { event_type: "search", entry_ref: `stash//${ref}`, query, source: "user" });
  } finally {
    db.close();
  }
}

/**
 * A fixed ranking for every query: `refs[i]` ranks at position `i + 1`,
 * truncated to `CONTINUITY_TOP_N` — the same `limit` the real search call
 * uses, so a rank beyond it is genuinely absent from the hits, not merely
 * unlisted. `mode` defaults to "semantic" (a verified query) — pass
 * "fts-fallback" for S2's unverified-query tests.
 */
function fixedRanking(
  refs: string[],
  mode: SearchExecutionMode = "semantic",
): (query: string) => Promise<ContinuitySearchResult> {
  return async () => ({ hits: refs.slice(0, CONTINUITY_TOP_N).map((ref) => ({ ref: `stash//${ref}` })), mode });
}

describe("checkRetirementContinuity", () => {
  test("no queries recorded for the retired asset: no check, no risk", async () => {
    let searchCalls = 0;
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      retiredRaw: "old body content",
      successorRaw: "new body content",
      ledgerAccess: {},
      search: async () => {
        searchCalls++;
        return { hits: [], mode: "semantic" };
      },
    });
    expect(risk).toBeUndefined();
    expect(searchCalls).toBe(0);
  });

  test("the successor ranks top 10 everywhere the retired asset did: no risk", async () => {
    recordQuery("memories/old-note", "how do I configure X");
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      retiredRaw: "old body content",
      successorRaw: "new body content",
      ledgerAccess: {},
      search: fixedRanking(["memories/old-note", "memories/new-note"]),
    });
    expect(risk).toBeUndefined();
  });

  test("the retired asset never ranks top 10 for its own queries: nothing to protect", async () => {
    recordQuery("memories/old-note", "how do I configure X");
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      retiredRaw: "old body content",
      successorRaw: "new body content",
      ledgerAccess: {},
      // Neither side shows up — the retired asset itself isn't top 10, so a
      // missing successor is not a continuity risk here.
      search: fixedRanking(["memories/unrelated"]),
    });
    expect(risk).toBeUndefined();
  });

  test("the retired asset ranks top 10 but the successor is absent entirely: flagged", async () => {
    recordQuery("memories/old-note", "how do I configure X");
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      retiredRaw: "old body content",
      successorRaw: "new body content",
      ledgerAccess: {},
      search: fixedRanking(["memories/old-note", "memories/unrelated"]), // successor nowhere in the results
    });
    expect(risk).toEqual({
      failingQueries: 1,
      ranks: [{ query: "how do I configure X", retiredRank: 1, successorRank: null }],
    });
  });

  test("the retired asset ranks top 10 and the successor ranks below it but still outside top 10: flagged with its rank", async () => {
    recordQuery("memories/old-note", "how do I configure X");
    const others = Array.from({ length: 9 }, (_, i) => `memories/filler-${i}`);
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      retiredRaw: "old body content",
      successorRaw: "new body content",
      ledgerAccess: {},
      // old-note at #1, 9 fillers fill out the top 10, new-note at #11 (past CONTINUITY_TOP_N).
      search: fixedRanking(["memories/old-note", ...others, "memories/new-note"]),
    });
    expect(risk?.failingQueries).toBe(1);
    expect(risk?.ranks[0]?.retiredRank).toBe(1);
    expect(risk?.ranks[0]?.successorRank).toBeNull(); // rank 11 truncated away by the limit:10 search itself
  });

  test("only queries where the check actually fails are counted, not every replayed query", async () => {
    recordQuery("memories/old-note", "query one");
    recordQuery("memories/old-note", "query two");
    let call = 0;
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      retiredRaw: "old body content",
      successorRaw: "new body content",
      ledgerAccess: {},
      search: async () => {
        call++;
        // First call: both rank top 10 (fine). Second call: successor absent (fails).
        const hits =
          call === 1
            ? [{ ref: "stash//memories/old-note" }, { ref: "stash//memories/new-note" }]
            : [{ ref: "stash//memories/old-note" }];
        return { hits, mode: "semantic" as const };
      },
    });
    expect(call).toBe(2);
    expect(risk?.failingQueries).toBe(1);
  });

  test("at most CONTINUITY_MAX_QUERIES (5) queries are replayed", async () => {
    for (let i = 0; i < 7; i++) recordQuery("memories/old-note", `query ${i}`);
    let searchCalls = 0;
    await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      retiredRaw: "old body content",
      successorRaw: "new body content",
      ledgerAccess: {},
      search: async () => {
        searchCalls++;
        return { hits: [{ ref: "stash//memories/old-note" }, { ref: "stash//memories/new-note" }], mode: "semantic" };
      },
    });
    expect(searchCalls).toBeLessThanOrEqual(CONTINUITY_MAX_QUERIES);
    expect(searchCalls).toBeGreaterThan(0);
  });

  test("a search failure drops that one query from the rank comparison, but still flags as unverified (S2)", async () => {
    recordQuery("memories/old-note", "query one");
    recordQuery("memories/old-note", "query two");
    let call = 0;
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      retiredRaw: "old body content",
      successorRaw: "new body content",
      ledgerAccess: {},
      search: async () => {
        call++;
        if (call === 1) throw new Error("simulated search failure");
        // second query: retired ranks, successor absent
        return { hits: [{ ref: "stash//memories/old-note" }], mode: "semantic" };
      },
    });
    expect(call).toBe(2);
    expect(risk?.failingQueries).toBe(1);
    expect(risk?.unverifiedQueries).toBe(1);
  });

  describe("S2: unverified queries never read as no-risk-found", () => {
    test("every search throws: flagged as unverified, not undefined", async () => {
      recordQuery("memories/old-note", "query one");
      const risk = await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "old body content",
        successorRaw: "new body content",
        ledgerAccess: {},
        search: async () => {
          throw new Error("endpoint unreachable");
        },
      });
      expect(risk).toEqual({ failingQueries: 0, ranks: [], unverifiedQueries: 1 });
    });

    test("a query that falls back to keyword-only ranking is unverified, not silently trusted", async () => {
      recordQuery("memories/old-note", "query one");
      // The retired asset ranks #1 and the successor is entirely absent —
      // exactly the shape that would otherwise flag as a rank failure. S2:
      // an fts-fallback hit is never compared at all, only counted unverified.
      const risk = await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "old body content",
        successorRaw: "new body content",
        ledgerAccess: {},
        search: fixedRanking(["memories/old-note"], "fts-fallback"),
      });
      expect(risk).toEqual({ failingQueries: 0, ranks: [], unverifiedQueries: 1 });
    });

    test("a mix of a verified rank failure and an unverified query reports both", async () => {
      recordQuery("memories/old-note", "query one");
      recordQuery("memories/old-note", "query two");
      let call = 0;
      const risk = await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "old body content",
        successorRaw: "new body content",
        ledgerAccess: {},
        search: async () => {
          call++;
          if (call === 1) return { hits: [{ ref: "stash//memories/old-note" }], mode: "fts-fallback" as const };
          return { hits: [{ ref: "stash//memories/old-note" }], mode: "semantic" as const }; // verified failure
        },
      });
      expect(risk?.unverifiedQueries).toBe(1);
      expect(risk?.failingQueries).toBe(1);
      // Most-recent-first replay order: "query two" (call 1) is the
      // fts-fallback/unverified one; "query one" (call 2) is the verified failure.
      expect(risk?.ranks[0]?.query).toBe("query one");
    });
  });

  describe("S3a: replays the SAME cleaned queries the retrieval regression gate uses", () => {
    test("a harness/tool envelope query is dropped before replay, never reaches search", async () => {
      recordQuery("memories/old-note", "<task-notification>do the thing</task-notification>");
      recordQuery("memories/old-note", "a real question about X");
      const seenQueries: string[] = [];
      const risk = await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "old body content",
        successorRaw: "new body content",
        ledgerAccess: {},
        search: async (query) => {
          seenQueries.push(query);
          return { hits: [{ ref: "stash//memories/old-note" }], mode: "semantic" };
        },
      });
      expect(seenQueries).toEqual(["a real question about X"]);
      expect(risk?.failingQueries).toBe(1);
    });

    test("two queries that normalize identical (only whitespace differs) are replayed once, not twice", async () => {
      recordQuery("memories/old-note", "how do I configure X");
      recordQuery("memories/old-note", "how   do I configure X  "); // same after whitespace collapse
      let searchCalls = 0;
      await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "old body content",
        successorRaw: "new body content",
        ledgerAccess: {},
        search: async () => {
          searchCalls++;
          return { hits: [{ ref: "stash//memories/old-note" }], mode: "semantic" };
        },
      });
      expect(searchCalls).toBe(1);
    });

    test("a paste over 2,000 characters is dropped, not replayed as a query", async () => {
      recordQuery("memories/old-note", "x".repeat(2001));
      recordQuery("memories/old-note", "a real question about X");
      const seenQueries: string[] = [];
      await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "old body content",
        successorRaw: "new body content",
        ledgerAccess: {},
        search: async (query) => {
          seenQueries.push(query);
          return { hits: [], mode: "semantic" };
        },
      });
      expect(seenQueries).toEqual(["a real question about X"]);
    });
  });

  describe("S3b: identical bodies skip the check entirely — search's own dedupe already hides the successor", () => {
    test("byte-identical bodies: no check at all, even though the retired asset ranks and the successor would be absent", async () => {
      recordQuery("memories/old-note", "how do I configure X");
      let searchCalls = 0;
      const risk = await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "---\ndescription: old\n---\n\nSame body.\n",
        successorRaw: "---\ndescription: new\n---\n\nSame body.\n",
        ledgerAccess: {},
        search: async () => {
          searchCalls++;
          return { hits: [{ ref: "stash//memories/old-note" }], mode: "semantic" }; // would otherwise flag
        },
      });
      expect(risk).toBeUndefined();
      expect(searchCalls).toBe(0); // never even replayed a query
    });

    test("bodies that normalize identical (only whitespace differs) also skip", async () => {
      recordQuery("memories/old-note", "how do I configure X");
      const risk = await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "---\ndescription: old\n---\n\nSame   body.\n\n\nMore text.\n",
        successorRaw: "---\ndescription: new\n---\n\nSame body. More text.\n",
        ledgerAccess: {},
        search: async () => ({ hits: [{ ref: "stash//memories/old-note" }], mode: "semantic" }),
      });
      expect(risk).toBeUndefined();
    });

    test("genuinely different bodies still run the check normally", async () => {
      recordQuery("memories/old-note", "how do I configure X");
      const risk = await checkRetirementContinuity({
        stashDir: storage.stashDir,
        config: {} as never,
        retiredRef: "memories/old-note",
        successorRef: "memories/new-note",
        retiredRaw: "---\ndescription: old\n---\n\nOld body.\n",
        successorRaw: "---\ndescription: new\n---\n\nCompletely different body.\n",
        ledgerAccess: {},
        search: fixedRanking(["memories/old-note"]), // successor absent
      });
      expect(risk?.failingQueries).toBe(1);
    });
  });
});

describe("createContinuitySearch: keyword-only throttle after the first fallback (S2)", () => {
  test("once a query falls back to keyword-only, every later call through the SAME instance skips the semantic attempt entirely", async () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      embedding: { endpoint: "http://127.0.0.1:1/v1", model: "test-model" },
    } as AkmConfig;

    const db = openIndexDatabase(getDbPath());
    try {
      const entryId = upsertEntry(
        db,
        `${storage.stashDir}/knowledge/deploy-guide.md`,
        { type: "knowledge", name: "deploy-guide", description: "deploy applications safely" } as IndexDocument,
        deriveEntryProvenance(
          { bundleId: "stash", componentId: "stash", adapterId: "akm" },
          "knowledge",
          "deploy-guide",
        ),
      );
      upsertEmbedding(db, entryId, [1, 0, 0, 0]);
      rebuildFts(db);
      setMeta(db, "hasEmbeddings", "1");
      setMeta(db, "stashDir", storage.stashDir);
    } finally {
      closeDatabase(db);
    }

    let embedCalls = 0;
    overrideSeam(_setEmbedderForTests, {
      embed: async () => {
        embedCalls++;
        // Every call would fail if attempted — proves the throttle is what
        // stops the second/third attempt, not a lucky success.
        throw Object.assign(new TypeError("connection refused"), { code: "ECONNREFUSED" });
      },
    });

    const search = createContinuitySearch(storage.stashDir, config);

    const first = await search("deploy");
    expect(first.mode).toBe("fts-fallback");
    expect(embedCalls).toBe(1);

    const second = await search("deploy");
    expect(second.mode).toBe("keyword"); // forced semanticSearchMode: "off" — not another fallback
    expect(embedCalls).toBe(1); // the embedder was never called again

    const third = await search("deploy");
    expect(third.mode).toBe("keyword");
    expect(embedCalls).toBe(1);
  });

  test("a clean run (no fallback) never forces keyword-only", async () => {
    const config: AkmConfig = { semanticSearchMode: "off" } as AkmConfig;
    const db = openIndexDatabase(getDbPath());
    try {
      upsertEntry(
        db,
        `${storage.stashDir}/knowledge/deploy-guide.md`,
        { type: "knowledge", name: "deploy-guide", description: "deploy applications safely" } as IndexDocument,
        deriveEntryProvenance(
          { bundleId: "stash", componentId: "stash", adapterId: "akm" },
          "knowledge",
          "deploy-guide",
        ),
      );
      rebuildFts(db);
      setMeta(db, "stashDir", storage.stashDir);
    } finally {
      closeDatabase(db);
    }

    const search = createContinuitySearch(storage.stashDir, config);
    const first = await search("deploy");
    const second = await search("deploy");
    expect(first.mode).toBe("keyword");
    expect(second.mode).toBe("keyword");
  });
});
