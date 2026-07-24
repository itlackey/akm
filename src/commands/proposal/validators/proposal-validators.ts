// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { parseRefInput } from "../../../core/asset/resolve-ref";
import { proposalContent } from "../../../core/file-change";
import { lintLessonContent } from "../../../core/lesson-lint";
import { parseTaskDocument } from "../../../tasks/parser";
import { parseWorkflow } from "../../../workflows/parser";
import { looksLikeWorkflowProgram, parseWorkflowProgram } from "../../../workflows/program/parser";
import type {
  Proposal,
  ProposalValidationContext,
  ProposalValidationFinding,
  ProposalValidationReport,
  ProposalValidator,
} from "../proposal-types";
import { defaultProposalQualityValidators } from "./proposal-quality-validators";

// ProposalValidationContext / ProposalValidator moved to ../proposal-types.ts
// (WI-9.8 KILL 1 — proposal-quality-validators.ts needed ProposalValidator
// back, and this module needs defaultProposalQualityValidators from
// proposal-quality-validators.ts as a value; hoisting the shared interface to
// the dependency-free leaf breaks that back-edge). Re-exported here so
// existing import sites are unchanged.
export type { ProposalValidationContext, ProposalValidator } from "../proposal-types";

const genericProposalValidator: ProposalValidator = {
  name: "generic-proposal-validator",
  appliesTo: () => true,
  validate(proposal, ctx) {
    const findings: ProposalValidationFinding[] = [];

    if (!proposal.payload || typeof proposal.payload.content !== "string" || proposal.payload.content.trim() === "") {
      findings.push({ kind: "empty-content", message: `Proposal ${proposal.id} has empty content.` });
    }

    try {
      ctx.parsedRef = parseRefInput(proposal.ref);
    } catch (err) {
      findings.push({
        kind: "invalid-ref",
        message: `Proposal ${proposal.id} has invalid ref "${proposal.ref}": ${(err as Error).message}`,
      });
      ctx.stop = true;
      return findings;
    }

    if (proposalContent(proposal).startsWith("---")) {
      try {
        parseFrontmatter(proposalContent(proposal));
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

type CanonicalProposalValidator = (proposal: Proposal, ctx: ProposalValidationContext) => ProposalValidationFinding[];

const canonicalProposalValidators: Readonly<Record<string, CanonicalProposalValidator>> = {
  lesson(proposal) {
    return lintLessonContent(proposalContent(proposal), `proposal:${proposal.id}`).findings.map((finding) => ({
      kind: finding.kind,
      message: finding.message,
    }));
  },
  task(proposal, ctx) {
    const name = ctx.parsedRef?.name;
    if (!name) return [];
    parseTaskDocument({
      yaml: proposalContent(proposal),
      filePath: proposal.changes[0]?.path || proposal.ref,
      id: name,
    });
    return [];
  },
  workflow(proposal) {
    const content = proposalContent(proposal);
    if (!content.trim()) return [];

    const changePath = proposal.changes[0]?.path ?? "";
    const isYamlProgram = /\.ya?ml$/i.test(changePath) || (changePath === "" && looksLikeWorkflowProgram(content));
    const result = isYamlProgram
      ? parseWorkflowProgram(content, { path: changePath || proposal.ref })
      : parseWorkflow(content, { path: changePath || proposal.ref });
    if (result.ok) return [];

    return result.errors.map((error) => ({
      kind: "invalid-workflow-structure",
      message: `Workflow proposal ${proposal.id} (${proposal.ref}) is invalid at line ${error.line}: ${error.message}`,
    }));
  },
};

export function hasCanonicalProposalValidator(type: string): boolean {
  return Object.hasOwn(canonicalProposalValidators, type);
}

const canonicalProposalValidator: ProposalValidator = {
  name: "canonical-asset-proposal-validator",
  appliesTo(_proposal, ctx) {
    return ctx.parsedRef !== undefined && hasCanonicalProposalValidator(ctx.parsedRef.type);
  },
  validate(proposal, ctx) {
    const type = ctx.parsedRef?.type;
    const validator = type ? canonicalProposalValidators[type] : undefined;
    if (!validator) return [];
    try {
      return validator(proposal, ctx);
    } catch (error) {
      return [
        {
          kind: `invalid-${type}-structure`,
          message: `${type} proposal ${proposal.id} (${proposal.ref}) is invalid: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
};

export const defaultProposalValidators: ProposalValidator[] = [
  genericProposalValidator,
  canonicalProposalValidator,
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
