// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * State.db-backed health metrics for `akm health`: the round-trip probe,
 * denominator-fixed coverage, the enrichment-vs-minting rollup, and the WS-5
 * per-run degradation metrics.
 */

import { appendEvent, readEvents } from "../../core/events";
import { decodeImproveResult } from "../../core/improve-result";
import type { Database } from "../../storage/database";
import { queryImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { listStateProposals } from "../../storage/repositories/proposals-repository";
import { roundRate, toFiniteNumber } from "./improve-metrics";
import {
  ENRICHMENT_LANES,
  type EnrichmentMintingRollup,
  type ImproveDegradationMetrics,
  type ImproveHealthMetrics,
  type OracleSpotCheckEntry,
} from "./types";

/** Event type appended + read back by the state.db round-trip probe. */
const HEALTH_PROBE_EVENT = "health_probe";

export function probeStateDbRoundTrip(stateDbPath: string): { ok: boolean; durationMs: number | null; error?: string } {
  const before = readEvents({}, { dbPath: stateDbPath }).nextOffset;
  const started = Date.now();
  appendEvent(
    { eventType: HEALTH_PROBE_EVENT, ref: "health:probe", metadata: { source: "akm health" } },
    { dbPath: stateDbPath },
  );
  const after = readEvents(
    { sinceOffset: before, type: HEALTH_PROBE_EVENT, ref: "health:probe" },
    { dbPath: stateDbPath },
  );
  const durationMs = Date.now() - started;
  if (after.events.length === 0 || after.nextOffset <= before) {
    return { ok: false, durationMs, error: "probe event was not readable after append" };
  }
  return { ok: true, durationMs };
}

// ── WS-5 Observability helpers ───────────────────────────────────────────────

/**
 * Compute WS-5 denominator-fixed coverage metrics.
 *
 * `coverage = accepted_proposals / total_assets` (Part V §3).
 * The denominator is the TOTAL stash size (not the moving eligible set) so
 * more-inclusive WS-1 ranking cannot spuriously inflate coverage.
 * `eligibleFraction = eligible_assets / total_assets` is reported separately.
 *
 * Proposals are counted only when their `updatedAt` falls within `[since, until)`
 * so the rate is genuinely window-scoped (matching the JSDoc on the type).
 *
 * @param db - Open state.db connection.
 * @param totalAssets - Total stash asset count (eligible + derived) from the
 *   most recent run's memorySummary. 0 = denominator unknown, returns NaN rates.
 * @param eligibleAssets - Eligible (non-derived) asset count from the most recent run.
 * @param since - Window start (ISO-8601). Proposals accepted before this are excluded.
 * @param until - Window end (ISO-8601, exclusive). Absent = open-ended (up to now).
 * @param stashDir - Optional: scope accepted proposals to one stash. Absent = all stashes.
 */
export function computeDenominatorFixedCoverage(
  db: Database,
  totalAssets: number,
  eligibleAssets: number,
  since: string,
  until?: string,
  stashDir?: string,
): ImproveHealthMetrics["coverage"] {
  let acceptedProposals = 0;
  let distinctRefs = 0;
  try {
    const proposals = listStateProposals(db, {
      status: "accepted",
      ...(stashDir ? { stashDir } : {}),
    }).filter((p) => {
      const updatedAt = p.updatedAt ?? "";
      if (updatedAt < since) return false;
      if (until !== undefined && updatedAt >= until) return false;
      return true;
    });
    acceptedProposals = proposals.length;
    // Coverage counts DISTINCT refs: N accepted rewrites of one asset are
    // churn, not coverage. The raw proposal count is kept alongside so the
    // churn ratio (proposals ÷ distinct refs) stays visible.
    distinctRefs = new Set(proposals.map((p) => p.ref)).size;
  } catch {
    // Fail open: table may not exist on older installs.
  }

  const churnRatio = distinctRefs > 0 ? roundRate(acceptedProposals / distinctRefs) : Number.NaN;

  if (totalAssets === 0) {
    return {
      rate: Number.NaN,
      eligibleFraction: Number.NaN,
      acceptedProposals,
      distinctRefs,
      churnRatio,
      totalAssets: 0,
    };
  }

  return {
    rate: roundRate(distinctRefs / totalAssets),
    eligibleFraction: roundRate(eligibleAssets / totalAssets),
    acceptedProposals,
    distinctRefs,
    churnRatio,
    totalAssets,
  };
}

/**
 * Compute the enrichment-vs-minting rollup over the window's accepted,
 * lane-attributed proposals (reporting-only; see {@link EnrichmentMintingRollup}).
 *
 * SQL-side `json_extract` keeps the (potentially large) `backupContent` blobs
 * out of process memory. Pre-Phase-6C rows without an `eligibilitySource`
 * cannot be lane-classified and are excluded. Fails open (undefined) when the
 * proposals table is absent.
 */
export function computeEnrichmentMintingRollup(
  db: Database,
  since: string,
  until?: string,
): EnrichmentMintingRollup | undefined {
  try {
    const rows = db
      .prepare(
        `SELECT
           json_extract(metadata_json, '$.eligibilitySource') AS lane,
           CASE WHEN json_extract(metadata_json, '$.backupContent') IS NULL THEN 1 ELSE 0 END AS is_minted,
           COUNT(*) AS cnt
         FROM proposals
         WHERE status = 'accepted'
           AND updated_at >= ?
           AND (? IS NULL OR updated_at < ?)
           AND json_extract(metadata_json, '$.eligibilitySource') IS NOT NULL
           AND json_extract(metadata_json, '$.eligibilitySource') != ''
         GROUP BY lane, is_minted`,
      )
      .all(since, until ?? null, until ?? null) as Array<{ lane: string; is_minted: number; cnt: number }>;
    if (rows.length === 0) return undefined;

    const byLane: Record<string, { minted: number; updated: number }> = {};
    for (const row of rows) {
      byLane[row.lane] ??= { minted: 0, updated: 0 };
      const entry = byLane[row.lane]!;
      if (row.is_minted === 1) entry.minted += row.cnt;
      else entry.updated += row.cnt;
    }

    let minted = 0;
    let updated = 0;
    for (const lane of ENRICHMENT_LANES) {
      const entry = byLane[lane];
      if (!entry) continue;
      minted += entry.minted;
      updated += entry.updated;
    }
    const decided = minted + updated;
    return {
      minted,
      updated,
      share: decided > 0 ? roundRate(minted / decided) : Number.NaN,
      byLane,
    };
  } catch {
    // Fail open: proposals table may not exist on older installs.
    return undefined;
  }
}

/**
 * Compute WS-5 per-run degradation metrics (Part V §4).
 *
 * Health VIEWS only — reads from state.db tables populated by prior improve
 * runs. Gracefully returns partial data when tables are absent (pre-WS-1/2).
 *
 * @param db - Open state.db connection.
 * @param since - Window start (ISO-8601).
 * @param until - Window end (ISO-8601).
 */
export function computeDegradationMetrics(
  db: Database,
  since: string,
  until: string,
): ImproveDegradationMetrics | undefined {
  // (a) Corpus diversity — salience rank distribution of the top-100 assets.
  // We use the Gini coefficient of retrieval_salience scores as an intra-corpus
  // diversity proxy. A Gini close to 1 = highly concentrated (entrenched top
  // assets), Gini near 0 = flat/diverse. This is a single-snapshot metric;
  // consecutive-run centroid distance requires cross-run history not yet stored.
  let corpusCentroidDistance = Number.NaN;
  let entrenchmentFlagged: boolean | undefined;
  let salienceUniformityFlagged: boolean | undefined;
  try {
    const rows = db
      .prepare(
        `SELECT retrieval_salience FROM asset_salience
         ORDER BY rank_score DESC LIMIT 100`,
      )
      .all() as Array<{ retrieval_salience: number }>;
    if (rows.length >= 5) {
      const vals = rows.map((r) => r.retrieval_salience).sort((a, b) => a - b);
      const n = vals.length;
      const sumAbsDiff = vals.reduce((acc, xi, i) => {
        return acc + vals.slice(i + 1).reduce((a, xj) => a + Math.abs(xi - xj), 0);
      }, 0);
      const mean = vals.reduce((a, b) => a + b, 0) / n;
      // Gini = (sum |xi - xj|) / (2 n^2 mean); 0 = perfect equality, 1 = perfect inequality.
      const gini = mean > 0 ? sumAbsDiff / (2 * n * n * mean) : 0;
      // Re-express as a diversity proxy in [0,1]: high gini = low diversity.
      // corpusCentroidDistance approximation: gini is "distance from uniform".
      // Note: retrieval_salience values are in [0,1], so the max achievable Gini
      // with this formula is ~0.5 (when one asset dominates and others are near 0).
      // Two-tailed: >0.35 flags entrenchment (robustly above the ~0.1 uniform
      // baseline); <0.08 flags uniformity collapse — the distribution no longer
      // discriminates between assets (live 2026-07 value 0.040 sat unflagged
      // in this tail under the old one-tailed check).
      corpusCentroidDistance = roundRate(gini);
      entrenchmentFlagged = gini > 0.35;
      salienceUniformityFlagged = gini < 0.08;
    }
  } catch {
    // Table not present (pre-WS-1 install) — leave NaN.
  }

  // (b) Merge fidelity — fraction of consolidate accepted proposals in the window
  // whose ref also has a consolidate skip-reason of "contradict_target_missing"
  // or an event indicating contradiction. Uses the improve_runs result_json
  // consolidation.contradicted count as a proxy.
  // Simple implementation: contradictionRate = total_contradicted / max(1, total_processed)
  // sourced from the window's consolidation envelope.
  // (The full "merge proposal → later contradiction" correlation requires cross-run
  // history; this is the available proxy.)
  let mergeFidelityContradictionRate = 0;
  try {
    const runs = queryImproveRuns(db, since, until);
    let totalContradicted = 0;
    let totalProcessed = 0;
    for (const row of runs) {
      try {
        const result = decodeImproveResult(row.result_json).envelope as unknown as Record<string, unknown>;
        const cons = result.consolidation as Record<string, unknown> | undefined;
        if (cons) {
          totalContradicted += toFiniteNumber(cons.contradicted);
          totalProcessed += toFiniteNumber(cons.processed);
        }
      } catch {
        // Skip malformed rows.
      }
    }
    if (totalProcessed > 0) {
      mergeFidelityContradictionRate = roundRate(totalContradicted / totalProcessed);
    }
  } catch {
    // Fail open.
  }

  // (c) highGenerationFraction was DELETED (meta-review 05 DRIFT-3): it
  // approximated "LLM-merge generations" from consecutive_no_ops — which counts
  // the opposite condition (cycles where nothing was changed) — and its own
  // in-code TODO admitted the proxy. Display-only, never actionable; removed
  // rather than instrumented.

  // (d) Oracle spot-check — up to 5 recently accepted proposals in the window.
  const oracleSpotCheck: OracleSpotCheckEntry[] = [];
  try {
    const accepted = listStateProposals(db, { status: "accepted" }).filter((p) => {
      const updatedAt = p.updatedAt ?? "";
      return updatedAt >= since && updatedAt < until;
    });
    // Sample up to 5: pick evenly spaced (not just the first 5).
    const step = Math.max(1, Math.floor(accepted.length / 5));
    for (let i = 0; i < accepted.length && oracleSpotCheck.length < 5; i += step) {
      const p = accepted[i];
      if (p) {
        oracleSpotCheck.push({
          proposalId: p.id,
          ref: p.ref,
          source: p.source ?? "unknown",
          acceptedAt: p.updatedAt ?? p.createdAt ?? "",
        });
      }
    }
  } catch {
    // Fail open.
  }

  return {
    corpusCentroidDistance,
    entrenchmentFlagged,
    salienceUniformityFlagged,
    mergeFidelityContradictionRate,
    oracleSpotCheck,
  };
}
