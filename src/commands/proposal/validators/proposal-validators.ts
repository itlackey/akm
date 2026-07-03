// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AssetRef } from "../../../core/asset/asset-ref";
import { parseAssetRef } from "../../../core/asset/asset-ref";
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { lintLessonContent } from "../../../core/lesson-lint";
import type { Proposal } from "../repository";
import { defaultProposalQualityValidators } from "./proposal-quality-validators";
import type { ProposalValidationFinding, ProposalValidationReport } from "./proposals";

export interface ProposalValidationContext {
  parsedRef?: AssetRef;
  stop?: boolean;
  /**
   * Optional source-asset context for validators that need to compare the
   * proposed payload against the asset it was derived from (improve-stage
   * validators: reflect size guard, consolidate source-superseded guard).
   *
   * Populated by improve-stage call sites before invoking
   * {@link runProposalValidators}; the `proposal accept` path leaves this
   * absent and source-context-aware validators no-op.
   */
  source?: {
    content?: string;
    frontmatter?: Record<string, unknown>;
  };
}

export interface ProposalValidator {
  name: string;
  appliesTo(proposal: Proposal, ctx: ProposalValidationContext): boolean;
  validate(proposal: Proposal, ctx: ProposalValidationContext): ProposalValidationFinding[];
}

const genericProposalValidator: ProposalValidator = {
  name: "generic-proposal-validator",
  appliesTo: () => true,
  validate(proposal, ctx) {
    const findings: ProposalValidationFinding[] = [];

    if (!proposal.payload || typeof proposal.payload.content !== "string" || proposal.payload.content.trim() === "") {
      findings.push({ kind: "empty-content", message: `Proposal ${proposal.id} has empty content.` });
    }

    try {
      ctx.parsedRef = parseAssetRef(proposal.ref);
    } catch (err) {
      findings.push({
        kind: "invalid-ref",
        message: `Proposal ${proposal.id} has invalid ref "${proposal.ref}": ${(err as Error).message}`,
      });
      ctx.stop = true;
      return findings;
    }

    if (proposal.payload.content.startsWith("---")) {
      try {
        parseFrontmatter(proposal.payload.content);
      } catch (err) {
        findings.push({
          kind: "invalid-frontmatter",
          message: `Proposal ${proposal.id} frontmatter could not be parsed: ${(err as Error).message}`,
        });
      }
    }

    return findings;
  },
};

const lessonProposalValidator: ProposalValidator = {
  name: "lesson-proposal-validator",
  appliesTo(_proposal, ctx) {
    return ctx.parsedRef?.type === "lesson";
  },
  validate(proposal) {
    return lintLessonContent(proposal.payload.content, `proposal:${proposal.id}`).findings.map((finding) => ({
      kind: finding.kind,
      message: finding.message,
    }));
  },
};

export const defaultProposalValidators: ProposalValidator[] = [
  genericProposalValidator,
  lessonProposalValidator,
  ...defaultProposalQualityValidators,
];

export function runProposalValidators(
  proposal: Proposal,
  validators: ProposalValidator[] = defaultProposalValidators,
  initialContext: Partial<ProposalValidationContext> = {},
): ProposalValidationReport {
  const findings: ProposalValidationFinding[] = [];
  const ctx: ProposalValidationContext = { ...initialContext };

  for (const validator of validators) {
    if (!validator.appliesTo(proposal, ctx)) continue;
    findings.push(...validator.validate(proposal, ctx));
    if (ctx.stop) break;
  }

  return { ok: findings.every((f) => f.severity === "warn"), findings };
}
