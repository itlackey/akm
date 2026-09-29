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
  type ContinuityHit,
  checkRetirementContinuity,
} from "../../../../src/commands/improve/consolidate/continuity-check";
import { openStateDatabase } from "../../../../src/core/state-db";
import { insertUsageEvent } from "../../../../src/indexer/usage/usage-events";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

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
 * unlisted.
 */
function fixedRanking(refs: string[]): (query: string) => Promise<ContinuityHit[]> {
  return async () => refs.slice(0, CONTINUITY_TOP_N).map((ref) => ({ ref: `stash//${ref}` }));
}

describe("checkRetirementContinuity", () => {
  test("no queries recorded for the retired asset: no check, no risk", async () => {
    let searchCalls = 0;
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      ledgerAccess: {},
      search: async () => {
        searchCalls++;
        return [];
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
      ledgerAccess: {},
      search: async () => {
        call++;
        // First call: both rank top 10 (fine). Second call: successor absent (fails).
        return call === 1
          ? [{ ref: "stash//memories/old-note" }, { ref: "stash//memories/new-note" }]
          : [{ ref: "stash//memories/old-note" }];
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
      ledgerAccess: {},
      search: async () => {
        searchCalls++;
        return [{ ref: "stash//memories/old-note" }, { ref: "stash//memories/new-note" }];
      },
    });
    expect(searchCalls).toBeLessThanOrEqual(CONTINUITY_MAX_QUERIES);
    expect(searchCalls).toBeGreaterThan(0);
  });

  test("a search failure drops that one query instead of blocking the check", async () => {
    recordQuery("memories/old-note", "query one");
    recordQuery("memories/old-note", "query two");
    let call = 0;
    const risk = await checkRetirementContinuity({
      stashDir: storage.stashDir,
      config: {} as never,
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      ledgerAccess: {},
      search: async () => {
        call++;
        if (call === 1) throw new Error("simulated search failure");
        return [{ ref: "stash//memories/old-note" }]; // second query: retired ranks, successor absent
      },
    });
    expect(call).toBe(2);
    expect(risk?.failingQueries).toBe(1);
  });
});
