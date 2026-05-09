import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { makeAssetRef, parseAssetRef } from "../core/asset-ref";
import { NotFoundError } from "../core/errors";
import { parseFrontmatter } from "../core/frontmatter";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../indexer/db";
import { resolveSourceEntries } from "../indexer/search-source";
import { type AkmDistillResult, akmDistill } from "./distill";
import { type AkmReflectResult, akmReflect } from "./reflect";

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  autoAccept?: "safe";
}

export interface ImproveEligibleRef {
  ref: string;
  reason: "scope-ref" | "scope-type" | "memory-cleanup";
}

export interface ImproveActionResult {
  ref: string;
  mode: "reflect" | "distill";
  result: AkmReflectResult | AkmDistillResult;
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

function collectEligibleRefs(scope: { mode: "all" | "type" | "ref"; value?: string }): {
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
} {
  if (scope.mode === "ref" && scope.value) {
    const parsed = parseAssetRef(scope.value);
    return {
      plannedRefs: [
        { ref: scope.value, reason: "scope-ref" },
        ...(parsed.type === "memory" ? [{ ref: scope.value, reason: "memory-cleanup" as const }] : []),
      ],
      memorySummary: {
        eligible: parsed.type === "memory" ? 1 : 0,
        derived: parsed.type === "memory" && parsed.name.endsWith(".derived") ? 1 : 0,
      },
    };
  }

  const sources = resolveSourceEntries();
  if (sources.length === 0) {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
  }

  let db: Database | undefined;
  try {
    db = openExistingDatabase();
    const entries = getAllEntries(db, scope.mode === "type" ? scope.value : undefined);
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

function isLessonCandidate(ref: string): boolean {
  const parsed = parseAssetRef(ref);
  return parsed.type !== "lesson" && parsed.type !== "memory";
}

function shouldDistillMemoryRef(ref: string): boolean {
  const parsed = parseAssetRef(ref);
  if (parsed.type !== "memory") return false;
  const sources = resolveSourceEntries();
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
  const { plannedRefs, memorySummary } = collectEligibleRefs(scope);
  const guidance =
    memorySummary.eligible > 0
      ? "Improve folds memory cleanup into the same proposal queue: redundant memories should be consolidated, reinforced facts can graduate into higher-trust knowledge proposals, and age alone is not enough to prune a memory."
      : undefined;

  if (options.dryRun) {
    return {
      schemaVersion: 1,
      ok: true,
      scope,
      dryRun: true,
      ...(guidance ? { guidance } : {}),
      memorySummary,
      plannedRefs,
    };
  }

  const actions: ImproveActionResult[] = [];
  for (const planned of plannedRefs) {
    const reflectResult = await akmReflect({ ref: planned.ref, task: options.task });
    actions.push({ ref: planned.ref, mode: "reflect", result: reflectResult });
    if (isLessonCandidate(planned.ref) || shouldDistillMemoryRef(planned.ref)) {
      const distillResult = await akmDistill({ ref: planned.ref });
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
    plannedRefs,
    actions,
  };
}
