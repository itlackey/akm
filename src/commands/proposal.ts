/**
 * `akm proposal {list,show,accept,reject,diff}` — review surface for the
 * proposal substrate (#225).
 *
 * Each function returns a plain JSON envelope; the CLI dispatcher in
 * `src/cli.ts` flows the result through the standard
 * `shapeForCommand` + `formatPlain` pipeline. There is no `JSON.stringify`
 * fallback in the output layer — every shape is registered explicitly in
 * `src/output/shapes.ts` and `src/output/text.ts`.
 */

import { resolveStashDir } from "../core/common";
import type { AkmConfig } from "../core/config";
import { loadConfig } from "../core/config";
import { UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import {
  archiveProposal,
  type CreateProposalInput,
  createProposal,
  diffProposal,
  getProposal,
  listProposals,
  type Proposal,
  type ProposalsContext,
  promoteProposal,
  validateProposal,
} from "../core/proposals";

// ── Shared helpers ──────────────────────────────────────────────────────────

function resolveStash(stashDir?: string): string {
  if (stashDir) return stashDir;
  return resolveStashDir();
}

// ── list ────────────────────────────────────────────────────────────────────

export interface ProposalListOptions {
  stashDir?: string;
  status?: "pending" | "accepted" | "rejected";
  ref?: string;
  includeArchive?: boolean;
}

export interface ProposalListResult {
  schemaVersion: 1;
  totalCount: number;
  proposals: Proposal[];
}

export function akmProposalList(options: ProposalListOptions = {}): ProposalListResult {
  const stash = resolveStash(options.stashDir);
  // `--status accepted|rejected` implies archive-inclusion since the live
  // queue only ever contains pending entries.
  const includeArchive =
    options.includeArchive === true || options.status === "accepted" || options.status === "rejected";
  const proposals = listProposals(stash, {
    includeArchive,
    status: options.status,
    ref: options.ref,
  });
  return { schemaVersion: 1, totalCount: proposals.length, proposals };
}

// ── show ────────────────────────────────────────────────────────────────────

export interface ProposalShowOptions {
  stashDir?: string;
  id: string;
}

export interface ProposalShowResult {
  schemaVersion: 1;
  proposal: Proposal;
  validation: { ok: boolean; findings: { kind: string; message: string }[] };
}

export function akmProposalShow(options: ProposalShowOptions): ProposalShowResult {
  const stash = resolveStash(options.stashDir);
  const proposal = getProposal(stash, options.id);
  return {
    schemaVersion: 1,
    proposal,
    validation: validateProposal(proposal),
  };
}

// ── accept ──────────────────────────────────────────────────────────────────

export interface ProposalAcceptOptions {
  stashDir?: string;
  id: string;
  target?: string;
  /** Test seam — overrides config used for the write target. */
  config?: AkmConfig;
  /** Test seam — overrides clock / id source. */
  ctx?: ProposalsContext;
}

export interface ProposalAcceptResult {
  schemaVersion: 1;
  ok: true;
  id: string;
  ref: string;
  assetPath: string;
  proposal: Proposal;
}

export async function akmProposalAccept(options: ProposalAcceptOptions): Promise<ProposalAcceptResult> {
  const stash = resolveStash(options.stashDir);
  const config = options.config ?? loadConfig();
  const result = await promoteProposal(stash, config, options.id, { target: options.target }, options.ctx);

  // Emit `promoted` to the events stream so observers (audit, dashboards,
  // sync) see the accept happen. Only emit on the happy path — promotion
  // throws on validation failure, so reaching this point means the asset
  // is committed.
  appendEvent({
    eventType: "promoted",
    ref: result.ref,
    metadata: {
      proposalId: result.proposal.id,
      source: result.proposal.source,
      ...(result.proposal.sourceRun !== undefined ? { sourceRun: result.proposal.sourceRun } : {}),
      assetPath: result.assetPath,
    },
  });

  return {
    schemaVersion: 1,
    ok: true,
    id: result.proposal.id,
    ref: result.ref,
    assetPath: result.assetPath,
    proposal: result.proposal,
  };
}

// ── reject ──────────────────────────────────────────────────────────────────

export interface ProposalRejectOptions {
  stashDir?: string;
  id: string;
  reason?: string;
  ctx?: ProposalsContext;
}

export interface ProposalRejectResult {
  schemaVersion: 1;
  ok: true;
  id: string;
  ref: string;
  reason?: string;
  proposal: Proposal;
}

export function akmProposalReject(options: ProposalRejectOptions): ProposalRejectResult {
  const stash = resolveStash(options.stashDir);
  const existing = getProposal(stash, options.id);
  if (existing.status !== "pending") {
    throw new UsageError(
      `Proposal ${options.id} is not pending (current status: ${existing.status}). Only pending proposals can be rejected.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const updated = archiveProposal(stash, options.id, "rejected", options.reason, options.ctx);

  appendEvent({
    eventType: "rejected",
    ref: updated.ref,
    metadata: {
      proposalId: updated.id,
      source: updated.source,
      ...(updated.sourceRun !== undefined ? { sourceRun: updated.sourceRun } : {}),
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
    },
  });

  return {
    schemaVersion: 1,
    ok: true,
    id: updated.id,
    ref: updated.ref,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    proposal: updated,
  };
}

// ── diff ────────────────────────────────────────────────────────────────────

export interface ProposalDiffOptions {
  stashDir?: string;
  id: string;
  target?: string;
  config?: AkmConfig;
}

export interface ProposalDiffResult {
  schemaVersion: 1;
  id: string;
  ref: string;
  isNew: boolean;
  unified: string;
  targetPath?: string;
}

export function akmProposalDiff(options: ProposalDiffOptions): ProposalDiffResult {
  const stash = resolveStash(options.stashDir);
  const config = options.config ?? loadConfig();
  const proposal = getProposal(stash, options.id);
  const diff = diffProposal(stash, config, options.id, { target: options.target });
  return {
    schemaVersion: 1,
    id: proposal.id,
    ref: proposal.ref,
    isNew: diff.isNew,
    unified: diff.unified,
    ...(diff.targetPath ? { targetPath: diff.targetPath } : {}),
  };
}

// ── create (programmatic helper for upstream commands like reflect/distill) ──

export interface ProposalCreateOptions extends CreateProposalInput {
  stashDir?: string;
  ctx?: ProposalsContext;
}

export interface ProposalCreateResult {
  schemaVersion: 1;
  ok: true;
  proposal: Proposal;
}

export function akmProposalCreate(options: ProposalCreateOptions): ProposalCreateResult {
  const stash = resolveStash(options.stashDir);
  const proposal = createProposal(
    stash,
    {
      ref: options.ref,
      source: options.source,
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
      payload: options.payload,
    },
    options.ctx,
  );
  return { schemaVersion: 1, ok: true, proposal };
}
