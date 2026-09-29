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
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConsolidateOptions } from "../../../../src/commands/improve/consolidate";
import {
  BACKFILL_FLOOR,
  type PairJudgeChat,
  runConsolidatePairPass,
  selectCandidates,
  selectInitiators,
  T_PAIR,
} from "../../../../src/commands/improve/consolidate/pair-pass";
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

function writeAsset(relPath: string, frontmatter: string, body = "Body text.\n"): string {
  const filePath = path.join(storage.stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
  return filePath;
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
  test("a backlog initiator (never attempted) needs >= BACKFILL_FLOOR (0.95); T_PAIR (0.93) alone is not enough", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old note");
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
    );
    expect(initiators).toHaveLength(1);
    expect(initiators[0]?.backlog).toBe(true);

    const db2 = openIndexDatabase(getDbPath());
    let candidates: ReturnType<typeof selectCandidates>;
    try {
      candidates = selectCandidates(db2, initiators, "stash");
    } finally {
      closeDatabase(db2);
    }
    expect(candidates.map((c) => c.other.name)).toEqual(["close-note"]);
  });

  test("an initiator with a prior (now-stale) ledger attempt uses the lower T_PAIR (0.93) floor", () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old note");
    const midPath = writeAsset("memories/mid-note.md", "description: between T_PAIR and BACKFILL_FLOOR");
    // Seed a ledger row attempted BEFORE the file's mtime, so isLedgerBlocked's
    // content-change signal lifts it (not a backlog initiator any more).
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const stateDb = openStateDatabase();
    try {
      recordImproveLedger(stateDb, {
        stashDir: storage.stashDir,
        ref: "memories/old-note",
        source: "consolidate-pair",
        outcome: "judged_no_action_stable",
        at: past,
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
    );
    expect(initiators[0]?.backlog).toBe(false);
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
});

describe("runConsolidatePairPass — end-to-end with a fake judge", () => {
  test("duplicate: mints a retire proposal for the older side, with the full retirement metadata", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old\ncreatedAt: 2026-01-01T00:00:00.000Z");
    writeAsset("memories/new-note.md", "description: new\ncreatedAt: 2026-06-01T00:00:00.000Z");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "old-note", oldPath, 0);
      indexAsset(
        db,
        "memory",
        "new-note",
        path.join(storage.stashDir, "memories/new-note.md"),
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
    expect(proposal.source).toBe("consolidate");
    expect(proposal.retirement).toMatchObject({
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      judgeLabel: "duplicate",
      reason: "duplicate",
    });
    expect(proposal.retirement?.cosine).toBeGreaterThan(0.96);

    // Ledger: consolidate-pair source, distinguishable from the promote pass's own "consolidate" rows.
    const stateDb = openStateDatabase();
    try {
      const row = getImproveLedgerRow(stateDb, storage.stashDir, "memories/old-note", "consolidate-pair");
      expect(row?.outcome).toBe("proposed");
    } finally {
      stateDb.close();
    }
  });

  test("never mints two retire proposals for the same asset in one run, even when it loses two different pairs", async () => {
    // A is the nearest neighbour of both B and C, and all three are mutually
    // close enough to pair up — three candidate pairs total: {A,B}, {B,C},
    // {A,C}. A "duplicate" judge on every pair would naively retire A twice
    // (once via each of its two pairs) without the in-run dedup guard.
    const aPath = writeAsset("memories/a-note.md", "description: a\ncreatedAt: 2026-01-01T00:00:00.000Z");
    const bPath = writeAsset("memories/b-note.md", "description: b\ncreatedAt: 2026-02-01T00:00:00.000Z");
    const cPath = writeAsset("memories/c-note.md", "description: c\ncreatedAt: 2026-03-01T00:00:00.000Z");
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
    expect(result.retired).toHaveLength(2); // but only two distinct assets were actually retired
    const retiredRefs = result.retired.map((id) => getProposal(storage.stashDir, id).ref).sort();
    expect(retiredRefs).toEqual(["stash//memories/a-note", "stash//memories/b-note"]);
    // No two pending proposals target the same ref.
    const refs = listProposals(storage.stashDir).map((p) => p.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  test("contradicts: counted, no proposal, no belief write", async () => {
    const oldPath = writeAsset("memories/claim-a.md", "description: claim a\ncreatedAt: 2026-01-01T00:00:00.000Z");
    writeAsset("memories/claim-b.md", "description: claim b\ncreatedAt: 2026-06-01T00:00:00.000Z");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "claim-a", oldPath, 0);
      indexAsset(db, "memory", "claim-b", path.join(storage.stashDir, "memories/claim-b.md"), angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "contradicts", redundant: null }),
    });

    expect(result.labelCounts.contradicts).toBeGreaterThanOrEqual(1);
    expect(result.contradictionsFound).toBe(result.labelCounts.contradicts);
    expect(result.retired).toHaveLength(0);
    expect(listProposals(storage.stashDir)).toHaveLength(0);
    const claimAContent = fs.readFileSync(oldPath, "utf8");
    expect(claimAContent).not.toContain("supersededBy");
    expect(claimAContent).not.toContain("beliefState");
  });

  test("subsumed: retires the side the judge names redundant", async () => {
    const smallPath = writeAsset("memories/small-note.md", "description: small\ncreatedAt: 2026-01-01T00:00:00.000Z");
    writeAsset(
      "memories/big-note.md",
      "description: big, contains everything small has plus more\ncreatedAt: 2026-06-01T00:00:00.000Z",
    );
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "small-note", smallPath, 0);
      indexAsset(db, "memory", "big-note", path.join(storage.stashDir, "memories/big-note.md"), angleForCosine(0.96));
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    // redundant: "A" — A is the older side by createdAt (small-note).
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "subsumed", redundant: "A" }),
    });
    expect(result.retired).toHaveLength(1);
    const proposal = getProposal(storage.stashDir, result.retired[0]!);
    expect(proposal.ref).toBe("stash//memories/small-note");
    expect(proposal.retirement?.reason).toBe("subsumed");
  });

  test("never retires a captureMode: hot memory — the pair is left alone", async () => {
    const hotPath = writeAsset(
      "memories/hot-note.md",
      "description: hot\ncaptureMode: hot\ncreatedAt: 2026-01-01T00:00:00.000Z",
    );
    writeAsset("memories/plain-note.md", "description: plain\ncreatedAt: 2026-06-01T00:00:00.000Z");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "hot-note", hotPath, 0);
      indexAsset(
        db,
        "memory",
        "plain-note",
        path.join(storage.stashDir, "memories/plain-note.md"),
        angleForCosine(0.96),
      );
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
      "inferred: true\nsource: memories/parent\ndescription: derived\ncreatedAt: 2026-01-01T00:00:00.000Z",
    );
    writeAsset("memories/other-note.md", "description: another note\ncreatedAt: 2026-06-01T00:00:00.000Z");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "parent.derived", derivedPath, 0);
      indexAsset(
        db,
        "memory",
        "other-note",
        path.join(storage.stashDir, "memories/other-note.md"),
        angleForCosine(0.96),
      );
    } finally {
      closeDatabase(db);
    }

    const warnings: string[] = [];
    const result = await runConsolidatePairPass(baseOpts(), {} as never, storage.stashDir, "stash", warnings, {
      chat: fixedChat({ relation: "duplicate", redundant: null }),
    });
    expect(result.retired).toHaveLength(0);
  });

  test("skips a pair when either side already has a pending retire proposal", async () => {
    const { createRetireProposal } = await import("../../../../src/commands/proposal/repository");
    const oldPath = writeAsset("memories/old-note.md", "description: old\ncreatedAt: 2026-01-01T00:00:00.000Z");
    writeAsset("memories/new-note.md", "description: new\ncreatedAt: 2026-06-01T00:00:00.000Z");
    createRetireProposal(storage.stashDir, {
      ref: "memories/old-note",
      source: "consolidate",
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
      indexAsset(db, "memory", "new-note", path.join(storage.stashDir, "memories/new-note.md"), angleForCosine(0.96));
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
  });

  test("a dry run judges pairs and previews retirements without minting proposals or writing the ledger", async () => {
    const oldPath = writeAsset("memories/old-note.md", "description: old\ncreatedAt: 2026-01-01T00:00:00.000Z");
    writeAsset("memories/new-note.md", "description: new\ncreatedAt: 2026-06-01T00:00:00.000Z");
    const db = openIndexDatabase(getDbPath());
    try {
      indexAsset(db, "memory", "old-note", oldPath, 0);
      indexAsset(
        db,
        "memory",
        "new-note",
        path.join(storage.stashDir, "memories/new-note.md"),
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
});
