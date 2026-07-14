// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: consolidate op-outcome behavior preservation (WI-05, plan
 * §15.7 / R5). Chunk 0a brief §2.3, `anchors.md`
 * `consolidate.ts:2117` (`handleMergeOp`), `:2416` (`handleDeleteOp`),
 * `:2477` (`handlePromoteOp`), `:2693` (`handleContradictOp`), `:838`
 * (`archiveMemory`).
 *
 * This suite pins the OUTCOMES (not message wording) of the four consolidate
 * op-handlers extracted out of `akmConsolidateInner`'s op-execution loop —
 * the surface Chunk 7's decomposed passes must reproduce exactly (plan §12.2
 * DoD 5, §12.3). Capture-only: no `src/` changes.
 *
 * ## Harness — direct handler invocation, not a full `akmConsolidate` run
 *
 * Every scenario constructs a `ConsolidateOpContext` by hand (real on-disk
 * `memories`/`knowledge` dirs under a fresh `withIsolatedAkmStorage()`
 * sandbox, a `filesystem`-kind write target) and calls `handleMergeOp` /
 * `handleDeleteOp` / `handlePromoteOp` / `handleContradictOp` directly with a
 * pre-built `ConsolidateOperation`, extending the established pattern in
 * `tests/commands/consolidate/consolidate-op-handlers.test.ts`. WI-05 scopes
 * to op OUTCOMES, not op SELECTION (which is `planConsolidation`'s concern —
 * already covered by `consolidate-chunks.test.ts` and WI-06's
 * journal/hot-capture-guard/all-hot-skip suite), so driving the handlers
 * directly with hand-picked ops is the precise, deterministic, LLM-free way
 * to pin these outcomes without depending on chunk-planning nondeterminism.
 *
 * DEVIATION from the brief's step 2 prose ("stub chunk-plan via
 * overrideSeam(_setChatCompletionForTests)"): most merge scenarios below
 * inject a `generateMergedContentFn` directly into the `ConsolidateOpContext`
 * (brief's OTHER named technique, `consolidate.ts:2113`) instead of routing
 * merge-content generation through the real LLM transport — this gives
 * byte-for-byte control with no LLM stub needed. The ONE exception is the
 * "merge 1+2 secondaries" scenario below, which deliberately uses the REAL
 * (unexported, only reachable via the `ctx.generateMergedContentFn`
 * fallback) `generateMergedContent` with `_setChatCompletionForTests`
 * stubbed — because the one-LLM-call/all-archived asymmetry is a property of
 * that real function's `secondaryRefs[0]`-only read (consolidate.ts:2961),
 * which an injected stand-in would trivially not exhibit.
 *
 * ## Byte-for-byte encoding
 *
 * Per brief §3.2 rule 5, the merge-1+1-primary output and the contradict
 * high-confidence output are pinned as exact raw file bytes (string values,
 * `<TS>`-normalized by `expectGolden`) in addition to the parsed
 * frontmatter/body used elsewhere. All other scenarios use
 * `{relPath: {frontmatter, body}}` manifests (key-order-proof) plus outcome
 * booleans/counts/skip-reason strings — never raw journal/archive bytes or
 * timestamp-bearing filenames as object KEYS (`<TS>` only substitutes inside
 * string VALUES, so archive filenames are recorded as array values, never as
 * manifest keys — same convention as the WI-03/04 fileTree-key caveat).
 *
 * Designation: `frozen-migration-input` (`DESIGNATIONS.json`) — this is the
 * Chunk 7 DoD 5 oracle; it must stay green through Chunk 7's decomposition.
 *
 * Extends (does not duplicate) the 13 existing `tests/commands/consolidate/*`
 * suites: `consolidateGuardStatus`'s four verdicts are pinned directly by
 * `consolidate-eligibility.test.ts` (referenced here, not re-asserted); the
 * generation/provenance injection mechanics are pinned by
 * `consolidate-op-handlers.test.ts` (referenced here for the merge-provenance
 * assertions this suite does not repeat); `mergePlans` promote-by-ref dedup
 * is pinned by `consolidate-promote-dedup.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type ConsolidateContradictOp,
  type ConsolidateDeleteOp,
  type ConsolidateMergeOp,
  type ConsolidateOpContext,
  type ConsolidatePromoteOp,
  handleContradictOp,
  handleDeleteOp,
  handleMergeOp,
  handlePromoteOp,
} from "../../../src/commands/improve/consolidate";
import type { MemoryEntry } from "../../../src/commands/improve/consolidate/types";
import { createProposal, listProposals } from "../../../src/commands/proposal/repository";
import { assembleAsset } from "../../../src/core/asset/asset-serialize";
import type { AkmConfig } from "../../../src/core/config/config";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { _setChatCompletionForTests } from "../../../src/llm/client";
import { expectGolden } from "../../_helpers/golden";
import { overrideSeam } from "../../_helpers/seams";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import {
  CONTRADICT_ARCHIVED_BY_NAME,
  CONTRADICT_ARCHIVED_NAME,
  CONTRADICT_HIGH_CONF_BY_NAME,
  CONTRADICT_HIGH_CONF_NAME,
  CONTRADICT_LOW_CONF_BY_NAME,
  CONTRADICT_LOW_CONF_NAME,
  CONTRADICT_MISSING_CONF_BY_NAME,
  CONTRADICT_MISSING_CONF_NAME,
  DELETE_ALREADY_GONE_NAME,
  DELETE_HOT_REFUSED_NAME,
  DELETE_NORMAL_NAME,
  knowledgeRef,
  MERGE11_PRIMARY_NAME,
  MERGE11_SECONDARY_NAME,
  MERGE12_PRIMARY_NAME,
  MERGE12_SECONDARY_A_NAME,
  MERGE12_SECONDARY_B_NAME,
  MERGE_REFUSAL_GENERATION_PRIMARY_NAME,
  MERGE_REFUSAL_GENERATION_SECONDARY_NAME,
  MERGE_REFUSAL_HOT_PRIMARY_NAME,
  MERGE_REFUSAL_HOT_SECONDARY_NAME,
  MERGE_REFUSAL_MISSING_DESC_PRIMARY_NAME,
  MERGE_REFUSAL_MISSING_DESC_SECONDARY_NAME,
  MERGE_REFUSAL_TRUNCATED_DESC_PRIMARY_NAME,
  MERGE_REFUSAL_TRUNCATED_DESC_SECONDARY_NAME,
  MERGE_REFUSAL_UNPARSEABLE_PRIMARY_NAME,
  MERGE_REFUSAL_UNPARSEABLE_SECONDARY_NAME,
  memoryRef,
  PROMOTE_GATE_ALREADY_EXISTS_KNOWLEDGE_NAME,
  PROMOTE_GATE_ALREADY_EXISTS_NAME,
  PROMOTE_GATE_BODY_DEDUP_EXISTING_KNOWLEDGE_NAME,
  PROMOTE_GATE_BODY_DEDUP_NAME,
  PROMOTE_GATE_SLUG_DEDUP_EXISTING_KNOWLEDGE_NAME,
  PROMOTE_GATE_SLUG_DEDUP_KNOWLEDGE_NAME,
  PROMOTE_GATE_SLUG_DEDUP_NAME,
  PROMOTE_GATE_SUPERSEDED_NAME,
  PROMOTE_GATE_TOO_SMALL_NAME,
  PROMOTE_GATE_WITHIN_RUN_DEDUP_NAME,
  PROMOTE_HAPPY_KNOWLEDGE_NAME,
  PROMOTE_HAPPY_NAME,
} from "../../fixtures/goldens/consolidate/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/consolidate/consolidate-ops.json";
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";

const LONG_BODY =
  "This is a substantive memory body with enough distinct content to clear every merge/promote length floor " +
  "used across these fixtures (the 100-char promote floor and the 0.3x-of-larger-source merge floor).";

// ── Harness ──────────────────────────────────────────────────────────────────

type SkipCall = { op: string; ref: string; reason: string };

function makeTarget(root: string): ConsolidateOpContext["target"] {
  return {
    source: { kind: "filesystem", name: "local", path: root },
    config: { type: "filesystem", name: "local", path: root, writable: true },
  } as ConsolidateOpContext["target"];
}

function makeCtx(
  root: string,
  overrides: Partial<ConsolidateOpContext> & { skips: SkipCall[] },
): ConsolidateOpContext {
  const { skips, ...rest } = overrides;
  return {
    config: {} as ConsolidateOpContext["config"],
    stashDir: root,
    sourceRun: "goldens-consolidate-ops-test",
    target: makeTarget(root),
    backupDir: path.join(root, ".akm", "consolidate-backup", "test"),
    memoryByRef: new Map<string, MemoryEntry>(),
    promoted: [],
    promotedSourceRefs: new Set<string>(),
    warnings: [],
    counts: { merged: 0, deleted: 0, contradicted: 0, mergeFloorViolations: 0, mergedSecondaries: 0 },
    pushSkipReason: (op, ref, reason) => skips.push({ op, ref, reason }),
    ...rest,
  };
}

function memoryPath(root: string, name: string): string {
  return path.join(root, "memories", `${name}.md`);
}

/** Write a memory fixture file and return a MemoryEntry + its ref. */
function writeMemory(
  root: string,
  name: string,
  fm: Record<string, unknown> = {},
  body: string = LONG_BODY,
): { entry: MemoryEntry; ref: string; filePath: string } {
  const filePath = memoryPath(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, assembleAsset({ description: `${name} description`, ...fm }, body), "utf8");
  return { entry: { name, filePath, description: "", tags: [], stashDir: root }, ref: memoryRef(name), filePath };
}

/** Write a raw (possibly unparseable) memory file with no frontmatter helper. */
function writeRawMemory(root: string, name: string, raw: string): { entry: MemoryEntry; ref: string } {
  const filePath = memoryPath(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw, "utf8");
  return { entry: { name, filePath, description: "", tags: [], stashDir: root }, ref: memoryRef(name) };
}

function readAsset(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  return { frontmatter: parsed.data, body: parsed.content };
}

function listArchiveFiles(root: string): string[] {
  const dir = path.join(root, ".akm", "archive");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

function readArchiveAsset(root: string, filename: string): { frontmatter: Record<string, unknown>; body: string } {
  return readAsset(path.join(root, ".akm", "archive", filename));
}

/** Deterministic stand-in for `generateMergedContent` — no LLM involved. */
function stubGenerateMergedContent(content: string): {
  fn: ConsolidateOpContext["generateMergedContentFn"];
  callCount: () => number;
} {
  let calls = 0;
  return {
    fn: (async () => {
      calls++;
      return { content };
    }) as ConsolidateOpContext["generateMergedContentFn"],
    callCount: () => calls,
  };
}

function mergedContentWith(opts: { description: string; extraFm?: Record<string, unknown> }): string {
  return assembleAsset({ description: opts.description, ...(opts.extraFm ?? {}) }, LONG_BODY);
}

// ── Merge ────────────────────────────────────────────────────────────────────

describe("handleMergeOp — merge 1 primary + 1 secondary", () => {
  test("primary output pinned; secondary archived with superseded_by then deleted", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const primary = writeMemory(root, MERGE11_PRIMARY_NAME, { generation: 1, xrefs: ["memory:merge11-existing"] });
      const secondary = writeMemory(root, MERGE11_SECONDARY_NAME, { generation: 1 });
      const skips: SkipCall[] = [];
      const stub = stubGenerateMergedContent(
        mergedContentWith({ description: "Merged primary content", extraFm: { updated: "2026-06-01T00:00:00.000Z" } }),
      );
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [primary.ref, primary.entry],
          [secondary.ref, secondary.entry],
        ]),
        generateMergedContentFn: stub.fn,
      });
      const op: ConsolidateMergeOp = {
        op: "merge",
        primary: primary.ref,
        secondaries: [secondary.ref],
        mergeStrategy: "synthesize",
      };

      await handleMergeOp(op, 0, ctx);

      expect(stub.callCount()).toBe(1);
      expect(ctx.counts.merged).toBe(1);
      expect(skips).toEqual([]);
      // Primary rewritten in place with generation = max(sources)+1 and a
      // canonical xrefs union (injectGenerationFrontmatter, consolidate.ts:796).
      const primaryAsset = readAsset(primary.filePath);
      expect(primaryAsset.frontmatter.generation).toBe(2);
      expect((primaryAsset.frontmatter.xrefs as string[]).sort()).toEqual(
        [primary.ref, secondary.ref, "memory:merge11-existing"].sort(),
      );
      // Secondary archived then hard-deleted.
      expect(fs.existsSync(secondary.filePath)).toBe(false);
      const archived = listArchiveFiles(root);
      expect(archived).toHaveLength(1);
      const archivedAsset = readArchiveAsset(root, archived[0]);
      expect(archivedAsset.frontmatter.status).toBe("superseded");
      expect(archivedAsset.frontmatter.superseded_by).toBe(primary.ref);
      expect(archivedAsset.frontmatter.superseded_reason).toBe("merged into primary");
      expect(typeof archivedAsset.frontmatter.superseded_at).toBe("string");
    } finally {
      storage.cleanup();
    }
  });
});

describe("handleMergeOp — merge 1 primary + 2 secondaries (one-LLM-call/all-archived asymmetry)", () => {
  test("generateMergedContent is called exactly ONCE (reads only secondaries[0]) yet BOTH secondaries are archived+deleted", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const primary = writeMemory(root, MERGE12_PRIMARY_NAME, {});
      const secA = writeMemory(root, MERGE12_SECONDARY_A_NAME, { tagsA: ["only-a"] });
      const secB = writeMemory(root, MERGE12_SECONDARY_B_NAME, { tagsB: ["only-b"] });
      let chatCalls = 0;
      overrideSeam(_setChatCompletionForTests, async () => {
        chatCalls++;
        return mergedContentWith({ description: "Merged via real generateMergedContent" });
      });
      const skips: SkipCall[] = [];
      const config = {
        configVersion: "0.9.0",
        engines: { default: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "t" } },
        defaults: { llmEngine: "default" },
      } as unknown as AkmConfig;
      const ctx = makeCtx(root, {
        skips,
        config,
        memoryByRef: new Map([
          [primary.ref, primary.entry],
          [secA.ref, secA.entry],
          [secB.ref, secB.entry],
        ]),
        // No generateMergedContentFn override: falls back to the real,
        // unexported `generateMergedContent` (consolidate.ts:2951).
      });
      const op: ConsolidateMergeOp = {
        op: "merge",
        primary: primary.ref,
        secondaries: [secA.ref, secB.ref],
        mergeStrategy: "synthesize",
      };

      await handleMergeOp(op, 0, ctx);

      expect(chatCalls).toBe(1);
      expect(ctx.counts.merged).toBe(1);
      expect(skips).toEqual([]);
      // Both secondaries archived + deleted regardless of the single-call read.
      expect(fs.existsSync(secA.filePath)).toBe(false);
      expect(fs.existsSync(secB.filePath)).toBe(false);
      expect(listArchiveFiles(root)).toHaveLength(2);
      // Asymmetry made visible: only secondary A's frontmatter (secondaries[0],
      // the only one `generateMergedContent` actually reads) gets auto-repaired
      // into the merged primary's frontmatter; B's distinct key never appears.
      const primaryAsset = readAsset(primary.filePath);
      expect(primaryAsset.frontmatter.tagsA).toEqual(["only-a"]);
      expect(primaryAsset.frontmatter.tagsB).toBeUndefined();
    } finally {
      storage.cleanup();
    }
  });
});

describe("handleMergeOp — refusal matrix", () => {
  test("hot participant blocks the merge pre-flight (no content-generation call)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const primary = writeMemory(root, MERGE_REFUSAL_HOT_PRIMARY_NAME, {});
      const secondary = writeMemory(root, MERGE_REFUSAL_HOT_SECONDARY_NAME, { captureMode: "hot" });
      const skips: SkipCall[] = [];
      const stub = stubGenerateMergedContent(mergedContentWith({ description: "should not be reached" }));
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [primary.ref, primary.entry],
          [secondary.ref, secondary.entry],
        ]),
        generateMergedContentFn: stub.fn,
      });
      const op: ConsolidateMergeOp = { op: "merge", primary: primary.ref, secondaries: [secondary.ref], mergeStrategy: "synthesize" };

      await handleMergeOp(op, 0, ctx);

      expect(stub.callCount()).toBe(0);
      expect(ctx.counts.merged).toBe(0);
      expect(skips).toEqual([
        { op: "merge", ref: primary.ref, reason: "merge_participant_blocked" },
        { op: "merge", ref: secondary.ref, reason: "merge_participant_blocked" },
      ]);
      expect(fs.existsSync(secondary.filePath)).toBe(true);
    } finally {
      storage.cleanup();
    }
  });

  test("unparseable participant blocks the merge pre-flight (no content-generation call)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const primary = writeMemory(root, MERGE_REFUSAL_UNPARSEABLE_PRIMARY_NAME, {});
      const secondary = writeRawMemory(root, MERGE_REFUSAL_UNPARSEABLE_SECONDARY_NAME, "just body, no frontmatter\n");
      const skips: SkipCall[] = [];
      const stub = stubGenerateMergedContent(mergedContentWith({ description: "should not be reached" }));
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [primary.ref, primary.entry],
          [secondary.ref, secondary.entry],
        ]),
        generateMergedContentFn: stub.fn,
      });
      const op: ConsolidateMergeOp = { op: "merge", primary: primary.ref, secondaries: [secondary.ref], mergeStrategy: "synthesize" };

      await handleMergeOp(op, 0, ctx);

      expect(stub.callCount()).toBe(0);
      expect(skips).toEqual([
        { op: "merge", ref: primary.ref, reason: "merge_participant_blocked" },
        { op: "merge", ref: secondary.ref, reason: "merge_participant_blocked" },
      ]);
    } finally {
      storage.cleanup();
    }
  });

  test("missing description in generated content is refused", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const primary = writeMemory(root, MERGE_REFUSAL_MISSING_DESC_PRIMARY_NAME, {});
      const secondary = writeMemory(root, MERGE_REFUSAL_MISSING_DESC_SECONDARY_NAME, {});
      const skips: SkipCall[] = [];
      const stub = stubGenerateMergedContent(assembleAsset({}, LONG_BODY));
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [primary.ref, primary.entry],
          [secondary.ref, secondary.entry],
        ]),
        generateMergedContentFn: stub.fn,
      });
      const op: ConsolidateMergeOp = { op: "merge", primary: primary.ref, secondaries: [secondary.ref], mergeStrategy: "synthesize" };

      await handleMergeOp(op, 0, ctx);

      expect(stub.callCount()).toBe(1);
      expect(skips).toEqual([
        { op: "merge", ref: primary.ref, reason: "merge_missing_description" },
        { op: "merge", ref: secondary.ref, reason: "merge_missing_description" },
      ]);
    } finally {
      storage.cleanup();
    }
  });

  test("truncated description (hanging connector) in generated content is refused", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const primary = writeMemory(root, MERGE_REFUSAL_TRUNCATED_DESC_PRIMARY_NAME, {});
      const secondary = writeMemory(root, MERGE_REFUSAL_TRUNCATED_DESC_SECONDARY_NAME, {});
      const skips: SkipCall[] = [];
      const stub = stubGenerateMergedContent(mergedContentWith({ description: "Summary of the merge and" }));
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [primary.ref, primary.entry],
          [secondary.ref, secondary.entry],
        ]),
        generateMergedContentFn: stub.fn,
      });
      const op: ConsolidateMergeOp = { op: "merge", primary: primary.ref, secondaries: [secondary.ref], mergeStrategy: "synthesize" };

      await handleMergeOp(op, 0, ctx);

      expect(skips).toEqual([
        { op: "merge", ref: primary.ref, reason: "merge_truncated_description" },
        { op: "merge", ref: secondary.ref, reason: "merge_truncated_description" },
      ]);
    } finally {
      storage.cleanup();
    }
  });

  test("anti-collapse generation guard refuses when >=2 participants exceed maxGeneration (content WAS generated)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const primary = writeMemory(root, MERGE_REFUSAL_GENERATION_PRIMARY_NAME, { generation: 3 });
      const secondary = writeMemory(root, MERGE_REFUSAL_GENERATION_SECONDARY_NAME, { generation: 3 });
      const skips: SkipCall[] = [];
      const stub = stubGenerateMergedContent(mergedContentWith({ description: "Merged content that is refused later" }));
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [primary.ref, primary.entry],
          [secondary.ref, secondary.entry],
        ]),
        generateMergedContentFn: stub.fn,
      });
      const op: ConsolidateMergeOp = { op: "merge", primary: primary.ref, secondaries: [secondary.ref], mergeStrategy: "synthesize" };

      await handleMergeOp(op, 0, ctx);

      // Unlike the pre-flight guards above, the generation guard runs AFTER
      // content generation (consolidate.ts:2306, after the :2205 call) —
      // content generation still fires once before the refusal.
      expect(stub.callCount()).toBe(1);
      expect(skips).toEqual([
        { op: "merge", ref: primary.ref, reason: "merge_generation_guard" },
        { op: "merge", ref: secondary.ref, reason: "merge_generation_guard" },
      ]);
      expect(ctx.counts.merged).toBe(0);
    } finally {
      storage.cleanup();
    }
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe("handleDeleteOp", () => {
  test("normal delete: archived (status/superseded_at/superseded_reason, NO superseded_by) + live delete", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const { entry, ref, filePath } = writeMemory(root, DELETE_NORMAL_NAME, {});
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      const op: ConsolidateDeleteOp = { op: "delete", ref, reason: "redundant" };

      await handleDeleteOp(op, 0, ctx);

      expect(ctx.counts.deleted).toBe(1);
      expect(skips).toEqual([]);
      expect(fs.existsSync(filePath)).toBe(false);
      const archived = listArchiveFiles(root);
      expect(archived).toHaveLength(1);
      const archivedAsset = readArchiveAsset(root, archived[0]);
      expect(archivedAsset.frontmatter.status).toBe("superseded");
      expect(archivedAsset.frontmatter.superseded_reason).toBe("redundant");
      expect(archivedAsset.frontmatter.superseded_by).toBeUndefined();
    } finally {
      storage.cleanup();
    }
  });

  test("hot-refused: refuses to delete a captureMode:hot memory", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const { entry, ref, filePath } = writeMemory(root, DELETE_HOT_REFUSED_NAME, { captureMode: "hot" });
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      const op: ConsolidateDeleteOp = { op: "delete", ref, reason: "redundant" };

      await handleDeleteOp(op, 0, ctx);

      expect(ctx.counts.deleted).toBe(0);
      expect(skips).toEqual([{ op: "delete", ref, reason: "captureMode_hot_refused" }]);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(listArchiveFiles(root)).toHaveLength(0);
    } finally {
      storage.cleanup();
    }
  });

  test("already-gone: memoryByRef entry present but underlying file missing", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const ref = memoryRef(DELETE_ALREADY_GONE_NAME);
      const filePath = memoryPath(root, DELETE_ALREADY_GONE_NAME);
      const entry: MemoryEntry = { name: DELETE_ALREADY_GONE_NAME, filePath, description: "", tags: [], stashDir: root };
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      const op: ConsolidateDeleteOp = { op: "delete", ref, reason: "redundant" };

      await handleDeleteOp(op, 0, ctx);

      expect(ctx.counts.deleted).toBe(0);
      expect(skips).toEqual([{ op: "delete", ref, reason: "delete_already_gone" }]);
      expect(listArchiveFiles(root)).toHaveLength(0);
    } finally {
      storage.cleanup();
    }
  });
});

// ── Promote ──────────────────────────────────────────────────────────────────

describe("handlePromoteOp — happy path", () => {
  test("creates a proposal with description merged into body frontmatter and op.ref unioned into xrefs", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const { entry, ref } = writeMemory(root, PROMOTE_HAPPY_NAME, { xrefs: ["memory:promote-happy-existing"] });
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      const kRef = knowledgeRef(PROMOTE_HAPPY_KNOWLEDGE_NAME);
      const op: ConsolidatePromoteOp = {
        op: "promote",
        ref,
        knowledgeRef: kRef,
        reason: "useful",
        description: "A promoted knowledge asset",
      };

      await handlePromoteOp(op, ctx);

      expect(skips).toEqual([]);
      expect(ctx.promoted).toHaveLength(1);
      expect(ctx.promotedSourceRefs.has(ref)).toBe(true);
      const [proposal] = listProposals(root, { ref: kRef });
      expect(proposal).toBeDefined();
      expect(proposal?.payload.frontmatter?.description).toBe("A promoted knowledge asset");
      const bodyFm = parseFrontmatter(proposal?.payload.content ?? "").data;
      expect(bodyFm.description).toBe("A promoted knowledge asset");
      expect((bodyFm.xrefs as string[]).sort()).toEqual(["memory:promote-happy-existing", ref].sort());
    } finally {
      storage.cleanup();
    }
  });
});

describe("handlePromoteOp — gate matrix (consolidate.ts:2477-2690 order)", () => {
  test("within-run dedup: source ref already promoted this run", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const { entry, ref } = writeMemory(root, PROMOTE_GATE_WITHIN_RUN_DEDUP_NAME, {});
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]), promotedSourceRefs: new Set([ref]) });
      const op: ConsolidatePromoteOp = { op: "promote", ref, knowledgeRef: knowledgeRef("unused"), reason: "x" };

      await handlePromoteOp(op, ctx);

      expect(ctx.promoted).toEqual([]);
      expect(skips).toEqual([{ op: "promote", ref, reason: "promote_already_promoted_this_run" }]);
    } finally {
      storage.cleanup();
    }
  });

  test("existing-knowledge-file idempotency: destination asset already exists in source", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const { entry, ref } = writeMemory(root, PROMOTE_GATE_ALREADY_EXISTS_NAME, {});
      const destPath = path.join(root, "knowledge", `${PROMOTE_GATE_ALREADY_EXISTS_KNOWLEDGE_NAME}.md`);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, assembleAsset({ description: "already here" }, LONG_BODY), "utf8");
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      const op: ConsolidatePromoteOp = {
        op: "promote",
        ref,
        knowledgeRef: knowledgeRef(PROMOTE_GATE_ALREADY_EXISTS_KNOWLEDGE_NAME),
        reason: "x",
      };

      await handlePromoteOp(op, ctx);

      expect(ctx.promoted).toEqual([]);
      expect(skips).toEqual([{ op: "promote", ref, reason: "promote_already_exists" }]);
    } finally {
      storage.cleanup();
    }
  });

  test("superseded refusal: source memory has status:superseded", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const { entry, ref } = writeMemory(root, PROMOTE_GATE_SUPERSEDED_NAME, { status: "superseded" });
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      const op: ConsolidatePromoteOp = { op: "promote", ref, knowledgeRef: knowledgeRef("unused-superseded"), reason: "x" };

      await handlePromoteOp(op, ctx);

      expect(ctx.promoted).toEqual([]);
      expect(skips).toEqual([{ op: "promote", ref, reason: "promote_superseded" }]);
    } finally {
      storage.cleanup();
    }
  });

  test("<100-char floor: source memory body is too small", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const { entry, ref } = writeMemory(root, PROMOTE_GATE_TOO_SMALL_NAME, {}, "too short");
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      const op: ConsolidatePromoteOp = { op: "promote", ref, knowledgeRef: knowledgeRef("unused-too-small"), reason: "x" };

      await handlePromoteOp(op, ctx);

      expect(ctx.promoted).toEqual([]);
      expect(skips).toEqual([{ op: "promote", ref, reason: "promote_source_too_small" }]);
    } finally {
      storage.cleanup();
    }
  });

  test("pending-dup by body cacheHash: identical body already pending under a different target ref", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const SHARED_BODY =
        "Shared body content that is identical between the source memory and a pending proposal, extended so " +
        "it clears the one-hundred character promote floor.";
      const { entry, ref } = writeMemory(root, PROMOTE_GATE_BODY_DEDUP_NAME, {}, SHARED_BODY);
      const existing = createProposal(root, {
        ref: knowledgeRef(PROMOTE_GATE_BODY_DEDUP_EXISTING_KNOWLEDGE_NAME),
        source: "consolidate",
        payload: { content: assembleAsset({ description: "pre-existing" }, SHARED_BODY), frontmatter: { description: "pre-existing" } },
      });
      expect("id" in existing).toBe(true);
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      const op: ConsolidatePromoteOp = { op: "promote", ref, knowledgeRef: knowledgeRef("unused-body-dedup"), reason: "x" };

      await handlePromoteOp(op, ctx);

      expect(ctx.promoted).toEqual([]);
      expect(skips).toEqual([{ op: "promote", ref, reason: "dedup_pending_proposal" }]);
    } finally {
      storage.cleanup();
    }
  });

  test("slug-variant checkPreEmitDedup: pending proposal's ref normalizes to the same slug", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const { entry, ref } = writeMemory(
        root,
        PROMOTE_GATE_SLUG_DEDUP_NAME,
        {},
        "This body is deliberately DIFFERENT from the pending proposal's body so the cacheHash gate does not fire first.",
      );
      const existing = createProposal(root, {
        ref: knowledgeRef(PROMOTE_GATE_SLUG_DEDUP_EXISTING_KNOWLEDGE_NAME),
        source: "consolidate",
        payload: {
          content: assembleAsset({ description: "pre-existing slug variant" }, "A completely different pending body."),
          frontmatter: { description: "pre-existing slug variant" },
        },
      });
      expect("id" in existing).toBe(true);
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
      // PROMOTE_GATE_SLUG_DEDUP_KNOWLEDGE_NAME ("...-2026-05-03") and
      // PROMOTE_GATE_SLUG_DEDUP_EXISTING_KNOWLEDGE_NAME ("...-9") both strip
      // to the same token set under normalizeSlugForDedup (dates/counters and
      // numeric tokens are dropped, remaining tokens sorted).
      const op: ConsolidatePromoteOp = {
        op: "promote",
        ref,
        knowledgeRef: knowledgeRef(PROMOTE_GATE_SLUG_DEDUP_KNOWLEDGE_NAME),
        reason: "x",
      };

      await handlePromoteOp(op, ctx);

      expect(ctx.promoted).toEqual([]);
      expect(skips).toEqual([{ op: "promote", ref, reason: "promote_dedup_window" }]);
    } finally {
      storage.cleanup();
    }
  });
});

// ── Contradict ───────────────────────────────────────────────────────────────

describe("handleContradictOp", () => {
  test(">=0.92 confidence: byte-for-byte contradictedBy + beliefState edge (timestamp-free)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const a = writeMemory(root, CONTRADICT_HIGH_CONF_NAME, {});
      const b = writeMemory(root, CONTRADICT_HIGH_CONF_BY_NAME, {});
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [a.ref, a.entry],
          [b.ref, b.entry],
        ]),
      });
      const op: ConsolidateContradictOp = { op: "contradict", ref: a.ref, contradictedByRef: b.ref, reason: "x", confidence: 0.95 };

      await handleContradictOp(op, ctx);

      expect(ctx.counts.contradicted).toBe(1);
      expect(skips).toEqual([]);
      const asset = readAsset(a.filePath);
      expect(asset.frontmatter.contradictedBy).toEqual([b.ref]);
      expect(asset.frontmatter.beliefState).toBe("contradicted");

      // Idempotent re-run: a second call makes no further change to the file.
      const bytesAfterFirst = fs.readFileSync(a.filePath, "utf8");
      await handleContradictOp(op, ctx);
      expect(ctx.counts.contradicted).toBe(2); // counter still increments (op-level, not edge-level)
      const bytesAfterSecond = fs.readFileSync(a.filePath, "utf8");
      expect(bytesAfterSecond).toBe(bytesAfterFirst);
    } finally {
      storage.cleanup();
    }
  });

  test("archived state is preserved (never weakened) when a beliefState:archived memory is contradicted", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const a = writeMemory(root, CONTRADICT_ARCHIVED_NAME, { beliefState: "archived" });
      const b = writeMemory(root, CONTRADICT_ARCHIVED_BY_NAME, {});
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [a.ref, a.entry],
          [b.ref, b.entry],
        ]),
      });
      const op: ConsolidateContradictOp = { op: "contradict", ref: a.ref, contradictedByRef: b.ref, reason: "x", confidence: 1.0 };

      await handleContradictOp(op, ctx);

      const asset = readAsset(a.filePath);
      expect(asset.frontmatter.beliefState).toBe("archived");
      expect(asset.frontmatter.contradictedBy).toEqual([b.ref]);
    } finally {
      storage.cleanup();
    }
  });

  test("<0.92 confidence: skipped, no edge written", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const a = writeMemory(root, CONTRADICT_LOW_CONF_NAME, {});
      const b = writeMemory(root, CONTRADICT_LOW_CONF_BY_NAME, {});
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [a.ref, a.entry],
          [b.ref, b.entry],
        ]),
      });
      const op: ConsolidateContradictOp = { op: "contradict", ref: a.ref, contradictedByRef: b.ref, reason: "x", confidence: 0.5 };

      await handleContradictOp(op, ctx);

      expect(ctx.counts.contradicted).toBe(0);
      expect(skips).toEqual([{ op: "contradict", ref: a.ref, reason: "contradict_low_confidence" }]);
      const asset = readAsset(a.filePath);
      expect(asset.frontmatter.contradictedBy).toBeUndefined();
    } finally {
      storage.cleanup();
    }
  });

  test("missing confidence field defaults to 1.0 (treated as high-confidence)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const root = storage.stashDir;
      const a = writeMemory(root, CONTRADICT_MISSING_CONF_NAME, {});
      const b = writeMemory(root, CONTRADICT_MISSING_CONF_BY_NAME, {});
      const skips: SkipCall[] = [];
      const ctx = makeCtx(root, {
        skips,
        memoryByRef: new Map([
          [a.ref, a.entry],
          [b.ref, b.entry],
        ]),
      });
      const op = { op: "contradict", ref: a.ref, contradictedByRef: b.ref, reason: "x" } as ConsolidateContradictOp;
      expect("confidence" in op).toBe(false);

      await handleContradictOp(op, ctx);

      expect(ctx.counts.contradicted).toBe(1);
      expect(skips).toEqual([]);
      const asset = readAsset(a.filePath);
      expect(asset.frontmatter.beliefState).toBe("contradicted");
    } finally {
      storage.cleanup();
    }
  });
});

// ── Golden fixture: serialize every scenario above ─────────────────────────
//
// Re-runs every scenario purely to assemble the committed golden fixture --
// kept independent of the assertion tests above so this capture never
// depends on bun:test's within-file execution order. Every fixture uses a
// fresh sandbox (matching the assertion tests) so scenario ordering here
// cannot leak proposal/db state between cases.

async function captureMerge11(storage: IsolatedAkmStorage) {
  const root = storage.stashDir;
  const primary = writeMemory(root, MERGE11_PRIMARY_NAME, { generation: 1, xrefs: ["memory:merge11-existing"] });
  const secondary = writeMemory(root, MERGE11_SECONDARY_NAME, { generation: 1 });
  const skips: SkipCall[] = [];
  const stub = stubGenerateMergedContent(
    mergedContentWith({ description: "Merged primary content", extraFm: { updated: "2026-06-01T00:00:00.000Z" } }),
  );
  const ctx = makeCtx(root, {
    skips,
    memoryByRef: new Map([
      [primary.ref, primary.entry],
      [secondary.ref, secondary.entry],
    ]),
    generateMergedContentFn: stub.fn,
  });
  await handleMergeOp({ op: "merge", primary: primary.ref, secondaries: [secondary.ref], mergeStrategy: "synthesize" }, 0, ctx);
  const archived = listArchiveFiles(root);
  return {
    generateMergedContentCallCount: stub.callCount(),
    merged: ctx.counts.merged,
    skips,
    primaryRawBytes: fs.readFileSync(primary.filePath, "utf8"),
    secondaryDeleted: !fs.existsSync(secondary.filePath),
    archiveFileCount: archived.length,
    archived: archived.map((f) => ({ filename: f, ...readArchiveAsset(root, f) })),
  };
}

async function captureMerge12(storage: IsolatedAkmStorage) {
  const root = storage.stashDir;
  const primary = writeMemory(root, MERGE12_PRIMARY_NAME, {});
  const secA = writeMemory(root, MERGE12_SECONDARY_A_NAME, { tagsA: ["only-a"] });
  const secB = writeMemory(root, MERGE12_SECONDARY_B_NAME, { tagsB: ["only-b"] });
  let chatCalls = 0;
  overrideSeam(_setChatCompletionForTests, async () => {
    chatCalls++;
    return mergedContentWith({ description: "Merged via real generateMergedContent" });
  });
  const skips: SkipCall[] = [];
  const config = {
    configVersion: "0.9.0",
    engines: { default: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "t" } },
    defaults: { llmEngine: "default" },
  } as unknown as AkmConfig;
  const ctx = makeCtx(root, {
    skips,
    config,
    memoryByRef: new Map([
      [primary.ref, primary.entry],
      [secA.ref, secA.entry],
      [secB.ref, secB.entry],
    ]),
  });
  await handleMergeOp(
    { op: "merge", primary: primary.ref, secondaries: [secA.ref, secB.ref], mergeStrategy: "synthesize" },
    0,
    ctx,
  );
  return {
    chatCompletionCallCount: chatCalls,
    merged: ctx.counts.merged,
    bothSecondariesArchivedAndDeleted: !fs.existsSync(secA.filePath) && !fs.existsSync(secB.filePath) && listArchiveFiles(root).length === 2,
    primaryHasSecondaryAKeys: readAsset(primary.filePath).frontmatter.tagsA !== undefined,
    primaryHasSecondaryBKeys: readAsset(primary.filePath).frontmatter.tagsB !== undefined,
  };
}

async function captureMergeRefusal(
  storage: IsolatedAkmStorage,
  primaryName: string,
  secondaryName: string,
  secondaryRaw: string | null,
  secondaryFm: Record<string, unknown>,
  generatedContent: string | null,
) {
  const root = storage.stashDir;
  const primary = writeMemory(root, primaryName, {});
  const secondary = secondaryRaw !== null ? writeRawMemory(root, secondaryName, secondaryRaw) : writeMemory(root, secondaryName, secondaryFm);
  const skips: SkipCall[] = [];
  const stub = stubGenerateMergedContent(generatedContent ?? mergedContentWith({ description: "unused" }));
  const ctx = makeCtx(root, {
    skips,
    memoryByRef: new Map([
      [primary.ref, primary.entry],
      [secondary.ref, secondary.entry],
    ]),
    generateMergedContentFn: stub.fn,
  });
  await handleMergeOp({ op: "merge", primary: primary.ref, secondaries: [secondary.ref], mergeStrategy: "synthesize" }, 0, ctx);
  return { generateMergedContentCallCount: stub.callCount(), merged: ctx.counts.merged, skips };
}

async function captureDelete(storage: IsolatedAkmStorage, name: string, fm: Record<string, unknown>, dropFile: boolean) {
  const root = storage.stashDir;
  const { entry, ref, filePath } = writeMemory(root, name, fm);
  if (dropFile) fs.unlinkSync(filePath);
  const skips: SkipCall[] = [];
  const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
  await handleDeleteOp({ op: "delete", ref, reason: "redundant" }, 0, ctx);
  const archived = listArchiveFiles(root);
  return {
    deleted: ctx.counts.deleted,
    skips,
    fileGone: !fs.existsSync(filePath),
    archived: archived.map((f) => ({ filename: f, ...readArchiveAsset(root, f) })),
  };
}

async function capturePromoteHappy(storage: IsolatedAkmStorage) {
  const root = storage.stashDir;
  const { entry, ref } = writeMemory(root, PROMOTE_HAPPY_NAME, { xrefs: ["memory:promote-happy-existing"] });
  const skips: SkipCall[] = [];
  const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
  const kRef = knowledgeRef(PROMOTE_HAPPY_KNOWLEDGE_NAME);
  await handlePromoteOp(
    { op: "promote", ref, knowledgeRef: kRef, reason: "useful", description: "A promoted knowledge asset" },
    ctx,
  );
  const [proposal] = listProposals(root, { ref: kRef });
  const bodyFm = parseFrontmatter(proposal?.payload.content ?? "").data;
  return {
    promotedCount: ctx.promoted.length,
    skips,
    proposalDescription: proposal?.payload.frontmatter?.description,
    bodyDescription: bodyFm.description,
    bodyXrefs: (bodyFm.xrefs as string[] | undefined)?.slice().sort(),
  };
}

async function capturePromoteGate(
  storage: IsolatedAkmStorage,
  setup: (root: string, ref: string, entry: MemoryEntry) => { op: ConsolidatePromoteOp; extraCtx?: Partial<ConsolidateOpContext> },
  name: string,
  fm: Record<string, unknown>,
  body?: string,
) {
  const root = storage.stashDir;
  const { entry, ref } = writeMemory(root, name, fm, body);
  const { op, extraCtx } = setup(root, ref, entry);
  const skips: SkipCall[] = [];
  const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]), ...extraCtx });
  await handlePromoteOp(op, ctx);
  return { promotedCount: ctx.promoted.length, skips };
}

async function captureContradict(
  storage: IsolatedAkmStorage,
  aName: string,
  aFm: Record<string, unknown>,
  bName: string,
  op: (aRef: string, bRef: string) => ConsolidateContradictOp,
) {
  const root = storage.stashDir;
  const a = writeMemory(root, aName, aFm);
  const b = writeMemory(root, bName, {});
  const skips: SkipCall[] = [];
  const ctx = makeCtx(root, {
    skips,
    memoryByRef: new Map([
      [a.ref, a.entry],
      [b.ref, b.entry],
    ]),
  });
  const theOp = op(a.ref, b.ref);
  await handleContradictOp(theOp, ctx);
  const firstBytes = fs.readFileSync(a.filePath, "utf8");
  await handleContradictOp(theOp, ctx); // idempotent re-run
  const secondBytes = fs.readFileSync(a.filePath, "utf8");
  return {
    contradictedCountAfterTwoRuns: ctx.counts.contradicted,
    skips,
    firstRunRawBytes: firstBytes,
    idempotentReRunByteIdentical: firstBytes === secondBytes,
    frontmatter: readAsset(a.filePath).frontmatter,
  };
}

test("golden fixture: serialize consolidate op-outcome scenarios", async () => {
  const merge11 = await withStash(captureMerge11);
  const merge12 = await withStash(captureMerge12);
  const refusalHot = await withStash((s) =>
    captureMergeRefusal(s, MERGE_REFUSAL_HOT_PRIMARY_NAME, MERGE_REFUSAL_HOT_SECONDARY_NAME, null, { captureMode: "hot" }, null),
  );
  const refusalUnparseable = await withStash((s) =>
    captureMergeRefusal(
      s,
      MERGE_REFUSAL_UNPARSEABLE_PRIMARY_NAME,
      MERGE_REFUSAL_UNPARSEABLE_SECONDARY_NAME,
      "just body, no frontmatter\n",
      {},
      null,
    ),
  );
  const refusalMissingDesc = await withStash((s) =>
    captureMergeRefusal(
      s,
      MERGE_REFUSAL_MISSING_DESC_PRIMARY_NAME,
      MERGE_REFUSAL_MISSING_DESC_SECONDARY_NAME,
      null,
      {},
      assembleAsset({}, LONG_BODY),
    ),
  );
  const refusalTruncatedDesc = await withStash((s) =>
    captureMergeRefusal(
      s,
      MERGE_REFUSAL_TRUNCATED_DESC_PRIMARY_NAME,
      MERGE_REFUSAL_TRUNCATED_DESC_SECONDARY_NAME,
      null,
      {},
      mergedContentWith({ description: "Summary of the merge and" }),
    ),
  );
  const refusalGeneration = await withStash(async (storage) => {
    const root = storage.stashDir;
    const primary = writeMemory(root, MERGE_REFUSAL_GENERATION_PRIMARY_NAME, { generation: 3 });
    const secondary = writeMemory(root, MERGE_REFUSAL_GENERATION_SECONDARY_NAME, { generation: 3 });
    const skips: SkipCall[] = [];
    const stub = stubGenerateMergedContent(mergedContentWith({ description: "Merged content that is refused later" }));
    const ctx = makeCtx(root, {
      skips,
      memoryByRef: new Map([
        [primary.ref, primary.entry],
        [secondary.ref, secondary.entry],
      ]),
      generateMergedContentFn: stub.fn,
    });
    await handleMergeOp({ op: "merge", primary: primary.ref, secondaries: [secondary.ref], mergeStrategy: "synthesize" }, 0, ctx);
    return { generateMergedContentCallCount: stub.callCount(), merged: ctx.counts.merged, skips };
  });

  const deleteNormal = await withStash((s) => captureDelete(s, DELETE_NORMAL_NAME, {}, false));
  const deleteHotRefused = await withStash((s) => captureDelete(s, DELETE_HOT_REFUSED_NAME, { captureMode: "hot" }, false));
  const deleteAlreadyGone = await withStash(async (storage) => {
    const root = storage.stashDir;
    const ref = memoryRef(DELETE_ALREADY_GONE_NAME);
    const filePath = memoryPath(root, DELETE_ALREADY_GONE_NAME);
    const entry: MemoryEntry = { name: DELETE_ALREADY_GONE_NAME, filePath, description: "", tags: [], stashDir: root };
    const skips: SkipCall[] = [];
    const ctx = makeCtx(root, { skips, memoryByRef: new Map([[ref, entry]]) });
    await handleDeleteOp({ op: "delete", ref, reason: "redundant" }, 0, ctx);
    return { deleted: ctx.counts.deleted, skips };
  });

  const promoteHappy = await withStash(capturePromoteHappy);
  const promoteWithinRunDedup = await withStash((s) =>
    capturePromoteGate(
      s,
      (_root, ref) => ({
        op: { op: "promote", ref, knowledgeRef: knowledgeRef("unused"), reason: "x" },
        extraCtx: { promotedSourceRefs: new Set([ref]) },
      }),
      PROMOTE_GATE_WITHIN_RUN_DEDUP_NAME,
      {},
    ),
  );
  const promoteAlreadyExists = await withStash(async (storage) => {
    const root = storage.stashDir;
    const destPath = path.join(root, "knowledge", `${PROMOTE_GATE_ALREADY_EXISTS_KNOWLEDGE_NAME}.md`);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, assembleAsset({ description: "already here" }, LONG_BODY), "utf8");
    return capturePromoteGate(
      storage,
      (_root, ref) => ({
        op: { op: "promote", ref, knowledgeRef: knowledgeRef(PROMOTE_GATE_ALREADY_EXISTS_KNOWLEDGE_NAME), reason: "x" },
      }),
      PROMOTE_GATE_ALREADY_EXISTS_NAME,
      {},
    );
  });
  const promoteSuperseded = await withStash((s) =>
    capturePromoteGate(
      s,
      (_root, ref) => ({ op: { op: "promote", ref, knowledgeRef: knowledgeRef("unused-superseded"), reason: "x" } }),
      PROMOTE_GATE_SUPERSEDED_NAME,
      { status: "superseded" },
    ),
  );
  const promoteTooSmall = await withStash((s) =>
    capturePromoteGate(
      s,
      (_root, ref) => ({ op: { op: "promote", ref, knowledgeRef: knowledgeRef("unused-too-small"), reason: "x" } }),
      PROMOTE_GATE_TOO_SMALL_NAME,
      {},
      "too short",
    ),
  );
  const promoteBodyDedup = await withStash(async (storage) => {
    const root = storage.stashDir;
    const SHARED_BODY =
      "Shared body content that is identical between the source memory and a pending proposal, extended so " +
      "it clears the one-hundred character promote floor.";
    createProposal(root, {
      ref: knowledgeRef(PROMOTE_GATE_BODY_DEDUP_EXISTING_KNOWLEDGE_NAME),
      source: "consolidate",
      payload: { content: assembleAsset({ description: "pre-existing" }, SHARED_BODY), frontmatter: { description: "pre-existing" } },
    });
    return capturePromoteGate(
      storage,
      (_root, ref) => ({ op: { op: "promote", ref, knowledgeRef: knowledgeRef("unused-body-dedup"), reason: "x" } }),
      PROMOTE_GATE_BODY_DEDUP_NAME,
      {},
      SHARED_BODY,
    );
  });
  const promoteSlugDedup = await withStash(async (storage) => {
    const root = storage.stashDir;
    createProposal(root, {
      ref: knowledgeRef(PROMOTE_GATE_SLUG_DEDUP_EXISTING_KNOWLEDGE_NAME),
      source: "consolidate",
      payload: {
        content: assembleAsset({ description: "pre-existing slug variant" }, "A completely different pending body."),
        frontmatter: { description: "pre-existing slug variant" },
      },
    });
    return capturePromoteGate(
      storage,
      (_root, ref) => ({
        op: { op: "promote", ref, knowledgeRef: knowledgeRef(PROMOTE_GATE_SLUG_DEDUP_KNOWLEDGE_NAME), reason: "x" },
      }),
      PROMOTE_GATE_SLUG_DEDUP_NAME,
      {},
      "This body is deliberately DIFFERENT from the pending proposal's body so the cacheHash gate does not fire first.",
    );
  });

  const contradictHighConf = await withStash((s) =>
    captureContradict(s, CONTRADICT_HIGH_CONF_NAME, {}, CONTRADICT_HIGH_CONF_BY_NAME, (aRef, bRef) => ({
      op: "contradict",
      ref: aRef,
      contradictedByRef: bRef,
      reason: "x",
      confidence: 0.95,
    })),
  );
  const contradictArchivedPreserved = await withStash((s) =>
    captureContradict(s, CONTRADICT_ARCHIVED_NAME, { beliefState: "archived" }, CONTRADICT_ARCHIVED_BY_NAME, (aRef, bRef) => ({
      op: "contradict",
      ref: aRef,
      contradictedByRef: bRef,
      reason: "x",
      confidence: 1.0,
    })),
  );
  const contradictLowConf = await withStash(async (storage) => {
    const root = storage.stashDir;
    const a = writeMemory(root, CONTRADICT_LOW_CONF_NAME, {});
    const b = writeMemory(root, CONTRADICT_LOW_CONF_BY_NAME, {});
    const skips: SkipCall[] = [];
    const ctx = makeCtx(root, {
      skips,
      memoryByRef: new Map([
        [a.ref, a.entry],
        [b.ref, b.entry],
      ]),
    });
    await handleContradictOp(
      { op: "contradict", ref: a.ref, contradictedByRef: b.ref, reason: "x", confidence: 0.5 },
      ctx,
    );
    return { contradicted: ctx.counts.contradicted, skips, edgeWritten: readAsset(a.filePath).frontmatter.contradictedBy !== undefined };
  });
  const contradictMissingConfDefaultsHigh = await withStash(async (storage) => {
    const root = storage.stashDir;
    const a = writeMemory(root, CONTRADICT_MISSING_CONF_NAME, {});
    const b = writeMemory(root, CONTRADICT_MISSING_CONF_BY_NAME, {});
    const skips: SkipCall[] = [];
    const ctx = makeCtx(root, {
      skips,
      memoryByRef: new Map([
        [a.ref, a.entry],
        [b.ref, b.entry],
      ]),
    });
    const op = { op: "contradict", ref: a.ref, contradictedByRef: b.ref, reason: "x" } as ConsolidateContradictOp;
    await handleContradictOp(op, ctx);
    return { contradicted: ctx.counts.contradicted, skips, beliefState: readAsset(a.filePath).frontmatter.beliefState };
  });

  expectGolden(GOLDEN_PATH, {
    scenario: "consolidate op-outcome behavior preservation: merge/delete/promote/contradict (WI-05, R5)",
    capturedAtHead: HEAD_SHA,
    config: {
      note: "Direct handler invocation (handleMergeOp/handleDeleteOp/handlePromoteOp/handleContradictOp), not a full akmConsolidate() run -- see suite header comment for rationale. dedupPrePass:off, judgedCache:true (n/a to handler-level tests), hotProbation:off, antiCollapse:on (default), semanticSearchMode:'off' (n/a to handler-level tests).",
    },
    notes: [
      "Byte-for-byte pins (brief §3.2 rule 5): merge11.primaryRawBytes and contradict.contradictHighConf.firstRunRawBytes " +
        "are exact raw file bytes (after <TS> normalization). All other scenarios use parsed frontmatter/body plus " +
        "outcome booleans/counts/skip-reason strings.",
      "Designation: frozen-migration-input (DESIGNATIONS.json) -- Chunk 7 DoD 5 oracle; must stay green through " +
        "Chunk 7's decomposition of the op-execution loop.",
      "Archive filenames embed a timestampForFilename() token and are recorded as array VALUES (never object keys) " +
        "so <TS> normalization applies -- same convention as the WI-03/04 fileTree-key caveat.",
    ],
    cases: {
      merge: {
        oneOneByteForByte: merge11,
        onePlusTwoAsymmetry: merge12,
        refusalHotParticipant: refusalHot,
        refusalUnparseableParticipant: refusalUnparseable,
        refusalMissingDescription: refusalMissingDesc,
        refusalTruncatedDescription: refusalTruncatedDesc,
        refusalGenerationGuard: refusalGeneration,
      },
      delete: {
        normal: deleteNormal,
        hotRefused: deleteHotRefused,
        alreadyGone: deleteAlreadyGone,
      },
      promote: {
        happyPath: promoteHappy,
        gateWithinRunDedup: promoteWithinRunDedup,
        gateAlreadyExists: promoteAlreadyExists,
        gateSuperseded: promoteSuperseded,
        gateTooSmall: promoteTooSmall,
        gateBodyDedup: promoteBodyDedup,
        gateSlugDedup: promoteSlugDedup,
      },
      contradict: {
        highConfidence: contradictHighConf,
        archivedPreserved: contradictArchivedPreserved,
        lowConfidenceSkipped: contradictLowConf,
        missingConfidenceDefaultsHigh: contradictMissingConfDefaultsHigh,
      },
    },
  });
});

/** Run `fn` against a fresh sandbox, always cleaning up afterward. */
async function withStash<T>(fn: (storage: IsolatedAkmStorage) => Promise<T>): Promise<T> {
  const storage = withIsolatedAkmStorage();
  try {
    return await fn(storage);
  } finally {
    storage.cleanup();
  }
}
