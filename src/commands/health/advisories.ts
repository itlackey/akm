// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Improve-pipeline advisories for `akm health`: projects the computed
 * {@link ImproveHealthMetrics} plus a few direct event reads into the
 * ordered advisory list.
 */

import { readEvents } from "../../core/events";
import type { openStateDatabase } from "../../core/state-db";
import { getLatestCycleMetrics } from "../../storage/repositories/canaries-repository";
import {
  ENRICHMENT_MINTED_FAIL_SHARE,
  ENRICHMENT_MINTED_WARN_SHARE,
  type HealthCheckResult,
  type ImproveHealthMetrics,
} from "./types";

/**
 * Build the improve-pipeline advisories for the health window from the already
 * computed {@link ImproveHealthMetrics} plus a few direct event reads. Pure
 * projection of state → advisories; emission order is preserved so the health
 * report is byte-identical to the previous inline construction.
 */
export function collectImproveAdvisories(
  db: ReturnType<typeof openStateDatabase>,
  stateDbPath: string,
  since: string,
  improveSummary: ImproveHealthMetrics,
): HealthCheckResult[] {
  const advisories: HealthCheckResult[] = [];

  // WS-2 proxy-adequacy tripwire: surface any outcome_proxy_inverted events
  // in the health window as an advisory so operators know when the 0.10+
  // rich in-session signal is no longer deferrable.
  const proxyInvertedEvents = readEvents({ since, type: "outcome_proxy_inverted" }, { dbPath: stateDbPath }).events;
  if (proxyInvertedEvents.length > 0) {
    const lastEvent = proxyInvertedEvents[proxyInvertedEvents.length - 1]!;
    const correlation =
      typeof lastEvent.metadata?.correlation === "number" ? lastEvent.metadata.correlation.toFixed(3) : "unknown";
    advisories.push({
      name: "outcome-proxy-adequacy",
      status: "warn",
      kind: "deterministic",
      confidence: "high",
      message:
        `WS-2 outcome proxy inverted (${proxyInvertedEvents.length} event(s) in window). ` +
        `corr(outcome_score, accepted_change_rate) = ${correlation} < −0.3. ` +
        "Popular assets are also the most-needing-improvement assets — " +
        "the retrieval-based proxy is inverted. " +
        "The 0.10+ rich in-session outcome signal is no longer deferrable. See plan §WS-2.",
    });
  }

  // Two-tailed companion: a proxy that decays to noise (|corr| < 0.1 at scale)
  // is as much a failure as an inverted one — it just fails silently.
  const proxyDeadEvents = readEvents({ since, type: "outcome_proxy_dead" }, { dbPath: stateDbPath, db }).events;
  if (proxyDeadEvents.length > 0) {
    const lastEvent = proxyDeadEvents[proxyDeadEvents.length - 1]!;
    const correlation =
      typeof lastEvent.metadata?.correlation === "number" ? lastEvent.metadata.correlation.toFixed(3) : "unknown";
    advisories.push({
      name: "outcome-proxy-dead",
      status: "warn",
      kind: "deterministic",
      confidence: "high",
      message:
        `WS-2 outcome proxy is DEAD (${proxyDeadEvents.length} event(s) in window). ` +
        `|corr(outcome_score, accepted_change_rate)| = ${correlation} < 0.1 at n ≥ 500. ` +
        "outcome_score is statistically unrelated to improvement outcomes — " +
        "treat outcome-derived rank contributions as noise until a real usage/outcome signal lands.",
    });
  }

  // Salience-distribution collapse: Gini below the uniform baseline means
  // ranking no longer discriminates between assets.
  if (improveSummary.degradation?.salienceUniformityFlagged) {
    advisories.push({
      name: "salience-uniformity-collapse",
      status: "warn",
      kind: "deterministic",
      confidence: "high",
      message:
        `Salience distribution collapsed toward uniform: top-100 retrieval_salience Gini = ` +
        `${improveSummary.degradation.corpusCentroidDistance} < 0.08 (uniform baseline ≈ 0.1). ` +
        "Ranking currently carries little to no discrimination between assets.",
    });
  }

  // Enrichment-vs-minting policy: enrichment lanes edit existing assets;
  // a rising minted share means a lane is generating new content instead.
  const minting = improveSummary.enrichmentMinting;
  if (minting && Number.isFinite(minting.share) && minting.share > ENRICHMENT_MINTED_WARN_SHARE) {
    advisories.push({
      name: "enrichment-lane-minting",
      status: minting.share > ENRICHMENT_MINTED_FAIL_SHARE ? "fail" : "warn",
      kind: "deterministic",
      confidence: "high",
      message:
        `Enrichment lanes minted ${minting.minted} NEW asset(s) vs ${minting.updated} update(s) ` +
        `(${Math.round(minting.share * 100)}% minted, threshold ${Math.round(ENRICHMENT_MINTED_WARN_SHARE * 100)}%). ` +
        "Enrichment-classed lanes (proactive/high-salience/signal-delta) are ratified to edit " +
        "existing assets only — new-asset generation belongs to the signal-gated minting lanes.",
    });
  }

  // Churn: accepted proposals far exceeding distinct touched refs means the
  // loop is repeatedly rewriting the same assets, not covering the corpus.
  if (Number.isFinite(improveSummary.coverage.churnRatio) && improveSummary.coverage.churnRatio > 1.5) {
    advisories.push({
      name: "improve-churn-ratio",
      status: "warn",
      kind: "deterministic",
      confidence: "high",
      message:
        `Improve churn ratio ${improveSummary.coverage.churnRatio} > 1.5: ` +
        `${improveSummary.coverage.acceptedProposals} accepted proposals touched only ` +
        `${improveSummary.coverage.distinctRefs} distinct assets in the window — ` +
        "repeated rewrites of the same refs count as churn, not coverage.",
    });
  }

  // R5 collapse/churn detector: surface any collapse_detector_alert events
  // in the health window, plus the latest cycle row's headline numbers so
  // the operator can act without opening the DB. `unknown` when the detector
  // has never produced a cycle row (no consolidate work yet).
  try {
    // Reuse the already-open state.db handle (readEvents supports a
    // borrowed connection) — no extra open/migrate/close per health call.
    const collapseAlertEvents = readEvents(
      { since, type: "collapse_detector_alert" },
      { dbPath: stateDbPath, db },
    ).events;
    const latestCycle = getLatestCycleMetrics(db);
    const cycleSummary = latestCycle
      ? `Latest cycle (${latestCycle.ts}, ${latestCycle.pass}): mean canary recall ${latestCycle.mean_recall.toFixed(3)}, ` +
        `distinct-content ratio ${latestCycle.distinct_content_ratio.toFixed(3)}, ` +
        `${latestCycle.accepted_actions} accepted action(s).`
      : "";
    if (collapseAlertEvents.length > 0) {
      const kinds = [...new Set(collapseAlertEvents.map((e) => String(e.metadata?.kind ?? "unknown")))];
      const collapseKinds = kinds.filter((k) => k.startsWith("collapse"));
      advisories.push({
        name: "collapse-churn-detector",
        status: "warn",
        kind: "deterministic",
        // Collapse kinds are measured, not inferred; churn/merge-floor
        // volume thresholds are still being tuned (design doc §7).
        confidence: collapseKinds.length > 0 ? "high" : "medium",
        message:
          `R5 detector fired ${collapseAlertEvents.length} alert(s) in window (kinds: ${kinds.join(", ")}). ` +
          `${cycleSummary} See docs/architecture/specs/improve-collapse-churn-detector-design.md §6.3 runbook queries.`,
      });
    } else if (latestCycle) {
      advisories.push({
        name: "collapse-churn-detector",
        status: "pass",
        kind: "deterministic",
        confidence: "high",
        message: `No collapse/churn alerts in window. ${cycleSummary}`,
      });
    } else {
      advisories.push({
        name: "collapse-churn-detector",
        status: "unknown",
        kind: "deterministic",
        confidence: "high",
        message:
          "No detector cycle rows yet — the collapse/churn detector runs only on improve cycles " +
          "where consolidate did work.",
      });
    }
  } catch {
    // Table may predate migration 016 in odd mixed-version setups — advisory
    // is best-effort and must never fail the health command.
  }

  return advisories;
}
