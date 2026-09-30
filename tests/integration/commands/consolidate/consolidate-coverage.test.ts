// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #998 — the promote pass's coverage gate against a real index.db: crafted
 * unit-vector embeddings (so neighbours are exact and deterministic, as in
 * consolidate-pair-pass.test.ts), real knowledge files on disk, and the real
 * mint path. Opens a real index.db, so it lives under integration (ORG-03).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmConsolidate, emitPromotionProposal } from "../../../../src/commands/improve/consolidate";
import { findCoveringKnowledge, openKnowledgeCoverage } from "../../../../src/commands/improve/consolidate/coverage";
import { PAIR_NEIGHBOR_FETCH_K } from "../../../../src/commands/improve/consolidate/pair-pass";
import { listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { getDbPath } from "../../../../src/core/paths";
import { openStateDatabase } from "../../../../src/core/state-db";
import { resolveWriteTarget } from "../../../../src/core/write-source";
import type { IndexDocument } from "../../../../src/indexer/passes/metadata";
import { getImproveLedgerRow } from "../../../../src/storage/repositories/improve-ledger-repository";
import { closeDatabase, openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../../src/storage/repositories/index-entries-repository";
import { upsertEmbedding } from "../../../../src/storage/repositories/index-vec-repository";
import { makeConfig } from "../../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let stash: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = storage.stashDir;
  for (const dir of ["memories", "knowledge", "lessons"]) fs.mkdirSync(path.join(stash, dir), { recursive: true });
});

afterEach(() => {
  storage.cleanup();
});

/** A unit vector `deg` degrees from the 0° vector: cos(deg) is the exact cosine to it. */
function vecAtAngle(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), 0, 0];
}

const TYPE_DIR: Record<string, string> = { memory: "memories", knowledge: "knowledge", lesson: "lessons" };

function writeAsset(type: "memory" | "knowledge", name: string, description: string, body: string): string {
  const file = path.join(stash, TYPE_DIR[type]!, `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
  return file;
}

/** Index one asset, matching the real indexer; `angleDeg` undefined leaves it with no stored vector. */
function indexAsset(
  db: ReturnType<typeof openIndexDatabase>,
  type: "memory" | "knowledge",
  name: string,
  file: string,
  angleDeg?: number,
  bundleId = "stash",
): number {
  const entry: IndexDocument = { type, name, description: `desc for ${name}` };
  const id = upsertEntry(db, file, entry, {
    bundleId,
    componentId: bundleId,
    adapterId: "akm",
    conceptId: `${TYPE_DIR[type]}/${name}`,
    itemRef: `${bundleId}//${TYPE_DIR[type]}/${name}`,
  });
  if (angleDeg !== undefined) upsertEmbedding(db, id, vecAtAngle(angleDeg));
  return id;
}

function withIndex<T>(fn: (db: ReturnType<typeof openIndexDatabase>) => T): T {
  const db = openIndexDatabase(getDbPath());
  try {
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

// Long enough to promote (>= 100 chars) and to shingle; the words are chosen so
// that unrelated fixtures below share no 5-word run with it.
const RELEASE_NOTE =
  "Always run the release check on a clean checkout before tagging, because a dirty working tree hides files " +
  "the build silently depends on and the tag then ships a package nobody can rebuild.";
const GUIDE_INTRO = "This guide collects the release habits the team settled on after the March incident.";
const GUIDE_OUTRO = "Finally publish the notes and announce the new version in the usual channel.";
const UNRELATED =
  "Rotate the staging database credentials every quarter and record the rotation in the shared operations " +
  "calendar so the on-call engineer can see when the previous secret stops working.";

describe("findCoveringKnowledge — neighbours from the index, decided by shared text", () => {
  test("finds the knowledge doc that quotes the memory, ignores the ones that do not, and never reports the memory's own kind", () => {
    const memoryFile = writeAsset("memory", "release-note", "release note", RELEASE_NOTE);
    const twinFile = writeAsset("memory", "release-note-copy", "a copy of the note", RELEASE_NOTE);
    // Longer than the memory and worded differently around it: the whole-body hash cannot see this one.
    const guideFile = writeAsset(
      "knowledge",
      "release-habits",
      "release habits",
      `${GUIDE_INTRO}\n\n${RELEASE_NOTE}\n\n${GUIDE_OUTRO}`,
    );
    const partialFile = writeAsset(
      "knowledge",
      "release-tagging",
      "tagging",
      "Always run the release check on a clean checkout before tagging. Then push the tag.",
    );
    const otherFile = writeAsset("knowledge", "credentials", "credentials", UNRELATED);
    const foreignFile = writeAsset("knowledge", "foreign-release-habits", "elsewhere", RELEASE_NOTE);

    withIndex((db) => {
      indexAsset(db, "memory", "release-note", memoryFile, 0);
      indexAsset(db, "memory", "release-note-copy", twinFile, 1); // nearest of all, but a memory
      indexAsset(db, "knowledge", "release-habits", guideFile, 4);
      indexAsset(db, "knowledge", "release-tagging", partialFile, 6);
      indexAsset(db, "knowledge", "credentials", otherFile, 9);
      indexAsset(db, "knowledge", "foreign-release-habits", foreignFile, 2, "other-bundle"); // covers it, but not in this bundle
      const found = findCoveringKnowledge(db, "stash", memoryFile, RELEASE_NOTE);
      expect(found?.ref).toBe("knowledge/release-habits");
      expect(found?.containment).toBe(1);
    });
  });

  test("a guide that sits far from the memory by vector but quotes it is still found: there is no cosine floor, only a rank", () => {
    const memoryFile = writeAsset("memory", "release-note", "release note", RELEASE_NOTE);
    const guideFile = writeAsset("knowledge", "handbook", "handbook", `${GUIDE_INTRO}\n\n${RELEASE_NOTE}`);
    withIndex((db) => {
      indexAsset(db, "memory", "release-note", memoryFile, 0);
      indexAsset(db, "knowledge", "handbook", guideFile, 70); // cosine ~0.34
      expect(findCoveringKnowledge(db, "stash", memoryFile, RELEASE_NOTE)?.ref).toBe("knowledge/handbook");
    });
  });

  test("a doc holding less than half of the memory's text does not cover it, and neither does an unrelated one", () => {
    const memoryFile = writeAsset("memory", "release-note", "release note", RELEASE_NOTE);
    const partialFile = writeAsset(
      "knowledge",
      "release-tagging",
      "tagging",
      "Always run the release check on a clean checkout before tagging. Then push the tag.",
    );
    const otherFile = writeAsset("knowledge", "credentials", "credentials", UNRELATED);
    withIndex((db) => {
      indexAsset(db, "memory", "release-note", memoryFile, 0);
      indexAsset(db, "knowledge", "release-tagging", partialFile, 3);
      indexAsset(db, "knowledge", "credentials", otherFile, 5);
      expect(findCoveringKnowledge(db, "stash", memoryFile, RELEASE_NOTE)).toBeUndefined();
    });
  });

  test("memories and other bundles' knowledge that sit nearer do not crowd the covering guide out: the scan is scoped, not filtered afterwards", () => {
    const memoryFile = writeAsset("memory", "release-note", "release note", RELEASE_NOTE);
    const guideFile = writeAsset("knowledge", "handbook", "handbook", `${GUIDE_INTRO}\n\n${RELEASE_NOTE}`);
    withIndex((db) => {
      indexAsset(db, "memory", "release-note", memoryFile, 0);
      // More than the fetch depth of nearer entries that cannot be candidates.
      for (let i = 0; i < PAIR_NEIGHBOR_FETCH_K + 5; i++) {
        const nearMemory = writeAsset("memory", `near-memory-${i}`, "near", `Unrelated memory ${i}.`);
        indexAsset(db, "memory", `near-memory-${i}`, nearMemory, 1 + i * 0.1);
        const foreign = writeAsset("knowledge", `foreign-${i}`, "foreign", `Unrelated foreign doc ${i}.`);
        indexAsset(db, "knowledge", `foreign-${i}`, foreign, 1.05 + i * 0.1, "other-bundle");
      }
      indexAsset(db, "knowledge", "handbook", guideFile, 30);
      expect(findCoveringKnowledge(db, "stash", memoryFile, RELEASE_NOTE)?.ref).toBe("knowledge/handbook");
    });
  });

  test.each([
    { nearer: PAIR_NEIGHBOR_FETCH_K - 1, found: true }, // the guide is the 20th nearest knowledge doc
    { nearer: PAIR_NEIGHBOR_FETCH_K, found: false }, // the guide is the 21st: past the fetch depth, unseen
  ])("reads only the nearest knowledge docs: with $nearer of them nearer than the guide, it is found: $found", ({
    nearer,
    found,
  }) => {
    const memoryFile = writeAsset("memory", "release-note", "release note", RELEASE_NOTE);
    const guideFile = writeAsset("knowledge", "handbook", "handbook", `${GUIDE_INTRO}\n\n${RELEASE_NOTE}`);
    withIndex((db) => {
      indexAsset(db, "memory", "release-note", memoryFile, 0);
      for (let i = 0; i < nearer; i++) {
        const filler = writeAsset("knowledge", `filler-${i}`, "filler", `Unrelated filler ${i}.`);
        indexAsset(db, "knowledge", `filler-${i}`, filler, 1 + i * 0.1);
      }
      indexAsset(db, "knowledge", "handbook", guideFile, 30);
      expect(findCoveringKnowledge(db, "stash", memoryFile, RELEASE_NOTE)?.ref).toBe(
        found ? "knowledge/handbook" : undefined,
      );
    });
  });

  test("no stored vector, an unindexed memory or a body too short to shingle: nothing to compare, nothing thrown", () => {
    const noVector = writeAsset("memory", "no-vector", "no vector", RELEASE_NOTE);
    const unindexed = writeAsset("memory", "unindexed", "unindexed", RELEASE_NOTE);
    const guideFile = writeAsset("knowledge", "handbook", "handbook", `${GUIDE_INTRO}\n\n${RELEASE_NOTE}`);
    withIndex((db) => {
      indexAsset(db, "memory", "no-vector", noVector); // semantic search was off when it was indexed
      indexAsset(db, "knowledge", "handbook", guideFile, 0);
      expect(findCoveringKnowledge(db, "stash", noVector, RELEASE_NOTE)).toBeUndefined();
      expect(findCoveringKnowledge(db, "stash", unindexed, RELEASE_NOTE)).toBeUndefined();
      expect(findCoveringKnowledge(db, "stash", noVector, "too short")).toBeUndefined();
    });
  });
});

describe("openKnowledgeCoverage", () => {
  test("is absent without a bundle or an index, and a lookup that fails counts as not covered", () => {
    expect(openKnowledgeCoverage(undefined)).toBeUndefined();
    expect(openKnowledgeCoverage("stash")).toBeUndefined(); // no index.db has been built in this sandbox

    const memoryFile = writeAsset("memory", "release-note", "release note", RELEASE_NOTE);
    const guideFile = writeAsset("knowledge", "handbook", "handbook", `${GUIDE_INTRO}\n\n${RELEASE_NOTE}`);
    withIndex((db) => {
      indexAsset(db, "memory", "release-note", memoryFile, 0);
      indexAsset(db, "knowledge", "handbook", guideFile, 3);
    });
    const coverage = openKnowledgeCoverage("stash");
    expect(coverage?.find(memoryFile, RELEASE_NOTE)?.ref).toBe("knowledge/handbook");
    coverage?.close();
    expect(coverage?.find(memoryFile, RELEASE_NOTE)).toBeUndefined(); // the handle is closed: it throws inside, not out
  });
});

describe("emitPromotionProposal with the coverage gate", () => {
  async function emit(name: string, coverage: ReturnType<typeof openKnowledgeCoverage>) {
    const cfg = { ...makeConfig(stash), semanticSearchMode: "off" } as AkmConfig;
    const skips: Array<{ ref: string; reason: string }> = [];
    const warnings: string[] = [];
    const promoted: string[] = [];
    await emitPromotionProposal(
      {
        op: "promote",
        ref: `memories/${name}`,
        knowledgeRef: `knowledge/${name}-promoted`,
        reason: "test",
        description: `${name} notes`,
      },
      {
        config: cfg,
        stashDir: stash,
        sourceRun: "consolidate-test",
        target: resolveWriteTarget(cfg),
        memoryByRef: new Map([
          [
            `memories/${name}`,
            {
              name,
              filePath: path.join(stash, "memories", `${name}.md`),
              description: `${name} memory`,
              tags: [],
              stashDir: stash,
            },
          ],
        ]),
        promoted,
        promotedSourceRefs: new Set(),
        existingKnowledgeBodyHashes: new Set(),
        ...(coverage ? { coveringKnowledge: coverage.find } : {}),
        promotionFailures: { count: 0 },
        warnings,
        pushSkipReason: (_op, ref, reason) => skips.push({ ref, reason }),
      },
    );
    return { skips, warnings, promoted };
  }

  test("skips a memory a knowledge doc already covers, recording dedup_covered_by_knowledge, and still mints one it does not", async () => {
    const coveredFile = writeAsset("memory", "covered", "covered", RELEASE_NOTE);
    const freshFile = writeAsset("memory", "fresh", "fresh", UNRELATED);
    const guideFile = writeAsset(
      "knowledge",
      "handbook",
      "handbook",
      `${GUIDE_INTRO}\n\n${RELEASE_NOTE}\n\n${GUIDE_OUTRO}`,
    );
    withIndex((db) => {
      indexAsset(db, "memory", "covered", coveredFile, 0);
      indexAsset(db, "memory", "fresh", freshFile, 40);
      indexAsset(db, "knowledge", "handbook", guideFile, 3);
    });
    const coverage = openKnowledgeCoverage("stash");
    try {
      const covered = await emit("covered", coverage);
      expect(covered.promoted).toEqual([]);
      expect(covered.skips).toEqual([{ ref: "memories/covered", reason: "dedup_covered_by_knowledge" }]);
      expect(covered.warnings.some((w) => w.includes("knowledge/handbook") && w.includes("already covered"))).toBe(
        true,
      );
      expect(listProposals(stash, { status: "pending" })).toHaveLength(0);

      const fresh = await emit("fresh", coverage);
      expect(fresh.skips).toEqual([]);
      expect(fresh.promoted).toHaveLength(1);
      expect(listProposals(stash, { status: "pending" }).map((p) => p.promotionSource)).toEqual(["memories/fresh"]);
    } finally {
      coverage?.close();
    }
  });

  test("without the gate (no index, or semantic search off) the same memory is minted: the exact checks still apply and nothing throws", async () => {
    writeAsset("memory", "covered", "covered", RELEASE_NOTE);
    writeAsset("knowledge", "handbook", "handbook", `${GUIDE_INTRO}\n\n${RELEASE_NOTE}\n\n${GUIDE_OUTRO}`);
    const result = await emit("covered", undefined);
    expect(result.skips).toEqual([]);
    expect(result.promoted).toHaveLength(1);
  });
});

describe("akmConsolidate — a covered memory is not promoted, an uncovered one is", () => {
  test("the skip reason reaches the result, the accounting still balances, and the ledger keeps the covered memory's verdict", async () => {
    const coveredFile = writeAsset("memory", "covered-note", "covered note", RELEASE_NOTE);
    const freshFile = writeAsset("memory", "fresh-note", "fresh note", UNRELATED);
    const guideFile = writeAsset(
      "knowledge",
      "handbook",
      "handbook",
      `${GUIDE_INTRO}\n\n${RELEASE_NOTE}\n\n${GUIDE_OUTRO}`,
    );
    withIndex((db) => {
      indexAsset(db, "memory", "covered-note", coveredFile, 0);
      indexAsset(db, "memory", "fresh-note", freshFile, 40);
      indexAsset(db, "knowledge", "handbook", guideFile, 3);
    });
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      engines: {
        planner: { kind: "llm", endpoint: "https://consolidate.example.test/v1/chat/completions", model: "planner" },
      },
      defaults: { llmEngine: "planner", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { consolidate: { enabled: true } } } } },
    } as AkmConfig;
    const reply = (content: unknown) =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const result = await withMockedFetch(
      () => akmConsolidate({ stashDir: stash, config, sourceRun: "consolidate-coverage-test" }),
      async (_url, init) => {
        const messages = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages;
        // The pair pass shares the endpoint; it has nothing to say about these fixtures.
        if (messages.some((m) => m.content.includes("You compare two assets"))) {
          return reply({ relation: "unrelated", redundant: null, stale: null, confidence: 0.5, reason: "x" });
        }
        return reply({
          operations: [
            {
              op: "promote",
              ref: "memories/covered-note",
              knowledgeRef: "knowledge/covered-note-copy",
              reason: "durable",
              description: "Covered note",
            },
            {
              op: "promote",
              ref: "memories/fresh-note",
              knowledgeRef: "knowledge/fresh-note-copy",
              reason: "durable",
              description: "Fresh note",
            },
          ],
        });
      },
    );

    expect(result.ok).toBe(true);
    expect(result.skipReasons).toEqual([
      { ref: "memories/covered-note", skips: [{ op: "promote", reason: "dedup_covered_by_knowledge" }] },
    ]);
    expect(result.promoted).toHaveLength(1);
    expect(listProposals(stash, { status: "pending" }).map((p) => p.promotionSource)).toEqual(["memories/fresh-note"]);
    // processed == promoted + judgedNoAction + Σ(skipReasons) + failedChunkMemories
    expect(result.processed).toBe(
      result.promoted.length +
        (result.judgedNoAction ?? 0) +
        (result.skipReasons?.length ?? 0) +
        (result.failedChunkMemories ?? 0),
    );

    const db = openStateDatabase();
    try {
      expect(getImproveLedgerRow(db, stash, "memories/covered-note", "consolidate")?.outcome).toBe("judged_no_action");
      expect(getImproveLedgerRow(db, stash, "memories/fresh-note", "consolidate")?.outcome).toBe("proposed");
    } finally {
      db.close();
    }
  });
});
