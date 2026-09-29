// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { assembleAsset } from "../../../core/asset/asset-serialize";
import { mutateFrontmatter, parseFrontmatter } from "../../../core/asset/frontmatter";
import { MEMORY_ARCHIVE_REL } from "../../../core/asset/memory-archive";
import { conceptIdFromTypeName } from "../../../core/asset/resolve-ref";
import { asNonEmptyString, groupBy, stringArray, toPosix } from "../../../core/common";
import type {
  ArchivedMemoryCleanupRecord,
  MemoryBeliefState,
  MemoryBeliefStateTransition,
  MemoryConsolidationCandidate,
  MemoryContradictionCandidate,
  MemoryPruneCandidate,
  MemoryPruneReason,
  RelativeDateCandidate,
} from "../../../core/improve-types";
import { DERIVED_SUFFIX } from "../../../core/recognition-util";
import { warn } from "../../../core/warn";
import { recordWrittenPath } from "../../../core/write-provenance";
import { walkMarkdownFiles } from "../../../indexer/walk/walker";
import { isGitBackedStash, listGitChangedPaths, listGitTrackedPaths } from "../../../sources/providers/git-stash";
import { contentHash } from "../content-hash";
import { isDerivedMemory, memoryIdentityRef, parseMemoryName, resolveParentRef } from "./derived-ref";

export interface MemoryCleanupPlan {
  analyzedDerived: number;
  pruneCandidates: MemoryPruneCandidate[];
  contradictionCandidates: MemoryContradictionCandidate[];
  beliefStateTransitions: MemoryBeliefStateTransition[];
  consolidationCandidates: MemoryConsolidationCandidate[];
  relativeDateCandidates: RelativeDateCandidate[];
}

export interface MemoryBeliefTransitionLogRecord extends MemoryBeliefStateTransition {
  appliedAt: string;
}

export interface MemoryCleanupApplyResult {
  archived: ArchivedMemoryCleanupRecord[];
  beliefStateTransitions: MemoryBeliefStateTransition[];
  transitionLogPath?: string;
  transitionLogEntries?: number;
  warnings?: string[];
  /** M-5 / #396: Number of relative-date expressions resolved to absolute dates. */
  relativeDatesResolved?: number;
}

export interface MemoryCleanupOptions {
  parentRef?: string;
}

interface DerivedMemoryRecord {
  ref: string;
  name: string;
  filePath: string;
  parentRef: string;
  title: string;
  description: string;
  tags: string[];
  searchHints: string[];
  body: string;
  canonicalName: boolean;
  signalScore: number;
  fingerprint: string;
  signalKey?: string;
  supersededBy: string[];
  contradictedBy: string[];
  currentBeliefRefs: string[];
  obsolete: boolean;
  beliefState: Exclude<MemoryBeliefState, "archived">;
}

interface PlannedPrune extends MemoryPruneCandidate {
  filePath: string;
}

interface FamilyContradictionResolution {
  contradictionCandidates: MemoryContradictionCandidate[];
  transitions: MemoryBeliefStateTransition[];
}

export function analyzeMemoryCleanup(stashDir: string, options: MemoryCleanupOptions = {}): MemoryCleanupPlan {
  const records = collectDerivedMemories(stashDir, options.parentRef);
  const byRef = new Map(records.map((record) => [record.ref, record]));
  const byParent = groupBy(records, (record) => record.parentRef);
  const planned = new Map<string, PlannedPrune>();
  const contradictionCandidates: MemoryContradictionCandidate[] = [];
  const beliefTransitions = new Map<string, MemoryBeliefStateTransition>();

  const planPrune = (record: DerivedMemoryRecord, reason: MemoryPruneReason, survivorRef?: string) => {
    const existing = planned.get(record.ref);
    if (existing) return existing;
    const next: PlannedPrune = {
      ref: record.ref,
      parentRef: record.parentRef,
      reason,
      ...(survivorRef ? { survivorRef } : {}),
      filePath: record.filePath,
    };
    planned.set(record.ref, next);
    return next;
  };

  const planBeliefTransition = (
    record: DerivedMemoryRecord,
    toState: Exclude<MemoryBeliefState, "archived">,
    reason: MemoryBeliefStateTransition["reason"],
    currentBeliefRefs: string[] = [],
  ) => {
    const normalizedRefs = [...new Set(currentBeliefRefs)].sort();
    const metadataChanged =
      !sameStringArray(record.currentBeliefRefs, normalizedRefs) ||
      (toState === "contradicted"
        ? !sameStringArray(record.contradictedBy, normalizedRefs)
        : record.contradictedBy.length > 0);
    if (record.beliefState === toState && !metadataChanged) return;

    const existing = beliefTransitions.get(record.ref);
    if (existing) return existing;

    const next: MemoryBeliefStateTransition = {
      ref: record.ref,
      parentRef: record.parentRef,
      fromState: record.beliefState,
      toState,
      reason,
      ...(normalizedRefs[0] ? { relatedRef: normalizedRefs[0] } : {}),
      ...(normalizedRefs.length > 0 ? { relatedRefs: normalizedRefs, currentBeliefRefs: normalizedRefs } : {}),
    };
    beliefTransitions.set(record.ref, next);
    return next;
  };

  for (const record of records) {
    const supersededTarget = firstExistingRef(record.supersededBy, byRef, record.ref);
    if (supersededTarget) {
      planPrune(record, "superseded-derived", supersededTarget);
      continue;
    }
    if (record.obsolete) {
      planPrune(record, "obsolete-derived");
    }
  }

  const excludedRefs = new Set<string>(planned.keys());
  for (const family of byParent.values()) {
    const activeFamily = family.filter((record) => !excludedRefs.has(record.ref));
    const resolution = resolveFamilyContradictions(activeFamily);
    for (const candidate of resolution.contradictionCandidates) {
      contradictionCandidates.push(candidate);
    }
    for (const transition of resolution.transitions) {
      const record = byRef.get(transition.ref);
      if (!record) continue;
      planBeliefTransition(record, transition.toState, transition.reason, transition.currentBeliefRefs ?? []);
    }
  }

  const excludedForDuplicateDetection = new Set<string>([
    ...planned.keys(),
    ...contradictionCandidates.map((candidate) => candidate.ref),
  ]);

  for (const family of byParent.values()) {
    const active = family.filter((record) => !excludedForDuplicateDetection.has(record.ref));
    const byFingerprint = groupBy(active, (record) => record.fingerprint);
    for (const duplicates of byFingerprint.values()) {
      if (duplicates.length < 2) continue;
      const [survivor, ...rest] = sortRecordsForSurvival(duplicates);
      if (survivor === undefined) continue;
      for (const duplicate of rest) {
        planPrune(duplicate, "duplicate-derived", survivor.ref);
      }
    }
  }

  const consolidationCandidates: MemoryConsolidationCandidate[] = [];
  const excludedForConsolidation = new Set<string>([
    ...planned.keys(),
    ...contradictionCandidates.map((candidate) => candidate.ref),
  ]);
  for (const [parentRef, family] of byParent.entries()) {
    const active = family.filter((record) => !excludedForConsolidation.has(record.ref));
    if (active.length < 2) continue;
    const bySignal = groupBy(
      active.filter((record) => record.signalKey !== undefined),
      (record) => record.signalKey as string,
    );
    for (const [signal, signalRecords] of bySignal.entries()) {
      if (signalRecords.length < 2) continue;
      const ordered = sortRecordsForSurvival(signalRecords);
      consolidationCandidates.push({
        parentRef,
        signal,
        refs: ordered.map((record) => record.ref),
        suggestedSurvivorRef: ordered[0]!.ref,
      });
    }
  }

  const RELATIVE_DATE_RE =
    /\b(yesterday|last week|last month|last year|\d+ days? ago|\d+ weeks? ago|\d+ months? ago)\b/gi;

  const relativeDateCandidates: RelativeDateCandidate[] = [];
  for (const record of records) {
    const matches = record.body.match(RELATIVE_DATE_RE);
    if (matches && matches.length > 0) {
      relativeDateCandidates.push({
        ref: record.ref,
        filePath: record.filePath,
        matches: [...new Set(matches.map((m) => m.toLowerCase()))],
      });
    }
  }

  return {
    analyzedDerived: records.length,
    pruneCandidates: [...planned.values()]
      .map(({ filePath: _filePath, ...candidate }) => candidate)
      .sort(compareCandidates),
    contradictionCandidates: contradictionCandidates.sort(compareContradictionCandidates),
    beliefStateTransitions: [...beliefTransitions.values()].sort(compareBeliefTransitions),
    consolidationCandidates: consolidationCandidates.sort(compareConsolidationCandidates),
    relativeDateCandidates,
  };
}

export function applyMemoryCleanup(stashDir: string, plan: MemoryCleanupPlan): MemoryCleanupApplyResult {
  const records = collectDerivedMemories(stashDir);
  const fileByRef = new Map(records.map((record) => [record.ref, record.filePath]));
  const archived: ArchivedMemoryCleanupRecord[] = [];
  const appliedBeliefTransitions: MemoryBeliefStateTransition[] = [];
  const warnings: string[] = [];

  for (const transition of plan.beliefStateTransitions) {
    const filePath = fileByRef.get(transition.ref);
    if (!filePath) continue;
    try {
      persistBeliefStateTransition(filePath, transition);
      appliedBeliefTransitions.push(transition);
    } catch (error) {
      warnings.push(formatApplyWarning("belief-transition", transition.ref, error));
    }
  }

  let transitionLogPath: string | undefined;
  if (appliedBeliefTransitions.length > 0) {
    try {
      transitionLogPath = appendBeliefStateTransitionLog(stashDir, appliedBeliefTransitions);
    } catch (error) {
      warnings.push(formatApplyWarning("transition-log", "memory-cleanup", error));
    }
  }

  for (const candidate of plan.pruneCandidates) {
    const filePath = fileByRef.get(candidate.ref);
    if (!filePath) continue;
    try {
      archived.push(archiveCleanupCandidate(stashDir, candidate, filePath));
    } catch (error) {
      warnings.push(formatApplyWarning("archive", candidate.ref, error));
    }
  }

  // M-5 / #396: Resolve relative dates for flagged candidates.
  // Anchor: use the file's `createdAt` frontmatter field, or fall back to the
  // file's mtime. Graphiti arXiv:2501.13956, HeidelTime (Strötgen & Gertz 2010).
  let relativeDatesResolved = 0;
  for (const candidate of plan.relativeDateCandidates) {
    try {
      const raw = fs.readFileSync(candidate.filePath, "utf8");
      const fm = parseFrontmatter(raw);
      const createdAtStr = fm.data.createdAt as string | undefined;
      let referenceDate: Date;
      if (createdAtStr) {
        const parsed = new Date(createdAtStr);
        referenceDate = Number.isNaN(parsed.getTime()) ? new Date(fs.statSync(candidate.filePath).mtimeMs) : parsed;
      } else {
        referenceDate = new Date(fs.statSync(candidate.filePath).mtimeMs);
      }
      const resolvedBody = resolveRelativeDates(fm.content ?? "", referenceDate);
      if (resolvedBody === (fm.content ?? "")) continue; // no change
      const newContent = assembleAsset(fm.data, resolvedBody);
      fs.writeFileSync(candidate.filePath, newContent, "utf8");
      // #652: relative-date resolution rewrites the asset in place.
      recordWrittenPath(candidate.filePath);
      relativeDatesResolved++;
    } catch (error) {
      warnings.push(formatApplyWarning("relative-date-resolve", candidate.ref, error));
    }
  }

  archived.sort((a, b) => a.ref.localeCompare(b.ref));
  appliedBeliefTransitions.sort(compareBeliefTransitions);
  return {
    archived,
    beliefStateTransitions: appliedBeliefTransitions,
    ...(transitionLogPath ? { transitionLogPath: path.relative(stashDir, transitionLogPath).replace(/\\/g, "/") } : {}),
    ...(transitionLogPath ? { transitionLogEntries: appliedBeliefTransitions.length } : {}),
    ...(relativeDatesResolved > 0 ? { relativeDatesResolved } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function formatApplyWarning(stage: string, ref: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${stage} failed for ${ref}: ${detail}`;
}

/**
 * M-5 / #396: Resolve relative date expressions to absolute ISO dates.
 *
 * Uses `referenceDate` as the anchor point (Graphiti arXiv:2501.13956,
 * HeidelTime Strötgen & Gertz 2010 — document creation time as reference).
 * Replaces patterns like "yesterday", "3 days ago", "last week" with their
 * ISO 8601 date string (YYYY-MM-DD).
 *
 * Returns the rewritten string; returns the original if no matches.
 */
function resolveRelativeDates(text: string, referenceDate: Date): string {
  const RELATIVE_DATE_RE =
    /\b(yesterday|last week|last month|last year|\d+ days? ago|\d+ weeks? ago|\d+ months? ago)\b/gi;
  return text.replace(RELATIVE_DATE_RE, (match) => {
    const lower = match.toLowerCase().trim();
    const d = new Date(referenceDate);
    if (lower === "yesterday") {
      d.setDate(d.getDate() - 1);
    } else if (lower === "last week") {
      d.setDate(d.getDate() - 7);
    } else if (lower === "last month") {
      d.setMonth(d.getMonth() - 1);
    } else if (lower === "last year") {
      d.setFullYear(d.getFullYear() - 1);
    } else {
      const numMatch = lower.match(/^(\d+)\s+(day|week|month)s?\s+ago$/);
      if (numMatch) {
        const n = Number.parseInt(numMatch[1] ?? "0", 10);
        const unit = numMatch[2] ?? "day";
        if (unit === "day") d.setDate(d.getDate() - n);
        else if (unit === "week") d.setDate(d.getDate() - n * 7);
        else if (unit === "month") d.setMonth(d.getMonth() - n);
      } else {
        return match; // unrecognized pattern — leave as-is
      }
    }
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  });
}

function resolveFamilyContradictions(family: DerivedMemoryRecord[]): FamilyContradictionResolution {
  if (family.length === 0) return { contradictionCandidates: [], transitions: [] };

  const familyRefSet = new Set(family.map((record) => record.ref));
  const edges = new Map<string, string[]>();
  let edgeCount = 0;

  for (const record of family) {
    const targets = [
      ...new Set(record.contradictedBy.filter((ref) => ref !== record.ref && familyRefSet.has(ref))),
    ].sort();
    edges.set(record.ref, targets);
    edgeCount += targets.length;
  }

  if (edgeCount === 0) {
    return {
      contradictionCandidates: [],
      transitions: family
        .filter((record) => {
          // `deprecated` is a frozen historical state — never refresh it to active.
          // (`superseded` is intentionally still refreshable to preserve pre-Phase-1A behavior.)
          if (isFrozenHistoricalBeliefState(record.beliefState)) return false;
          // `active` and `asserted` are both "current/believed" states. Only emit a
          // refresh if there is something to clear (contradictions / currentBeliefRefs)
          // or the state is something else entirely (e.g. lingering `contradicted`).
          if (isActiveLikeBeliefState(record.beliefState)) {
            return record.contradictedBy.length > 0 || record.currentBeliefRefs.length > 0;
          }
          return true;
        })
        .map((record) => ({
          ref: record.ref,
          parentRef: record.parentRef,
          fromState: record.beliefState,
          // Preserve `asserted` authority; otherwise refresh to plain `active`.
          toState: record.beliefState === "asserted" ? "asserted" : "active",
          reason: "belief-refresh" as const,
        })),
    };
  }

  const { components, componentIndexByRef } = stronglyConnectedComponents(
    family.map((record) => record.ref),
    edges,
  );
  const outgoingComponents = new Map<number, Set<number>>();
  for (let index = 0; index < components.length; index += 1) {
    outgoingComponents.set(index, new Set());
  }
  for (const [ref, targets] of edges.entries()) {
    const fromIndex = componentIndexByRef.get(ref);
    if (fromIndex === undefined) continue;
    for (const target of targets) {
      const toIndex = componentIndexByRef.get(target);
      if (toIndex === undefined || toIndex === fromIndex) continue;
      outgoingComponents.get(fromIndex)?.add(toIndex);
    }
  }

  const sinkComponents = new Set<number>();
  for (const [index, outgoing] of outgoingComponents.entries()) {
    if (outgoing.size === 0) sinkComponents.add(index);
  }

  const reachableSinkRefsMemo = new Map<number, string[]>();
  const reachableSinkRefsForComponent = (index: number): string[] => {
    const memoized = reachableSinkRefsMemo.get(index);
    if (memoized) return memoized;

    const outgoing = outgoingComponents.get(index);
    if (!outgoing || outgoing.size === 0) {
      const refs = [...components[index]!].sort();
      reachableSinkRefsMemo.set(index, refs);
      return refs;
    }

    const refs = new Set<string>();
    for (const nextIndex of outgoing) {
      for (const ref of reachableSinkRefsForComponent(nextIndex)) refs.add(ref);
    }
    const resolved = [...refs].sort();
    reachableSinkRefsMemo.set(index, resolved);
    return resolved;
  };

  const contradictionCandidates: MemoryContradictionCandidate[] = [];
  const transitions: MemoryBeliefStateTransition[] = [];
  for (const record of family) {
    const componentIndex = componentIndexByRef.get(record.ref);
    if (componentIndex === undefined) continue;
    const isCurrentComponent = sinkComponents.has(componentIndex);
    const currentRefs = reachableSinkRefsForComponent(componentIndex);

    if (!isCurrentComponent) {
      contradictionCandidates.push({
        ref: record.ref,
        parentRef: record.parentRef,
        reason: "contradicted-derived",
        contradictedByRef: currentRefs[0]!,
        contradictedByRefs: currentRefs,
        currentBeliefRefs: currentRefs,
      });

      if (
        record.beliefState !== "contradicted" ||
        !sameStringArray(record.contradictedBy, currentRefs) ||
        !sameStringArray(record.currentBeliefRefs, currentRefs)
      ) {
        transitions.push({
          ref: record.ref,
          parentRef: record.parentRef,
          fromState: record.beliefState,
          toState: "contradicted",
          reason: "contradicted-derived",
          relatedRef: currentRefs[0],
          relatedRefs: currentRefs,
          currentBeliefRefs: currentRefs,
        });
      }
      continue;
    }

    const componentRefs = [...components[componentIndex]!].sort();
    const peerCurrentRefs = componentRefs.filter((ref) => ref !== record.ref);
    // `deprecated` is a frozen historical state — never refresh to active.
    // (`superseded` is intentionally still refreshable to preserve pre-Phase-1A behavior.)
    if (isFrozenHistoricalBeliefState(record.beliefState)) {
      continue;
    }
    // For `active` / `asserted` records, only refresh when something changes.
    // For everything else (e.g. lingering `contradicted`) always refresh.
    const isActiveLike = isActiveLikeBeliefState(record.beliefState);
    const needsRefresh =
      !isActiveLike || record.contradictedBy.length > 0 || !sameStringArray(record.currentBeliefRefs, peerCurrentRefs);
    if (needsRefresh) {
      transitions.push({
        ref: record.ref,
        parentRef: record.parentRef,
        fromState: record.beliefState,
        // Preserve `asserted` authority; otherwise refresh to plain `active`.
        toState: record.beliefState === "asserted" ? "asserted" : "active",
        reason: "belief-refresh",
        ...(peerCurrentRefs[0] ? { relatedRef: peerCurrentRefs[0], relatedRefs: peerCurrentRefs } : {}),
        ...(peerCurrentRefs.length > 0 ? { currentBeliefRefs: peerCurrentRefs } : {}),
      });
    }
  }

  return {
    contradictionCandidates: contradictionCandidates.sort(compareContradictionCandidates),
    transitions: transitions.sort(compareBeliefTransitions),
  };
}

function stronglyConnectedComponents(
  refs: string[],
  edges: Map<string, string[]>,
): { components: string[][]; componentIndexByRef: Map<string, number> } {
  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (ref: string) => {
    indices.set(ref, index);
    lowLinks.set(ref, index);
    index += 1;
    stack.push(ref);
    onStack.add(ref);

    for (const target of edges.get(ref) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(ref, Math.min(lowLinks.get(ref) ?? 0, lowLinks.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinks.set(ref, Math.min(lowLinks.get(ref) ?? 0, indices.get(target) ?? 0));
      }
    }

    if ((lowLinks.get(ref) ?? -1) !== (indices.get(ref) ?? -2)) return;

    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
      if (member === ref) break;
    }
    components.push(component.sort());
  };

  for (const ref of refs) {
    if (!indices.has(ref)) visit(ref);
  }

  const componentIndexByRef = new Map<string, number>();
  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    for (const ref of components[componentIndex]!) {
      componentIndexByRef.set(ref, componentIndex);
    }
  }

  return { components, componentIndexByRef };
}

/**
 * The `.derived` twin of a non-derived memory file, if one exists on disk:
 * `<name>.derived.md` beside it, the naming convention
 * `indexer/passes/memory-inference.ts`'s `derivedChildPath` writes.
 * `undefined` for a knowledge or lesson ref (no such twin exists), or for a
 * memory that is already itself `.derived` (it has no further twin).
 *
 * Used by `akm proposal accept` (alpha.9) to take a retired or promoted
 * memory's derived child along when it archives the memory.
 */
export function derivedTwinPath(filePath: string, refType: string): string | undefined {
  if (refType !== "memory" || filePath.endsWith(`${DERIVED_SUFFIX}.md`)) return undefined;
  const twin = `${filePath.slice(0, -3)}${DERIVED_SUFFIX}.md`;
  return fs.existsSync(twin) ? twin : undefined;
}

/**
 * True for a retire-proposal-caused archive (alpha.9: the consolidate pair
 * pass, or O1's promotion retirement) — distinguished from a memory-cleanup
 * family-prune candidate by carrying a `proposalId`. The two paths differ in
 * how `previousBeliefState` is derived (below) and in which extra tombstone
 * fields apply.
 */
function isRetireCandidate(candidate: MemoryPruneCandidate): boolean {
  return candidate.proposalId !== undefined;
}

/**
 * The tombstone's `previousBeliefState`. Memory cleanup's own family-prune
 * candidates keep their original reason-based inference (unchanged, so
 * existing behavior is not disturbed by this generalization). A
 * retire-proposal candidate has no such reason vocabulary to infer from, so
 * it reads the asset's ACTUAL frontmatter `beliefState` instead — more
 * correct, and available because every retire path already has the file on
 * disk right before the move.
 */
function resolvePreviousBeliefState(
  candidate: MemoryPruneCandidate,
  filePath: string,
): Exclude<MemoryBeliefState, "archived"> {
  if (!isRetireCandidate(candidate)) return priorBeliefStateForArchive(candidate);
  try {
    return resolveBeliefState(parseFrontmatter(fs.readFileSync(filePath, "utf8")).data);
  } catch {
    return "active";
  }
}

/**
 * Move `filePath` into the recoverable cleanup archive
 * (`.akm/memory-cleanup/archive/<stamp>-<ref>/`) with a `cleanup.md`
 * tombstone, journaling both ends (`recordWrittenPath`) so a LATER sync
 * commits the move — `akm sync`, or the batched auto-sync an `akm improve`
 * run does at its own end (`docs/architecture/improvement.md`, "Auto-sync").
 * This call does not itself commit anything: a standalone `akm proposal
 * accept` (the only way a retire proposal is ever accepted — triage never
 * auto-accepts one) leaves the move journaled but uncommitted until
 * something later reads that journal, unless the write target's `kind` is
 * `"git"`, in which case the caller's own `commitWriteTargetBoundary` commits
 * (and maybe pushes) immediately as part of the SAME accept.
 *
 * Generalized in alpha.9 to cover any memory, knowledge or lesson file in a
 * writable bundle — not only `.derived` memories — so `akm proposal accept`
 * can archive a consolidate pair-pass `retire` proposal's target, or (O1) an
 * accepted promotion's source memory, through the same one encoding memory
 * cleanup already used (D27: never two coexisting encodings). A
 * retire-proposal candidate (one carrying `proposalId`) additionally stamps
 * `proposalId`, `successorRefs` and `retiredAt` on the tombstone.
 */
export function archiveCleanupCandidate(
  stashDir: string,
  candidate: MemoryPruneCandidate,
  filePath: string,
): ArchivedMemoryCleanupRecord {
  const archivedAt = new Date().toISOString();
  const previousBeliefState = resolvePreviousBeliefState(candidate, filePath);
  const originalPath = path.relative(stashDir, filePath).replace(/\\/g, "/");
  const archiveDir = createArchiveDir(stashDir, candidate.ref, archivedAt);
  const archivedPath = path.join(archiveDir, originalPath);
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });

  const retiring = isRetireCandidate(candidate);
  const archiveRef = path.relative(stashDir, archivedPath).replace(/\\/g, "/");
  const auditPath = path.join(archiveDir, "cleanup.md");
  const auditRef = path.relative(stashDir, auditPath).replace(/\\/g, "/");
  const auditAsset = assembleAsset(
    {
      schemaVersion: 1,
      kind: "memory-cleanup-archive",
      archivedAt,
      beliefState: "archived",
      previousBeliefState,
      ref: candidate.ref,
      ...(candidate.parentRef ? { parentRef: candidate.parentRef } : {}),
      reason: candidate.reason,
      ...(candidate.survivorRef ? { survivorRef: candidate.survivorRef } : {}),
      originalPath,
      archivedPath: archiveRef,
      ...(retiring ? { proposalId: candidate.proposalId, retiredAt: archivedAt } : {}),
      ...(retiring && candidate.successorRefs && candidate.successorRefs.length > 0
        ? { successorRefs: candidate.successorRefs }
        : {}),
    },
    "Archived derived memory for recoverable cleanup.\n",
  );
  // 4c (third review round): write the tombstone BEFORE moving the file — a
  // crash in between used to leave a file already at archivedPath with no
  // cleanup.md to explain it (unrecoverable: revert refuses on a missing
  // tombstone, and nothing else knows this archive dir exists). Reordered,
  // a crash here instead leaves, at worst, a tombstone describing a move
  // that has not happened yet, with the file still at its original
  // location — the ordinary "nothing archived yet" state every caller
  // already handles.
  fs.writeFileSync(auditPath, auditAsset, "utf8");
  recordWrittenPath(auditPath);

  fs.renameSync(filePath, archivedPath);
  // #652: an archive is a delete + a create. BOTH ends are journaled so the
  // sync stages the removal of the original alongside the archived copy.
  recordWrittenPath(filePath);
  recordWrittenPath(archivedPath);

  return {
    ref: candidate.ref,
    ...(candidate.parentRef ? { parentRef: candidate.parentRef } : {}),
    reason: candidate.reason,
    beliefState: "archived",
    previousBeliefState,
    ...(candidate.survivorRef ? { survivorRef: candidate.survivorRef } : {}),
    originalPath,
    archivedPath: archiveRef,
    auditPath: auditRef,
    archivedAt,
    ...(retiring ? { proposalId: candidate.proposalId, retiredAt: archivedAt } : {}),
    ...(retiring && candidate.successorRefs && candidate.successorRefs.length > 0
      ? { successorRefs: candidate.successorRefs }
      : {}),
  };
}

/**
 * How long a retirement's archived bytes stay on disk after `retiredAt`
 * before the purge sweep deletes them. Git history keeps the bytes (D27;
 * plan §5.4 "Purge").
 */
export const RETIRE_GRACE_DAYS = 30;

const RETIRE_GRACE_MS = RETIRE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** The one file every archive dir keeps forever — never deleted by the purge sweep. */
const TOMBSTONE_FILENAME = "cleanup.md";

export interface ArchivePurgeResult {
  /** Archive directories whose bytes were purged this run. */
  purgedDirs: number;
  /** Individual files deleted (a retirement may archive more than one, e.g. a `.derived` twin). */
  purgedFiles: number;
}

const EMPTY_ARCHIVE_PURGE_RESULT: ArchivePurgeResult = { purgedDirs: 0, purgedFiles: 0 };

/**
 * The purge sweep (0.9.17-alpha.9 plan §5.4, §8 step 8): deterministic, no
 * LLM, run once at improve-run start. Deletes the archived asset bytes —
 * never `cleanup.md` — of every retirement whose tombstone `retiredAt` is
 * more than {@link RETIRE_GRACE_DAYS} old AND whose archived files are all
 * git-tracked and clean at the time of the sweep (see below). Git history
 * keeps the bytes (D27); the tombstone, and ref resolution through it
 * (`core/asset/memory-archive.ts`), are unaffected — only the tombstone's
 * own `originalPath` file(s) are removed.
 *
 * Git-backed bundles only: a bundle with no `.git` of its own has no history
 * to fall back on, so its archive is left untouched (`akm health` reports
 * its size instead — see `health/archive-usage.ts`). Every deleted path is
 * journaled (`recordWrittenPath`) so the end-of-run sync commits the
 * removal, the same way it commits the archive move itself (#652).
 *
 * `.git` presence is necessary but NOT sufficient: `proposal accept` only
 * commits for a `kind: "git"` write target (`core/write-source.ts`
 * `commitWriteTargetBoundary`), and improve's own auto-sync stages only the
 * paths its own run wrote. A filesystem-kind bundle that merely happens to
 * have a `.git` directory (e.g. the owner committing by hand, or an old
 * repo that was never configured as a git source) can carry retirements
 * that were archived but never committed — deleting those would lose the
 * only surviving copy. So every archived file under a directory past grace
 * is checked against `git ls-files` (tracked) and `git status --porcelain
 * -uall` (clean) — computed ONCE per sweep, not per directory — before that
 * directory's bytes are purged; a directory with even one untracked or
 * modified file (tombstone included) is left whole for a later sweep.
 *
 * A memory-cleanup family-prune archive (not a retire proposal's) carries no
 * `retiredAt` in its tombstone at all, so it is never a candidate here —
 * this sweep only ever touches retirements, never that older archive class.
 */
export function purgeGracedArchive(stashDir: string, now: Date = new Date()): ArchivePurgeResult {
  if (!isGitBackedStash(stashDir)) return EMPTY_ARCHIVE_PURGE_RESULT;
  const archiveRoot = path.join(stashDir, MEMORY_ARCHIVE_REL);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    return EMPTY_ARCHIVE_PURGE_RESULT; // no archive yet
  }
  const cutoffMs = now.getTime() - RETIRE_GRACE_MS;
  // One git inspection per sweep, not per directory. Both sets are
  // repo-relative POSIX paths, matched below against each archived file's
  // own repo-relative path — a file is safe to delete only if it is in
  // `tracked` and NOT in `dirty`.
  const dirty = new Set(listGitChangedPaths(stashDir));
  const tracked = new Set(listGitTrackedPaths(stashDir, MEMORY_ARCHIVE_REL));
  let purgedDirs = 0;
  let purgedFiles = 0;
  for (const entry of entries) {
    // `Dirent.isDirectory()` reflects `lstat`, so it is false for a symlink
    // even when the symlink points at a directory — a symlinked
    // `archive/<name>` is skipped here, never followed (N1). Everything
    // below only ever joins path components onto `archiveRoot` through
    // `entry.name`/`readdirSync` results, so a purge can never reach
    // outside `.akm/memory-cleanup/archive/`.
    if (!entry.isDirectory()) continue;
    const dir = path.join(archiveRoot, entry.name);
    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(fs.readFileSync(path.join(dir, TOMBSTONE_FILENAME), "utf8")).data;
    } catch {
      continue; // not a tombstone dir, or unreadable — never guess
    }
    const retiredAt = data.retiredAt;
    if (typeof retiredAt !== "string") continue; // family-prune archive, not a retirement — out of scope
    const retiredMs = Date.parse(retiredAt);
    if (!Number.isFinite(retiredMs) || retiredMs >= cutoffMs) continue; // "more than" the grace period — exactly at it is not enough
    const allFiles = listFilesRecursive(dir); // tombstone included — the whole entry must be a clean, committed unit
    const isSafeToPurge = allFiles.every((filePath) => {
      const key = toPosix(path.relative(stashDir, filePath));
      return tracked.has(key) && !dirty.has(key);
    });
    if (!isSafeToPurge) continue; // untracked or modified entry — skip the whole directory this sweep (B1)
    let children: string[];
    try {
      children = fs.readdirSync(dir);
    } catch {
      continue;
    }
    let purgedAnyInThisDir = false;
    for (const child of children) {
      if (child === TOMBSTONE_FILENAME) continue;
      const childPath = path.join(dir, child);
      // The archived original path may be nested (e.g. `memories/sub/foo.md`
      // under this dir) — the journal (like git) tracks FILES, so every leaf
      // under childPath is recorded individually, not the directory itself.
      const filesUnderChild = listFilesRecursive(childPath);
      try {
        fs.rmSync(childPath, { recursive: true, force: true });
        for (const filePath of filesUnderChild) recordWrittenPath(filePath);
        purgedFiles += filesUnderChild.length;
        purgedAnyInThisDir = purgedAnyInThisDir || filesUnderChild.length > 0;
      } catch {
        // Best-effort: a locked or already-gone entry is skipped, not fatal to the run.
      }
    }
    if (purgedAnyInThisDir) purgedDirs++;
  }
  return { purgedDirs, purgedFiles };
}

/** Every file under `target` (itself included if it's a file), for individual journaling before a recursive delete. */
function listFilesRecursive(target: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return stat.isFile() ? [target] : [];
  let children: string[];
  try {
    children = fs.readdirSync(target);
  } catch {
    return [];
  }
  return children.flatMap((child) => listFilesRecursive(path.join(target, child)));
}

function persistBeliefStateTransition(filePath: string, transition: MemoryBeliefStateTransition): void {
  mutateFrontmatter(filePath, (parsed) => {
    const nextFrontmatter: Record<string, unknown> = {
      ...parsed.data,
      beliefState: transition.toState,
    };

    const currentBeliefRefs = [...new Set(transition.currentBeliefRefs ?? [])].sort();
    if (transition.toState === "contradicted") {
      nextFrontmatter.contradictedBy = [...currentBeliefRefs];
    } else {
      delete nextFrontmatter.contradictedBy;
      if (parsed.data.supersededBy !== undefined && refArray(parsed.data.supersededBy).length === 0) {
        delete nextFrontmatter.supersededBy;
      }
    }

    if (currentBeliefRefs.length > 0) nextFrontmatter.currentBeliefRefs = [...currentBeliefRefs];
    else delete nextFrontmatter.currentBeliefRefs;

    return nextFrontmatter;
  });
}

function appendBeliefStateTransitionLog(stashDir: string, transitions: MemoryBeliefStateTransition[]): string {
  const logDir = path.join(stashDir, ".akm", "memory-cleanup");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "belief-transitions.jsonl");
  const appliedAt = new Date().toISOString();
  const lines = transitions
    .map((transition) =>
      JSON.stringify({
        appliedAt,
        ref: transition.ref,
        parentRef: transition.parentRef,
        fromState: transition.fromState,
        toState: transition.toState,
        reason: transition.reason,
        ...(transition.relatedRef ? { relatedRef: transition.relatedRef } : {}),
        ...(transition.relatedRefs ? { relatedRefs: transition.relatedRefs } : {}),
        ...(transition.currentBeliefRefs ? { currentBeliefRefs: transition.currentBeliefRefs } : {}),
      } satisfies MemoryBeliefTransitionLogRecord),
    )
    .join("\n");
  fs.appendFileSync(logPath, `${lines}\n`, "utf8");
  recordWrittenPath(logPath);
  return logPath;
}

function priorBeliefStateForArchive(candidate: MemoryPruneCandidate): Exclude<MemoryBeliefState, "archived"> {
  if (candidate.reason === "superseded-derived") return "superseded";
  return "active";
}

function createArchiveDir(stashDir: string, ref: string, archivedAt: string): string {
  const baseName = `${archivedAt.replace(/[:.]/g, "-")}-${sanitizeRef(ref)}`;
  const root = path.join(stashDir, MEMORY_ARCHIVE_REL);
  fs.mkdirSync(root, { recursive: true });
  let attempt = 0;
  while (true) {
    const candidate = path.join(root, attempt === 0 ? baseName : `${baseName}-${attempt}`);
    if (!fs.existsSync(candidate)) {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    }
    attempt += 1;
  }
}

function sanitizeRef(ref: string): string {
  return ref.replace(/[^a-z0-9._-]+/gi, "-");
}

function collectDerivedMemories(stashDir: string, parentRefFilter?: string): DerivedMemoryRecord[] {
  const memoriesDir = path.join(stashDir, "memories");
  if (!fs.existsSync(memoriesDir)) return [];

  const records: DerivedMemoryRecord[] = [];
  const walked = walkMarkdownFiles(memoriesDir);
  if (!walked.complete) {
    warn(`memory improve: directory scan under ${memoriesDir} is incomplete — some derived memories may be missing`);
  }
  for (const filePath of walked.files) {
    const name = toMemoryName(memoriesDir, filePath);
    if (!name) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(raw);
    const parentRef = resolveParentRef(name, parsed.data);
    if (!parentRef) continue;
    if (parentRefFilter && parentRef !== parentRefFilter) continue;
    if (!isDerivedMemory(name, parsed.data)) continue;

    const title = asNonEmptyString(parsed.data.title) ?? extractHeading(parsed.content) ?? "";
    const description = asNonEmptyString(parsed.data.description) ?? "";
    const tags = stringArray(parsed.data.tags);
    const searchHints = stringArray(parsed.data.searchHints);
    const body = parsed.content.trim();
    const signalKey = normalizeSignal(firstNonEmpty([title, description, searchHints[0]]));

    records.push({
      ref: `memory:${name}`,
      name,
      filePath,
      parentRef,
      title,
      description,
      tags,
      searchHints,
      body,
      // parentRef is the 0.9.0 `memories/<name>` conceptId (Group-C item 2), so
      // the canonical-child test compares the minted conceptId of the suffix-
      // stripped name against it rather than slicing a fixed `memory:` prefix.
      canonicalName:
        name.endsWith(DERIVED_SUFFIX) &&
        parentRef === conceptIdFromTypeName("memory", name.slice(0, -DERIVED_SUFFIX.length)),
      signalScore: computeSignalScore(title, description, tags, searchHints, body),
      fingerprint: buildFingerprint(title, description, tags, searchHints, body),
      ...(signalKey ? { signalKey } : {}),
      supersededBy: refArray(parsed.data.supersededBy),
      contradictedBy: refArray(parsed.data.contradictedBy),
      currentBeliefRefs: refArray(parsed.data.currentBeliefRefs),
      obsolete: parsed.data.obsolete === true || parsed.data.retracted === true,
      beliefState: resolveBeliefState(parsed.data),
    });
  }

  return records.sort(compareRecords);
}

/**
 * `active` and `asserted` are both "currently believed" states. `asserted` carries
 * stronger user-explicit authority (set by the hot-path `akm remember`) but for
 * state-machine purposes (contradiction resolution, refresh logic) they are
 * equivalent.
 */
function isActiveLikeBeliefState(state: Exclude<MemoryBeliefState, "archived">): state is "active" | "asserted" {
  return state === "active" || state === "asserted";
}

/**
 * `deprecated` is a frozen historical state introduced in Phase 1A. Once
 * recorded, the contradiction-resolution pass must not refresh it back to
 * active. (`contradicted` is also historical but it *is* updated by the
 * contradiction resolver, so it is treated separately.)
 *
 * Note: `superseded` is deliberately NOT included here. Pre-Phase-1A,
 * `superseded` records were refreshed to `active` by the belief-refresh
 * pass (the old guard was `record.beliefState !== "active"`). In practice
 * most `superseded` records are pruned earlier via `supersededBy` metadata
 * in `analyzeMemoryCleanup`, so they never reach belief refresh — but a
 * record marked `beliefState: superseded` without `supersededBy` metadata
 * was previously refreshable. Preserving that behavior here avoids a
 * surprise regression; only `deprecated` is the new frozen state.
 */
function isFrozenHistoricalBeliefState(state: Exclude<MemoryBeliefState, "archived">): state is "deprecated" {
  return state === "deprecated";
}

function resolveBeliefState(frontmatter: Record<string, unknown>): Exclude<MemoryBeliefState, "archived"> {
  const explicit = asNonEmptyString(frontmatter.beliefState);
  if (
    explicit === "active" ||
    explicit === "asserted" ||
    explicit === "deprecated" ||
    explicit === "superseded" ||
    explicit === "contradicted"
  ) {
    return explicit;
  }
  return "active";
}

// Belief-edge refs (contradictedBy / supersededBy / currentBeliefRefs) are the
// IDENTITY channel: they are compared against a derived memory's own
// `memory:<name>` ref (resolveFamilyContradictions' familyRefSet,
// firstExistingRef's byRef map), so they are NORMALIZED to `memory:<name>` here.
// On disk they arrive in either spelling — `memory:<name>` from pre-0.9.0
// writes, or the `[<bundle>//]memories/<name>` conceptId that
// `writeSupersededEdge` persists today — and
// `parseMemoryName` accepts both. Reading only the first spelling silently
// dropped every edge the current write path produces.
function refArray(value: unknown): string[] {
  if (typeof value === "string") {
    const name = parseMemoryName(value);
    return name === undefined ? [] : [memoryIdentityRef(name)];
  }
  if (!Array.isArray(value)) return [];
  const refs = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = parseMemoryName(item);
    if (name !== undefined) refs.add(memoryIdentityRef(name));
  }
  return [...refs].sort();
}

function buildFingerprint(
  title: string,
  description: string,
  tags: string[],
  searchHints: string[],
  body: string,
): string {
  return contentHash(
    JSON.stringify({
      title: normalizeSignal(title),
      description: normalizeSignal(description),
      tags: normalizeList(tags),
      searchHints: normalizeList(searchHints),
      body: normalizeBody(body),
    }),
  );
}

function normalizeBody(value: string): string {
  return value
    .replace(/^#+\s+/gm, "")
    .replace(/[`*_>#-]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSignal(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeList(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => normalizeSignal(value)).filter((value): value is string => value !== undefined)),
  ].sort();
}

function computeSignalScore(
  title: string,
  description: string,
  tags: string[],
  searchHints: string[],
  body: string,
): number {
  return [title, description, body].join("\n").trim().length + tags.length * 25 + searchHints.length * 10;
}

function sortRecordsForSurvival(records: DerivedMemoryRecord[]): DerivedMemoryRecord[] {
  return [...records].sort((a, b) => {
    if (a.canonicalName !== b.canonicalName) return a.canonicalName ? -1 : 1;
    if (a.signalScore !== b.signalScore) return b.signalScore - a.signalScore;
    return compareRecords(a, b);
  });
}

function compareRecords(a: DerivedMemoryRecord, b: DerivedMemoryRecord): number {
  return a.ref.localeCompare(b.ref);
}

function compareCandidates(a: MemoryPruneCandidate, b: MemoryPruneCandidate): number {
  return a.ref.localeCompare(b.ref);
}

function compareContradictionCandidates(a: MemoryContradictionCandidate, b: MemoryContradictionCandidate): number {
  return a.ref.localeCompare(b.ref);
}

function compareBeliefTransitions(a: MemoryBeliefStateTransition, b: MemoryBeliefStateTransition): number {
  return a.ref.localeCompare(b.ref);
}

function compareConsolidationCandidates(a: MemoryConsolidationCandidate, b: MemoryConsolidationCandidate): number {
  return a.parentRef.localeCompare(b.parentRef) || a.signal.localeCompare(b.signal);
}

function firstExistingRef(
  refs: string[],
  byRef: Map<string, DerivedMemoryRecord>,
  selfRef: string,
): string | undefined {
  for (const ref of refs) {
    if (ref === selfRef) continue;
    if (byRef.has(ref)) return ref;
  }
  return undefined;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function extractHeading(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

function toMemoryName(memoriesDir: string, filePath: string): string | undefined {
  const rel = path.relative(memoriesDir, filePath);
  if (!rel || rel.startsWith("..")) return undefined;
  return rel.replace(/\\/g, "/").replace(/\.md$/i, "");
}
