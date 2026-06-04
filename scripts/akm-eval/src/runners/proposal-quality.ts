/**
 * Proposal-quality runner — computes acceptance rate, validation pass rate,
 * and accept-rate-by-source from the existing proposal queue and events.
 *
 * Reads state.db when available; falls back to filesystem scan of
 * <stash>/.akm/proposals/.
 *
 * Inputs:  { since?: string; source?: string }
 *   - `since` accepts an ISO timestamp ("2026-05-20T00:00:00Z") or a
 *     shorthand duration ("24h", "7d", "30m"). The same window is applied
 *     to BOTH the proposals table AND the `proposal_creation_rejected`
 *     events so the validationPassRate reflects RECENT validator health
 *     instead of lifetime accumulated churn. (Live proposals get cleaned
 *     out post-decision and orphan-purged, so `counts.total` collapses
 *     to 0 over time while the rejection events table keeps growing —
 *     yielding 0/(0+N)=0 permanently with no window. See task #66.)
 *   - Set `since: null` to explicitly opt OUT of windowing (lifetime mode).
 *
 * Expected:
 *   { minValidationPassRate?: number; minAcceptRate?: number;
 *     maxRejectRate?: number; maxCreationRejectedRate?: number;
 *     minProposals?: number }
 */

import type { EvalCase, EvalCaseResult, EvalContext } from "../types";
import { makeStateDbSources, type ProposalRow } from "../sources/state-db";
import { StashFsSources } from "../sources/stash-fs";

/**
 * Resolve a `since` input to an ISO-8601 timestamp string suitable for
 * `ts >= ?` SQL comparison. Accepts:
 *
 *   - undefined     → returns undefined (no window)
 *   - null          → returns undefined (explicit lifetime mode)
 *   - shorthand     → "24h", "7d", "30m", "45s" → relative to `now`
 *   - ISO timestamp → returned as-is (any string containing "T" or "-")
 *
 * Invalid shorthand falls through as a literal string; SQL will then
 * compare lexicographically and likely return zero rows — caller handles
 * the empty-window case gracefully.
 */
export function resolveSinceWindow(value: unknown, now: Date = new Date()): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // Shorthand duration: <integer><unit> where unit ∈ {s, m, h, d}
  const m = /^(\d+)\s*([smhd])$/i.exec(trimmed);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms =
      unit === "s" ? n * 1000 :
      unit === "m" ? n * 60_000 :
      unit === "h" ? n * 3_600_000 :
      n * 86_400_000;
    return new Date(now.getTime() - ms).toISOString();
  }
  // Assume ISO-8601 or any user-supplied raw string — pass through.
  return trimmed;
}

export async function runProposalQualityCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  // Anchor windowed `since` to the orchestrator's frozen run-start instant so
  // record-vs-replay produce identical SQL parameters; falls back to a fresh
  // `new Date()` for hand-built contexts (older tests, ad-hoc invocations).
  const since = resolveSinceWindow(c.input.since, ctx.runStartedAt);
  const filterSource = c.input.source as string | undefined;

  const stateDb = makeStateDbSources({ dbPath: `${ctx.dataDir}/state.db`, record: ctx.recording });
  let proposals: ProposalRow[] = [];
  let creationRejected = 0;
  let dbAvailable = stateDb.available();

  try {
    if (dbAvailable) {
      proposals = stateDb.readProposals({ since, source: filterSource });
      creationRejected = stateDb
        .readEvents({ types: ["proposal_creation_rejected"], since })
        .length;
    } else {
      const fs = new StashFsSources(ctx.stashRoot);
      proposals = fs.readProposals({ source: filterSource, since });
    }
  } catch (err) {
    return errorResult(c, err instanceof Error ? err.message : String(err), start);
  } finally {
    stateDb.close();
  }

  const expected = c.expected as {
    minValidationPassRate?: number;
    minAcceptRate?: number;
    maxRejectRate?: number;
    maxCreationRejectedRate?: number;
    minProposals?: number;
  };

  const counts = {
    total: proposals.length,
    pending: proposals.filter((p) => p.status === "pending").length,
    accepted: proposals.filter((p) => p.status === "accepted").length,
    rejected: proposals.filter((p) => p.status === "rejected").length,
    reverted: proposals.filter((p) => p.status === "reverted").length,
    creationRejected,
  };

  const decided = counts.accepted + counts.rejected;
  const acceptRate = decided === 0 ? null : counts.accepted / decided;
  const rejectRate = decided === 0 ? null : counts.rejected / decided;
  const denominator = counts.total + counts.creationRejected;
  const validationPassRate = denominator === 0 ? null : counts.total / denominator;
  const creationRejectedRate = denominator === 0 ? null : counts.creationRejected / denominator;

  const bySource: Record<
    string,
    { total: number; accepted: number; rejected: number; pending: number; acceptRate: number | null }
  > = {};
  for (const p of proposals) {
    const s = p.source || "unknown";
    bySource[s] ??= { total: 0, accepted: 0, rejected: 0, pending: 0, acceptRate: null };
    bySource[s].total += 1;
    if (p.status === "accepted") bySource[s].accepted += 1;
    else if (p.status === "rejected") bySource[s].rejected += 1;
    else if (p.status === "pending") bySource[s].pending += 1;
  }
  for (const s of Object.keys(bySource)) {
    const row = bySource[s];
    const d = row.accepted + row.rejected;
    row.acceptRate = d === 0 ? null : row.accepted / d;
  }

  // Each expectation contributes one unit; the score is the fraction satisfied.
  const checks: Array<{ name: string; ok: boolean; value: number | null }> = [];
  if (expected.minProposals !== undefined) {
    checks.push({ name: "minProposals", ok: counts.total >= expected.minProposals, value: counts.total });
  }
  if (expected.minValidationPassRate !== undefined) {
    checks.push({
      name: "minValidationPassRate",
      ok: validationPassRate === null ? true : validationPassRate >= expected.minValidationPassRate,
      value: validationPassRate,
    });
  }
  if (expected.minAcceptRate !== undefined) {
    checks.push({
      name: "minAcceptRate",
      ok: acceptRate === null ? true : acceptRate >= expected.minAcceptRate,
      value: acceptRate,
    });
  }
  if (expected.maxRejectRate !== undefined) {
    checks.push({
      name: "maxRejectRate",
      ok: rejectRate === null ? true : rejectRate <= expected.maxRejectRate,
      value: rejectRate,
    });
  }
  if (expected.maxCreationRejectedRate !== undefined) {
    checks.push({
      name: "maxCreationRejectedRate",
      ok: creationRejectedRate === null ? true : creationRejectedRate <= expected.maxCreationRejectedRate,
      value: creationRejectedRate,
    });
  }

  // No expectations declared → metrics-only mode. Always passes; metrics are
  // the deliverable.
  const passThreshold = c.scoring?.passThreshold ?? 0.8;
  const score = checks.length === 0 ? 1 : checks.filter((c) => c.ok).length / checks.length;

  // Zero proposal traffic in the window AND no rejection events either →
  // mark as skipped so the rollup shows "no traffic" rather than implying
  // the gate passed on real data. The skipped flag carries the same score
  // so it still counts as healthy for overall aggregation.
  const skipped = counts.total === 0 && counts.creationRejected === 0;

  return {
    caseId: c.id,
    type: "proposal-quality",
    score,
    passed: score >= passThreshold,
    ...(skipped ? { skipped: true, skipReason: "no proposal traffic in window" } : {}),
    metrics: {
      counts,
      validationPassRate,
      acceptRate,
      rejectRate,
      creationRejectedRate,
      bySource,
      checks,
      sourceMode: dbAvailable ? "state-db" : "stash-fs",
    },
    evidence: {
      sampleProposalIds: proposals.slice(0, 5).map((p) => p.id),
      filterSource,
      since,
    },
    durationMs: Date.now() - start,
  };
}

function errorResult(c: EvalCase, message: string, start: number): EvalCaseResult {
  return {
    caseId: c.id,
    type: "proposal-quality",
    score: 0,
    passed: false,
    metrics: {},
    evidence: {},
    errors: [message],
    durationMs: Date.now() - start,
  };
}
