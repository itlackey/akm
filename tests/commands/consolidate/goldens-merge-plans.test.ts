// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: `mergePlans` reconciliation-algebra precedence table (WI-05,
 * plan §15.7 / R5). Chunk 0a brief §2.3, `anchors.md` `consolidate/merge.ts:35`
 * (precedence rules `:80-110`).
 *
 * `mergePlans` is a pure function (no fs, no LLM, no config) that merges
 * per-chunk `ConsolidateOperation[]` proposals into one deduplicated,
 * conflict-resolved op list. This suite pins its precedence table:
 *
 *   1. Hallucinated primary refs are dropped before execution; hallucinated
 *      secondary refs are filtered out of a surviving merge op.
 *   2. Merge (and promote) always win over a delete targeting the same ref,
 *      regardless of chunk order.
 *   3. A promote op is queued BEFORE a merge op on the same source ref (the
 *      human-gated proposal is created before the destructive merge runs) —
 *      pinned via `ops` ARRAY ORDER, since `applyConsolidationPlan` processes
 *      ops in array order (consolidate.ts brief anchor `:1887-1905`).
 *   4. Contradict ops are deduplicated by the `ref|contradictedByRef` pair,
 *      keeping the FIRST (insertion-order) occurrence.
 *
 * Byte-for-byte pure-function goldens: no timestamps, ids, or filesystem
 * state are involved, so `expectGolden`'s placeholder normalization is a
 * no-op here — the committed fixture is the literal `{ops, warnings}` output.
 *
 * Capture-only: no `src/` changes. Extends (does not duplicate)
 * `tests/commands/consolidate/consolidate-promote-dedup.test.ts`'s
 * `mergePlans` promote-by-ref dedup coverage — this suite covers the
 * hallucinated-ref, merge-vs-delete, promote-vs-merge-ordering, and
 * contradict-dedup rules that suite does not.
 *
 * Designation: `frozen-migration-input` (`DESIGNATIONS.json`) — `mergePlans`
 * is untouched surface until Chunk 7's decomposition; this is the
 * preservation oracle its reconciliation-algebra tests must keep matching.
 */

import { describe, expect, test } from "bun:test";
import {
  type ConsolidateContradictOp,
  type ConsolidateDeleteOp,
  type ConsolidateMergeOp,
  type ConsolidateOperation,
  type ConsolidatePromoteOp,
  mergePlans,
} from "../../../src/commands/improve/consolidate";
import { expectGolden } from "../../_helpers/golden";
import {
  MP_CONTRADICT_A,
  MP_CONTRADICT_B,
  MP_HALLUCINATED_PRIMARY,
  MP_HALLUCINATED_SECONDARY,
  MP_MERGE_DELETE_SECONDARY,
  MP_MERGE_DELETE_TARGET,
  MP_PROMOTE_MERGE_KNOWLEDGE,
  MP_PROMOTE_MERGE_TARGET,
  MP_REAL_PRIMARY,
  MP_REAL_SECONDARY,
} from "../../fixtures/goldens/consolidate/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/consolidate/merge-plans.json";
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";

function mergeOp(primary: string, secondaries: string[]): ConsolidateMergeOp {
  return { op: "merge", primary, secondaries, mergeStrategy: "synthesize" };
}
function deleteOp(ref: string): ConsolidateDeleteOp {
  return { op: "delete", ref, reason: "test reason" };
}
function promoteOp(ref: string, knowledgeRefStr: string): ConsolidatePromoteOp {
  return { op: "promote", ref, knowledgeRef: knowledgeRefStr, reason: "test reason" };
}
function contradictOp(ref: string, contradictedByRef: string): ConsolidateContradictOp {
  return { op: "contradict", ref, contradictedByRef, reason: "test reason" };
}

describe("mergePlans — hallucinated-ref drop", () => {
  test("drops a merge op whose primary is not in knownRefs", () => {
    const chunk: ConsolidateOperation[] = [mergeOp(MP_HALLUCINATED_PRIMARY, [MP_REAL_SECONDARY])];
    const knownRefs = new Set([MP_REAL_PRIMARY, MP_REAL_SECONDARY]);

    const { ops, warnings } = mergePlans([chunk], knownRefs);

    expect(ops).toEqual([]);
    expect(warnings.some((w) => w.includes(MP_HALLUCINATED_PRIMARY) && w.includes("hallucination"))).toBe(true);
  });

  test("filters a hallucinated secondary while preserving the op and its real secondary", () => {
    const chunk: ConsolidateOperation[] = [mergeOp(MP_REAL_PRIMARY, [MP_REAL_SECONDARY, MP_HALLUCINATED_SECONDARY])];
    const knownRefs = new Set([MP_REAL_PRIMARY, MP_REAL_SECONDARY]);

    const { ops, warnings } = mergePlans([chunk], knownRefs);

    expect(ops).toEqual([mergeOp(MP_REAL_PRIMARY, [MP_REAL_SECONDARY])]);
    expect(warnings.some((w) => w.includes(MP_HALLUCINATED_SECONDARY) && w.includes("hallucination"))).toBe(true);
  });
});

describe("mergePlans — merge wins over delete", () => {
  test("merge-then-delete chunk order: delete for the primary and a secondary is dropped", () => {
    const chunk1: ConsolidateOperation[] = [mergeOp(MP_MERGE_DELETE_TARGET, [MP_MERGE_DELETE_SECONDARY])];
    const chunk2: ConsolidateOperation[] = [deleteOp(MP_MERGE_DELETE_TARGET), deleteOp(MP_MERGE_DELETE_SECONDARY)];

    const { ops } = mergePlans([chunk1, chunk2]);

    expect(ops).toEqual([mergeOp(MP_MERGE_DELETE_TARGET, [MP_MERGE_DELETE_SECONDARY])]);
  });

  test("delete-then-merge chunk order: same outcome regardless of chunk order", () => {
    const chunk1: ConsolidateOperation[] = [deleteOp(MP_MERGE_DELETE_TARGET), deleteOp(MP_MERGE_DELETE_SECONDARY)];
    const chunk2: ConsolidateOperation[] = [mergeOp(MP_MERGE_DELETE_TARGET, [MP_MERGE_DELETE_SECONDARY])];

    const { ops } = mergePlans([chunk1, chunk2]);

    expect(ops).toEqual([mergeOp(MP_MERGE_DELETE_TARGET, [MP_MERGE_DELETE_SECONDARY])]);
  });
});

describe("mergePlans — promote queued before merge", () => {
  test("a promote and a merge on the same source ref: promote is ordered FIRST and the ref's delete is dropped", () => {
    const chunk: ConsolidateOperation[] = [
      deleteOp(MP_PROMOTE_MERGE_TARGET),
      promoteOp(MP_PROMOTE_MERGE_TARGET, MP_PROMOTE_MERGE_KNOWLEDGE),
      mergeOp(MP_PROMOTE_MERGE_TARGET, [MP_MERGE_DELETE_SECONDARY]),
    ];

    const { ops } = mergePlans([chunk]);

    expect(ops).toEqual([
      promoteOp(MP_PROMOTE_MERGE_TARGET, MP_PROMOTE_MERGE_KNOWLEDGE),
      mergeOp(MP_PROMOTE_MERGE_TARGET, [MP_MERGE_DELETE_SECONDARY]),
    ]);
  });
});

describe("mergePlans — contradict pair dedup", () => {
  test("deduplicates by the ref|contradictedByRef pair, keeping the first occurrence", () => {
    const chunk1: ConsolidateOperation[] = [{ ...contradictOp(MP_CONTRADICT_A, MP_CONTRADICT_B), reason: "first" }];
    const chunk2: ConsolidateOperation[] = [{ ...contradictOp(MP_CONTRADICT_A, MP_CONTRADICT_B), reason: "second" }];

    const { ops } = mergePlans([chunk1, chunk2]);

    expect(ops).toEqual([{ ...contradictOp(MP_CONTRADICT_A, MP_CONTRADICT_B), reason: "first" }]);
  });

  test("does NOT dedup a same-ref pair with a different contradictedByRef", () => {
    const chunk: ConsolidateOperation[] = [
      contradictOp(MP_CONTRADICT_A, MP_CONTRADICT_B),
      contradictOp(MP_CONTRADICT_A, MP_MERGE_DELETE_TARGET),
    ];

    const { ops } = mergePlans([chunk]);

    expect(ops).toEqual([
      contradictOp(MP_CONTRADICT_A, MP_CONTRADICT_B),
      contradictOp(MP_CONTRADICT_A, MP_MERGE_DELETE_TARGET),
    ]);
  });
});

// Re-runs every scenario above purely to assemble the committed golden
// fixture — kept independent of the assertion tests so this capture never
// depends on bun:test's within-file execution order.
test("golden fixture: serialize the mergePlans precedence table byte-for-byte", () => {
  const hallucinatedPrimary = mergePlans([[mergeOp(MP_HALLUCINATED_PRIMARY, [MP_REAL_SECONDARY])]], new Set([MP_REAL_PRIMARY, MP_REAL_SECONDARY]));
  const hallucinatedSecondary = mergePlans(
    [[mergeOp(MP_REAL_PRIMARY, [MP_REAL_SECONDARY, MP_HALLUCINATED_SECONDARY])]],
    new Set([MP_REAL_PRIMARY, MP_REAL_SECONDARY]),
  );
  const mergeWinsOverDelete = mergePlans([
    [mergeOp(MP_MERGE_DELETE_TARGET, [MP_MERGE_DELETE_SECONDARY])],
    [deleteOp(MP_MERGE_DELETE_TARGET), deleteOp(MP_MERGE_DELETE_SECONDARY)],
  ]);
  const promoteBeforeMerge = mergePlans([
    [
      deleteOp(MP_PROMOTE_MERGE_TARGET),
      promoteOp(MP_PROMOTE_MERGE_TARGET, MP_PROMOTE_MERGE_KNOWLEDGE),
      mergeOp(MP_PROMOTE_MERGE_TARGET, [MP_MERGE_DELETE_SECONDARY]),
    ],
  ]);
  const contradictDedup = mergePlans([
    [{ ...contradictOp(MP_CONTRADICT_A, MP_CONTRADICT_B), reason: "first" }],
    [{ ...contradictOp(MP_CONTRADICT_A, MP_CONTRADICT_B), reason: "second" }],
  ]);
  const contradictNoOverDedup = mergePlans([
    [contradictOp(MP_CONTRADICT_A, MP_CONTRADICT_B), contradictOp(MP_CONTRADICT_A, MP_MERGE_DELETE_TARGET)],
  ]);

  expectGolden(GOLDEN_PATH, {
    scenario: "mergePlans reconciliation-algebra precedence table (WI-05, R5, consolidate/merge.ts:35,80-110)",
    capturedAtHead: HEAD_SHA,
    notes: [
      "Pure-function goldens: mergePlans has no fs/LLM/config dependency, so this fixture is byte-for-byte the " +
        "literal {ops, warnings} output -- no <TS>/<ID> placeholders apply. Refs are fixture-local constants from " +
        "tests/fixtures/goldens/consolidate/fixture-refs.ts.",
      "Extends (does not duplicate) tests/commands/consolidate/consolidate-promote-dedup.test.ts's mergePlans " +
        "promote-by-ref dedup coverage.",
    ],
    cases: {
      hallucinatedPrimaryDropped: hallucinatedPrimary,
      hallucinatedSecondaryFiltered: hallucinatedSecondary,
      mergeWinsOverDelete: mergeWinsOverDelete,
      promoteQueuedBeforeMerge: promoteBeforeMerge,
      contradictPairDedup: contradictDedup,
      contradictNoOverDedupByRefAlone: contradictNoOverDedup,
    },
  });
});
