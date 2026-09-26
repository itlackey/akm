// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Proposal validation and the one content repair applied before promotion. */

import { repairTruncatedDescription } from "../../../core/text-truncation";
import { splitFrontmatter } from "../../improve/reflect-noise";
import type { Proposal, ProposalValidationReport } from "../proposal-types";
import { runProposalValidators } from "./proposal-validators";

export type { ProposalValidationFinding, ProposalValidationReport } from "../proposal-types";

/**
 * Validate a proposal before promotion: it must parse and carry a body, and a
 * type with a canonical validator runs it.
 */
export function validateProposal(proposal: Proposal): ProposalValidationReport {
  return runProposalValidators(proposal);
}

/**
 * Normalize line endings and complete a truncated frontmatter `description`
 * (`repairTruncatedDescription`, with the body as context). Nothing else: an
 * earlier repair that deleted body lines gutted any asset documenting
 * frontmatter. Callers re-validate the result.
 */
export function repairProposalContent(content: string): string {
  if (typeof content !== "string" || content.trim() === "") return content;
  const repaired = content.replace(/\r\n/g, "\n");
  const { fmText, body } = splitFrontmatter(repaired);
  if (fmText === null) return repaired;
  return repaired.replace(
    /^(description:\s*)(.*?)(\r?\n)/m,
    (_match, prefix: string, rawDesc: string, nl: string) =>
      `${prefix}${repairTruncatedDescription(rawDesc.trim(), body)}${nl}`,
  );
}
