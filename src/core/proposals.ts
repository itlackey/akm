// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Same-path re-export shim (#490 reorg, SLICE 2). The proposal substrate moved
// into commands/proposal/validators/proposals.ts together with its two
// validator siblings (the 3-file intra-cycle moves as one unit). This shim
// keeps the historical core/proposals.ts import path byte-diff-free for its
// external importers. Explicit named re-exports only (never `export *`), one
// level; retire once aliases are universal.

export type {
  CreateProposalInput,
  CreateProposalResult,
  CreateProposalSkipped,
  ExpireStaleResult,
  OrphanPurgeResult,
  PromoteResult,
  Proposal,
  ProposalDiff,
  ProposalPayload,
  ProposalRejectionReason,
  ProposalReview,
  ProposalSkipReason,
  ProposalSource,
  ProposalStatus,
  ProposalsContext,
  ProposalValidationFinding,
  ProposalValidationReport,
  RevertResult,
} from "../commands/proposal/validators/proposals";
export {
  AUTOMATED_PROPOSAL_SOURCES,
  archiveProposal,
  createProposal,
  diffProposal,
  expireStaleProposals,
  formatUnifiedDiff,
  getProposal,
  getProposalsRoot,
  isAutomatedProposalSource,
  isProposalArchived,
  isProposalSkipped,
  isValidProposalSource,
  listProposals,
  PROPOSAL_SOURCES,
  promoteProposal,
  purgeOrphanProposals,
  resolveProposalId,
  revertProposal,
  validateProposal,
} from "../commands/proposal/validators/proposals";
