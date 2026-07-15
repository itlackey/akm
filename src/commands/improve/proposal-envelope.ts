// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `emitProposal` — the proposal-envelope facade (D10 / R7).
 *
 * Every improve verb that raises a proposal (revise = reflect, learn =
 * distill/promote/extract, consolidate = the merge/promote ops) routes it
 * through this single seam instead of calling {@link createProposal} directly.
 * Centralising the call gives Chunk 6 exactly ONE place to thread the future
 * `FileChange[]` / `beforeHash` envelope through — none of that exists yet.
 *
 * At Chunk 7 the facade is a behaviour-preserving pass-through: it wraps the
 * CURRENT `createProposal` shape verbatim (`payload.content` + optional
 * `frontmatter`, status `pending`, dedup/cooldown guards intact) and is
 * arg-for-arg equivalent to a direct call. It intentionally does NOT synthesise
 * `sourceRun` or mutate the input — each emit site owns its own
 * `source`/`sourceRun`/attribution, so adoption in WI-7.5/7.7/7.8 is mechanical
 * and byte-for-byte behaviour-neutral.
 *
 * Pinned by `tests/commands/improve/proposal-envelope.test.ts`.
 */

import {
  type CreateProposalInput,
  type CreateProposalResult,
  createProposal,
  type ProposalsContext,
} from "../proposal/repository";

/**
 * The minimal run context {@link emitProposal} needs: where proposals are
 * written (`stashDir`) and the clock/id/dbPath seam (`proposalsCtx`). A full
 * `RunContext` satisfies this structurally, so the five emit sites pass their
 * run context straight in.
 */
export interface ProposalEmitContext {
  /** Stash directory the proposal is written under. */
  stashDir: string;
  /** Proposals clock/id/dbPath seam (test isolation). */
  proposalsCtx?: ProposalsContext;
}

/**
 * Emit a proposal through the single improve envelope seam. Equivalent to
 * `createProposal(ctx.stashDir, input, ctx.proposalsCtx)`; returns either the
 * persisted {@link import("../proposal/repository").Proposal} or a
 * {@link import("../proposal/repository").CreateProposalSkipped} record when a
 * dedup/cooldown guard fires (detect with `isProposalSkipped`).
 */
export function emitProposal(ctx: ProposalEmitContext, input: CreateProposalInput): CreateProposalResult {
  return createProposal(ctx.stashDir, input, ctx.proposalsCtx);
}
