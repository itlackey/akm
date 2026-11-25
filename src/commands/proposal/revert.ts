// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { readAsset } from "../../core/assets/read";
import { writeAssets } from "../../core/assets/write";
import { stateBundleId } from "../../core/bundle-at-dir";
import type { AkmConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { withAssetMutationLease } from "../../core/index-writer-lock";
import { warn } from "../../core/warn";
import { beginWriteProvenance } from "../../core/write-provenance";
import {
  commitWriteTargetBoundary,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  requireWriteTargetPath,
} from "../../core/write-source";
import { insertEventOnce } from "../../storage/repositories/events-repository";
import {
  forgetImproveLedgerDecision,
  recordImproveLedgerDecision,
  reopenImproveLedgerDecision,
} from "../../storage/repositories/improve-ledger-repository";
import { listStateProposals, upsertProposal } from "../../storage/repositories/proposals-repository";
import { contentHash } from "../improve/content-hash";
import {
  acceptedAsset,
  assertRetirementStillFresh,
  indexWrittenProposalAssets,
  matchesBeforeHash,
  type PromoteResult,
  readFreshProposalTarget,
  requireAcceptedTarget,
  resolveAddressSafe,
  resolveProposalWriteTarget,
  resolveRecordedProposalTarget,
} from "./accept";
import { isRetireProposal, type Proposal, proposalContent } from "./proposal-types";
import {
  getProposal,
  listProposalsReadOnly,
  nowIso,
  type ProposalsContext,
  persistProposalDecision,
  requireProposal,
  retireHeldRefs,
  withProposalTx,
} from "./repository";

export type RevertResult = Pick<PromoteResult, "proposal" | "assetPath" | "ref">;

/**
 * Restore an accepted proposal's target from the backup taken at promotion.
 * New-asset proposals have no backup; a target edited since acceptance is
 * never clobbered. Reverting twice is a no-op.
 */
export async function revertProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string; queueTarget?: ResolvedWriteTarget } = {},
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  return withAssetMutationLease("proposal-revert", () => revertProposalWithLease(stashDir, config, id, options, ctx));
}

/**
 * Revert an accepted `retire` proposal: restore its retirements — the
 * retired asset, and its `.derived` twin when one was retired alongside it —
 * then overwrite the primary with the exact pre-retire bytes `backupContent`
 * recorded at accept — byte-exact, so it also undoes any supersede edge
 * accept wrote without touching one a person had already written, and
 * without appending a trailing newline the original never had. Each
 * retirement is the one `retiredArchive.retired` names by handle (set at
 * accept time).
 *
 * Every retirement is found and validated before any of them is restored,
 * AND that validation tells "not yet restored" apart from "already restored
 * by an earlier, crashed attempt of our own" (asset present, retired copy
 * gone) rather than treating the latter as a conflict — so a retry of a
 * crashed revert resumes instead of erroring on its own prior work. The
 * retirements are forgotten only after the "reverted" decision is durably
 * recorded, not interleaved with the restores — a crash between restoring an
 * asset and recording the decision would otherwise drop its retirement first,
 * leaving an "accepted" proposal a retry could neither finish nor re-validate.
 */
async function unretireProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  proposal: Proposal,
  options: { target?: string; queueTarget?: ResolvedWriteTarget },
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  const recorded = requireAcceptedTarget(proposal);
  const boundTarget = resolveRecordedProposalTarget(config, proposal.id, { source: recorded.bundle }, options.target);
  const { assetPath } = acceptedAsset(proposal, boundTarget);
  if (proposal.status === "reverted") {
    return { proposal, assetPath, ref: proposal.ref };
  }
  const archive = proposal.retiredArchive;
  if (!archive || archive.retired.length === 0) {
    throw new UsageError(
      `no archive recorded for this retire proposal (id: ${proposal.id})`,
      "MISSING_REQUIRED_ARGUMENT",
      "A retire proposal's archive is recorded at accept time; a proposal missing it cannot be reverted through this path.",
    );
  }
  const target = prepareWriteTargetForMutation(boundTarget);
  const bundle = target.source.name;
  /** Where the asset `ref` is kept, as base named it in a refusal: its file in the bundle (display only). */
  const shown = (ref: string): string => {
    const file = resolveAddressSafe(target.source, ref)?.file;
    return file === undefined
      ? ref
      : path.relative(requireWriteTargetPath(target.source), file).split(path.sep).join("/");
  };
  interface PendingRestore {
    handle: string;
    conceptId: string;
    primary: boolean;
    /**
     * The archived copy was purged: nothing to move. The primary is rewritten from `backupContent`; only a derived twin
     * is retired beside it, so any other purged copy is the twin's, which is gone.
     */
    purged: boolean;
  }
  // Every file the restores and the primary's rewrite touch goes into the revert's commit.
  const journal = beginWriteProvenance();
  let pending: PendingRestore[];
  try {
    pending = writeAssets(target, { purpose: "proposal-revert" }, (w) => {
      const retirements = new Map(w.retired().map((retirement) => [retirement.handle, retirement]));
      const found: PendingRestore[] = [];
      for (const { handle } of archive.retired) {
        const retirement = retirements.get(handle);
        if (!retirement) {
          throw new UsageError(
            `Archive for proposal ${proposal.id} is missing its tombstone (${handle}); cannot revert.`,
            "INVALID_FLAG_VALUE",
          );
        }
        const ref = makeBundleRef(bundle, retirement.conceptId);
        const current = w.read(retirement.conceptId);
        const originalExists = current !== undefined;
        const archivedExists = retirement.restorable;
        if (originalExists && archivedExists) {
          throw new UsageError(
            `Cannot revert proposal ${proposal.id}: ${shown(ref)} already exists (created since retirement); refusing to overwrite it.`,
            "INVALID_FLAG_VALUE",
          );
        }
        // The graced purge deletes the archived bytes once git holds them, but the
        // proposal keeps the primary's exact pre-retire bytes (`backupContent`),
        // so the primary can still be restored from those.
        const primary = ref === recorded.ref;
        const purged = !originalExists && !archivedExists;
        if (purged && primary && proposal.backupContent === undefined) {
          throw new UsageError(
            `Cannot revert proposal ${proposal.id}: archived copy of ${shown(ref)} (${handle}) is missing.`,
            "INVALID_FLAG_VALUE",
          );
        }
        // "asset present, retired copy
        // missing" is not necessarily our own earlier, crashed revert — once a
        // purge can delete an archived copy on its own, a LATER, unrelated file
        // can occupy this same path (a new memory reusing a retired one's name),
        // and the restore below would overwrite it with the retired asset's
        // pre-retire bytes. Only the primary has a recorded pre-retire hash
        // (`retirement.retiredContentHash`, or `beforeHash` for a person's retirement) to tell the two apart; resume only
        // when it matches the asset actually there, otherwise refuse
        // exactly as the conflict case above does.
        if (current && !archivedExists && primary) {
          // A retirement with no judged pair (a person's) has only the `beforeHash` it was minted against.
          let matches = false;
          try {
            const bytes = current.entry.bytes();
            const judged = proposal.retirement;
            matches = judged
              ? contentHash(bytes, "body") === judged.retiredContentHash
              : matchesBeforeHash(proposal, bytes);
          } catch {
            matches = false;
          }
          if (!matches) {
            throw new UsageError(
              `Cannot revert proposal ${proposal.id}: ${shown(ref)} exists but its content does not match what was retired (its path may have been reused since); refusing to overwrite it.`,
              "INVALID_FLAG_VALUE",
            );
          }
        }
        found.push({ handle, conceptId: retirement.conceptId, primary, purged });
      }
      // The primary first: a refusal its restore makes (a retirement that does not say where its file went) leaves
      // every other retirement as it was, whatever order the accept recorded them in.
      const ordered = [...found.filter((p) => p.primary), ...found.filter((p) => !p.primary)];
      for (const p of ordered) {
        if (p.purged && !p.primary) warn(`[proposal] ${p.conceptId} was purged from the archive and is gone.`);
        else w.restore(p.handle, proposal.backupContent); // the backup is used only for a purged primary
      }
      // Overwrite the primary with the EXACT pre-retire bytes recorded
      // at accept (`backupContent`) — no appended trailing newline either, so
      // YAML comments, key order, a pre-existing human `supersededBy` edge, and
      // even the exact absence of a final newline all survive the round trip.
      // The archived copy just restored may carry a `supersededBy` edge THIS
      // accept wrote (a `supersedes` judgement); restoring the recorded original
      // bytes already removes exactly that edge, so no separate
      // removeSupersededEdge mutation runs here — one that could not tell "the
      // edge accept wrote" from "an edge a person had already written" apart,
      // and would delete either.
      // Skipped when the restored bytes already decode to `backupContent`: that leaves a
      // non-UTF-8 asset byte-exact, since `backupContent` is only its lossy text. After the
      // grace purge (`purged`) the restore wrote `backupContent` itself; git history keeps the bytes.
      const restoredPrimary = found.find((p) => p.primary);
      if (restoredPrimary && proposal.backupContent !== undefined) {
        if (w.read(restoredPrimary.conceptId)?.entry.content() !== proposal.backupContent) {
          w.update(restoredPrimary.conceptId, proposal.backupContent);
        }
      }
      return found;
    });
  } finally {
    journal.end();
  }
  commitWriteTargetBoundary(target, `Revert ${proposal.ref}`, { paths: journal.writtenPaths() });
  const restoredPath = resolveAddressSafe(target.source, recorded.ref)?.file ?? assetPath;
  const decidedAt = nowIso(ctx);
  const reverted = withProposalTx(ctx, (db) => {
    const current = requireProposal(db, stashDir, proposal.id);
    if (current.status === "reverted") return current;
    const next: Proposal = {
      ...current,
      status: "reverted",
      updatedAt: decidedAt,
      review: {
        outcome: "rejected",
        reason: "reverted: archived asset restored",
        decidedAt,
        ...(current.review?.decidedBy ? { decidedBy: current.review.decidedBy } : {}),
      },
    };
    upsertProposal(db, next, stateBundleId(stashDir));
    recordImproveLedgerDecision(db, {
      proposalId: next.id,
      bundleId: stateBundleId(stashDir),
      ref: next.ref,
      source: next.source,
      outcome: "rejected",
      at: decidedAt,
      detail: "reverted",
    });
    insertEventOnce(db, {
      eventType: "proposal_reverted",
      ts: decidedAt,
      ref: next.ref,
      metadata: { proposalId: next.id, source: next.source, assetPath: restoredPath },
      idempotencyKey: `${next.id}:reverted`,
    });
    return next;
  });
  // Only now — after the decision is durably recorded — forget the
  // retirements. See the function doc comment for why this ordering matters.
  writeAssets(target, { purpose: "proposal-revert" }, (w) => {
    for (const p of pending) w.forget(p.handle);
  });
  return { proposal: reverted, assetPath: restoredPath, ref: proposal.ref };
}

async function revertProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string; queueTarget?: ResolvedWriteTarget },
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  const proposal = getProposal(stashDir, id, ctx);
  if (proposal.status !== "accepted" && proposal.status !== "reverted") {
    throw new UsageError(
      `only accepted proposals can be reverted (proposal ${id} status: ${proposal.status})`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (isRetireProposal(proposal)) return unretireProposalWithLease(stashDir, config, proposal, options, ctx);
  const backupContent = proposal.backupContent;
  if (proposal.status === "accepted" && backupContent === undefined) {
    throw new UsageError(
      `no backup available for this proposal (id: ${id})`,
      "MISSING_REQUIRED_ARGUMENT",
      "Backups are only captured when a proposal overwrites an existing asset — new-asset proposals cannot be reverted via this path; delete the asset directly instead.",
    );
  }
  const recorded = requireAcceptedTarget(proposal);
  const boundTarget = resolveRecordedProposalTarget(config, id, { source: recorded.bundle }, options.target);
  const { assetPath } = acceptedAsset(proposal, boundTarget);
  if (proposal.status === "reverted" || backupContent === undefined) {
    return { proposal, assetPath, ref: proposal.ref };
  }
  const target = prepareWriteTargetForMutation(boundTarget);
  const accepted = readAsset(target.source, parseBundleRef(recorded.ref).conceptId);
  if (!accepted || contentHash(accepted.entry.bytes()) !== recorded.contentHash) {
    // By-ref resolution skips retire proposals, so reverting by ref when a
    // SEPARATE retire proposal
    // for the same ref exists (pending or already accepted) lands here with
    // no clue that proposal is the real story — name it when one does.
    const siblingRetire = listProposalsReadOnly(stashDir, { ref: proposal.ref, includeArchive: true }, ctx).find(
      (p) => isRetireProposal(p) && (p.status === "pending" || p.status === "accepted"),
    );
    throw new UsageError(
      `asset content changed after proposal ${id} was accepted; refusing to clobber the newer content` +
        (siblingRetire ? ` (a retire proposal for this ref exists: ${siblingRetire.id})` : ""),
      "INVALID_FLAG_VALUE",
    );
  }
  const decidedAt = nowIso(ctx);
  writeAssets(target, { purpose: "proposal-revert" }, (w) =>
    w.update(accepted.conceptId, backupContent.endsWith("\n") ? backupContent : `${backupContent}\n`),
  );
  const restoredPath = assetPath;
  commitWriteTargetBoundary(target, `Revert ${proposal.ref}`, { paths: [restoredPath] });
  const reverted = persistProposalDecision(
    stashDir,
    proposal,
    { operation: "revert", assetPath: restoredPath, decidedAt },
    ctx,
  );
  await indexWrittenProposalAssets(target, [restoredPath]);
  return { proposal: reverted, assetPath: restoredPath, ref: proposal.ref };
}

export interface ReopenOptions {
  queueTarget?: ResolvedWriteTarget;
  /** Why the rejection is being undone: kept in the review history, the ledger row and the event. */
  reason?: string;
}

/** The message of the stale-target refusal `check` raises, else `undefined`. */
function staleRefusal(check: () => void): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
}

/**
 * Why `proposal` cannot be reopened, or `undefined` when it can. Only a
 * rejected proposal comes back, and only one accept would not refuse as stale:
 * a retire proposal needs its successor and both recorded body hashes to still
 * match (B2), any other its target to be what it was minted against
 * (STALE, R20) — so a reopened proposal is never one the next accept refuses.
 */
function reopenRefusal(config: AkmConfig, proposal: Proposal, queueTarget?: ResolvedWriteTarget): string | undefined {
  if (proposal.status !== "rejected") {
    return `it is not rejected (current status: ${proposal.status}); only a rejected proposal can be reopened.`;
  }
  if (proposal.changes.length === 0 || proposal.proposedTarget === undefined) {
    // A pending row must carry both (proposalToRowValues), which a row from
    // before the change envelope existed cannot.
    return "it was recorded before proposals carried their change envelope, so it cannot go back in the queue.";
  }
  const target = resolveProposalWriteTarget(config, proposal, undefined, queueTarget);
  const address = resolveAddressSafe(target.source, proposal.ref);
  if (!address?.file) return "its target cannot be resolved.";
  if (!isRetireProposal(proposal)) {
    return staleRefusal(
      () => void readFreshProposalTarget(proposal, target.source, address, proposalContent(proposal)),
    );
  }
  if (!proposal.retirement) return "it has no retirement metadata.";
  const current = address.exists ? readAsset(target.source, address.conceptId) : undefined;
  if (!current) {
    return "its retired file no longer exists (already retired, or removed by something else).";
  }
  const { retirement } = proposal;
  return staleRefusal(() =>
    assertRetirementStillFresh(proposal.id, proposal.ref, retirement, target.source, current.entry.bytes()),
  );
}

const REOPEN_REFUSED_HINT =
  "Only a rejected proposal whose target is unchanged can be reopened; `akm proposal list --status rejected` lists the candidates.";

const REOPEN_RETIRE_CONFLICT_HINT =
  "Only one pending retire proposal can involve a document: accept or reject the pending one (or reopen just one of a clashing pair), then reopen the other.";

/**
 * The pair pass never has two pending retire proposals speak for one asset
 * (`pendingRetireRefs`): accepting one would strand the other. Reopening must
 * not break that either — a rejected pair can meanwhile have been re-paired
 * with something else. `held` maps each asset to the pending retire proposal
 * that has it; a proposal that clears this claims its assets, so two in one
 * batch that clash refuse the later.
 */
function retireConflict(proposal: Proposal, held: Map<string, string>): string | undefined {
  if (!isRetireProposal(proposal)) return undefined;
  const refs = retireHeldRefs(proposal);
  for (const ref of refs) {
    const holder = held.get(ref);
    if (holder !== undefined) {
      return `${ref} is already part of retire proposal ${holder}, which is pending or being reopened with this one; only one pending retire proposal may involve an asset.`;
    }
  }
  for (const ref of refs) held.set(ref, proposal.id);
  return undefined;
}

/**
 * Put rejected proposals back in the queue (`akm proposal reopen`, #997): a
 * rejection is otherwise final, and it also suppresses the pair pass from ever
 * re-proposing a retirement (its record keys the pair), so a mistaken one
 * could not be undone. Each proposal returns to `pending` with the rejection —
 * and the gate verdict that came with it — kept in `reviewHistory` (the verdict
 * itself is cleared, unless it is a `deferred` hand-off to a person), its
 * ledger row reset (the pair pass keys off proposal status, so the pair is no
 * longer suppressed and, while pending, cannot be minted twice), and a
 * `proposal_reopened` event recorded, all in one transaction.
 *
 * All-or-nothing: every id is checked (see {@link reopenRefusal} and
 * {@link retireConflict}) before any is reopened, and one refusal leaves the
 * whole batch untouched.
 */
export function reopenProposals(
  stashDir: string,
  config: AkmConfig,
  ids: readonly string[],
  options: ReopenOptions = {},
  ctx?: ProposalsContext,
): Proposal[] {
  return withProposalTx(ctx, (db) => {
    const proposals = [...new Set(ids)].map((id) => requireProposal(db, stashDir, id));
    const held = new Map<string, string>();
    for (const pending of listStateProposals(db, { bundleId: stateBundleId(stashDir), status: "pending" })) {
      if (isRetireProposal(pending)) for (const ref of retireHeldRefs(pending)) held.set(ref, pending.id);
    }
    const refusals = proposals.flatMap((proposal) => {
      const refusal = reopenRefusal(config, proposal, options.queueTarget);
      const conflict = refusal === undefined ? retireConflict(proposal, held) : undefined;
      const reason = refusal ?? conflict;
      return reason === undefined
        ? []
        : [{ proposal: `${proposal.id} (${proposal.ref})`, reason, isConflict: conflict !== undefined }];
    });
    if (refusals.length > 0) {
      // A retire conflict is not about the target changing, so it gets its own hint.
      const hints = [
        ...(refusals.some((refusal) => !refusal.isConflict) ? [REOPEN_REFUSED_HINT] : []),
        ...(refusals.some((refusal) => refusal.isConflict) ? [REOPEN_RETIRE_CONFLICT_HINT] : []),
      ];
      throw new UsageError(
        proposals.length === 1
          ? `Proposal ${refusals[0]?.proposal} cannot be reopened: ${refusals[0]?.reason}`
          : `Cannot reopen ${refusals.length} of ${proposals.length} proposals; none were reopened:\n${refusals
              .map((refusal) => `  - ${refusal.proposal}: ${refusal.reason}`)
              .join("\n")}`,
        "INVALID_FLAG_VALUE",
        hints.join(" "),
      );
    }
    const decidedAt = nowIso(ctx);
    return proposals.map((existing) => {
      const reopened: Proposal = {
        ...existing,
        status: "pending",
        updatedAt: decidedAt,
        review: undefined,
        // A reopened proposal is adjudicated afresh: a `staged` verdict would
        // let the drain accept it unseen, and another gate's `auto-rejected`
        // would have the drain skip it. A `deferred` one is the quality
        // gate's hand-off to a person, which the drain must keep honouring
        // (drainProposals leaves it alone), so it stays.
        gateDecision: existing.gateDecision?.outcome === "deferred" ? existing.gateDecision : undefined,
        reviewHistory: [
          ...(existing.reviewHistory ?? []),
          {
            ...(existing.review !== undefined ? { review: existing.review } : {}),
            ...(existing.gateDecision !== undefined ? { gateDecision: existing.gateDecision } : {}),
            reopenedAt: decidedAt,
            ...(options.reason !== undefined ? { reopenReason: options.reason } : {}),
          },
        ],
      };
      upsertProposal(db, reopened, stateBundleId(stashDir));
      if (isRetireProposal(existing)) {
        // A retire mint writes no ledger row, so the one its rejection wrote goes.
        forgetImproveLedgerDecision(db, stateBundleId(stashDir), existing.id);
      } else {
        reopenImproveLedgerDecision(db, {
          proposalId: existing.id,
          bundleId: stateBundleId(stashDir),
          source: existing.source,
          at: decidedAt,
          detail: options.reason !== undefined ? `reopened: ${options.reason}` : "reopened",
        });
      }
      insertEventOnce(db, {
        eventType: "proposal_reopened",
        ts: decidedAt,
        ref: reopened.ref,
        metadata: {
          proposalId: reopened.id,
          source: reopened.source,
          ...(reopened.sourceRun !== undefined ? { sourceRun: reopened.sourceRun } : {}),
          ...(options.reason !== undefined ? { reason: options.reason } : {}),
        },
        idempotencyKey: `${reopened.id}:reopened:${decidedAt}`,
      });
      return reopened;
    });
  });
}
