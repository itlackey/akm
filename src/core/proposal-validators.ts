import type { AssetRef } from "./asset-ref";
import { parseAssetRef } from "./asset-ref";
import { parseFrontmatter } from "./frontmatter";
import { lintLessonContent } from "./lesson-lint";
import type { Proposal, ProposalValidationFinding, ProposalValidationReport } from "./proposals";

export interface ProposalValidationContext {
  parsedRef?: AssetRef;
  stop?: boolean;
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

export const defaultProposalValidators: ProposalValidator[] = [genericProposalValidator, lessonProposalValidator];

export function runProposalValidators(
  proposal: Proposal,
  validators: ProposalValidator[] = defaultProposalValidators,
): ProposalValidationReport {
  const findings: ProposalValidationFinding[] = [];
  const ctx: ProposalValidationContext = {};

  for (const validator of validators) {
    if (!validator.appliesTo(proposal, ctx)) continue;
    findings.push(...validator.validate(proposal, ctx));
    if (ctx.stop) break;
  }

  return { ok: findings.length === 0, findings };
}
