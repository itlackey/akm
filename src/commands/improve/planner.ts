// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure improve planning projections.
 *
 * Filesystem/database snapshot collection stays in `preparation.ts`; this leaf
 * receives immutable values and is shared by dry preview and live execution.
 * Keeping the limit/lane projection here prevents the two entry paths from
 * independently reconstructing "what would run".
 */

import { conceptIdFromTypeName } from "../../core/asset/resolve-ref";
import type { ImproveEligibleRef, ImproveExecutionPlan, ImprovePlanGate } from "../../core/improve-types";
import type { ProcessRoutingRow } from "./improve-strategies";
import { parseMemoryName } from "./memory/derived-ref";

export interface EffectiveRefSelection {
  loopRefs: ImproveEligibleRef[];
  distillOnlyRefs: ImproveEligibleRef[];
  limitRemoved: number;
}

type MemoryCleanupProjectionInput =
  | {
      mode: "estimate";
      plannedRefs: readonly ImproveEligibleRef[];
      candidateRefs: readonly string[];
      allowApply: boolean;
    }
  | {
      mode: "execution";
      plannedRefs: readonly ImproveEligibleRef[];
      archivedRefs: readonly string[];
      allowApply: boolean;
    };

export interface MemoryCleanupProjection {
  postCleanupRefs: ImproveEligibleRef[];
  gate: ImprovePlanGate;
}

function canonicalMemoryConceptRef(ref: string): string | undefined {
  const name = parseMemoryName(ref);
  return name === undefined ? undefined : conceptIdFromTypeName("memory", name);
}

/**
 * Project the refs that survive memory cleanup from either the planned archive
 * candidates (dry estimate) or the archives that actually succeeded (live
 * execution). Cleanup records use the legacy `memory:<name>` identity channel,
 * while improve candidates use canonical `memories/<name>` concept refs, so
 * both sides are normalized before comparison.
 */
export function projectMemoryCleanup(input: MemoryCleanupProjectionInput): MemoryCleanupProjection {
  const cleanupRefs = input.allowApply ? (input.mode === "estimate" ? input.candidateRefs : input.archivedRefs) : [];
  const removed = new Set(cleanupRefs.map(canonicalMemoryConceptRef).filter((ref) => ref !== undefined));
  const postCleanupRefs = input.plannedRefs.filter((entry) => {
    const canonical = canonicalMemoryConceptRef(entry.ref);
    return canonical === undefined || !removed.has(canonical);
  });

  return {
    postCleanupRefs,
    gate: {
      name: "cleanup",
      removed: input.plannedRefs.length - postCleanupRefs.length,
      reason: !input.allowApply
        ? "memory cleanup archive application is autonomy-gated"
        : input.mode === "estimate"
          ? "would be archived by memory cleanup"
          : "archived by memory cleanup",
    },
  };
}

/**
 * Apply the final global cap to an already-ranked candidate snapshot.
 * Replay remains additive to the ordinary cap, matching the live #610 rule.
 */
export function selectEffectiveImproveRefs(args: {
  rankedRefs: readonly ImproveEligibleRef[];
  distillOnlyRefs: readonly ImproveEligibleRef[];
  limit?: number;
  replayBudget: number;
}): EffectiveRefSelection {
  const distillOnlySet = new Set(args.distillOnlyRefs.map((entry) => entry.ref));
  const reflectAndDistill = args.rankedRefs.filter((entry) => !distillOnlySet.has(entry.ref));
  const distillOnly = args.rankedRefs.filter((entry) => distillOnlySet.has(entry.ref));
  // Preserve the established live ordering: ordinary reflect-path refs first,
  // then distill-only refs, with the rank order stable inside each partition.
  const allLoopRefs = [...reflectAndDistill, ...distillOnly];
  const replay = allLoopRefs.filter((entry) => entry.eligibilitySource === "replay");
  const ordinary = allLoopRefs.filter((entry) => entry.eligibilitySource !== "replay");
  const selectedOrdinary = args.limit === undefined ? ordinary : ordinary.slice(0, args.limit);
  const loopRefs = [...selectedOrdinary, ...replay.slice(0, args.replayBudget)];
  return {
    loopRefs,
    distillOnlyRefs: distillOnly,
    limitRemoved: allLoopRefs.length - loopRefs.length,
  };
}

export interface ImprovePlanProjectionInput {
  dryRun: boolean;
  snapshot: ImproveExecutionPlan["snapshot"];
  rawInScope: number;
  selectedRefs: readonly ImproveEligibleRef[];
  effectiveRefs: readonly ImproveEligibleRef[];
  distillOnlyRefs: ReadonlySet<string>;
  configuredLimits: { cli?: number; profile?: number; reflect?: number };
  effectiveLimit?: number;
  replayBudget: number;
  gates: readonly ImprovePlanGate[];
  processes: readonly ProcessRoutingRow[];
  proactive?: ImproveExecutionPlan["proactive"];
  consolidation: ImproveExecutionPlan["consolidation"];
  stageConfig: {
    extract: { enabled: boolean; reason: string };
    graphExtraction: { enabled: boolean; reason: string };
    memoryInference: { enabled: boolean; reason: string };
  };
  triage: ImproveExecutionPlan["triage"];
}

/** Build the stable public plan DTO from one invocation's selector observation. */
export function buildImproveExecutionPlan(input: ImprovePlanProjectionInput): ImproveExecutionPlan {
  const effectiveRefs = input.effectiveRefs.map((entry) => ({
    ref: entry.ref,
    lane: input.distillOnlyRefs.has(entry.ref) ? ("distill-only" as const) : (entry.eligibilitySource ?? "unknown"),
    reason: entry.reason,
  }));
  return {
    mode: input.dryRun ? "estimate" : "execution",
    dispatch: !input.dryRun,
    snapshot: { ...input.snapshot },
    candidates: {
      rawInScope: input.rawInScope,
      selected: input.selectedRefs.length,
      effective: effectiveRefs.length,
    },
    limits: {
      configured: { ...input.configuredLimits },
      ...(input.effectiveLimit !== undefined ? { effective: input.effectiveLimit } : {}),
      additiveReplayAllowance: input.replayBudget,
      ...(input.effectiveLimit !== undefined ? { totalCeiling: input.effectiveLimit + input.replayBudget } : {}),
    },
    gates: input.gates.map((gate) => ({ ...gate })),
    effectiveRefs,
    processes: input.processes.map((row) => ({ ...row })),
    ...(input.proactive
      ? {
          proactive: {
            ...input.proactive,
            configured: { ...input.proactive.configured },
            effective: { ...input.proactive.effective },
            selectedRefs: [...input.proactive.selectedRefs],
          },
        }
      : {}),
    consolidation: {
      ...input.consolidation,
      configured: { ...input.consolidation.configured },
      effective: { ...input.consolidation.effective },
      gates: {
        profile: { ...input.consolidation.gates.profile },
        minimumPool: { ...input.consolidation.gates.minimumPool },
        delta: { ...input.consolidation.gates.delta },
      },
    },
    stages: [
      {
        name: "consolidation",
        wouldRun: input.consolidation.wouldRun,
        reason: input.consolidation.reason,
      },
      {
        name: "extract",
        wouldRun: input.stageConfig.extract.enabled,
        reason: input.stageConfig.extract.reason,
      },
      {
        name: "graph-extraction",
        wouldRun: input.stageConfig.graphExtraction.enabled,
        reason: input.stageConfig.graphExtraction.reason,
      },
      {
        name: "memory-inference",
        wouldRun: input.stageConfig.memoryInference.enabled,
        reason: input.stageConfig.memoryInference.reason,
      },
    ],
    triage: { ...input.triage },
  };
}
