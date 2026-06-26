// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Plan parsing / merging: pure reconciliation algebra over ConsolidateOperation
// arrays. No fs, no LLM, no config — validates ops and merges per-chunk plans
// into a single deduplicated, conflict-resolved op list.

import type {
  ConsolidateContradictOp,
  ConsolidateDeleteOp,
  ConsolidateMergeOp,
  ConsolidateOperation,
  ConsolidatePromoteOp,
} from "./types";

export function isValidOp(op: unknown): op is ConsolidateOperation {
  if (typeof op !== "object" || op === null) return false;
  const o = op as Record<string, unknown>;
  if (o.op === "merge") {
    return typeof o.primary === "string" && Array.isArray(o.secondaries);
  }
  if (o.op === "delete") {
    return typeof o.ref === "string";
  }
  if (o.op === "promote") {
    return typeof o.ref === "string" && typeof o.knowledgeRef === "string";
  }
  if (o.op === "contradict") {
    return typeof o.ref === "string" && typeof o.contradictedByRef === "string";
  }
  return false;
}

export function mergePlans(
  chunks: ConsolidateOperation[][],
  knownRefs?: Set<string>,
): { ops: ConsolidateOperation[]; warnings: string[] } {
  const mergeOps = new Map<string, ConsolidateMergeOp>();
  const deleteOps = new Map<string, ConsolidateDeleteOp>();
  const promoteOps = new Map<string, ConsolidatePromoteOp>();
  // C-3 / #382: contradict ops keyed by `ref|contradictedByRef` to deduplicate.
  const contradictOps = new Map<string, ConsolidateContradictOp>();
  const warnings: string[] = [];

  for (const chunk of chunks) {
    for (const op of chunk) {
      if (op.op === "merge") {
        // Drop ops whose primary the LLM hallucinated (not in the loaded memory
        // pool). Without this guard, a hallucinated primary flows all the way to
        // Phase B where !memoryByRef.has(primary) fires and charges every real
        // secondary with merge_primary_missing — masking LLM hallucinations as
        // filter regressions in health metrics.
        if (knownRefs && !knownRefs.has(op.primary)) {
          warnings.push(
            `mergePlans: primary ${op.primary} not in loaded memory pool (LLM hallucination) — dropping op before execution.`,
          );
          // Use a dedicated skip reason so dashboards can distinguish
          // hallucinated primaries from stale-DB regressions.
          // Secondaries are real refs; they are NOT charged here — they remain
          // available for other ops to claim.
          continue;
        }
        // Filter hallucinated secondaries while preserving real ones.
        let mergeOp: ConsolidateMergeOp = op;
        if (knownRefs) {
          const filteredSecondaries = op.secondaries.filter((sec) => {
            if (!knownRefs.has(sec)) {
              warnings.push(
                `mergePlans: secondary ${sec} not in loaded memory pool (LLM hallucination) — dropping from op.`,
              );
              return false;
            }
            return true;
          });
          if (filteredSecondaries.length !== op.secondaries.length) {
            mergeOp = { ...op, secondaries: filteredSecondaries };
          }
        }
        // merge wins over delete
        if (deleteOps.has(mergeOp.primary)) {
          deleteOps.delete(mergeOp.primary);
        }
        for (const sec of mergeOp.secondaries) {
          if (deleteOps.has(sec)) deleteOps.delete(sec);
        }
        mergeOps.set(mergeOp.primary, mergeOp);
      } else if (op.op === "delete") {
        // merge and promote both win over delete. A promote is non-destructive
        // (creates a proposal) but the source memory is counted in `promoted`;
        // if a delete also fires, the ref lands in both `promoted` and
        // `skipReasons`, breaking the invariant by +1.
        if (!mergeOps.has(op.ref) && !promoteOps.has(op.ref)) {
          deleteOps.set(op.ref, op);
        }
      } else if (op.op === "promote") {
        // C-2 / #381: when both a promote and a merge target the same ref,
        // queue the promote FIRST rather than discarding it. The promote op
        // routes through createProposal (the human-gated proposal queue), so
        // it is non-destructive. The merge follows after the proposal is
        // created. This preserves the human reviewer's ability to inspect the
        // promotion before the source memory is merged/deleted.
        // AGM K*8 — retain the maximally informative consistent subset.
        promoteOps.set(op.ref, op);
      } else if (op.op === "contradict") {
        // Deduplicate by ref+contradictedByRef pair.
        const key = `${op.ref}|${op.contradictedByRef}`;
        if (!contradictOps.has(key)) {
          contradictOps.set(key, op);
        }
      }
    }
  }

  // Second pass: enforce merge-wins-over-delete and deduplicate secondaries.
  //
  // 1. Delete/secondary ordering bug: the per-chunk loop removes delete ops
  //    for secondaries that were already in deleteOps, but misses the case
  //    where the delete chunk came first. A full sweep here fixes both orders.
  //
  // 2. Cross-merge secondary dedup: if ref A is a secondary in two merge ops,
  //    only the first (insertion-order) retains it. Without this, a successful
  //    merge credits A to mergedSecondaries and a later merge's emitMerge-
  //    FailureSkips also charges A to skipReasons — double-counting A while
  //    processed has it only once.
  //
  // 3. Primary-as-secondary dedup: if ref A is a primary in one merge op and
  //    a secondary in another, remove A from the secondary list. Both merges
  //    would otherwise claim A (merged++ for A, then mergedSecondaries++ for A)
  //    breaking the invariant the same way.
  // Also remove delete ops for any ref claimed by a promote op (handles the
  // case where the delete chunk appeared before the promote chunk).
  for (const ref of promoteOps.keys()) {
    deleteOps.delete(ref);
  }

  const claimedSecondaries = new Set<string>();
  for (const mergeOp of mergeOps.values()) {
    deleteOps.delete(mergeOp.primary);
    mergeOp.secondaries = mergeOp.secondaries.filter((sec) => {
      if (mergeOps.has(sec)) {
        warnings.push(
          `Merge: secondary ${sec} is also a merge primary — removing from secondary list to avoid double-count.`,
        );
        return false;
      }
      if (claimedSecondaries.has(sec)) {
        warnings.push(`Merge: secondary ${sec} appears in multiple merge ops — retaining in first op only.`);
        return false;
      }
      claimedSecondaries.add(sec);
      deleteOps.delete(sec);
      return true;
    });
  }

  // C-2 / #381: promote ops are ordered BEFORE merge ops so that the
  // human-gated proposal queue entry is created before any destructive merge.
  // Phase B processes ops in array order, so promote executes first.
  const ops: ConsolidateOperation[] = [
    ...promoteOps.values(),
    ...mergeOps.values(),
    ...deleteOps.values(),
    ...contradictOps.values(),
  ];
  return { ops, warnings };
}
