// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Proposal validation and the one content repair applied before promotion. */

import { repairTruncatedDescription } from "../../../core/text-truncation";
import { splitFrontmatter } from "../../improve/reflect-noise";
import { isRetireProposal, type Proposal, type ProposalValidationReport } from "../proposal-types";
import { runProposalValidators } from "./proposal-validators";

export type { ProposalValidationFinding, ProposalValidationReport } from "../proposal-types";

/**
 * Validate a proposal before promotion: it must parse and carry a body, and a
 * type with a canonical validator runs it.
 *
 * A retire proposal (alpha.9 consolidate pair pass) writes no new content —
 * it deletes an asset that already passed validation when IT was created —
 * so the content-quality validators (built for new/updated bodies: a
 * description, lesson shape, reflect size ratio, …) do not apply and are
 * skipped entirely rather than misreading the empty body as a defect.
 */
export function validateProposal(proposal: Proposal): ProposalValidationReport {
  if (isRetireProposal(proposal)) return { ok: true, findings: [] };
  return runProposalValidators(proposal);
}

/**
 * Normalize line endings and complete a truncated frontmatter `description`
 * (`repairTruncatedDescription`, with the body as context). Nothing else: an
 * earlier repair that deleted body lines gutted any asset documenting
 * frontmatter. Only a single-line description is repaired: one YAML wrapped
 * over indented lines (`yaml.stringify` does that past ~80 columns) has a
 * first line that merely looks truncated. Callers re-validate the result.
 */
export function repairProposalContent(content: string): string {
  if (typeof content !== "string" || content.trim() === "") return content;
  const repaired = content.replace(/\r\n/g, "\n");
  const { fmText, body } = splitFrontmatter(repaired);
  if (fmText === null) return repaired;
  if (/^description:.*\n[ \t]/m.test(fmText)) return repaired;
  return repaired.replace(
    /^(description:\s*)(.*?)(\r?\n)/m,
    (_match, prefix: string, rawDesc: string, nl: string) =>
      `${prefix}${repairTruncatedDescription(rawDesc.trim(), body)}${nl}`,
  );
}
