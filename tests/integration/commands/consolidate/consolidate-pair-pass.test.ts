// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The consolidate pair pass end-to-end (0.9.17-alpha.9): a real index.db
 * with crafted unit-vector embeddings (so cosine similarity is exact and
 * deterministic, the same technique consolidate-incremental.test.ts uses for
 * `getNeighborsByEntryId`), a fake judge via the `chat` test seam
 * (`CallStructuredRequest["chat"]`, "transport override for tests"), and the
 * real proposal/ledger repositories.
 *
 * None of the `IsolatedAkmStorage` sandboxes below has a `.git` directory, so
 * `loadGitFirstAddedMap` always returns `undefined` for them and every
 * asset's "created" date falls back to its file mtime (B1) — tests that need
 * a specific older/newer ordering set mtimes explicitly with `dateAsset`,
 * since frontmatter `createdAt` is no longer read for this at all. The final
 * describe block below is the one exception: it drives `loadGitFirstAddedMap`
 * against a real, disposable git repo to pin a real regression.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConsolidateOptions } from "../../../../src/commands/improve/consolidate";
import {
  BACKFILL_FLOOR,
  NEW_MATERIAL_DAYS,
  type PairJudgeChat,
  runConsolidatePairPass,
  selectCandidates,
  selectInitiators,
  T_PAIR,
} from "../../../../src/commands/improve/consolidate/pair-pass";
import { contentHash } from "../../../../src/commands/improve/content-hash";
import { getProposal, listProposals } from "../../../../src/commands/proposal/repository";
import { getDbPath } from "../../../../src/core/paths";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { IndexDocument } from "../../../../src/indexer/passes/metadata";
import { insertUsageEvent } from "../../../../src/indexer/usage/usage-events";
import {
  getImproveLedgerRow,
  recordImproveLedger,
} from "../../../../src/storage/repositories/improve-ledger-repository";
import { closeDatabase, openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../../src/storage/repositories/index-entries-repository";
import { upsertEmbedding } from "../../../../src/storage/repositories/index-vec-repository";
import { testLlmRunner } from "../../../_helpers/llm-runner";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  for (const dir of ["memories", "knowledge", "lessons"]) {
    fs.mkdirSync(path.join(storage.stashDir, dir), { recursive: true });
  }
});

afterEach(() => {
  storage.cleanup();
});

/** A unit vector at `deg` degrees from 0° — cos(deg) is the exact cosine to the 0° vector. */
function vecAtAngle(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), 0, 0];
}
const angleForCosine = (cosine: number): number => (Math.acos(cosine) * 180) / Math.PI;
const MS_PER_DAY = 86_400_000;

function writeAsset(relPath: string, frontmatter: string, body = "Body text.\n"): string {
  const filePath = path.join(storage.stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
  return filePath;
}

/** Sets a file's mtime (B1: "created" falls back to mtime with no git) — `daysAgo` may be fractional. */
function dateAsset(filePath: string, daysAgo: number): void {
  const at = new Date(Date.now() - daysAgo * MS_PER_DAY);
  fs.utimesSync(filePath, at, at);
}

/** Index one asset + its embedding, matching how the real indexer would (bundleId "stash"). */
function indexAsset(
  db: ReturnType<typeof openIndexDatabase>,
  type: string,
  name: string,
  filePath: string,
  angleDeg: number,
): number {
  const entry: IndexDocument = { type, name, description: `desc for ${name}` };
  const id = upsertEntry(db, filePath, entry, {
    bundleId: "stash",
    componentId: "stash",
    adapterId: "akm",
    conceptId: `${type === "memory" ? "memories" : type === "knowledge" ? "knowledge" : "lessons"}/${name}`,
    itemRef: `stash//${type === "memory" ? "memories" : type === "knowledge" ? "knowledge" : "lessons"}/${name}`,
  });
  upsertEmbedding(db, id, vecAtAngle(angleDeg));
  return id;
}

function baseOpts(): AkmConsolidateOptions {
  return {
    writeTarget: {
      source: { kind: "filesystem", name: "stash", path: storage.stashDir, adapterId: "akm" },
      config: { type: "filesystem", name: "stash", path: storage.stashDir, writable: true },
    },
    llmRunner: testLlmRunner({ endpoint: "http://localhost/v1/chat/completions", model: "test", concurrency: 1 }),
    sourceRun: "consolidate-pair-test",
  } as AkmConsolidateOptions;
}

/** A canned judge: returns a fixed verdict for every call, regardless of the prompt. */
function fixedChat(verdict: {
  relation: string;
  redundant: "A" | "B" | null;
  confidence?: number;
  reason?: string;
}): PairJudgeChat {
  return async () =>
    JSON.stringify({
      relation: verdict.relation,
      redundant: verdict.redundant,
      stale: null,
      confidence: verdict.confidence ?? 0.9,
      reason: verdict.reason ?? "test reason",
    });
}

describe("selectInitiators / selectCandidates — threshold math against a real index", () => {
  test("a backlog initiator (never attempted, not new material) needs >= BACKFILL_FLOOR (0.95); T_PAIR (0.93) alone is not enough", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old note");
    dateAsset(oldPath, NEW_MATERIAL_DAYS + 1); // outside the new-material window, so backlog really uses BACKFILL_FLOOR
    writeAsset("memories/mid-note.md", "description: just under the backfill floor");
    writeAsset("memories/close-note.md", "description: past the backfill floor");
    const db = openIndexDatabase(getDbPath());
    let oldId: number;
    try {
      oldId = indexAsset(db, "memory", "old-note", oldPath, 0);
      // T_PAIR < cosine < BACKFILL_FLOOR: excluded for a backlog initiator.
      indexAsset(
        db,
        "memory",
        "mid-note",
        path.join(storage.stashDir, "memories/mid-note.md"),
        angleForCosine(T_PAIR + 0.01) /* between T_PAIR and BACKFILL_FLOOR */,
      );
      // >= BACKFILL_FLOOR: included.
      indexAsset(
        db,
        "memory",
        "close-note",
        path.join(storage.stashDir, "memories/close-note.md"),
        angleForCosine(BACKFILL_FLOOR + 0.02) /* clearly above BACKFILL_FLOOR */,
      );
    } finally {
      closeDatabase(db);
    }

    const opts = baseOpts();
    const { initiators } = selectInitiators(
      [{ ref: "memories/old-note", type: "memory", name: "old-note", filePath: oldPath, entryId: oldId }],
      opts,
      storage.stashDir,
      undefined,
    );
    expect(initiators).toHaveLength(1);
    expect(initiators[0]?.backlog).toBe(true);
    expect(initiators[0]?.newMaterial).toBe(false);

    const db2 = openIndexDatabase(getDbPath());
    let candidates: ReturnType<typeof selectCandidates>;
    try {
      candidates = selectCandidates(db2, initiators, "stash");
    } finally {
      closeDatabase(db2);
    }
    expect(candidates.map((c) => c.other.name)).toEqual(["close-note"]);
  });

  test("a backlog initiator git/mtime-dated within NEW_MATERIAL_DAYS is new material: T_PAIR (0.93) is enough, not just BACKFILL_FLOOR", () => {
    const newPath = writeAsset("memories/new-note.md", "description: new note"); // fresh mtime — within the window
    writeAsset("memories/mid-note.md", "description: between T_PAIR and BACKFILL_FLOOR");
    const db = openIndexDatabase(getDbPath());
    let newId: number;
    try {
      newId = indexAsset(db, "memory", "new-note", newPath, 0);
      indexAsset(
        db,
        "memory",
        "mid-note",
        path.join(storage.stashDir, "memories/mid-note.md"),
        angleForCosine(T_PAIR + 0.01),
      );
    } finally {
      closeDatabase(db);
    }

    const opts = baseOpts();
    const { initiators } = selectInitiators(
      [{ ref: "memories/new-note", type: "memory", name: "new-note", filePath: newPath, entryId: newId }],
      opts,
      storage.stashDir,
      undefined,
    );
    expect(initiators[0]?.backlog).toBe(true);
    expect(initiators[0]?.newMaterial).toBe(true);
    const db2 = openIndexDatabase(getDbPath());
    let candidates: ReturnType<typeof selectCandidates>;
    try {
      candidates = selectCandidates(db2, initiators, "stash");
    } finally {
      closeDatabase(db2);
    }
    expect(candidates.map((c) => c.other.name)).toEqual(["mid-note"]);
  });

  test("an initiator with a prior attempt whose content has since changed uses the lower T_PAIR (0.93) floor", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old note");
    const midPath = writeAsset("memories/mid-note.md", "description: between T_PAIR and BACKFILL_FLOOR");
    // Seed a ledger row recording a DIFFERENT content hash than the file's
    // current body — S1: eligibility (and hence "not backlog") is decided by
    // that mismatch, not by a time window.
    const stateDb = openStateDatabase();
    try {
      recordImproveLedger(stateDb, {
        stashDir: storage.stashDir,
        ref: "memories/old-note",
        source: "consolidate-pair",
        outcome: "judged_no_action",
        at: new Date(Date.now() - 10 * MS_PER_DAY).toISOString(),
        contentHash: "hash-before-the-edit",
      });
      // A ledger row alone puts the ref outside the retrieval scope (isInRetrievalScope
      // treats any non-capture ledger row as "already processed" — it needs a fresh
      // retrieval, not just a file edit, to stay eligible). Seed that retrieval.
      insertUsageEvent(stateDb, { event_type: "search", entry_ref: "stash//memories/old-note", source: "user" });
    } finally {
      stateDb.close();
    }

    const db = openIndexDatabase(getDbPath());
    let oldId: number;
    try {
      oldId = indexAsset(db, "memory", "old-note", oldPath, 0);
      indexAsset(
        db,
        "memory",
        "mid-note",
        midPath,
        angleForCosine(T_PAIR + 0.01) /* between T_PAIR and BACKFILL_FLOOR */,
      ); // between T_PAIR and BACKFILL_FLOOR
    } finally {
      closeDatabase(db);
    }

    const opts = baseOpts();
    const { initiators } = selectInitiators(
      [{ ref: "memories/old-note", type: "memory", name: "old-note", filePath: oldPath, entryId: oldId }],
      opts,
      storage.stashDir,
      undefined,
    );
    expect(initiators).toHaveLength(1); // eligible: the row's hash no longer matches
    expect(initiators[0]?.backlog).toBe(false); // it DID have a prior row
    const db2 = openIndexDatabase(getDbPath());
    let candidates: ReturnType<typeof selectCandidates>;
    try {
      candidates = selectCandidates(db2, initiators, "stash");
    } finally {
      closeDatabase(db2);
    }
    // 0.94 clears T_PAIR (0.93) even though it misses BACKFILL_FLOOR (0.95).
    expect(candidates.map((c) => c.other.name)).toEqual(["mid-note"]);
  });

  test("an initiator with a prior attempt whose content is UNCHANGED is not eligible (S1: no timer, content only)", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old note");
    const raw = fs.readFileSync(oldPath, "utf8");
    const stateDb = openStateDatabase();
    try {
      recordImproveLedger(stateDb, {
        stashDir: storage.stashDir,
        ref: "memories/old-note",
        source: "consolidate-pair",
        outcome: "judged_no_action",
        at: new Date(Date.now() - 10 * MS_PER_DAY).toISOString(),
        contentHash: contentHash(raw, "body"),
      });
      insertUsageEvent(stateDb, { event_type: "search", entry_ref: "stash//memories/old-note", source: "user" });
    } finally {
      stateDb.close();
    }
    const db = openIndexDatabase(getDbPath());
    let oldId: number;
    try {
      oldId = indexAsset(db, "memory", "old-note", oldPath, 0);
    } finally {
      closeDatabase(db);
    }
    const { initiators } = selectInitiators(
      [{ ref: "memories/old-note", type: "memory", name: "old-note", filePath: oldPath, entryId: oldId }],
      baseOpts(),
      storage.stashDir,
      undefined,
    );
    expect(initiators).toHaveLength(0);
  });

  test("S2: fetches 20 raw neighbours and keeps the first 5 that pass every filter, not just the raw top 5", () => {
    const initiatorPath = writeAsset("memories/initiator.md", "description: initiator");
    dateAsset(initiatorPath, 60);
    const db = openIndexDatabase(getDbPath());
    let initiatorId: number;
    try {
      initiatorId = indexAsset(db, "memory", "initiator", initiatorPath, 0);
      // The 3 NEAREST neighbours all fail the bundle filter — a different
      // bundleId, same index — so with the old k=5 raw fetch, only 2 raw
      // slots would ever reach a same-bundle candidate.
      for (let i = 0; i < 3; i++) {
        const noisePath = writeAsset(`memories/noise-${i}.md`, `description: noise ${i}`);
        const entry: IndexDocument = { type: "memory", name: `noise-${i}`, description: `noise ${i}` };
        const id = upsertEntry(db, noisePath, entry, {
          bundleId: "other-bundle",
          componentId: "other-bundle",
          adapterId: "akm",
          conceptId: `memories/noise-${i}`,
          itemRef: `other-bundle//memories/noise-${i}`,
        });
        upsertEmbedding(db, id, vecAtAngle(1 + i)); // closer than every real candidate below
      }
      // 5 real same-bundle candidates, all comfortably above BACKFILL_FLOOR
      // (tiny angle steps keep every one of them there), but FARTHER than
      // the 3 noise hits above (so they only surface once the fetch window
      // is wide enough to look past the noise).
      for (let i = 0; i < 5; i++) {
        const realPath = writeAsset(`memories/real-${i}.md`, `description: real ${i}`);
        indexAsset(db, "memory", `real-${i}`, realPath, angleForCosine(BACKFILL_FLOOR + 0.03) + i * 0.2);
      }
    } finally {
      closeDatabase(db);
    }
    const { initiators } = selectInitiators(
      [{ ref: "memories/initiator", type: "memory", name: "initiator", filePath: initiatorPath, entryId: initiatorId }],
      baseOpts(),
      storage.stashDir,
      undefined,
    );
    const db2 = openIndexDatabase(getDbPath());
    let candidates: ReturnType<typeof selectCandidates>;
    try {
      candidates = selectCandidates(db2, initiators, "stash");
    } finally {
      closeDatabase(db2);
    }
    expect(candidates).toHaveLength(5); // all 5 real candidates, none of the cross-bundle noise
    expect(candidates.every((c) => c.other.name.startsWith("real-"))).toBe(true);
  });
});

describe("runConsolidatePairPass — end-to-end with a fake judge", () => {
  test("duplicate: mints a retire proposal for the older side, with the full retirement metadata", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old");
    dateAsset(oldPath, 60);
    const newPath = writeAsset("memories/new-note.md", "description: new");
    dateAsset(newPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "old-note", oldPath, 0);
      indexAsset(
        db,
        "memory",
        "new-note",
        newPath,
        angleForCosine(BACKFILL_FLOOR + 0.02) /* clearly above BACKFILL_FLOOR */,
      );
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });

    expect(result.initiators).toBe(2); // both old-note and new-note qualify as initiators
    expect(result.labelCounts.duplicate).toBeGreaterThanOrEqual(1);
    expect(result.retired).toHaveLength(1);

    const proposal = getProposal(storage.stashDir, result.retired[0]!);
    expect(proposal.ref).toBe("stash//memories/old-note");
    expect(proposal.changes).toEqual([{ path: "memories/old-note.md", op: "delete" }]);
    // S6: its own generator, kept apart from the promote pass's "consolidate" proposals.
    expect(proposal.source).toBe("consolidate-pair");
    expect(proposal.retirement).toMatchObject({
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      judgeLabel: "duplicate",
      reason: "duplicate",
    });
    expect(proposal.retirement?.cosine).toBeGreaterThan(0.96);
    // Item 1: no recorded query for old-note means no continuity check ran.
    expect(proposal.retirement?.continuityRisk).toBeUndefined();

    // Ledger: consolidate-pair source, distinguishable from the promote pass's own "consolidate" rows.
    const stateDb = openStateDatabase();
    try {
      const row = getImproveLedgerRow(stateDb, storage.stashDir, "memories/old-note", "consolidate-pair");
      expect(row?.outcome).toBe("proposed");
      expect(row?.nextEligibleAt).toBeNull();
      expect(typeof row?.contentHash).toBe("string");
    } finally {
      stateDb.close();
    }
  });

  test("item 1: a continuity-risk pair still mints, with the risk on its retirement metadata", async () => {
    // Distinct bodies (S3b gives an identical pair no check at all — this
    // test is about the rank-based flag, so the two sides must differ).
    const oldPath = writeAsset("memories/old-note.md", "description: old", "Old body text.\n");
    dateAsset(oldPath, 60);
    const newPath = writeAsset("memories/new-note.md", "description: new", "New body text.\n");
    dateAsset(newPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "old-note", oldPath, 0);
      indexAsset(db, "memory", "new-note", newPath, angleForCosine(BACKFILL_FLOOR + 0.02));
    } finally {
      closeDatabase(db);
    }
    // A past user query that returned old-note — the continuity check's own
    // input (listRetrievalQueries). Without this, there is nothing to replay
    // and no check runs at all (see the plain "duplicate" test above, which
    // records no queries and mints with no continuityRisk field).
    const stateDb = openStateDatabase();
    try {
      insertUsageEvent(stateDb, {
        event_type: "search",
        entry_ref: "stash//memories/old-note",
        query: "how do I do X",
        source: "user",
      });
    } finally {
      stateDb.close();
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
      // old-note ranks #1 for its own past query; new-note never shows up —
      // a real continuity failure.
      continuitySearch: async () => ({ hits: [{ ref: "stash//memories/old-note" }], mode: "semantic" }),
    });

    expect(result.retired).toHaveLength(1); // flagged, but still minted — never blocked
    const proposal = getProposal(storage.stashDir, result.retired[0]!);
    expect(proposal.retirement?.continuityRisk).toEqual({
      failingQueries: 1,
      ranks: [{ query: "how do I do X", retiredRank: 1, successorRank: null }],
    });
  });

  test("never mints two retire proposals for the same asset in one run, and a just-used successor cannot itself be retired in the same run (B2 chain guard)", async () => {
    // A is the nearest neighbour of both B and C, and all three are mutually
    // close enough to pair up — three candidate pairs total: {A,B}, {B,C},
    // {A,C}. A "duplicate" judge on every pair would naively retire A twice
    // (once via each of its two pairs), and would retire B into C right
    // after A was retired into B, forming an A->B->C chain in one run.
    const aPath = writeAsset("memories/a-note.md", "description: a");
    dateAsset(aPath, 80);
    const bPath = writeAsset("memories/b-note.md", "description: b");
    dateAsset(bPath, 60);
    const cPath = writeAsset("memories/c-note.md", "description: c");
    dateAsset(cPath, 40);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "a-note", aPath, 0);
      indexAsset(db, "memory", "b-note", bPath, 3); // cosine(A,B) = cos(3deg), highest -> judged first
      indexAsset(db, "memory", "c-note", cPath, 7); // cosine(A,C) = cos(7deg), lowest -> judged last
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });

    expect(result.labelCounts.duplicate).toBe(3); // all three pairs were judged
    // Pair {A,B} (highest cosine, judged first) retires A, keeping B — and
    // spends B as a successor for this run. Pair {B,C} would retire B
    // (older of the two) into C, but B was already spent, so it is skipped.
    // Pair {A,C} would retire A again, also already spent.
    expect(result.retired).toHaveLength(1);
    const retiredRefs = result.retired.map((id) => getProposal(storage.stashDir, id).ref).sort();
    expect(retiredRefs).toEqual(["stash//memories/a-note"]);
    expect(fs.existsSync(bPath)).toBe(true);
    expect(fs.existsSync(cPath)).toBe(true);
    // No two pending proposals target the same ref.
    const refs = listProposals(storage.stashDir).map((p) => p.ref);
    expect(new Set(refs).size).toBe(refs.length);

    // Must-fix 1 (third review round): {B,C} was a genuine "duplicate"
    // verdict, dropped only because the chain guard had already spent B this
    // run — not a settled "no action". b-note gets no ledger row for it.
    const stateDb = openStateDatabase();
    try {
      expect(getImproveLedgerRow(stateDb, storage.stashDir, "memories/b-note", "consolidate-pair")).toBeUndefined();
    } finally {
      stateDb.close();
    }

    // Accept the single proposal (a-note archived), then run again: the two
    // survivors (b-note, c-note) are judged again instead of being treated
    // as already settled.
    const { akmProposalAccept } = await import("../../../../src/commands/proposal/proposal");
    const { makeConfig } = await import("../../../_helpers/factories");
    await akmProposalAccept({
      stashDir: storage.stashDir,
      id: result.retired[0]!,
      config: makeConfig(storage.stashDir),
    });

    let chatCalls2 = 0;
    const result2 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async (...args) => {
        chatCalls2++;
        return fixedChat({ relation: "duplicate", redundant: null })(...args);
      },
    });
    expect(chatCalls2).toBe(1); // the {B,C} pair, judged for the first time
    expect(result2.retired).toHaveLength(1);
    const retiredRefs2 = result2.retired.map((id) => getProposal(storage.stashDir, id).ref);
    expect(retiredRefs2).toEqual(["stash//memories/b-note"]); // b (older of the two survivors) retires into c
  });

  test("contradicts: counted, no proposal, no belief write", async () => {
    const oldPath = writeAsset("memories/claim-a.md", "description: claim a");
    dateAsset(oldPath, 60);
    const newPath = writeAsset("memories/claim-b.md", "description: claim b");
    dateAsset(newPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "claim-a", oldPath, 0);
      indexAsset(db, "memory", "claim-b", newPath, angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "contradicts", redundant: null }),
    });

    expect(result.labelCounts.contradicts).toBeGreaterThanOrEqual(1);
    expect(result.retired).toHaveLength(0);
    expect(listProposals(storage.stashDir)).toHaveLength(0);
    const claimAContent = fs.readFileSync(oldPath, "utf8");
    expect(claimAContent).not.toContain("supersededBy");
    expect(claimAContent).not.toContain("beliefState");
  });

  test("subsumed: retires the side the judge names redundant", async () => {
    const smallPath = writeAsset("memories/small-note.md", "description: small");
    dateAsset(smallPath, 60);
    const bigPath = writeAsset("memories/big-note.md", "description: big, contains everything small has plus more");
    dateAsset(bigPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "small-note", smallPath, 0);
      indexAsset(db, "memory", "big-note", bigPath, angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    // redundant: "A" — A is the older side by created date (small-note).
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "subsumed", redundant: "A" }),
    });
    expect(result.retired).toHaveLength(1);
    const proposal = getProposal(storage.stashDir, result.retired[0]!);
    expect(proposal.ref).toBe("stash//memories/small-note");
    expect(proposal.retirement?.reason).toBe("subsumed");
  });

  test("never retires a captureMode: hot memory — the pair is left alone", async () => {
    const hotPath = writeAsset("memories/hot-note.md", "description: hot\ncaptureMode: hot");
    dateAsset(hotPath, 60);
    const plainPath = writeAsset("memories/plain-note.md", "description: plain");
    dateAsset(plainPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "hot-note", hotPath, 0);
      indexAsset(db, "memory", "plain-note", plainPath, angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      // duplicate would normally retire the older (hot) side.
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });
    expect(result.retired).toHaveLength(0);
    expect(listProposals(storage.stashDir)).toHaveLength(0);
  });

  test("never retires a .derived memory whose parent still exists", async () => {
    writeAsset("memories/parent.md", "description: parent memory");
    const derivedPath = writeAsset(
      "memories/parent.derived.md",
      "inferred: true\nsource: memories/parent\ndescription: derived",
    );
    dateAsset(derivedPath, 60);
    const otherPath = writeAsset("memories/other-note.md", "description: another note");
    dateAsset(otherPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "parent.derived", derivedPath, 0);
      indexAsset(db, "memory", "other-note", otherPath, angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });
    expect(result.retired).toHaveLength(0);
  });

  test("never retires a SUBFOLDER .derived memory whose parent still exists (S3: no doubled subfolder segment)", async () => {
    writeAsset("memories/sub/foo.md", "description: parent memory in a subfolder");
    const derivedPath = writeAsset(
      "memories/sub/foo.derived.md",
      "inferred: true\nsource: memories/sub/foo\ndescription: derived",
    );
    dateAsset(derivedPath, 60);
    const otherPath = writeAsset("memories/other-note.md", "description: another note");
    dateAsset(otherPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "sub/foo.derived", derivedPath, 0);
      indexAsset(db, "memory", "other-note", otherPath, angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });
    expect(result.retired).toHaveLength(0);
  });

  test("skips a pair when either side already has a pending retire proposal, as the retired ref OR its successor (B2)", async () => {
    const { createRetireProposal } = await import("../../../../src/commands/proposal/repository");
    const oldPath = writeAsset("memories/old-note.md", "description: old");
    dateAsset(oldPath, 60);
    const newPath = writeAsset("memories/new-note.md", "description: new");
    dateAsset(newPath, 1);
    writeAsset("memories/someone-else.md", "description: someone else, unrelated");
    createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate-pair",
      target: { source: "stash", root: storage.stashDir },
      retirement: {
        retiredRef: "memories/old-note",
        successorRef: "memories/someone-else",
        cosine: 0.99,
        judgeLabel: "duplicate",
        judgeReason: "already queued",
        retiredContentHash: "a".repeat(64),
        successorContentHash: "b".repeat(64),
        reason: "duplicate",
      },
    });

    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "old-note", oldPath, 0);
      indexAsset(db, "memory", "new-note", newPath, angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }

    let chatCalls = 0;
    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async () => {
        chatCalls++;
        return JSON.stringify({ relation: "duplicate", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(chatCalls).toBe(0);
    expect(result.pairsJudged).toBe(0);
    // The pre-existing proposal is still the only one.
    expect(listProposals(storage.stashDir)).toHaveLength(1);
    // S1: neither initiator got all of its candidates judged (both were
    // skipped by the pending-proposal filter), so neither gets a ledger row.
    const stateDb = openStateDatabase();
    try {
      expect(getImproveLedgerRow(stateDb, storage.stashDir, "memories/old-note", "consolidate-pair")).toBeUndefined();
      expect(getImproveLedgerRow(stateDb, storage.stashDir, "memories/new-note", "consolidate-pair")).toBeUndefined();
    } finally {
      stateDb.close();
    }
  });

  test("a dry run judges pairs and previews retirements without minting proposals or writing the ledger", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old");
    dateAsset(oldPath, 60);
    const newPath = writeAsset("memories/new-note.md", "description: new");
    dateAsset(newPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "old-note", oldPath, 0);
      indexAsset(
        db,
        "memory",
        "new-note",
        newPath,
        angleForCosine(BACKFILL_FLOOR + 0.02) /* clearly above BACKFILL_FLOOR */,
      );
    } finally {
      closeDatabase(db);
    }

    const opts = { ...baseOpts(), dryRun: true };
    const warnings: string[] = [];
    const result = await runConsolidatePairPass(opts, {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });
    expect(result.retired).toEqual(["memories/old-note -> memories/new-note"]);
    expect(listProposals(storage.stashDir)).toHaveLength(0);
    const stateDb = openStateDatabase();
    try {
      expect(getImproveLedgerRow(stateDb, storage.stashDir, "memories/old-note", "consolidate-pair")).toBeUndefined();
    } finally {
      stateDb.close();
    }
  });

  test("an initiator with no candidates still gets a ledger row (S1), so it is not rescanned every night", async () => {
    const lonelyPath = writeAsset("memories/lonely.md", "description: lonely");
    const farPath = writeAsset("memories/far.md", "description: far");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "lonely", lonelyPath, 0);
      indexAsset(db, "memory", "far", farPath, 40); // cosine ~0.77: never a candidate at either threshold
    } finally {
      closeDatabase(db);
    }
    let chatCalls = 0;
    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async () => {
        chatCalls++;
        return JSON.stringify({ relation: "unrelated", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(chatCalls).toBe(0); // no candidates at all — nothing to judge
    expect(result.initiators).toBe(2);
    const stateDb = openStateDatabase();
    try {
      const lonelyRow = getImproveLedgerRow(stateDb, storage.stashDir, "memories/lonely", "consolidate-pair");
      expect(lonelyRow?.outcome).toBe("judged_no_action");
      expect(typeof lonelyRow?.contentHash).toBe("string");
      expect(getImproveLedgerRow(stateDb, storage.stashDir, "memories/far", "consolidate-pair")?.outcome).toBe(
        "judged_no_action",
      );
    } finally {
      stateDb.close();
    }

    // Seed the retrieval-scope signal a ledger row requires, then run again unchanged: no candidates, still no judge call.
    const stateDb2 = openStateDatabase();
    try {
      insertUsageEvent(stateDb2, { event_type: "search", entry_ref: "stash//memories/lonely", source: "user" });
    } finally {
      stateDb2.close();
    }
    const result2 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async () => {
        chatCalls++;
        return JSON.stringify({ relation: "unrelated", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(result2.initiators).toBe(0); // unchanged content: not eligible again
    expect(chatCalls).toBe(0);
  });

  test("a rejected retire proposal is not re-proposed once the initiator's content is unchanged (S1: no timer)", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old");
    dateAsset(oldPath, 60);
    const newPath = writeAsset("memories/new-note.md", "description: new");
    dateAsset(newPath, 1);
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "old-note", oldPath, 0);
      indexAsset(db, "memory", "new-note", newPath, angleForCosine(BACKFILL_FLOOR + 0.02));
    } finally {
      closeDatabase(db);
    }
    const warnings: string[] = [];
    const r1 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });
    expect(r1.retired).toHaveLength(1);
    const { akmProposalReject } = await import("../../../../src/commands/proposal/proposal");
    const { makeConfig } = await import("../../../_helpers/factories");
    await akmProposalReject({
      stashDir: storage.stashDir,
      id: r1.retired[0]!,
      reason: "owner says keep both",
      config: makeConfig(storage.stashDir),
    });

    // The rejected proposal's OWN row still keeps old-note "processed"
    // (Blocker 1 exempts only the pair pass's ledger source — a minted
    // proposal, rejected or not, remains real evidence something happened to
    // the asset). Seed a retrieval so scope isn't what keeps r2 quiet:
    // without this, r2 would pass for the same wrong reason Blocker 1 fixed
    // for the ledger row (a residual scope exclusion), just via the
    // surviving proposal row instead, and would never actually exercise the
    // content-hash rule this test is named for.
    const stateDb = openStateDatabase();
    try {
      insertUsageEvent(stateDb, { event_type: "search", entry_ref: "stash//memories/old-note", source: "user" });
    } finally {
      stateDb.close();
    }

    let chatCalls = 0;
    const r2 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async () => {
        chatCalls++;
        return JSON.stringify({ relation: "duplicate", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(chatCalls).toBe(0); // old-note's content never changed since it was judged — not eligible again
    expect(r2.retired).toHaveLength(0);

    // Prove it really is the hash and not some other residual effect: edit
    // old-note's own content (it stays in scope via the usage event above)
    // and the pair becomes eligible again.
    writeAsset("memories/old-note.md", "description: old", "Body text, edited.\n");
    const r3 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });
    expect(r3.retired).toHaveLength(1); // content changed since the last attempt: judged again, and re-proposed
  });

  test("item 0: a rejected pair stays rejected even when a sibling verdict drops the initiator's own ledger row", async () => {
    // I is the initiator both Y and Z pair against — indexed first, so it
    // claims both pairs (same "claims every pair it's nearest to" setup as
    // the B2 chain-guard test above). Y and Z sit on OPPOSITE sides of I
    // (angles of opposite sign) so they are not each other's neighbour too —
    // only (I,Y) and (I,Z) clear T_PAIR, never (Y,Z) — keeping I the sole
    // initiator of both pairs in both runs below. I is dated inside
    // NEW_MATERIAL_DAYS so both runs judge at T_PAIR, not the higher
    // BACKFILL_FLOOR, regardless of I's own backlog status.
    const iPath = writeAsset("memories/i-note.md", "description: i");
    dateAsset(iPath, 1);
    const yPath = writeAsset("memories/y-note.md", "description: y");
    const zPath = writeAsset("memories/z-note.md", "description: z");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "i-note", iPath, 0);
      indexAsset(db, "memory", "y-note", yPath, angleForCosine(0.95)); // judged first (higher cosine)
      indexAsset(db, "memory", "z-note", zPath, -angleForCosine(0.94)); // opposite side: cosine(Y,Z) well under T_PAIR
    } finally {
      closeDatabase(db);
    }

    // Run 1: the (I,Y) pair judges cleanly and mints a retire proposal; the
    // (I,Z) pair's judge call fails — a dropped verdict unrelated to Y. I is
    // the initiator of BOTH, so should-fix 3's rule (a row only once ALL of
    // an initiator's own candidates succeeded) leaves I with no row at all,
    // even though the Y pair minted fine.
    const warnings: string[] = [];
    const r1 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async (_connection, messages) => {
        const text = messages.map((m) => m.content).join("\n");
        if (text.includes("memories/z-note")) throw new Error("simulated transport failure");
        return JSON.stringify({ relation: "duplicate", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(r1.retired).toHaveLength(1);
    const rejectedId = r1.retired[0]!;
    expect(getProposal(storage.stashDir, rejectedId).retirement?.successorRef).toBe("memories/y-note");

    const stateDbAfterRun1 = openStateDatabase();
    try {
      // I had a genuine "duplicate" verdict on Y AND a dropped one on Z —
      // should-fix 3 means no row at all, so I is reconsidered next run.
      expect(
        getImproveLedgerRow(stateDbAfterRun1, storage.stashDir, "memories/i-note", "consolidate-pair"),
      ).toBeUndefined();
      // Minting (even a proposal later rejected) marks i-note "processed" in
      // the retrieval scope (Blocker 1's exemption covers only the pair
      // pass's OWN ledger source, not the proposal it wrote) — seed a search
      // so scope isn't what keeps run 2 from reconsidering it, the same
      // reason the "unchanged content" test above seeds one.
      insertUsageEvent(stateDbAfterRun1, { event_type: "search", entry_ref: "stash//memories/i-note", source: "user" });
    } finally {
      stateDbAfterRun1.close();
    }

    const { akmProposalReject, akmProposalAccept } = await import("../../../../src/commands/proposal/proposal");
    const { makeConfig } = await import("../../../_helpers/factories");
    await akmProposalReject({
      stashDir: storage.stashDir,
      id: rejectedId,
      reason: "owner says keep both",
      config: makeConfig(storage.stashDir),
    });

    // Run 2: nothing about I or Y changed. I is re-selected (still no row),
    // regenerating BOTH pairs. S1: the (I,Y) pair is now skipped BEFORE the
    // judge call (both orientations of its ref pair + content hashes match
    // the rejected record), so it costs no LLM call at all and must NOT mint
    // a second time. The (I,Z) pair still succeeds and mints normally —
    // proving the fix does not block unrelated pairs sharing the initiator.
    let chatCalls2 = 0;
    const r2 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async (_connection, messages) => {
        chatCalls2++;
        const text = messages.map((m) => m.content).join("\n");
        if (text.includes("memories/y-note")) {
          throw new Error("(I,Y) must not reach the judge — it was already rejected, unchanged (S1)");
        }
        return JSON.stringify({ relation: "duplicate", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(chatCalls2).toBe(1); // only (I,Z) reaches the judge — (I,Y) is skipped before callStage (S1)
    expect(r2.retired).toHaveLength(1);
    expect(getProposal(storage.stashDir, r2.retired[0]!).retirement?.successorRef).toBe("memories/z-note");

    // The rejected pair is still exactly one proposal, still rejected.
    const allForY = listProposals(storage.stashDir, { includeArchive: true }).filter(
      (p) => p.retirement?.successorRef === "memories/y-note",
    );
    expect(allForY).toHaveLength(1);
    expect(allForY[0]!.status).toBe("rejected");
    expect(fs.existsSync(yPath)).toBe(true); // never touched — only accepting a retire proposal moves a file

    // I now has a row: every one of its candidates resolved cleanly this run.
    const stateDbAfterRun2 = openStateDatabase();
    try {
      const row = getImproveLedgerRow(stateDbAfterRun2, storage.stashDir, "memories/i-note", "consolidate-pair");
      expect(row?.outcome).toBe("proposed");
    } finally {
      stateDbAfterRun2.close();
    }

    // Accept the Z proposal (the "accept one pair" half of the scenario) and
    // confirm it behaves like any other retire accept.
    await akmProposalAccept({ stashDir: storage.stashDir, id: r2.retired[0]!, config: makeConfig(storage.stashDir) });
    expect(fs.existsSync(iPath)).toBe(false); // I (older) archived; Z (newer) survives
    expect(fs.existsSync(zPath)).toBe(true);
  });

  test("S1: a reverted pair (accepted, then undone) stays settled too — not just a rejected one", async () => {
    // Same I/Y/Z shape as item 0's test above: I claims both (I,Y) and
    // (I,Z); Y and Z sit on opposite sides of I so (Y,Z) itself never pairs.
    const iPath = writeAsset("memories/i-note.md", "description: i");
    dateAsset(iPath, 1);
    const yPath = writeAsset("memories/y-note.md", "description: y");
    const zPath = writeAsset("memories/z-note.md", "description: z");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "i-note", iPath, 0);
      indexAsset(db, "memory", "y-note", yPath, angleForCosine(0.95));
      indexAsset(db, "memory", "z-note", zPath, -angleForCosine(0.94));
    } finally {
      closeDatabase(db);
    }

    // Run 1: (I,Y) mints and is ACCEPTED then REVERTED — the owner's other
    // way of saying "no, not this" besides an outright reject. (I,Z)'s judge
    // call fails, so I gets no ledger row at all (should-fix 3), forcing a
    // full re-selection of I (and both its pairs) next run.
    const warnings: string[] = [];
    const r1 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async (_connection, messages) => {
        const text = messages.map((m) => m.content).join("\n");
        if (text.includes("memories/z-note")) throw new Error("simulated transport failure");
        return JSON.stringify({ relation: "duplicate", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(r1.retired).toHaveLength(1);
    const revertedId = r1.retired[0]!;
    expect(getProposal(storage.stashDir, revertedId).retirement?.successorRef).toBe("memories/y-note");

    const { akmProposalAccept, akmProposalRevert } = await import("../../../../src/commands/proposal/proposal");
    const { makeConfig } = await import("../../../_helpers/factories");
    await akmProposalAccept({ stashDir: storage.stashDir, id: revertedId, config: makeConfig(storage.stashDir) });
    expect(fs.existsSync(iPath)).toBe(false); // I (older) archived; Y (newer, the successor) survives
    await akmProposalRevert({ stashDir: storage.stashDir, id: revertedId, config: makeConfig(storage.stashDir) });
    expect(fs.existsSync(iPath)).toBe(true); // restored, exact pre-retire bytes
    // Revert's restore-write resets iPath's mtime to "now" — reapply the
    // same age used at setup so (I,Z)'s older/newer ordering (and so which
    // side judge-time "duplicate" retires) stays exactly as before, the same
    // way run 1 saw it.
    dateAsset(iPath, 1);

    // The archive/restore round trip invalidates I's embedding row (its
    // entry survives with the same id, but the write path that restores the
    // file also drops the now-possibly-stale vector) — a real `akm improve`
    // run re-embeds it during index bootstrap, ahead of consolidate; this
    // test drives the pair pass directly, so it does that one step by hand.
    const dbReindex = openIndexDatabase(getDbPath());
    try {
      indexAsset(dbReindex, "memory", "i-note", iPath, 0);
    } finally {
      closeDatabase(dbReindex);
    }

    const stateDbAfterRun1 = openStateDatabase();
    try {
      expect(
        getImproveLedgerRow(stateDbAfterRun1, storage.stashDir, "memories/i-note", "consolidate-pair"),
      ).toBeUndefined();
      insertUsageEvent(stateDbAfterRun1, { event_type: "search", entry_ref: "stash//memories/i-note", source: "user" });
    } finally {
      stateDbAfterRun1.close();
    }

    // Run 2: I is re-selected, regenerating both pairs. (I,Y) must be
    // skipped BEFORE the judge — reverted, unchanged since, counts the same
    // as a rejected pair (S1).
    let chatCalls2 = 0;
    const r2 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async (_connection, messages) => {
        chatCalls2++;
        const text = messages.map((m) => m.content).join("\n");
        if (text.includes("memories/y-note")) {
          throw new Error("(I,Y) must not reach the judge — it was already reverted, unchanged (S1)");
        }
        return JSON.stringify({ relation: "duplicate", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(chatCalls2).toBe(1); // only (I,Z) reaches the judge — (I,Y) is skipped before callStage (S1)
    expect(r2.retired).toHaveLength(1);
    expect(getProposal(storage.stashDir, r2.retired[0]!).retirement?.successorRef).toBe("memories/z-note");

    // Exactly one proposal ever existed for Y, and it stays reverted — not re-minted.
    const allForY = listProposals(storage.stashDir, { includeArchive: true }).filter(
      (p) => p.retirement?.successorRef === "memories/y-note",
    );
    expect(allForY).toHaveLength(1);
    expect(allForY[0]!.status).toBe("reverted");
  });

  test("#997: a rejected pair settles only while it stays rejected — reopened, it is pending, so it is neither re-judged nor minted twice", async () => {
    // Same I/Y/Z shape as item 0's test above: I claims (I,Y) and (I,Z), Y and
    // Z on opposite sides so (Y,Z) never pairs; Z's judge call fails in run 1,
    // so I gets no ledger row and every later run regenerates both of its pairs.
    const iPath = writeAsset("memories/i-note.md", "description: i");
    dateAsset(iPath, 1);
    const yPath = writeAsset("memories/y-note.md", "description: y");
    const zPath = writeAsset("memories/z-note.md", "description: z");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "i-note", iPath, 0);
      indexAsset(db, "memory", "y-note", yPath, angleForCosine(0.95));
      indexAsset(db, "memory", "z-note", zPath, -angleForCosine(0.94));
    } finally {
      closeDatabase(db);
    }
    const warnings: string[] = [];
    const r1 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async (_connection, messages) => {
        const text = messages.map((m) => m.content).join("\n");
        if (text.includes("memories/z-note")) throw new Error("simulated transport failure");
        return JSON.stringify({ relation: "duplicate", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(r1.retired).toHaveLength(1);
    const proposalId = r1.retired[0]!;
    const stateDb = openStateDatabase();
    try {
      // Seed the usage signal that keeps i-note in the retrieval scope (as item 0's test does).
      insertUsageEvent(stateDb, { event_type: "search", entry_ref: "stash//memories/i-note", source: "user" });
    } finally {
      stateDb.close();
    }

    const { akmProposalReject, akmProposalReopen } = await import("../../../../src/commands/proposal/proposal");
    const { makeConfig } = await import("../../../_helpers/factories");
    const { loadRejectedPairKeys } = await import("../../../../src/commands/improve/consolidate/pair-pass");
    await akmProposalReject({
      stashDir: storage.stashDir,
      id: proposalId,
      reason: "would destroy content (generator bug)",
      config: makeConfig(storage.stashDir),
    });
    expect(loadRejectedPairKeys(storage.stashDir, undefined).size).toBe(1); // rejected: the pair is settled

    await akmProposalReopen({
      stashDir: storage.stashDir,
      ids: [proposalId],
      reason: "the diff was misrendered",
      config: makeConfig(storage.stashDir),
    });
    expect(loadRejectedPairKeys(storage.stashDir, undefined).size).toBe(0); // reopened: it no longer is

    // Run 2 re-selects I. The reopened (I,Y) is pending, so the pair pass
    // leaves its whole group alone — no judge call, and above all no second
    // proposal for a pair that already has one waiting for a person.
    let chatCalls = 0;
    const r2 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async () => {
        chatCalls++;
        return JSON.stringify({ relation: "duplicate", redundant: null, stale: null, confidence: 0.9, reason: "x" });
      },
    });
    expect(chatCalls).toBe(0);
    expect(r2.retired).toHaveLength(0);
    const forY = listProposals(storage.stashDir, { includeArchive: true }).filter(
      (p) => p.retirement?.successorRef === "memories/y-note",
    );
    expect(forY.map((p) => [p.id, p.status])).toEqual([[proposalId, "pending"]]);
    expect(fs.existsSync(yPath) && fs.existsSync(iPath)).toBe(true); // reopening moved nothing
  });

  test("a cap-cut initiator gets no ledger row and is picked back up next run (S1)", async () => {
    // Three assets close enough to pair, but MAX_PAIRS_PER_RUN is patched
    // (via a throwaway db read) is impractical here — instead this proves
    // the underlying mechanism directly: an initiator whose candidate did
    // NOT make it into `judgeable` (skipped by the pending-proposal filter,
    // the same "left something out" shape a cap-cut produces) gets no row,
    // matching the "cap-cut initiators get no row" contract via the SAME
    // totalByInitiator/attemptedByInitiator check runConsolidatePairPass
    // uses for both cases.
    const { createRetireProposal } = await import("../../../../src/commands/proposal/repository");
    const aPath = writeAsset("memories/a-note.md", "description: a");
    const bPath = writeAsset("memories/b-note.md", "description: b");
    writeAsset("memories/elsewhere.md", "description: elsewhere");
    createRetireProposal(storage.stashDir, {
      ref: "memories/b-note",
      source: "consolidate-pair",
      target: { source: "stash", root: storage.stashDir },
      retirement: {
        retiredRef: "memories/b-note",
        successorRef: "memories/elsewhere",
        cosine: 0.99,
        judgeLabel: "duplicate",
        judgeReason: "already queued",
        retiredContentHash: "a".repeat(64),
        successorContentHash: "b".repeat(64),
        reason: "duplicate",
      },
    });
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "a-note", aPath, 0);
      indexAsset(db, "memory", "b-note", bPath, angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }
    const warnings: string[] = [];
    await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "unrelated", redundant: null }),
    });
    const stateDb = openStateDatabase();
    try {
      // a-note's only candidate (b-note) was skipped (b-note has a pending
      // proposal) — a-note is not "fully judged" and gets no row.
      expect(getImproveLedgerRow(stateDb, storage.stashDir, "memories/a-note", "consolidate-pair")).toBeUndefined();
    } finally {
      stateDb.close();
    }
  });

  test("an initiator whose judge call fails gets no ledger row, so the next run retries it (should-fix 3)", async () => {
    const aPath = writeAsset("memories/a-note.md", "description: a");
    const bPath = writeAsset("memories/b-note.md", "description: b");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "a-note", aPath, 0);
      indexAsset(db, "memory", "b-note", bPath, angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }
    const warnings: string[] = [];
    let chatCalls = 0;
    await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: async () => {
        chatCalls++;
        throw new Error("simulated transport failure");
      },
    });
    expect(chatCalls).toBe(1);
    const stateDb = openStateDatabase();
    try {
      // A failed (unparsed) verdict judged nothing conclusive — no row for
      // a-note, so it remains eligible rather than being treated as settled.
      // (b-note is not asserted on here: the pair is deduped onto a-note as
      // the sole initiator, so b-note has no candidates of its own and gets
      // an unrelated zero-candidate row — the same shape the cap-cut test
      // above already works around.)
      expect(getImproveLedgerRow(stateDb, storage.stashDir, "memories/a-note", "consolidate-pair")).toBeUndefined();
    } finally {
      stateDb.close();
    }

    // The next run retries the same pair instead of skipping it as judged.
    const r2 = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });
    expect(r2.retired).toHaveLength(1);
  });
});

describe("loadGitFirstAddedMap — real git, large output (B1 regression)", () => {
  // Found by the post-review real-data measurement, not by any hand-sized
  // fixture: `spawnSync`'s default maxBuffer is 1 MB, and the owner's real
  // bundle alone prints ~1.8 MB from this exact git log command — enough to
  // silently overflow it. Overflow looks identical to "git failed" (a
  // non-zero/null status), so every asset's "created" date would have
  // quietly fallen back to mtime, with no warning anywhere. This fixture
  // manufactures >1 MB of output the cheap way (many long, content-less
  // filenames in one commit) rather than needing real history.
  test("a git log output over 1 MB (spawnSync's default maxBuffer) is still read in full, not silently dropped", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "akm-gitmap-bigrepo-"));
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      // ~208 bytes/name x 6000 files ≈ 1.25 MB of `--name-only` output —
      // comfortably over the 1 MB default, without needing real content or history.
      const names: string[] = [];
      for (let i = 0; i < 6000; i++) {
        const name = `m${"x".repeat(200)}${String(i).padStart(5, "0")}.md`;
        fs.writeFileSync(path.join(repo, name), "x");
        names.push(name);
      }
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "--quiet", "-m", "bulk"], { cwd: repo });

      const { loadGitFirstAddedMap } = await import("../../../../src/commands/improve/consolidate/pair-pass");
      const map = loadGitFirstAddedMap(repo);
      expect(map).toBeDefined();
      expect(map?.size).toBe(6000);
      // Every single one of the 6000 names actually resolved, not just "some".
      expect(names.every((n) => map?.has(n))).toBe(true);
      const aName = names[0]!;
      expect(map?.get(aName)).toBeGreaterThan(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a renamed file keeps its original first-add date, not the rename commit's (should-fix 4)", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "akm-gitmap-rename-"));
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });

      const firstCommitEpoch = Math.floor(Date.now() / 1000) - 30 * 86_400;
      fs.writeFileSync(path.join(repo, "old-name.md"), "content\n".repeat(50));
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "--quiet", "-m", "add old-name"], {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_DATE: `@${firstCommitEpoch}`, GIT_COMMITTER_DATE: `@${firstCommitEpoch}` },
      });

      // A pure rename (unchanged content) — git detects this as R100, not a delete+add.
      fs.renameSync(path.join(repo, "old-name.md"), path.join(repo, "new-name.md"));
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "--quiet", "-m", "rename to new-name"], { cwd: repo });

      const { loadGitFirstAddedMap } = await import("../../../../src/commands/improve/consolidate/pair-pass");
      const map = loadGitFirstAddedMap(repo);
      expect(map).toBeDefined();
      // new-name.md inherits old-name.md's original first-add time, not the
      // (much later) rename commit's own time. The map stores milliseconds
      // (matching Date.now()/mtimeMs), git's %ct is seconds.
      expect(map?.get("new-name.md")).toBe(firstCommitEpoch * 1000);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
