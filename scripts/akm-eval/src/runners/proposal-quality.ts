/**
 * Proposal-quality runner — computes acceptance rate, validation pass rate,
 * and accept-rate-by-source from the existing proposal queue and events.
 *
 * Reads state.db when available; falls back to filesystem scan of
 * <stash>/.akm/proposals/.
 *
 * Inputs:  { since?: string; source?: string }
 * Expected:
 *   { minValidationPassRate?: number; minAcceptRate?: number;
 *     maxRejectRate?: number; maxCreationRejectedRate?: number;
 *     minProposals?: number }
 */

import type { EvalCase, EvalCaseResult, EvalContext } from "../types";
import { makeStateDbSources, type ProposalRow } from "../sources/state-db";
import { StashFsSources } from "../sources/stash-fs";

export async function runProposalQualityCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  const since = c.input.since as string | undefined;
  const filterSource = c.input.source as string | undefined;

  const stateDb = makeStateDbSources({ record: ctx.recording });
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
      proposals = fs.readProposals({ source: filterSource });
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

  return {
    caseId: c.id,
    type: "proposal-quality",
    score,
    passed: score >= passThreshold,
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
