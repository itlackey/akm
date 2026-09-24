// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-proposal-source accept-rate metrics, folded into `akm health --report`
 * (0.9.0 CLI overhaul, S3).
 *
 * Provides the core self-measurement metric for recursive self-improvement:
 * if reflect proposals are accepted at 20% and distill proposals at 60%,
 * that guides resource allocation to higher-ROI generators.
 *
 * Previously exposed as the removed `akm history --accept-rate-by-source`
 * flag (src/commands/sources/history.ts, F-4 / #385); `health` already reads
 * the pending proposal queue for its own `--report` dataset, so this is the
 * same read extended to the accepted/rejected archive.
 */

import { resolveStashDir } from "../../core/common";
import { isStaleTargetRejection } from "../proposal/proposal-types";
import { listProposals } from "../proposal/repository";

export interface AcceptRateEntry {
  /** Proposal source (one of PROPOSAL_SOURCES or a custom value). */
  source: string;
  /** Total proposals seen (accepted + rejected + pending). */
  total: number;
  /** Proposals accepted. */
  accepted: number;
  /** Proposals rejected. */
  rejected: number;
  /** Proposals still pending (not yet decided). */
  pending: number;
  /** Accept rate as a fraction [0, 1]. null when total decided = 0. */
  acceptRate: number | null;
}

/**
 * Compute accept-rate-per-source metrics from the proposal store. Defaults to
 * the configured default stash when `stashDir` is omitted (same resolution
 * `akm health` already uses for the rest of its report).
 */
export function computeAcceptRateBySource(stashDir?: string): AcceptRateEntry[] {
  const stash = stashDir ?? resolveStashDir();
  const bySource = new Map<string, { accepted: number; rejected: number; pending: number }>();

  const countProposals = (statuses: Array<"pending" | "accepted" | "rejected">, includeArchive: boolean) => {
    for (const status of statuses) {
      const proposals = listProposals(stash, { status, includeArchive });
      for (const p of proposals) {
        // A stale-target auto-reject (STALE, R20) is procedural, not a
        // judgement on the content — counting it would understate the
        // source's real accept rate for content the drain will re-propose.
        if (status === "rejected" && isStaleTargetRejection(p)) continue;
        const src = p.source || "(unknown)";
        const entry = bySource.get(src) ?? { accepted: 0, rejected: 0, pending: 0 };
        if (status === "accepted") entry.accepted++;
        else if (status === "rejected") entry.rejected++;
        else entry.pending++;
        bySource.set(src, entry);
      }
    }
  };

  countProposals(["pending"], false);
  countProposals(["accepted", "rejected"], true);

  return Array.from(bySource.entries())
    .map(([source, counts]) => {
      const decided = counts.accepted + counts.rejected;
      return {
        source,
        total: decided + counts.pending,
        accepted: counts.accepted,
        rejected: counts.rejected,
        pending: counts.pending,
        acceptRate: decided > 0 ? counts.accepted / decided : null,
      } satisfies AcceptRateEntry;
    })
    .sort((a, b) => b.total - a.total); // Most active source first
}
