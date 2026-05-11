import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { makeAssetRef, parseAssetRef } from "../core/asset-ref";
import type { AkmConfig } from "../core/config";
import { loadConfig } from "../core/config";
import { ConfigError, NotFoundError } from "../core/errors";
import { appendEvent, readEvents } from "../core/events";
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
import { listProposals } from "../core/proposals";
import { warn } from "../core/warn";
import {
  closeDatabase,
  getAllEntries,
  getRetrievalCounts,
  getUtilityScoresByIds,
  openExistingDatabase,
} from "../indexer/db";
import { ensureIndex } from "../indexer/ensure-index";
import { akmIndex } from "../indexer/indexer";
import { resolveSourceEntries } from "../indexer/search-source";
import { chatCompletion, parseEmbeddedJsonResponse } from "../llm/client";
import { type AkmConsolidateOptions, akmConsolidate, type ConsolidateResult } from "./consolidate";
import { type AkmDistillResult, akmDistill } from "./distill";
import { type AkmReflectResult, akmReflect } from "./reflect";

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  autoAccept?: "safe";
  stashDir?: string;
  config?: AkmConfig;
  /** Wall-clock budget for the entire improve run in milliseconds. Defaults to 2 hours. */
  timeoutMs?: number;
  limit?: number;
  consolidateOptions?: Omit<AkmConsolidateOptions, "config" | "stashDir">;
  /** Number of eligible memory assets above which consolidation is forced even if the memory_consolidation feature flag is not set. Defaults to 100. */
  memoryVolumeConsolidationThreshold?: number;
  reflectFn?: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn?: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  ensureIndexFn?: (stashDir: string) => Promise<unknown>;
  reindexFn?: (options: { stashDir: string }) => Promise<unknown>;
  /** When true (default), attempt LLM-driven schema repair on validation failures before skipping. Requires llm config. */
  repairValidationFailures?: boolean;
  /** Cooldown in days before re-reflecting an asset that was recently reflected. Defaults to 7. Set to 0 to disable. */
  reflectCooldownDays?: number;
  /** Cooldown in days before re-distilling an asset with a recent accepted proposal. Defaults to 30. Set to 0 to disable. */
  distillCooldownDays?: number;
}

export interface ImproveEligibleRef {
  ref: string;
  reason: "scope-ref" | "scope-type" | "memory-cleanup";
}

export interface ImproveActionResult {
  ref: string;
  mode: "reflect" | "distill" | "distill-skipped" | "memory-prune" | "error";
  result:
    | AkmReflectResult
    | AkmDistillResult
    | { ok: true; pruned: boolean; reason: MemoryPruneCandidate["reason"] }
    | { ok: true; reason: string }
    | { ok: false; error: string };
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
  validationFailures?: Array<{ ref: string; reason: string }>;
  schemaRepairs?: Array<{
    ref: string;
    reason: string;
    outcome: "written" | "skipped" | "error";
    error?: string;
  }>;
  consolidation?: ConsolidateResult;
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

  let sources: ReturnType<typeof resolveSourceEntries>;
  try {
    sources = resolveSourceEntries(stashDir);
  } catch {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
  }
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
  let primaryStashDir: string | undefined;
  try {
    primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  } catch {
    primaryStashDir = undefined;
  }
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

  const resolvedLockPath = primaryStashDir
    ? path.join(primaryStashDir, ".akm", "improve.lock")
    : path.join(options.stashDir ?? ".", ".akm", "improve.lock");
  let staleLock = false;
  if (fs.existsSync(resolvedLockPath)) {
    let lock: { pid: number; startedAt: string } | null = null;
    try {
      lock = JSON.parse(fs.readFileSync(resolvedLockPath, "utf8")) as { pid: number; startedAt: string };
    } catch {
      staleLock = true;
    }
    if (lock !== null) {
      try {
        process.kill(lock.pid, 0);
        throw new ConfigError(
          `akm improve is already running (pid ${lock.pid}, started ${lock.startedAt}). Use SIGTERM to stop it.`,
          "INVALID_CONFIG_FILE",
        );
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        staleLock = true;
      }
    }
    if (staleLock) {
      try {
        fs.unlinkSync(resolvedLockPath);
      } catch {
        // ignore
      }
    }
  }
  fs.mkdirSync(path.dirname(resolvedLockPath), { recursive: true });
  fs.writeFileSync(resolvedLockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const budgetMs = options.timeoutMs ?? 2 * 60 * 60 * 1000; // default 2 hours
  const startMs = Date.now();

  try {
    const actions: ImproveActionResult[] = [];
    const cleanupWarnings: string[] = [];

    appendEvent({
      eventType: "improve_invoked",
      ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
      metadata: { scope, dryRun: options.dryRun ?? false, assetCount: plannedRefs.length },
    });

    if (primaryStashDir) {
      try {
        await ensureIndexFn(primaryStashDir);
      } catch (err) {
        cleanupWarnings.push(`ensureIndex failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let appliedCleanup: Awaited<ReturnType<typeof applyMemoryCleanup>> | undefined;
    try {
      appliedCleanup =
        primaryStashDir && memoryCleanupPlan ? applyMemoryCleanup(primaryStashDir, memoryCleanupPlan) : undefined;
    } catch (err) {
      cleanupWarnings.push(`applyMemoryCleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const archivedRefs = appliedCleanup?.archived.map((record) => record.ref) ?? [];
    const postCleanupRefs = filterRemovedPlannedRefs(plannedRefs, archivedRefs);

    // Gap 6: only surface feedback signals from the last 30 days so that
    // ancient one-off feedback events don't permanently lock an asset into
    // every improve run. Assets with only stale signals fall through to the
    // high-retrieval path (P0-A) or are skipped until new signals arrive.
    const FEEDBACK_SIGNAL_WINDOW_DAYS = 30;
    const feedbackSinceCutoff = new Date(Date.now() - FEEDBACK_SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const signalFiltered = postCleanupRefs.filter((candidate) => {
      const { events } = readEvents({ type: "feedback", ref: candidate.ref });
      return events.some(
        (e) =>
          (e.ts ?? "") >= feedbackSinceCutoff &&
          ((e.metadata !== undefined && typeof e.metadata.signal === "string") ||
            (e.metadata !== undefined && typeof e.metadata.note === "string")),
      );
    });

    // P0-A: also surface zero-feedback assets that have been retrieved many times.
    const RETRIEVAL_COUNT_THRESHOLD = 3;

    const signalBearingSet = new Set(signalFiltered.map((r) => r.ref));
    const noFeedbackCandidates = postCleanupRefs.filter((r) => !signalBearingSet.has(r.ref));

    let highRetrievalRefs: typeof postCleanupRefs = [];
    let dbForRetrieval: import("bun:sqlite").Database | undefined;
    try {
      dbForRetrieval = openExistingDatabase();
      const showEventCount = (
        dbForRetrieval.prepare("SELECT COUNT(*) AS cnt FROM usage_events WHERE event_type = 'show'").get() as {
          cnt: number;
        }
      ).cnt;
      if (showEventCount === 0) {
        warn(
          "Warning: show events not yet in usage_events — zero-feedback fallback will match only search-retrieved assets.",
        );
      }
      const retrievalCounts = getRetrievalCounts(
        dbForRetrieval,
        noFeedbackCandidates.map((r) => r.ref),
      );
      highRetrievalRefs = noFeedbackCandidates.filter(
        (r) => (retrievalCounts.get(r.ref) ?? 0) >= RETRIEVAL_COUNT_THRESHOLD,
      );
    } catch {
      // best-effort: if DB unavailable, highRetrievalRefs stays empty
    } finally {
      if (dbForRetrieval) closeDatabase(dbForRetrieval);
    }

    const mergedRefs = [...signalFiltered, ...highRetrievalRefs];

    const utilityMap = buildUtilityMap(mergedRefs);
    const sorted = [...mergedRefs].sort((a, b) => (utilityMap.get(b.ref) ?? 0) - (utilityMap.get(a.ref) ?? 0));
    const actionableRefs = options.limit ? sorted.slice(0, options.limit) : sorted;

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
        try {
          await reindexFn({ stashDir: primaryStashDir });
        } catch (err) {
          cleanupWarnings.push(`reindex after cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const validationFailures: Array<{ ref: string; reason: string }> = [];
    for (const candidate of actionableRefs) {
      try {
        const filePath = findAssetFilePath(candidate.ref, options.stashDir);
        if (!filePath) {
          validationFailures.push({ ref: candidate.ref, reason: "not found in index" });
          continue;
        }
        if (isLessonCandidate(candidate.ref)) {
          const raw = fs.readFileSync(filePath, "utf8");
          const fm = parseFrontmatter(raw).data;
          if (!fm.description) validationFailures.push({ ref: candidate.ref, reason: "missing description" });
        }
      } catch (e) {
        validationFailures.push({ ref: candidate.ref, reason: String(e) });
      }
    }
    if (validationFailures.length > 0) {
      console.error(`[improve] ${validationFailures.length} assets have validation issues (will be skipped):`);
      for (const f of validationFailures) console.error(`  ${f.ref}: ${f.reason}`);
    }
    // Schema repair pass: attempt to fix validation failures via agent before skipping.
    const schemaRepairs: Array<{
      ref: string;
      reason: string;
      outcome: "written" | "skipped" | "error";
      error?: string;
    }> = [];
    const repairedRefs = new Set<string>();

    // Gap 3: cooldown constant for schema repair — re-running on the same
    // asset every improve cycle without any change in the asset state is pure
    // churn. 7 days matches the reflect cooldown default.
    const SCHEMA_REPAIR_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

    if (validationFailures.length > 0 && options.repairValidationFailures !== false) {
      const baseConfigForRepair = options.config ?? loadConfig();
      const llmCfg = baseConfigForRepair.llm;
      if (llmCfg) {
        for (const failure of validationFailures) {
          if (Date.now() - startMs >= budgetMs) break;

          // Gap 3 cooldown: skip repair if we already ran it recently.
          const recentRepairs = readEvents({ type: "schema_repair_invoked", ref: failure.ref });
          const lastRepair = recentRepairs.events
            .filter((e) => e.metadata?.outcome === "written")
            .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())[0];
          if (lastRepair?.ts && Date.now() - new Date(lastRepair.ts).getTime() < SCHEMA_REPAIR_COOLDOWN_MS) {
            schemaRepairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
            continue;
          }

          let filePath = findAssetFilePath(failure.ref, options.stashDir);
          if (!filePath) {
            schemaRepairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
            continue;
          }
          // Skill assets are stored as directories — resolve to the markdown file inside.
          try {
            if (fs.statSync(filePath).isDirectory()) {
              const candidates = ["SKILL.md", "index.md", "README.md"];
              const found = candidates.map((f) => path.join(filePath as string, f)).find((p) => fs.existsSync(p));
              if (!found) {
                schemaRepairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
                continue;
              }
              filePath = found;
            }
          } catch {
            schemaRepairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
            continue;
          }

          try {
            const raw = fs.readFileSync(filePath, "utf8");
            const fm = parseFrontmatter(raw);

            // Determine which fields need to be generated.
            const missingFields: string[] = [];
            if (!fm.data.description) missingFields.push("description");
            if (isLessonCandidate(failure.ref) && !fm.data.when_to_use) missingFields.push("when_to_use");

            if (missingFields.length === 0) {
              schemaRepairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
              continue;
            }

            const fieldList = missingFields.join(" and ");
            console.error(`[improve] schema-repair ${failure.ref} (${fieldList})`);

            const bodyPreview = (fm.content ?? raw).slice(0, 2000);
            const llmResponse = await chatCompletion(llmCfg, [
              {
                role: "system",
                content: `You generate concise asset frontmatter fields. Respond with a JSON object containing only the missing fields. No prose, no markdown fences.`,
              },
              {
                role: "user",
                content: `Generate the missing frontmatter fields (${fieldList}) for this ${parseAssetRef(failure.ref).type} asset. Return ONLY valid JSON like {"description": "...", "when_to_use": "..."}\n\n${bodyPreview}`,
              },
            ]);

            const parsed = parseEmbeddedJsonResponse<Record<string, string>>(llmResponse.trim());
            if (!parsed) {
              schemaRepairs.push({
                ref: failure.ref,
                reason: failure.reason,
                outcome: "error",
                error: "LLM returned unparseable JSON for schema repair",
              });
              continue;
            }

            // Patch the generated fields into frontmatter and rewrite the file.
            const newFm = { ...fm.data };
            if (parsed.description) newFm.description = parsed.description;
            if (parsed.when_to_use) newFm.when_to_use = parsed.when_to_use;
            const fmStr = yamlStringify(newFm).trimEnd();
            const newContent = `---\n${fmStr}\n---\n${fm.content}`;
            fs.writeFileSync(filePath, newContent, "utf8");
            console.error(`[improve] schema-repair written: ${failure.ref}`);
            appendEvent({
              eventType: "schema_repair_invoked",
              ref: failure.ref,
              metadata: { outcome: "written", reason: failure.reason },
            });
            schemaRepairs.push({ ref: failure.ref, reason: failure.reason, outcome: "written" });
            repairedRefs.add(failure.ref);
          } catch (e) {
            appendEvent({
              eventType: "schema_repair_invoked",
              ref: failure.ref,
              metadata: { outcome: "error", reason: failure.reason, error: String(e) },
            });
            schemaRepairs.push({ ref: failure.ref, reason: failure.reason, outcome: "error", error: String(e) });
          }
        }
      }
    }

    const validationFailureRefs = new Set(validationFailures.filter((f) => !repairedRefs.has(f.ref)).map((f) => f.ref));

    let completedCount = 0;
    for (const planned of actionableRefs) {
      if (validationFailureRefs.has(planned.ref)) continue;
      if (Date.now() - startMs >= budgetMs) {
        const remaining = actionableRefs.length - completedCount;
        console.error(
          `[improve] budget exhausted after ${Math.round((Date.now() - startMs) / 60000)}min — ${remaining} assets skipped`,
        );
        actions.push({
          ref: planned.ref,
          mode: "error",
          result: { ok: false, error: "timeout: improve wall-clock budget exhausted" },
        });
        break;
      }
      try {
        // Reflect cooldown — Event-sourced Idempotency Guard with Spaced Cooldown (SM-2 derived).
        // Three-tier multiplier based on last proposal outcome:
        //   approved proposal → 14d (ease × 2.0: "easily recalled" in SM-2 terms)
        //   neutral (no outcome recorded) → base window (default 7d)
        //   lapsed (rejected/error) → 3d (SM-2 lapse interval: accelerated re-review)
        const REFLECT_COOLDOWN_DAYS = options.reflectCooldownDays ?? 7;
        if (REFLECT_COOLDOWN_DAYS > 0) {
          const recentReflects = readEvents({ type: "reflect_invoked", ref: planned.ref });
          const lastReflect = recentReflects.events.sort(
            (a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime(),
          )[0];
          if (lastReflect?.ts) {
            // Determine cooldown tier from the proposal outcome of the last reflect run.
            const stashForProposals = primaryStashDir ?? options.stashDir;
            let effectiveCooldownDays = REFLECT_COOLDOWN_DAYS;
            if (stashForProposals) {
              const proposalsForRef = listProposals(stashForProposals, { ref: planned.ref });
              const hasAccepted = proposalsForRef.some((p) => p.status === "accepted");
              const hasRejected = proposalsForRef.some((p) => p.status === "rejected");
              if (hasAccepted) effectiveCooldownDays = Math.max(REFLECT_COOLDOWN_DAYS, 14);
              else if (hasRejected) effectiveCooldownDays = Math.min(REFLECT_COOLDOWN_DAYS, 3);
            }
            const cooldownMs = effectiveCooldownDays * 24 * 60 * 60 * 1000;
            if (Date.now() - new Date(lastReflect.ts).getTime() < cooldownMs) {
              const daysAgo = Math.round((Date.now() - new Date(lastReflect.ts).getTime()) / 86400000);
              actions.push({
                ref: planned.ref,
                mode: "distill-skipped",
                result: {
                  ok: true,
                  reason: `reflect cooldown (last reflected ${daysAgo}d ago, effective window ${effectiveCooldownDays}d)`,
                },
              });
              completedCount++;
              console.error(`[improve] ${completedCount}/${actionableRefs.length} ${planned.ref} (reflect cooldown)`);
              continue;
            }
          }
        }

        const reflectResult = await reflectFn({
          ref: planned.ref,
          task: options.task,
          ...(options.stashDir ? { stashDir: options.stashDir } : {}),
        });
        actions.push({ ref: planned.ref, mode: "reflect", result: reflectResult });
        if (isLessonCandidate(planned.ref) || shouldDistillMemoryRef(planned.ref, options.stashDir)) {
          const parsedPlannedRef = parseAssetRef(planned.ref);

          const slug = `${parsedPlannedRef.type}-${parsedPlannedRef.name}`.toLowerCase();
          const safe = slug
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "");
          const lessonRef = `lesson:${safe}-lesson`;
          const dedupeStashDir = primaryStashDir ?? options.stashDir;
          if (dedupeStashDir) {
            const existingProposals = listProposals(dedupeStashDir, { ref: lessonRef });
            if (existingProposals.some((p) => p.status === "pending")) {
              actions.push({
                ref: planned.ref,
                mode: "distill-skipped",
                result: { ok: true, reason: "pending proposal exists" },
              });
              completedCount++;
              console.error(`[improve] ${completedCount}/${actionableRefs.length} ${planned.ref}`);
              continue;
            }
          }

          // Distill cooldown: skip if a distill_invoked event with outcome "queued" exists for this
          // ref within the cooldown window (covers recently-accepted proposals whose queue entry has
          // moved to the archive and is no longer "pending").
          const DISTILL_COOLDOWN_DAYS = options.distillCooldownDays ?? 30;
          if (DISTILL_COOLDOWN_DAYS > 0) {
            const distillCooldownMs = DISTILL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
            const recentDistills = readEvents({ type: "distill_invoked", ref: planned.ref });
            const lastQueuedDistill = recentDistills.events
              .filter((e) => e.metadata?.outcome === "queued")
              .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())[0];
            if (lastQueuedDistill?.ts && Date.now() - new Date(lastQueuedDistill.ts).getTime() < distillCooldownMs) {
              const daysAgo = Math.round((Date.now() - new Date(lastQueuedDistill.ts).getTime()) / 86400000);
              actions.push({
                ref: planned.ref,
                mode: "distill-skipped",
                result: { ok: true, reason: `distill cooldown (last distilled ${daysAgo}d ago)` },
              });
              completedCount++;
              console.error(`[improve] ${completedCount}/${actionableRefs.length} ${planned.ref} (distill cooldown)`);
              continue;
            }
          }

          const distillResult = await distillFn({
            ref: planned.ref,
            ...(parsedPlannedRef.type === "memory" ? { proposalKind: "auto" as const } : {}),
            ...(options.stashDir ? { stashDir: options.stashDir } : {}),
          });
          actions.push({ ref: planned.ref, mode: "distill", result: distillResult });
        }
      } catch (err) {
        actions.push({
          ref: planned.ref,
          mode: "error",
          result: { ok: false, error: err instanceof Error ? err.message : String(err) },
        });
      }
      completedCount++;
      console.error(`[improve] ${completedCount}/${actionableRefs.length} ${planned.ref}`);
    }

    const allWarnings = [...cleanupWarnings, ...(appliedCleanup?.warnings ?? [])];

    const baseConfig = options.config ?? loadConfig();
    const MEMORY_VOLUME_THRESHOLD = options.memoryVolumeConsolidationThreshold ?? 100;
    const hasLlm = !!(baseConfig.llm || baseConfig.agent);
    const volumeTriggered =
      typeof memorySummary?.eligible === "number" && memorySummary.eligible > MEMORY_VOLUME_THRESHOLD && hasLlm;
    const consolidationConfig: AkmConfig = volumeTriggered
      ? {
          ...baseConfig,
          ...(baseConfig.llm
            ? {
                llm: {
                  ...baseConfig.llm,
                  features: { ...baseConfig.llm.features, memory_consolidation: true },
                },
              }
            : {}),
        }
      : baseConfig;

    // Gap 4: skip consolidation if it ran recently (14-day cooldown) to prevent
    // the same memory cluster being churned through consolidation on every run.
    const CONSOLIDATE_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
    const recentConsolidations = readEvents({ type: "consolidate_completed" });
    const lastConsolidation = recentConsolidations.events
      .filter((e) => e.metadata?.processed && Number(e.metadata.processed) > 0)
      .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())[0];
    const consolidationOnCooldown =
      !volumeTriggered &&
      lastConsolidation?.ts &&
      Date.now() - new Date(lastConsolidation.ts).getTime() < CONSOLIDATE_COOLDOWN_MS;

    let consolidation: ConsolidateResult = {
      ok: true,
      shape: "consolidate-result",
      dryRun: false,
      previewOnly: false,
      target: "",
      processed: 0,
      merged: 0,
      deleted: 0,
      promoted: [],
      warnings: [],
      durationMs: 0,
    };
    if (!consolidationOnCooldown) {
      consolidation = await akmConsolidate({
        ...options.consolidateOptions,
        config: consolidationConfig,
        stashDir: options.stashDir,
        autoTriggered: volumeTriggered,
      });
      if (consolidation.processed > 0) {
        appendEvent({
          eventType: "consolidate_completed",
          ref: "memory:_consolidation",
          metadata: { processed: consolidation.processed, merged: consolidation.merged },
        });
      }
    } else {
      const daysAgo = Math.round((Date.now() - new Date(lastConsolidation?.ts ?? 0).getTime()) / 86400000);
      console.error(`[improve] consolidation skipped (last ran ${daysAgo}d ago, cooldown 14d)`);
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
                    ...(appliedCleanup.transitionLogPath
                      ? { transitionLogPath: appliedCleanup.transitionLogPath }
                      : {}),
                    ...(appliedCleanup.transitionLogEntries !== undefined
                      ? { transitionLogEntries: appliedCleanup.transitionLogEntries }
                      : {}),
                    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
                  }
                : cleanupWarnings.length > 0
                  ? { warnings: cleanupWarnings }
                  : {}),
            },
          }
        : {}),
      plannedRefs: actionableRefs,
      actions,
      ...(validationFailures.length > 0 ? { validationFailures } : {}),
      ...(schemaRepairs.length > 0 ? { schemaRepairs } : {}),
      ...(consolidation.processed > 0 || consolidation.warnings.length > 0 ? { consolidation } : {}),
    };
  } finally {
    try {
      fs.unlinkSync(resolvedLockPath);
    } catch {
      // ignore
    }
  }
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

function buildUtilityMap(refs: ImproveEligibleRef[]): Map<string, number> {
  const map = new Map<string, number>();
  if (refs.length === 0) return map;
  const refSet = new Set(refs.map((r) => r.ref));
  let db: Database | undefined;
  try {
    db = openExistingDatabase();
    const allDbEntries = getAllEntries(db);
    const idToRef = new Map<number, string>();
    for (const indexed of allDbEntries) {
      const ref = makeAssetRef(indexed.entry.type, indexed.entry.name);
      if (refSet.has(ref)) idToRef.set(indexed.id, ref);
    }
    const ids = [...idToRef.keys()];
    if (ids.length > 0) {
      const scores = getUtilityScoresByIds(db, ids);
      for (const [id, score] of scores) {
        const ref = idToRef.get(id);
        if (ref) map.set(ref, score.utility);
      }
    }
  } catch {
    // best-effort: if DB unavailable, all utilities default to 0
  } finally {
    if (db) closeDatabase(db);
  }
  return map;
}

function findAssetFilePath(ref: string, stashDir?: string): string | null {
  try {
    const parsed = parseAssetRef(ref);
    const sources = resolveSourceEntries(stashDir);
    for (const source of sources) {
      const candidates = [
        path.join(source.path, `${parsed.type}s`, `${parsed.name}.md`),
        path.join(source.path, `${parsed.type}`, `${parsed.name}.md`),
        path.join(source.path, `${parsed.type}s`, parsed.name),
        path.join(source.path, `${parsed.type}`, parsed.name),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // best-effort
  }
  return null;
}
