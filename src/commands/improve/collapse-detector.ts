// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R5 — Longitudinal collapse/churn detector
 * (docs/design/improve-collapse-churn-detector-design.md).
 *
 * Detects the two measured failure modes of LLM-consolidated memory stores:
 *
 *   COLLAPSE — repeated merges destroy information: canary retrieval recall
 *     downtrends, distinct-content entropy downtrends, or the store shrinks
 *     while generation counts rise.
 *   CHURN — real accepted-change volume with zero retrieval-visible or
 *     shape-visible movement (LLM budget burned rewriting to no effect).
 *
 * Hard invariants: deterministic only (FTS BM25 + hashing — never an LLM,
 * never an embedding model); bounded storage (< 2 KB per qualifying cycle,
 * 365-day retention); fail-open (an error warns and skips, never breaks an
 * improve run); runs only on cycles where consolidate/recombine did work.
 *
 * Observe-only in v1: alerts land in `improve_cycle_metrics.alerts_json`, the
 * events log (`collapse_detector_alert`), and the `akm health` advisory —
 * nothing is ever blocked.
 *
 * @module collapse-detector
 */

import { randomBytes } from "node:crypto";
import { makeAssetRef } from "../../core/asset/asset-ref";
import type { AkmAssetType } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { appendEvent, type EventsContext } from "../../core/events";
import {
  type CanaryQueryRow,
  type CycleMetricsRow,
  deactivateCanarySet,
  getActiveCanaries,
  getCanariesBySetId,
  insertCanaries,
  insertCycleMetrics,
  listActiveCanarySetIds,
  queryRecentCycleMetrics,
  type Database as StateDatabase,
  withStateDb,
} from "../../core/state-db";
import { warn } from "../../core/warn";
import {
  closeDatabase,
  type DbIndexedEntry,
  getAllEntries,
  openExistingDatabase,
  searchFts,
} from "../../indexer/db/db";
import type { Database as IndexDatabase } from "../../storage/database";
import { computeBigramDiversity, DEFAULT_MAX_GENERATION } from "./anti-collapse";
import { getAllRankScores } from "./salience";

// ── Defaults (mirrored in config-schema.ts ImproveCollapseDetectorSchema) ────

export const DEFAULT_CANARY_COUNT = 40; // owner-approved 30–50 range
export const DEFAULT_CANARY_K = 10;
export const DEFAULT_WINDOW_CYCLES = 5;
export const DEFAULT_RECALL_DROP_THRESHOLD = 0.15;
export const DEFAULT_ENTROPY_DROP_THRESHOLD = 0.05;
export const DEFAULT_CHURN_MIN_ACCEPTED = 25;
export const DEFAULT_RETENTION_DAYS = 365;
/** Deterministic bigram-diversity sample cap (cost bound at 10k assets). */
const DIVERSITY_SAMPLE_CAP = 2000;
/**
 * Minimum merge-floor violations in one cycle before the advisory alert fires.
 * The specificity floor is deliberately strict (Phase-1 tuning pending), so a
 * couple of borderline merges per cycle must not flip `akm health` to warn —
 * that alert fatigue would drown the real collapse signals.
 */
const MERGE_FLOOR_ALERT_MIN = 3;
/** The learning-store types the detector measures. */
const LEARNING_TYPES = new Set(["memory", "lesson", "knowledge"]);

export interface CollapseDetectorConfig {
  enabled?: boolean;
  canaryCount?: number;
  k?: number;
  windowCycles?: number;
  recallDropThreshold?: number;
  entropyDropThreshold?: number;
  churnMinAcceptedActions?: number;
  retentionDays?: number;
}

export type CollapseAlertKind = "collapse-recall" | "collapse-entropy" | "collapse-shrink" | "churn" | "merge-floor";

export interface CollapseAlert {
  kind: CollapseAlertKind;
  detail: string;
  metrics: Record<string, number>;
}

// ── Canary set ────────────────────────────────────────────────────────────────

/** Deterministic query string for one anchor entry: name tokens + top tags + description head. */
function buildCanaryQuery(entry: DbIndexedEntry): string {
  const nameTokens = entry.entry.name.split(/[-_/.]+/).filter((t) => t.length > 1);
  const tags = (entry.entry.tags ?? []).slice(0, 3);
  const descriptionHead = (entry.entry.description ?? "").split(/\s+/).slice(0, 6);
  const parts = [...nameTokens, ...tags, ...descriptionHead].filter((t) => t.length > 0);
  return [...new Set(parts)].join(" ");
}

/** Build the mint candidate list (deterministic given index + salience tables). */
function buildMintList(
  stateDb: StateDatabase,
  entries: DbIndexedEntry[],
  cfg: CollapseDetectorConfig,
): Array<{ anchorRef: string; query: string }> {
  const canaryCount = cfg.canaryCount ?? DEFAULT_CANARY_COUNT;
  const rankScores = getAllRankScores(stateDb);
  // NOTE: entryKey is stash-prefixed ("<stashDir>:type:name"); asset_salience
  // and the canary scoring both key on the bare "type:name" ref.
  const candidates = entries
    .filter((e) => LEARNING_TYPES.has(e.entry.type))
    .map((e) => {
      const ref = makeAssetRef(e.entry.type as AkmAssetType, e.entry.name);
      return { e, ref, score: rankScores.get(ref) ?? 0 };
    })
    .sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : 1));

  // Type-stratified top slice: ⅓ per learning type, backfill from global order.
  const perType = Math.ceil(canaryCount / 3);
  const picked = new Map<string, (typeof candidates)[number]>();
  for (const type of LEARNING_TYPES) {
    let taken = 0;
    for (const c of candidates) {
      if (taken >= perType || picked.size >= canaryCount) break;
      if (c.e.entry.type === type && !picked.has(c.ref)) {
        picked.set(c.ref, c);
        taken++;
      }
    }
  }
  for (const c of candidates) {
    if (picked.size >= canaryCount) break;
    if (!picked.has(c.ref)) picked.set(c.ref, c);
  }

  return [...picked.values()]
    .map((c) => ({ anchorRef: c.ref, query: buildCanaryQuery(c.e) }))
    .filter((c) => c.query.length > 0);
}

/** Collision-safe mint token (same-millisecond mints happen in tests + concurrent runs). */
function newCanarySetId(): string {
  return `canary-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

/**
 * Mint (or return) the active canary set. Deterministic given the index +
 * salience tables: rank the three learning types by `asset_salience.rank_score`
 * (fallback 0, tie-broken by ref), take a type-stratified top slice
 * (⅓ per type, backfilled from the global ranking when a type is short).
 *
 * Returns `null` when the index has no mintable learning entries — a cycle
 * with no canary set is NOT recorded (a fresh unused set id every cycle would
 * mean the trend window never fills and recall reads as a fake 0).
 *
 * NEVER auto-refreshes: once minted the set is frozen until an explicit
 * `akm improve canary --refresh` — silent re-baselining is how a slow collapse
 * hides. Rows are read back BY OUR OWN set id (never "newest active") so a
 * concurrent mint in another process cannot relabel this run's metrics.
 */
export function ensureCanarySet(
  stateDb: StateDatabase,
  indexDb: IndexDatabase,
  cfg: CollapseDetectorConfig,
  preloadedEntries?: DbIndexedEntry[],
): { canarySetId: string; canaries: CanaryQueryRow[] } | null {
  const existing = getActiveCanaries(stateDb);
  if (existing.length > 0) {
    return { canarySetId: existing[0].canary_set_id, canaries: existing };
  }

  const minted = buildMintList(stateDb, preloadedEntries ?? getAllEntries(indexDb), cfg);
  if (minted.length === 0) return null;

  const canarySetId = newCanarySetId();
  insertCanaries(stateDb, canarySetId, minted);
  return { canarySetId, canaries: getCanariesBySetId(stateDb, canarySetId) };
}

/**
 * Explicit canary re-mint (the ONLY refresh path — `akm improve canary
 * --refresh`). Mint-first, deactivate-after: when the index is empty or
 * unreadable the current baseline is left untouched instead of destroyed.
 * Deactivates ALL other active sets (not just the newest) so stragglers from
 * an interrupted refresh can never resurrect.
 */
export function refreshCanarySet(
  stateDb: StateDatabase,
  indexDb: IndexDatabase,
  cfg: CollapseDetectorConfig,
): { canarySetId: string; canaries: CanaryQueryRow[] } | null {
  const minted = buildMintList(stateDb, getAllEntries(indexDb), cfg);
  if (minted.length === 0) return null; // nothing mintable — keep the old baseline

  const canarySetId = newCanarySetId();
  insertCanaries(stateDb, canarySetId, minted);
  for (const oldSetId of listActiveCanarySetIds(stateDb)) {
    if (oldSetId !== canarySetId) deactivateCanarySet(stateDb, oldSetId);
  }
  return { canarySetId, canaries: getCanariesBySetId(stateDb, canarySetId) };
}

// ── Cycle metrics ─────────────────────────────────────────────────────────────

/**
 * Name-free content fingerprint text for entropy metrics. The indexed
 * search_text EMBEDS the (unique) entry name, which would pin the
 * distinct-content ratio at 1.0 forever; convergence shows up in the
 * description/tags/heading fields, so those are what get hashed. (The raw body
 * is not in the index at all — search_text covers metadata + TOC headings —
 * so v1 entropy is measured over the searchable surface, which is also what
 * generic merged assets converge on.)
 */
function contentFingerprint(entry: DbIndexedEntry["entry"]): string {
  const parts = [entry.description ?? "", (entry.tags ?? []).join(" "), (entry.toc ?? []).map((h) => h.text).join(" ")];
  return parts.filter((t) => t.length > 0).join(" ");
}

/** FNV-1a 64-bit over lowercased whitespace-collapsed text (distinct-content hashing). */
export function normHash(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= BigInt(normalized.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16);
}

/**
 * Score one canary against the live index, merge-following via `source_refs`:
 * a hit is the anchor ref itself OR any returned entry whose `source_refs`
 * frontmatter contains the anchor (ONE level — provenance dropped on a
 * second-generation merge is a miss by design; that IS the information loss).
 * Returns the 0-based rank of the first hit, or -1.
 */
function scoreCanary(indexDb: IndexDatabase, canary: { anchor_ref: string; query: string }, k: number): number {
  const results = searchFts(indexDb, canary.query, k);
  for (let i = 0; i < Math.min(results.length, k); i++) {
    const r = results[i];
    const ref = makeAssetRef(r.entry.type as AkmAssetType, r.entry.name);
    if (ref === canary.anchor_ref) return i;
    if (r.entry.sourceRefs?.includes(canary.anchor_ref)) return i;
  }
  return -1;
}

/**
 * Compute one qualifying cycle's store-health snapshot. One `entries` scan +
 * `canaryCount` FTS queries; no LLM, no embedding model, no filesystem reads.
 * Returns `null` when no canary set exists AND none is mintable (empty index)
 * — such a cycle is not measurable and must not be recorded.
 */
export function computeCycleMetrics(
  stateDb: StateDatabase,
  indexDb: IndexDatabase,
  args: {
    runId: string;
    pass: "consolidate" | "recombine" | "both";
    acceptedActions: number;
    mergeFloorViolations: number;
    cfg: CollapseDetectorConfig;
    /** Over-generation threshold; callers pass the antiCollapse.maxGeneration in effect. */
    maxGeneration?: number;
    now?: Date;
  },
): CycleMetricsRow | null {
  const k = args.cfg.k ?? DEFAULT_CANARY_K;
  const maxGeneration = args.maxGeneration ?? DEFAULT_MAX_GENERATION;

  // Single entries scan — shared by the canary mint (if one is needed) and
  // the store-shape metrics below.
  const all = getAllEntries(indexDb);
  const canarySet = ensureCanarySet(stateDb, indexDb, args.cfg, all);
  if (canarySet === null) return null;
  const { canarySetId, canaries } = canarySet;

  // ── Canary retrieval metrics ───────────────────────────────────────────────
  const ranks: Array<[number, number]> = [];
  let recallSum = 0;
  let ndcgSum = 0;
  let mrrSum = 0;
  for (const canary of canaries) {
    const rank = scoreCanary(indexDb, canary, k);
    ranks.push([canary.id, rank]);
    if (rank >= 0) {
      recallSum += 1;
      mrrSum += 1 / (rank + 1);
      // Single-relevant nDCG@k closed form: ideal DCG is 1, so the score is
      // just the discount at the hit rank.
      ndcgSum += 1 / Math.log2(rank + 2);
    }
  }
  const n = Math.max(1, canaries.length);

  // ── Store-shape metrics (same single entries scan) ────────────────────────
  const byType = new Map<string, number>();
  const contentHashes = new Set<string>();
  let learningTotal = 0;
  let overGeneration = 0;
  const learningTexts: Array<{ key: string; text: string }> = [];
  for (const e of all) {
    byType.set(e.entry.type, (byType.get(e.entry.type) ?? 0) + 1);
    if (!LEARNING_TYPES.has(e.entry.type)) continue;
    learningTotal++;
    const fingerprint = contentFingerprint(e.entry);
    contentHashes.add(normHash(fingerprint));
    if ((e.entry.generation ?? 0) > maxGeneration) overGeneration++;
    learningTexts.push({ key: e.entryKey, text: fingerprint });
  }

  // Deterministic diversity sample: sort by entryKey, take every ⌈N/cap⌉-th row.
  learningTexts.sort((a, b) => (a.key < b.key ? -1 : 1));
  const step = Math.max(1, Math.ceil(learningTexts.length / DIVERSITY_SAMPLE_CAP));
  let diversitySum = 0;
  let diversityCount = 0;
  for (let i = 0; i < learningTexts.length; i += step) {
    diversitySum += computeBigramDiversity(learningTexts[i].text);
    diversityCount++;
  }

  return {
    run_id: args.runId,
    ts: (args.now ?? new Date()).toISOString(),
    pass: args.pass,
    canary_set_id: canarySetId,
    mean_recall: recallSum / n,
    mean_ndcg: ndcgSum / n,
    mean_mrr: mrrSum / n,
    canary_ranks_json: JSON.stringify(ranks),
    store_total: learningTotal,
    store_by_type_json: JSON.stringify(Object.fromEntries([...byType.entries()].sort())),
    distinct_content_ratio: learningTotal === 0 ? 1 : contentHashes.size / learningTotal,
    mean_bigram_diversity: diversityCount === 0 ? 1 : diversitySum / diversityCount,
    over_generation_count: overGeneration,
    accepted_actions: args.acceptedActions,
    merge_floor_violations: args.mergeFloorViolations,
    alerts_json: "[]",
  };
}

// ── Alert evaluation (pure) ───────────────────────────────────────────────────

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Evaluate the §1 alert definitions. PURE — history rows (oldest-first, NOT
 * including `current`) plus the current row in, alerts out. A window shorter
 * than `windowCycles` never fires (no baseline yet); the merge-floor advisory
 * is per-cycle and fires regardless of window depth.
 */
export function evaluateCollapseAlerts(
  history: CycleMetricsRow[],
  current: CycleMetricsRow,
  cfg: CollapseDetectorConfig,
): CollapseAlert[] {
  const alerts: CollapseAlert[] = [];

  // MERGE-FLOOR advisory: per-cycle, window-independent. Gated on a minimum
  // count — the specificity floor is deliberately strict pre-tuning, and one
  // or two borderline merges per cycle must not generate alert fatigue.
  if (current.merge_floor_violations >= MERGE_FLOOR_ALERT_MIN) {
    alerts.push({
      kind: "merge-floor",
      detail: `${current.merge_floor_violations} merge(s) failed the information floor this cycle (provenance shrank or specificity below threshold)`,
      metrics: { mergeFloorViolations: current.merge_floor_violations },
    });
  }

  const W = cfg.windowCycles ?? DEFAULT_WINDOW_CYCLES;
  const hist = history.slice(-W);
  if (hist.length < W) return alerts; // no baseline yet

  const recallDrop = cfg.recallDropThreshold ?? DEFAULT_RECALL_DROP_THRESHOLD;
  const entropyDrop = cfg.entropyDropThreshold ?? DEFAULT_ENTROPY_DROP_THRESHOLD;
  const churnMin = cfg.churnMinAcceptedActions ?? DEFAULT_CHURN_MIN_ACCEPTED;

  // COLLAPSE 1 — canary recall drop vs window median (median, not previous
  // cycle, so one noisy cycle can neither fire nor mask the alert).
  const medianRecall = median(hist.map((h) => h.mean_recall));
  if (current.mean_recall <= medianRecall - recallDrop) {
    alerts.push({
      kind: "collapse-recall",
      detail: `mean canary recall ${current.mean_recall.toFixed(3)} dropped ≥${recallDrop} below the ${W}-cycle median ${medianRecall.toFixed(3)}`,
      metrics: { currentRecall: current.mean_recall, medianRecall, threshold: recallDrop },
    });
  }

  // COLLAPSE 2 — monotonic distinct-content-ratio decline over the window.
  const series = [...hist.map((h) => h.distinct_content_ratio), current.distinct_content_ratio];
  const monotonicNonIncreasing = series.every((v, i) => i === 0 || v <= series[i - 1]);
  const totalDecline = hist[0].distinct_content_ratio - current.distinct_content_ratio;
  if (monotonicNonIncreasing && totalDecline >= entropyDrop) {
    alerts.push({
      kind: "collapse-entropy",
      detail: `distinct-content ratio declined monotonically by ${totalDecline.toFixed(3)} (≥${entropyDrop}) over ${W} cycles — store content is converging`,
      metrics: {
        windowStart: hist[0].distinct_content_ratio,
        current: current.distinct_content_ratio,
        decline: totalDecline,
      },
    });
  }

  // COLLAPSE 3 — store shrinking BECAUSE of re-merging (not deletion hygiene).
  const maxStore = Math.max(...hist.map((h) => h.store_total));
  if (current.store_total < 0.8 * maxStore && current.over_generation_count > hist[0].over_generation_count) {
    alerts.push({
      kind: "collapse-shrink",
      detail: `store shrank >20% (${current.store_total} vs window max ${maxStore}) while over-generation count rose (${hist[0].over_generation_count} → ${current.over_generation_count})`,
      metrics: {
        storeTotal: current.store_total,
        windowMax: maxStore,
        overGeneration: current.over_generation_count,
      },
    });
  }

  // CHURN — real write volume, zero retrieval- or shape-visible movement.
  // Flatness is measured against the window MEDIAN (consistent with the
  // recall rule): endpoint-only comparison would call a window that swung
  // wildly but happened to land near its start "flat".
  const acceptedSum = hist.reduce((a, h) => a + h.accepted_actions, 0);
  const scoreFlat = Math.abs(current.mean_ndcg - median(hist.map((h) => h.mean_ndcg))) < 0.02;
  const entropyFlat =
    Math.abs(current.distinct_content_ratio - median(hist.map((h) => h.distinct_content_ratio))) < 0.02;
  if (acceptedSum >= churnMin && scoreFlat && entropyFlat) {
    alerts.push({
      kind: "churn",
      detail: `${acceptedSum} accepted actions over ${W} cycles with flat canary score and flat entropy — write volume with no retrieval-visible effect`,
      metrics: { acceptedSum, ndcgDelta: current.mean_ndcg - hist[0].mean_ndcg },
    });
  }

  return alerts;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the detector for one qualifying cycle: ensure canaries → compute →
 * evaluate against stored history → persist the row → append one
 * `collapse_detector_alert` event per fired alert. FAIL-OPEN: any error warns
 * and returns undefined — an improve run is never broken by its own
 * instrumentation.
 */
export function runCollapseDetector(args: {
  runId: string;
  pass: "consolidate" | "recombine" | "both";
  acceptedActions: number;
  mergeFloorViolations: number;
  config: AkmConfig;
  eventsCtx?: EventsContext;
  indexDbPath?: string;
}): CycleMetricsRow | undefined {
  const cfg: CollapseDetectorConfig = args.config.improve?.collapseDetector ?? {};
  if (cfg.enabled === false) return undefined;

  try {
    let indexDb: IndexDatabase | undefined;
    try {
      indexDb = openExistingDatabase(args.indexDbPath);
      const db = indexDb;
      // Over-generation threshold mirrors the guard actually in effect —
      // reading the same config key keeps the two aligned when tuned.
      const antiCollapse = args.config.profiles?.improve?.default?.processes?.consolidate?.antiCollapse as
        | { maxGeneration?: number }
        | undefined;
      const maxGeneration = antiCollapse?.maxGeneration ?? DEFAULT_MAX_GENERATION;
      return withStateDb(
        (stateDb) => {
          const row = computeCycleMetrics(stateDb, db, {
            runId: args.runId,
            pass: args.pass,
            acceptedActions: args.acceptedActions,
            mergeFloorViolations: args.mergeFloorViolations,
            cfg,
            maxGeneration,
          });
          if (row === null) return undefined; // empty index — nothing to measure
          const windowCycles = cfg.windowCycles ?? DEFAULT_WINDOW_CYCLES;
          const history = queryRecentCycleMetrics(stateDb, row.canary_set_id, windowCycles);
          const alerts = evaluateCollapseAlerts(history, row, cfg);
          row.alerts_json = JSON.stringify(alerts.map((a) => a.kind));
          insertCycleMetrics(stateDb, row);

          for (const alert of alerts) {
            appendEvent(
              {
                eventType: "collapse_detector_alert",
                ref: undefined,
                metadata: {
                  kind: alert.kind,
                  detail: alert.detail,
                  metrics: alert.metrics,
                  canarySetId: row.canary_set_id,
                  runId: args.runId,
                },
              },
              args.eventsCtx,
            );
          }
          return row;
        },
        { path: args.eventsCtx?.dbPath, borrowed: args.eventsCtx?.db },
      );
    } finally {
      if (indexDb) closeDatabase(indexDb);
    }
  } catch (err) {
    warn(`[collapse-detector] skipped (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
