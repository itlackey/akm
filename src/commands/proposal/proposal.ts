// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import {
  archiveProposal,
  type CreateProposalInput,
  createProposal,
  diffProposal,
  getProposal,
  isProposalSkipped,
  listProposals,
  type Proposal,
  type ProposalsContext,
  promoteProposal,
  resolveProposalId,
  revertProposal,
  validateProposal,
} from "./validators/proposals";

// ── Shared helpers ──────────────────────────────────────────────────────────

function resolveStash(stashDir?: string): string {
  if (stashDir) return stashDir;
  return resolveStashDir();
}

// ── list ────────────────────────────────────────────────────────────────────

export interface ProposalListOptions {
  stashDir?: string;
  status?: "pending" | "accepted" | "rejected" | "reverted";
  ref?: string;
  type?: string;
  includeArchive?: boolean;
}

export interface ProposalListResult {
  schemaVersion: 1;
  totalCount: number;
  proposals: Proposal[];
}

/**
 * Thin in-process read of the pending proposal queue, used by the health HTML
 * report builder (#582) so it never shells out to `akm proposal list`.
 *
 * Deliberately narrow (one optional arg, returns the storage-layer rows) so
 * the parallel proposal-storage-to-SQLite consolidation only has to swap this
 * one function's body.
 */
export function listPendingProposals(stashDir?: string): Proposal[] {
  return listProposals(resolveStash(stashDir), { status: "pending" });
}

export function akmProposalList(options: ProposalListOptions = {}): ProposalListResult {
  const stash = resolveStash(options.stashDir);
  // `--status accepted|rejected|reverted` implies archive-inclusion since the
  // live queue only ever contains pending entries.
  const includeArchive =
    options.includeArchive === true ||
    options.status === "accepted" ||
    options.status === "rejected" ||
    options.status === "reverted";
  const proposals = listProposals(stash, {
    includeArchive,
    status: options.status,
    ref: options.ref,
    type: options.type,
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
  const resolvedId = resolveProposalId(stash, options.id).id;
  const result = await promoteProposal(stash, config, resolvedId, { target: options.target }, options.ctx);

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
      // Attribution tagging: carry the eligibility lane from the proposal record
      // onto the promoted event so accept outcomes can be sliced by lane.
      ...(result.proposal.eligibilitySource !== undefined
        ? { eligibilitySource: result.proposal.eligibilitySource }
        : {}),
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
  const existing = resolveProposalId(stash, options.id);
  if (existing.status !== "pending") {
    throw new UsageError(
      `Proposal ${existing.id} is not pending (current status: ${existing.status}). Only pending proposals can be rejected.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const updated = archiveProposal(stash, existing.id, "rejected", options.reason, options.ctx);

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
  const proposal = resolveProposalId(stash, options.id);
  const diff = diffProposal(stash, config, proposal.id, { target: options.target });
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
  // Manual proposal creation (via `akm proposal create`) always bypasses
  // dedup/cooldown guards — the operator is explicitly requesting a proposal.
  const result = createProposal(
    stash,
    {
      ref: options.ref,
      source: options.source,
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
      payload: options.payload,
      force: true,
    },
    options.ctx,
  );
  if (isProposalSkipped(result)) {
    // Should never happen with force:true — defensive only.
    throw new Error(`Unexpected proposal skip: ${result.message}`);
  }
  return { schemaVersion: 1, ok: true, proposal: result };
}

// ── revert (Phase 6C / Advantage D6c) ────────────────────────────────────────

export interface ProposalRevertOptions {
  stashDir?: string;
  /** Proposal id (uuid / prefix) or asset ref. */
  id: string;
  /** Override the write target by source name (same semantics as accept). */
  target?: string;
  /** Test seam — overrides config used for the write target. */
  config?: AkmConfig;
  /** Test seam — overrides clock / id source. */
  ctx?: ProposalsContext;
}

export interface ProposalRevertResult {
  schemaVersion: 1;
  ok: true;
  id: string;
  ref: string;
  assetPath: string;
  proposal: Proposal;
}

/**
 * Restore an accepted proposal's prior content from the backup captured at
 * promotion time (Advantage D6c / Phase 6C).
 *
 * Failure modes (all surface as typed errors so the CLI can map exit codes):
 *   - Proposal id does not resolve → `NotFoundError("FILE_NOT_FOUND")`
 *     (raised by `resolveProposalId` / `getProposal`).
 *   - Proposal is not `status === "accepted"` → `UsageError("INVALID_FLAG_VALUE")`
 *     with message `"only accepted proposals can be reverted ..."`.
 *   - No backup content on the record (new-asset proposals capture none) →
 *     `UsageError` with message `"no backup available for this proposal ..."`.
 *
 * On success, emits a `proposal_reverted` event for observability, mirroring
 * how `akmProposalAccept` emits `promoted` and `akmProposalReject` emits
 * `rejected`.
 */
export async function akmProposalRevert(options: ProposalRevertOptions): Promise<ProposalRevertResult> {
  const stash = resolveStash(options.stashDir);
  const config = options.config ?? loadConfig();
  const resolvedId = resolveProposalId(stash, options.id).id;
  const result = await revertProposal(stash, config, resolvedId, { target: options.target }, options.ctx);

  appendEvent({
    eventType: "proposal_reverted",
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
