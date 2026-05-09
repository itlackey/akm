import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { makeAssetRef, parseAssetRef } from "../core/asset-ref";
import { NotFoundError } from "../core/errors";
import { parseFrontmatter } from "../core/frontmatter";
import {
  type ArchivedMemoryCleanupRecord,
  analyzeMemoryCleanup,
  applyMemoryCleanup,
  type MemoryBeliefStateTransition,
  type MemoryCleanupPlan,
  type MemoryConsolidationCandidate,
  type MemoryContradictionCandidate,
  type MemoryPruneCandidate,
} from "../core/memory-improve";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../indexer/db";
import { ensureIndex } from "../indexer/ensure-index";
import { akmIndex } from "../indexer/indexer";
import { resolveSourceEntries } from "../indexer/search-source";
import { type AkmDistillResult, akmDistill } from "./distill";
import { type AkmReflectResult, akmReflect } from "./reflect";

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  autoAccept?: "safe";
  stashDir?: string;
  reflectFn?: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn?: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  ensureIndexFn?: (stashDir: string) => Promise<unknown>;
  reindexFn?: (options: { stashDir: string }) => Promise<unknown>;
}

export interface ImproveEligibleRef {
  ref: string;
  reason: "scope-ref" | "scope-type" | "memory-cleanup";
}

export interface ImproveActionResult {
  ref: string;
  mode: "reflect" | "distill" | "memory-prune";
  result: AkmReflectResult | AkmDistillResult | { ok: true; pruned: boolean; reason: MemoryPruneCandidate["reason"] };
}

export interface ImproveMemoryCleanupResult {
  analyzedDerived: number;
  pruneCandidates: MemoryPruneCandidate[];
  contradictionCandidates: MemoryContradictionCandidate[];
  beliefStateTransitions: MemoryBeliefStateTransition[];
  consolidationCandidates: MemoryConsolidationCandidate[];
  archived?: ArchivedMemoryCleanupRecord[];
  transitionLogPath?: string;
  transitionLogEntries?: number;
  warnings?: string[];
}

export interface AkmImproveResult {
  schemaVersion: 1;
  ok: true;
  scope: {
    mode: "all" | "type" | "ref";
    value?: string;
  };
  dryRun: boolean;
  guidance?: string;
  memorySummary: {
    eligible: number;
    derived: number;
  };
  memoryCleanup?: ImproveMemoryCleanupResult;
  plannedRefs: ImproveEligibleRef[];
  actions?: ImproveActionResult[];
}

function resolveImproveScope(scope: string | undefined): { mode: "all" | "type" | "ref"; value?: string } {
  const trimmed = scope?.trim();
  if (!trimmed) return { mode: "all" };
  try {
    parseAssetRef(trimmed);
    return { mode: "ref", value: trimmed };
  } catch {
    return { mode: "type", value: trimmed };
  }
}

function collectEligibleRefs(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
): {
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
} {
  if (scope.mode === "ref" && scope.value) {
    const parsed = parseAssetRef(scope.value);
    return {
      plannedRefs: [{ ref: scope.value, reason: "scope-ref" }],
      memorySummary: {
        eligible: parsed.type === "memory" ? 1 : 0,
        derived: parsed.type === "memory" && parsed.name.endsWith(".derived") ? 1 : 0,
      },
    };
  }

  const sources = resolveSourceEntries(stashDir);
  if (sources.length === 0) {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
  }

  let db: Database | undefined;
  try {
    db = openExistingDatabase();
    const entries = getAllEntries(db, scope.mode === "type" ? scope.value : undefined).filter((indexed) =>
      isEntryInScope(indexed.stashDir, indexed.filePath, stashDir),
    );
    const planned = new Map<string, ImproveEligibleRef>();
    let memoryEligible = 0;
    let memoryDerived = 0;
    for (const indexed of entries) {
      const ref = makeAssetRef(indexed.entry.type, indexed.entry.name);
      if (!planned.has(ref)) {
        planned.set(ref, {
          ref,
          reason:
            scope.mode === "type" ? "scope-type" : indexed.entry.type === "memory" ? "memory-cleanup" : "scope-type",
        });
      }
      if (indexed.entry.type === "memory") {
        memoryEligible += 1;
        if (indexed.entry.name.endsWith(".derived")) memoryDerived += 1;
      }
    }
    return {
      plannedRefs: [...planned.values()],
      memorySummary: { eligible: memoryEligible, derived: memoryDerived },
    };
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof Error) {
      return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
    }
    throw error;
  } finally {
    if (db) closeDatabase(db);
  }
}

function isEntryInScope(entryStashDir: string, filePath: string, stashDir?: string): boolean {
  if (!stashDir) return true;
  const resolvedEntryStashDir = path.resolve(entryStashDir);
  const resolvedFilePath = path.resolve(filePath);
  const resolvedScopeStashDir = path.resolve(stashDir);
  return (
    resolvedEntryStashDir === resolvedScopeStashDir ||
    resolvedEntryStashDir.startsWith(`${resolvedScopeStashDir}${path.sep}`) ||
    resolvedFilePath.startsWith(`${resolvedScopeStashDir}${path.sep}`)
  );
}

function memoryCleanupParentRef(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
): string | undefined {
  if (scope.mode !== "ref" || !scope.value) return undefined;
  const parsed = parseAssetRef(scope.value);
  if (parsed.type !== "memory") return undefined;
  if (!parsed.name.endsWith(".derived")) return scope.value;

  const sources = resolveSourceEntries(stashDir);
  for (const source of sources) {
    const candidate = path.join(source.path, "memories", `${parsed.name}.md`);
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const fm = parseFrontmatter(raw).data;
    const sourceRef = typeof fm.source === "string" ? fm.source : undefined;
    if (sourceRef) {
      try {
        const parent = parseAssetRef(sourceRef.trim());
        if (parent.type === "memory") return makeAssetRef(parent.type, parent.name);
      } catch {}
    }
  }

  return makeAssetRef("memory", parsed.name.slice(0, -".derived".length));
}

function filterRemovedPlannedRefs(plannedRefs: ImproveEligibleRef[], archivedRefs: string[]): ImproveEligibleRef[] {
  if (archivedRefs.length === 0) return plannedRefs;
  const removed = new Set(archivedRefs);
  return plannedRefs.filter((planned) => !removed.has(planned.ref));
}

function isLessonCandidate(ref: string): boolean {
  const parsed = parseAssetRef(ref);
  return parsed.type !== "lesson" && parsed.type !== "memory";
}

function shouldDistillMemoryRef(ref: string, stashDir?: string): boolean {
  const parsed = parseAssetRef(ref);
  if (parsed.type !== "memory") return false;
  const sources = resolveSourceEntries(stashDir);
  for (const source of sources) {
    const candidate = `${source.path}/memories/${parsed.name}.md`;
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const fm = parseFrontmatter(raw).data;
    const quality = typeof fm.quality === "string" ? fm.quality : undefined;
    if (quality === "proposed") return false;
    return !parsed.name.endsWith(".derived");
  }
  return !parsed.name.endsWith(".derived");
}

export async function akmImprove(options: AkmImproveOptions = {}): Promise<AkmImproveResult> {
  const scope = resolveImproveScope(options.scope);
  const { plannedRefs, memorySummary } = collectEligibleRefs(scope, options.stashDir);
  const reflectFn = options.reflectFn ?? akmReflect;
  const distillFn = options.distillFn ?? akmDistill;
  const ensureIndexFn = options.ensureIndexFn ?? ensureIndex;
  const reindexFn = options.reindexFn ?? akmIndex;
  const primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);
  const memoryCleanupPlan = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
    ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
    : undefined;
  const guidance =
    memorySummary.eligible > 0
      ? "Improve folds memory cleanup into the same proposal queue: speculative promotions still go through reflect/distill proposals, while high-confidence redundant derived memories are moved into a recoverable cleanup archive instead of being left active in the stash."
      : undefined;

  if (options.dryRun) {
    return {
      schemaVersion: 1,
      ok: true,
      scope,
      dryRun: true,
      ...(guidance ? { guidance } : {}),
      memorySummary,
      ...(memoryCleanupPlan ? { memoryCleanup: shapeMemoryCleanup(memoryCleanupPlan) } : {}),
      plannedRefs,
    };
  }

  if (primaryStashDir) {
    await ensureIndexFn(primaryStashDir);
  }

  const actions: ImproveActionResult[] = [];
  const appliedCleanup =
    primaryStashDir && memoryCleanupPlan ? applyMemoryCleanup(primaryStashDir, memoryCleanupPlan) : undefined;
  const archivedRefs = appliedCleanup?.archived.map((record) => record.ref) ?? [];
  const actionableRefs = filterRemovedPlannedRefs(plannedRefs, archivedRefs);
  if (appliedCleanup) {
    for (const candidate of memoryCleanupPlan?.pruneCandidates ?? []) {
      const archived = appliedCleanup.archived.find((record) => record.ref === candidate.ref);
      if (!archived) continue;
      actions.push({
        ref: candidate.ref,
        mode: "memory-prune",
        result: { ok: true, pruned: true, reason: candidate.reason },
      });
    }
    if ((appliedCleanup.archived.length > 0 || appliedCleanup.beliefStateTransitions.length > 0) && primaryStashDir) {
      await reindexFn({ stashDir: primaryStashDir });
    }
  }

  for (const planned of actionableRefs) {
    const reflectResult = await reflectFn({
      ref: planned.ref,
      task: options.task,
      ...(options.stashDir ? { stashDir: options.stashDir } : {}),
    });
    actions.push({ ref: planned.ref, mode: "reflect", result: reflectResult });
    if (isLessonCandidate(planned.ref) || shouldDistillMemoryRef(planned.ref, options.stashDir)) {
      const parsedPlannedRef = parseAssetRef(planned.ref);
      const distillResult = await distillFn({
        ref: planned.ref,
        ...(parsedPlannedRef.type === "memory" ? { proposalKind: "auto" as const } : {}),
        ...(options.stashDir ? { stashDir: options.stashDir } : {}),
      });
      actions.push({ ref: planned.ref, mode: "distill", result: distillResult });
    }
  }

  return {
    schemaVersion: 1,
    ok: true,
    scope,
    dryRun: false,
    ...(guidance ? { guidance } : {}),
    memorySummary,
    ...(memoryCleanupPlan
      ? {
          memoryCleanup: {
            ...shapeMemoryCleanup(memoryCleanupPlan),
            ...(appliedCleanup
              ? {
                  archived: appliedCleanup.archived,
                  ...(appliedCleanup.transitionLogPath ? { transitionLogPath: appliedCleanup.transitionLogPath } : {}),
                  ...(appliedCleanup.transitionLogEntries !== undefined
                    ? { transitionLogEntries: appliedCleanup.transitionLogEntries }
                    : {}),
                  ...(appliedCleanup.warnings && appliedCleanup.warnings.length > 0
                    ? { warnings: appliedCleanup.warnings }
                    : {}),
                }
              : {}),
          },
        }
      : {}),
    plannedRefs: actionableRefs,
    actions,
  };
}

function shouldAnalyzeMemoryCleanup(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  eligibleMemories: number,
  primaryStashDir: string | undefined,
): boolean {
  if (!primaryStashDir || eligibleMemories === 0) return false;
  if (scope.mode === "all") return true;
  if (scope.mode === "type") return scope.value === "memory";
  if (!scope.value) return false;
  return parseAssetRef(scope.value).type === "memory";
}

function shapeMemoryCleanup(plan: MemoryCleanupPlan): ImproveMemoryCleanupResult {
  return {
    analyzedDerived: plan.analyzedDerived,
    pruneCandidates: plan.pruneCandidates,
    contradictionCandidates: plan.contradictionCandidates,
    beliefStateTransitions: plan.beliefStateTransitions,
    consolidationCandidates: plan.consolidationCandidates,
  };
}
