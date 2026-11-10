// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "../../../../src/commands/config";
import {
  akmConsolidate,
  type ConsolidatePromoteOp,
  emitPromotionProposal,
  type PromoteContext,
} from "../../../../src/commands/improve/consolidate";
import {
  findCoveringKnowledge,
  nearestKnowledgeNotes,
  openKnowledgeCoverage,
} from "../../../../src/commands/improve/consolidate/coverage";
import { PAIR_NEIGHBOR_FETCH_K } from "../../../../src/commands/improve/consolidate/pair-pass";
import { contentHash } from "../../../../src/commands/improve/content-hash";
import { drainProposals } from "../../../../src/commands/proposal/drain";
import { akmProposalAccept } from "../../../../src/commands/proposal/proposal";
import {
  createProposal,
  getProposal,
  listProposals,
  proposalContent,
} from "../../../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../../../src/core/config/config";
import { getDbPath } from "../../../../src/core/paths";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { IndexDocument } from "../../../../src/indexer/passes/metadata";
import { resolveWriteTarget } from "../../../../src/sources/write-source";
import { getImproveLedgerRow } from "../../../../src/storage/repositories/improve-ledger-repository";
import { closeDatabase, openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../../src/storage/repositories/index-entries-repository";
import { upsertEmbedding } from "../../../../src/storage/repositories/index-vec-repository";
import { makeConfig } from "../../../_helpers/factories";
import { testLlmRunner } from "../../../_helpers/llm-runner";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../../../_helpers/sandbox";

/**
 * #998 — the promote pass's coverage gate against a real index.db: crafted
 * unit-vector embeddings (so neighbours are exact and deterministic, as in
 * consolidate-pair-pass.test.ts), real knowledge files on disk, and the real
 * mint path. Opens a real index.db, so it lives under integration (ORG-03).
 */

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

  test("a doc holding less than 30% of the memory's text does not cover it, and neither does an unrelated one", () => {
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
              ref: `memories/${name}`,
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
      semanticSearchMode: "off",
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
      connections: {
        planner: { endpoint: "https://consolidate.example.test/v1/chat/completions", models: { fast: "planner" } },
      },
      improve: { strategy: "default", strategies: { default: { processes: { consolidate: { enabled: true } } } } },
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
          return reply({
            onlyInA: [],
            onlyInB: [],
            relation: "unrelated",
            redundant: null,
            stale: null,
            confidence: 0.5,
            reason: "x",
          });
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
      const covered = getImproveLedgerRow(db, stash, "memories/covered-note", "consolidate");
      expect(covered?.outcome).toBe("judged_no_action");
      // The judged text is recorded, so the memory is not asked about again until it changes.
      expect(covered?.contentHash).toBe(contentHash(fs.readFileSync(coveredFile, "utf8"), "body"));
      expect(covered?.nextEligibleAt).toBeNull();
      expect(getImproveLedgerRow(db, stash, "memories/fresh-note", "consolidate")?.outcome).toBe("proposed");
    } finally {
      db.close();
    }
  });
});

describe("the drain's judge sees the knowledge a promotion may duplicate", () => {
  const RUNNER = testLlmRunner(
    { endpoint: "http://fake.invalid/v1/chat/completions", model: "judge", contextLength: 8_192 },
    "fake-judge",
  );

  function promotionOf(memory: string, knowledgeRef: string) {
    return createProposal(stash, {
      ref: knowledgeRef,
      source: "consolidate",
      target: { source: "stash", root: stash },
      payload: {
        content: `---\ndescription: ${memory}\n---\n\n${RELEASE_NOTE}\n`,
        frontmatter: { description: memory },
      },
      attemptedRefs: [`memories/${memory}`],
      promotionSource: `memories/${memory}`,
    });
  }

  /** Drain with a judge that defers (writes nothing) and returns the prompts it was sent. */
  async function judgedPrompts(): Promise<string[]> {
    const prompts: string[] = [];
    await drainProposals(
      { stashDir: stash, applyMode: "promote", maxAccepts: 5, dryRun: false, judgment: RUNNER },
      undefined,
      undefined,
      {
        chat: async (_connection, messages) => {
          prompts.push(String(messages[0]?.content));
          return JSON.stringify({ decision: "defer", reason: "test" });
        },
      },
    );
    return prompts;
  }

  test("a promotion's prompt lists the nearest knowledge notes, nearest first, with description and excerpt", async () => {
    const memoryFile = writeAsset("memory", "release-note", "release note", RELEASE_NOTE);
    const guideFile = writeAsset("knowledge", "release-habits", "release habits", `${GUIDE_INTRO}\n\n${RELEASE_NOTE}`);
    const otherFile = writeAsset("knowledge", "credentials", "credentials", UNRELATED);
    const foreignFile = writeAsset("knowledge", "foreign", "elsewhere", RELEASE_NOTE);
    withIndex((db) => {
      indexAsset(db, "memory", "release-note", memoryFile, 0);
      indexAsset(db, "knowledge", "credentials", otherFile, 20);
      indexAsset(db, "knowledge", "release-habits", guideFile, 4);
      indexAsset(db, "knowledge", "foreign", foreignFile, 1, "other-bundle");
    });
    promotionOf("release-note", "knowledge/release-note-copy");

    const [prompt, ...more] = await judgedPrompts();
    expect(more).toEqual([]);
    expect(prompt).toContain("## Existing knowledge notes nearest to this promotion's source memory");
    expect(prompt).toContain("Reject the promotion if these notes already cover what it says");
    expect(prompt).toContain("### knowledge/release-habits\ndesc for release-habits");
    expect(prompt).toContain(GUIDE_INTRO);
    expect(prompt!.indexOf("knowledge/release-habits")).toBeLessThan(prompt!.indexOf("knowledge/credentials"));
    expect(prompt).not.toContain("knowledge/foreign"); // another bundle's note is not a neighbour
  });

  test("an excerpt is cut short, and the nearest notes are capped at five", () => {
    const memoryFile = writeAsset("memory", "release-note", "release note", RELEASE_NOTE);
    withIndex((db) => {
      indexAsset(db, "memory", "release-note", memoryFile, 0);
      for (let i = 0; i < 8; i++) {
        indexAsset(
          db,
          "knowledge",
          `long-${i}`,
          writeAsset("knowledge", `long-${i}`, "long", "word ".repeat(400)),
          1 + i,
        );
      }
    });
    const notes = nearestKnowledgeNotes(memoryFile);
    expect(notes.map((n) => n.ref)).toEqual([0, 1, 2, 3, 4].map((i) => `knowledge/long-${i}`));
    expect(notes[0]?.excerpt.length).toBeLessThan(310);
  });

  test("nothing is added for a memory the index does not know, for a proposal that is not a promotion, or when there is no index", async () => {
    expect(nearestKnowledgeNotes(path.join(stash, "memories", "ghost.md"))).toEqual([]);
    promotionOf("ghost", "knowledge/ghost-copy");
    const [prompt] = await judgedPrompts();
    expect(prompt).not.toContain("Existing knowledge notes");

    // A consolidate proposal that is not a promotion (no source memory) is judged as before.
    createProposal(stash, {
      ref: "knowledge/not-a-promotion",
      source: "consolidate",
      target: { source: "stash", root: stash },
      payload: {
        content: `---\ndescription: x\n---\n\n${RELEASE_NOTE}\n`,
        frontmatter: { description: "x" },
      },
    });
    const prompts = await judgedPrompts();
    expect(prompts.filter((p) => p.includes("knowledge/not-a-promotion"))).toHaveLength(1);
    expect(prompts.some((p) => p.includes("Existing knowledge notes"))).toBe(false);
  });
});

describe("consolidate-empty-as-none", () => {
  /**
   * A strict structured-output provider needs every property of the plan's
   * promote op in `required`, so the model says "none" in the value: an empty
   * `description` keeps the memory's own, a null `confidence` is no confidence.
   * `emitPromotionProposal` must read both as absent, not carry "" into the
   * proposal's frontmatter or reject a null where it expects a number.
   *
   * Integration (ORG-03): `emitPromotionProposal` mints into a real state.db.
   */

  const BODY =
    "Always run the release check on a clean checkout before tagging, because a dirty tree hides files the build needs. " +
    "The second sentence keeps this fixture above the promotion size gate.";

  let storage: IsolatedAkmStorage;
  let stash: string;
  let config: AkmConfig;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    stash = storage.stashDir;
    config = { ...makeConfig(stash), semanticSearchMode: "off" } as AkmConfig;
    fs.mkdirSync(path.join(stash, "memories"), { recursive: true });
    fs.mkdirSync(path.join(stash, "knowledge"), { recursive: true });
    fs.writeFileSync(
      path.join(stash, "memories", "release-check.md"),
      `---\ndescription: Run the release check on a clean checkout.\n---\n\n${BODY}\n`,
      "utf8",
    );
  });

  afterEach(() => storage.cleanup());

  /** Mint the promotion of `memories/release-check` for `reply` and return the one pending proposal. */
  async function promote(reply: Pick<ConsolidatePromoteOp, "description" | "confidence">) {
    const op: ConsolidatePromoteOp = {
      op: "promote",
      ref: "memories/release-check",
      knowledgeRef: "knowledge/release-check",
      reason: "Stable, reusable guidance.",
      ...reply,
    };
    const skips: string[] = [];
    await emitPromotionProposal(op, {
      config,
      stashDir: stash,
      sourceRun: "consolidate-test",
      target: resolveWriteTarget(config),
      memoryByRef: new Map([
        [
          op.ref,
          {
            name: "release-check",
            ref: "memories/release-check",
            filePath: path.join(stash, "memories", "release-check.md"),
            description: "Run the release check on a clean checkout.",
            tags: [],
            stashDir: stash,
          },
        ],
      ]),
      promoted: [],
      promotedSourceRefs: new Set(),
      existingKnowledgeBodyHashes: new Set(),
      promotionFailures: { count: 0 },
      warnings: [],
      pushSkipReason: (_op, _ref, reason) => skips.push(reason),
    });
    expect(skips).toEqual([]);
    const pending = listProposals(stash, { status: "pending" });
    expect(pending).toHaveLength(1);
    return pending[0]!;
  }

  describe("a promote op as a strict provider must write it", () => {
    test("an empty description keeps the memory's own and a null confidence records none", async () => {
      const proposal = await promote({ description: "", confidence: null });
      expect(proposal.payload.frontmatter?.description).toBe("Run the release check on a clean checkout.");
      expect(proposal.payload.content).toContain("description: Run the release check on a clean checkout.");
      expect(proposal).not.toHaveProperty("confidence");
    });

    test("a description and a confidence the model gave are used", async () => {
      const proposal = await promote({ description: "Run the release check before tagging.", confidence: 0.9 });
      expect(proposal.payload.frontmatter?.description).toBe("Run the release check before tagging.");
      expect(proposal.confidence).toBe(0.9);
    });
  });
});

describe("consolidate-scopes", () => {
  // Integration: exercises the real proposal/state database and publication/archive paths.

  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    storage.cleanup();
  });

  const keys = ["user", "agent", "run", "channel"] as const;
  const scope = Object.fromEntries(keys.map((key) => [`scope_${key}`, `original-${key}`]));
  const fm = keys.map((key) => `scope_${key}: original-${key}`).join("\n");
  const body =
    "The Larch recovery service requires the offline vault key from the custodian. Run the recovery check before restoring the backup, and retain the recovery log for seven days.\n";

  function setup() {
    const config = makeConfig(storage.stashDir);
    const file = path.join(storage.stashDir, "memories/source.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ndescription: Larch recovery\n${fm}\nxrefs: [knowledge/recovery-guide]\n---\n${body}`);
    const ctx: PromoteContext = {
      config,
      stashDir: storage.stashDir,
      sourceRun: "scope-test",
      target: resolveWriteTarget(config),
      memoryByRef: new Map([
        [
          "memories/source",
          {
            name: "source",
            ref: "memories/source",
            filePath: file,
            description: "Larch recovery",
            tags: [],
            stashDir: storage.stashDir,
          },
        ],
      ]),
      promoted: [],
      promotedSourceRefs: new Set(),
      existingKnowledgeBodyHashes: new Set(),
      promotionFailures: { count: 0 },
      warnings: [],
      pushSkipReason: () => {},
    };
    return { config, file, ctx };
  }
  async function promote(ctx: PromoteContext) {
    await emitPromotionProposal(
      {
        op: "promote",
        ref: "memories/source",
        knowledgeRef: "knowledge/recovery",
        reason: "durable recovery",
        description: "Larch recovery",
      },
      ctx,
    );
    expect(ctx.promoted).toHaveLength(1);
    return getProposal(storage.stashDir, ctx.promoted[0]!);
  }

  describe("promotion scope preservation (#1197)", () => {
    test("real writer and accepted output retain all scopes, body and source evidence", async () => {
      const { config, file, ctx } = setup();
      const proposal = await promote(ctx);
      expect(parseFrontmatter(proposalContent(proposal)).data).toMatchObject(scope);
      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
      const output = parseFrontmatter(fs.readFileSync(result.assetPath, "utf8"));
      expect(output.data).toMatchObject(scope);
      expect(output.content.trim()).toBe(body.trim());
      expect(output.data.xrefs).toContain("memories/source");
      expect(output.data.xrefs).toContain("knowledge/recovery-guide");
      expect(fs.existsSync(file)).toBe(false);
    });

    for (const key of keys)
      test(`scope-only source ${key} edit refuses publication and archival`, async () => {
        const { config, file, ctx } = setup();
        const proposal = await promote(ctx);
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`original-${key}`, `changed-${key}`));
        await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
          /scope/i,
        );
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.existsSync(path.join(storage.stashDir, "knowledge/recovery.md"))).toBe(false);
        expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
      });

    test("an older promotion with scope erased cannot publish or retire a scoped source", async () => {
      const { config, file } = setup();
      const proposal = createProposal(storage.stashDir, {
        source: "consolidate",
        ref: "knowledge/recovery",
        payload: {
          content: `---\ndescription: Larch recovery\n---\n${body}`,
          frontmatter: { description: "Larch recovery" },
        },
        promotionSource: "memories/source",
        promotionSourceHash: contentHash(fs.readFileSync(file, "utf8"), "body"),
      });
      await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config })).rejects.toThrow(
        /scope/i,
      );
      expect(fs.existsSync(file)).toBe(true);
    });

    test("a differently scoped derived twin survives promotion archive", async () => {
      const { config, file, ctx } = setup();
      const twin = file.replace(/\.md$/, ".derived.md");
      const original = fs.readFileSync(file, "utf8").replace("original-user", "other-user");
      fs.writeFileSync(twin, original);
      const proposal = await promote(ctx);
      await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, config });
      expect(fs.readFileSync(twin, "utf8")).toBe(original);
    });
  });
});

/**
 * Wave-2 QA fixes tests — Cluster B (#21, #36) and Cluster C (#6, #14, #24).
 *
 * Cluster B: llm/embedding subkey support in config-cli.
 * Cluster C: empty-query guards.
 */

// ── Cluster B: connection/embedding subkey support ────────────────────────────────

describe("config-cli: connections.* and embedding.* subkeys (#36)", () => {
  const base: AkmConfig = { semanticSearchMode: "auto" };

  // ── setConfigValue ────────────────────────────────────────────────────────
  // R-063 #5: previously exercised via `parseConfigValue`, a compatibility
  // shim removed as dead code (zero production callers) — see the note in
  // tests/config-cli.test.ts. `setConfigValue` is the live implementation.

  test("setConfigValue handles connections.local.endpoint", () => {
    const result = setConfigValue(base, "connections.local.endpoint", "http://localhost:11434/v1/chat/completions");
    expect(result.connections?.local?.endpoint).toBe("http://localhost:11434/v1/chat/completions");
  });

  test("setConfigValue handles connections.local.models.fast", () => {
    const result = setConfigValue(base, "connections.local.models.fast", "llama3.2");
    expect(result.connections?.local?.models).toEqual({ fast: "llama3.2" });
  });

  test("setConfigValue handles embedding.endpoint", () => {
    const result = setConfigValue(base, "embedding.endpoint", "http://localhost:11434/v1/embeddings");
    expect(result.embedding?.endpoint).toBe("http://localhost:11434/v1/embeddings");
  });

  test("setConfigValue handles embedding.model", () => {
    const result = setConfigValue(base, "embedding.model", "nomic-embed-text");
    expect(result.embedding?.model).toBe("nomic-embed-text");
  });

  test("setConfigValue accepts symbolic embedding credentials and rejects literals", () => {
    expect(setConfigValue(base, "embedding.apiKey", "$AKM_EMBED_API_KEY").embedding?.apiKey).toBe("$AKM_EMBED_API_KEY");
    expect(() => setConfigValue(base, "embedding.apiKey", "sk-embed")).toThrow(
      /apiKey cannot be a literal in config; use a \$VAR reference/,
    );
  });

  test("setConfigValue rejects an empty connection endpoint", () => {
    expect(() => setConfigValue(base, "connections.local.endpoint", "")).toThrow(/endpoint must be a complete URL/);
  });

  // ── getConfigValue ────────────────────────────────────────────────────────

  test("getConfigValue: connections.local.endpoint returns null when the connection is not set", () => {
    expect(getConfigValue(base, "connections.local.endpoint")).toBeNull();
  });

  test("getConfigValue: connection fields return values when set", () => {
    const config: AkmConfig = {
      ...base,
      connections: { local: { endpoint: "http://localhost/v1/chat/completions", models: { fast: "llama3.2" } } },
    };
    expect(getConfigValue(config, "connections.local.endpoint")).toBe("http://localhost/v1/chat/completions");
    expect(getConfigValue(config, "connections.local.models.fast")).toBe("llama3.2");
    expect(getConfigValue(config, "connections.local.apiKey")).toBeNull();
  });

  test("getConfigValue: embedding subkeys work", () => {
    const config: AkmConfig = {
      ...base,
      embedding: { endpoint: "http://localhost/emb", model: "bge-small" },
    };
    expect(getConfigValue(config, "embedding.endpoint")).toBe("http://localhost/emb");
    expect(getConfigValue(config, "embedding.model")).toBe("bge-small");
    expect(
      getConfigValue({ ...config, embedding: { ...config.embedding, apiKey: "$EMBED_KEY" } }, "embedding.apiKey"),
    ).toBe("$EMBED_KEY");
  });

  // ── setConfigValue with deep merge ────────────────────────────────────────

  test("setConfigValue: connection endpoint preserves sibling models", () => {
    const config: AkmConfig = {
      ...base,
      connections: { local: { endpoint: "http://old/chat/completions", models: { fast: "old-model" } } },
    };
    const result = setConfigValue(config, "connections.local.endpoint", "http://new/chat/completions");
    expect(result.connections?.local?.endpoint).toBe("http://new/chat/completions");
    expect(result.connections?.local?.models).toEqual({ fast: "old-model" });
  });

  test("setConfigValue: a connection's model alias preserves its endpoint", () => {
    const config: AkmConfig = {
      ...base,
      connections: { local: { endpoint: "http://localhost/v1/chat/completions", models: { fast: "old-model" } } },
    };
    const result = setConfigValue(config, "connections.local.models.fast", "gpt-4o");
    expect(result.connections?.local?.models).toEqual({ fast: "gpt-4o" });
    expect(result.connections?.local?.endpoint).toBe("http://localhost/v1/chat/completions");
  });

  test("setConfigValue: a literal connection apiKey is rejected with a $VAR hint (#454)", () => {
    const config: AkmConfig = { ...base };
    expect(() => setConfigValue(config, "connections.local.apiKey", "sk-secret")).toThrow(
      /apiKey cannot be a literal in config; use a \$VAR reference/,
    );
    expect(setConfigValue(config, "connections.local.apiKey", "$LOCAL_API_KEY").connections?.local?.apiKey).toBe(
      "$LOCAL_API_KEY",
    );
  });

  test("setConfigValue: embedding.endpoint works when embedding was undefined", () => {
    const result = setConfigValue(base, "embedding.endpoint", "http://localhost/emb");
    expect(result.embedding?.endpoint).toBe("http://localhost/emb");
    // Post-rewrite: subkey-set no longer scaffolds an empty `model`. The
    // user runs `embedding.model <name>` as a follow-up.
    expect(result.embedding?.model).toBeUndefined();
  });

  // ── unsetConfigValue ──────────────────────────────────────────────────────

  test("unsetConfigValue: connection endpoint removes the key", () => {
    const config: AkmConfig = {
      ...base,
      connections: { local: { endpoint: "http://localhost/v1/chat/completions", models: { fast: "llama3.2" } } },
    };
    const result = unsetConfigValue(config, "connections.local.endpoint");
    expect(result.connections?.local?.endpoint).toBeUndefined();
    expect(result.connections?.local?.models).toEqual({ fast: "llama3.2" });
  });

  test("unsetConfigValue: connection apiKey removes the key", () => {
    const config: AkmConfig = {
      ...base,
      connections: {
        local: {
          endpoint: "http://localhost/v1/chat/completions",
          models: { fast: "llama3.2" },
          apiKey: "$LOCAL_API_KEY",
        },
      },
    };
    const result = unsetConfigValue(config, "connections.local.apiKey");
    expect(result.connections?.local?.apiKey).toBeUndefined();
    expect(result.connections?.local?.endpoint).toBe("http://localhost/v1/chat/completions");
  });

  test("unsetConfigValue: embedding.apiKey removes the key", () => {
    const config: AkmConfig = {
      ...base,
      embedding: { endpoint: "http://localhost/emb", model: "bge-small", apiKey: "sk-embed" },
    };
    const result = unsetConfigValue(config, "embedding.apiKey");
    expect(result.embedding?.apiKey).toBeUndefined();
    expect(result.embedding?.endpoint).toBe("http://localhost/emb");
  });
});

// ── Cluster C: #14 empty query guard ────────────────────────────────────────

describe("search empty-query guard (#14, #24)", () => {
  // Note: The empty-query guard for `akmSearch` lives in the CLI layer (src/cli.ts),
  // not in `akmSearch` itself (which accepts empty queries for programmatic list-all).
  // The guard for `akmCurate` IS in the function itself since curation always
  // requires a meaningful query.

  test("akmCurate throws UsageError for empty string query", async () => {
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    await expect(akmCurate({ query: "" })).rejects.toThrow(/query is required/i);
  });

  test("akmCurate throws UsageError for whitespace-only query", async () => {
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    await expect(akmCurate({ query: "   " })).rejects.toThrow(/query is required/i);
  });

  test("akmCurate UsageError has MISSING_REQUIRED_ARGUMENT code", async () => {
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    const { UsageError } = await import("../../../../src/core/errors");
    try {
      await akmCurate({ query: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as import("../../../../src/core/errors").UsageError).code).toBe("MISSING_REQUIRED_ARGUMENT");
    }
  });
});
