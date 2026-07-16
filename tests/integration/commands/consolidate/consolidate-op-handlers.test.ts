// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as consolidateModule from "../../../../src/commands/improve/consolidate";
import {
  type ConsolidateOpContext,
  handleContradictOp,
  handleDeleteOp,
  handleMergeOp,
  handlePromoteOp,
  makeConsolidateResult,
} from "../../../../src/commands/improve/consolidate";
import type {
  ConsolidateContradictOp,
  ConsolidateDeleteOp,
  ConsolidateMergeOp,
  ConsolidatePromoteOp,
  MemoryEntry,
} from "../../../../src/commands/improve/consolidate/types";
import { parseAssetRef, refToString } from "../../../../src/core/asset/asset-ref";
import { parseFrontmatter } from "../../../../src/core/asset/frontmatter";

// Direct unit tests for the op-handlers extracted out of `akmConsolidateInner`'s
// former ~600-LOC op-execution loop. These pin the deterministic pre-flight
// guards that short-circuit BEFORE any write-target I/O, so they run with a
// dummy target and never touch disk except for the delete hot-guard's file read.

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-ophandlers-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

type SkipCall = { op: string; ref: string; reason: string };

function makeCtx(overrides: Partial<ConsolidateOpContext> & { skips: SkipCall[] }): ConsolidateOpContext {
  const { skips, ...rest } = overrides;
  return {
    config: {} as ConsolidateOpContext["config"],
    stashDir: tmp,
    txn: {
      // Unregistered kind: markJournalCompleted's advanceTxn throws before any
      // fs write and is swallowed by its best-effort catch — a true no-op stub.
      journal: { kind: "stub-unregistered-kind", payload: { startedAt: "", operations: [], completed: [] } },
      journalPath: "",
      dir: "",
    } as unknown as ConsolidateOpContext["txn"],
    sourceRun: "test-run",
    target: {} as ConsolidateOpContext["target"],
    backupDir: path.join(tmp, "backup"),
    memoryByRef: new Map<string, MemoryEntry>(),
    promoted: [],
    promotedSourceRefs: new Set<string>(),
    warnings: [],
    counts: { merged: 0, deleted: 0, contradicted: 0, mergeFloorViolations: 0, mergedSecondaries: 0 },
    pushSkipReason: (op, ref, reason) => skips.push({ op, ref, reason }),
    ...rest,
  };
}

function entryFor(name: string, filePath: string): MemoryEntry {
  return { name, filePath, description: "", tags: [], stashDir: tmp };
}

describe("handleContradictOp — confidence gate", () => {
  it("skips (no edge) when confidence is below the 0.92 threshold", async () => {
    const skips: SkipCall[] = [];
    const ctx = makeCtx({ skips });
    const op: ConsolidateContradictOp = {
      op: "contradict",
      ref: "memory:a",
      contradictedByRef: "memory:b",
      reason: "x",
      confidence: 0.5,
    };

    await handleContradictOp(op, ctx);

    expect(ctx.counts.contradicted).toBe(0);
    expect(skips).toEqual([{ op: "contradict", ref: "memory:a", reason: "contradict_low_confidence" }]);
    expect(ctx.warnings.some((w) => w.includes("below 0.92 threshold"))).toBe(true);
  });
});

describe("handleDeleteOp — captureMode:hot guard", () => {
  it("refuses to delete a user-explicit hot memory", async () => {
    const filePath = path.join(tmp, "hot-mem.md");
    fs.writeFileSync(filePath, "---\ncaptureMode: hot\ntype: memory\n---\nbody\n", "utf8");
    const skips: SkipCall[] = [];
    const ctx = makeCtx({ skips, memoryByRef: new Map([["memory:hot-mem", entryFor("hot-mem", filePath)]]) });
    const op: ConsolidateDeleteOp = { op: "delete", ref: "memory:hot-mem", reason: "redundant" };

    await handleDeleteOp(op, 0, ctx);

    expect(ctx.counts.deleted).toBe(0);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(skips).toEqual([{ op: "delete", ref: "memory:hot-mem", reason: "captureMode_hot_refused" }]);
  });
});

describe("handlePromoteOp — within-run source dedup", () => {
  it("skips a source ref already promoted earlier in the same run", async () => {
    const skips: SkipCall[] = [];
    const ctx = makeCtx({
      skips,
      memoryByRef: new Map([["memory:dup", entryFor("dup", path.join(tmp, "dup.md"))]]),
      promotedSourceRefs: new Set(["memory:dup"]),
    });
    const op: ConsolidatePromoteOp = {
      op: "promote",
      ref: "memory:dup",
      knowledgeRef: "knowledge:dup",
      reason: "useful",
    };

    await handlePromoteOp(op, ctx);

    expect(ctx.promoted).toEqual([]);
    expect(skips).toEqual([{ op: "promote", ref: "memory:dup", reason: "promote_already_promoted_this_run" }]);
  });
});

describe("makeConsolidateResult — envelope defaults", () => {
  it("fills the all-zero, ok, non-preview baseline", () => {
    expect(makeConsolidateResult({ target: "stash", durationMs: 5 })).toEqual({
      schemaVersion: 1,
      ok: true,
      shape: "consolidate-result",
      dryRun: false,
      previewOnly: false,
      target: "stash",
      processed: 0,
      merged: 0,
      deleted: 0,
      promoted: [],
      contradicted: 0,
      warnings: [],
      durationMs: 5,
    });
  });

  it("applies overrides over the defaults", () => {
    const r = makeConsolidateResult({
      target: "stash",
      durationMs: 12,
      processed: 10,
      merged: 3,
      deleted: 2,
      warnings: ["w1"],
    });
    expect(r.processed).toBe(10);
    expect(r.merged).toBe(3);
    expect(r.deleted).toBe(2);
    expect(r.warnings).toEqual(["w1"]);
    // Untouched fields keep their baseline value.
    expect(r.contradicted).toBe(0);
    expect(r.promoted).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("consolidation merge provenance", () => {
  it("serializes canonical xrefs and removes legacy source_refs metadata", () => {
    const inject = (
      consolidateModule as unknown as {
        injectGenerationFrontmatter: (content: string, generations: number[], refs: string[]) => string;
      }
    ).injectGenerationFrontmatter;
    expect(typeof inject).toBe("function");
    const content = inject(
      "---\ndescription: Merged memory\nsource_refs: [memory:legacy]\nxrefs: [memory:existing]\n---\n\nMerged body.\n",
      [1, 2],
      ["memory:primary", "memory:secondary", "environment:alias", "not-a-ref"],
    );
    const parsed = parseFrontmatter(content);
    const xrefs = parsed.data.xrefs as string[];

    expect(parsed.data.source_refs).toBeUndefined();
    expect(xrefs).toEqual(["memory:existing", "memory:legacy", "memory:primary", "memory:secondary", "env:alias"]);
    expect(xrefs.every((ref) => refToString(parseAssetRef(ref)) === ref)).toBe(true);
  });

  for (const antiCollapseEnabled of [true, false]) {
    it(`injects generation and canonical provenance during merge execution when anti-collapse is ${antiCollapseEnabled ? "enabled" : "disabled"}`, async () => {
      const root = fs.mkdtempSync(path.join(tmp, "merge-"));
      const primaryPath = path.join(root, "memories", "primary.md");
      const secondaryPath = path.join(root, "memories", "secondary.md");
      fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
      fs.writeFileSync(
        primaryPath,
        "---\ndescription: Primary\ngeneration: 2\nxrefs: [memory:primary-xref]\nsource_refs: [environment:primary-legacy]\n---\n\nPrimary source body with distinct details.\n",
        "utf8",
      );
      fs.writeFileSync(
        secondaryPath,
        "---\ndescription: Secondary\ngeneration: 1\nxrefs: [memory:secondary-xref]\nsource_refs: [environment:secondary-legacy]\n---\n\nSecondary source body with other details.\n",
        "utf8",
      );
      const skips: SkipCall[] = [];
      const ctx = makeCtx({
        skips,
        stashDir: root,
        backupDir: path.join(root, ".akm", "backup"),
        improveProfile: {
          processes: { consolidate: { antiCollapse: { enabled: antiCollapseEnabled } } },
        } as never,
        target: {
          source: { kind: "filesystem", name: "local", path: root },
          config: { type: "filesystem", name: "local", path: root, writable: true },
        } as ConsolidateOpContext["target"],
        memoryByRef: new Map([
          ["memory:primary", entryFor("primary", primaryPath)],
          ["memory:secondary", entryFor("secondary", secondaryPath)],
        ]),
        generateMergedContentFn: (async () => ({
          content:
            "---\ndescription: Merged memory\nxrefs: [memory:output-existing]\nsource_refs: [environment:output-legacy]\n---\n\nPrimary source body with distinct details and secondary source body with other details.\n",
        })) as never,
      });
      const op: ConsolidateMergeOp = {
        op: "merge",
        primary: "memory:primary",
        secondaries: ["memory:secondary"],
        mergeStrategy: "synthesize",
      };

      await handleMergeOp(op, 0, ctx);

      const merged = parseFrontmatter(fs.readFileSync(primaryPath, "utf8"));
      expect(merged.data.generation).toBe(3);
      expect(merged.data.source_refs).toBeUndefined();
      expect(merged.data.xrefs).toEqual([
        "memory:output-existing",
        "env:output-legacy",
        "memory:primary",
        "memory:secondary",
        "memory:primary-xref",
        "env:primary-legacy",
        "memory:secondary-xref",
        "env:secondary-legacy",
      ]);
      expect(ctx.counts.merged).toBe(1);
    });
  }
});
