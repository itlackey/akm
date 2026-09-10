// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { parseRefInput } from "../../../core/asset/resolve-ref";
import { proposalContent } from "../../../core/file-change";
import { lintLessonContent } from "../../../core/lesson-lint";
import { parseTaskSource } from "../../../tasks/source/parse-task-source";
import { compileWorkflowSource } from "../../../workflows/source-ir/compile";
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
    // Version-routing seam (spec docs/plans/specs/p2a-task-source-v4.md
    // §3.6): a proposal body is validated by parsing alone — neither arm's
    // parsed document is inspected further, so routing through the union is
    // a pure swap; any parse failure (either version) is turned into an
    // `invalid-task-structure` finding by the try/catch this call sits in.
    parseTaskSource({
      yaml: proposalContent(proposal),
      filePath: proposal.changes[0]?.path || proposal.ref,
    });
    return [];
  },
  workflow(proposal) {
    const content = proposalContent(proposal);
    if (!content.trim()) return [];
    // #859: proposedTarget is absent on legacy archived rows, but this
    // validator only ever runs on a proposal about to be minted or promoted
    // (both always carry proposedTarget — see the Proposal.proposedTarget
    // doc comment) — so hitting this is a genuine defect, not a legacy gap.
    if (!proposal.proposedTarget) {
      return [
        {
          kind: "invalid-workflow-structure",
          message: `Workflow proposal ${proposal.id} (${proposal.ref}) is missing proposedTarget and cannot be validated.`,
        },
      ];
    }

    const sourcePath = proposal.changes[0]?.path || proposal.ref;
    const result = compileWorkflowSource(content, {
      path: sourcePath,
      workspaceRoot: proposal.proposedTarget.root,
    });
    if (result.ok) return [];

    return result.errors.map((error) => ({
      kind: "invalid-workflow-structure",
      message: `Workflow proposal ${proposal.id} (${proposal.ref}) is invalid [${error.code}] at ${error.path}:${error.line}: ${error.message}`,
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

/**
 * Structural-only subset used by {@link createProposal}'s mint-time
 * canonical-structure gate (repository.ts, `hasCanonicalProposalValidator`).
 * That gate exists to reject a lesson/task/workflow proposal whose body is
 * not parseable as its type — it predates {@link defaultProposalQualityValidators}
 * and was previously safe to run in full there because every quality
 * validator was advisory (`advisory()` downgrades findings to `severity:
 * "warn"`, which {@link runProposalValidators}'s `ok` never treats as
 * failing). #952's `reflect-truncation-marker` validator is deliberately
 * NOT advisory (it guards against data loss), so running the full
 * {@link defaultProposalValidators} list at mint time would throw
 * `invalid_canonical_structure` for any lesson/task/workflow reflect
 * proposal whose body leaks the truncation marker — instead of letting
 * `sanitizeReflectPayload` mint the proposal and defer it with
 * `reflect-truncation-leak`, per the #952 design. Quality validators (prose
 * shape, reflect size ratio, the truncation-marker guard) belong at
 * `proposal accept` / drain-promotion time, which already calls
 * {@link validateProposal} (the full list) via `preflightProposalPromotion`
 * / `promoteProposalWithLease`.
 */
export const canonicalOnlyProposalValidators: ProposalValidator[] = [
  genericProposalValidator,
  canonicalProposalValidator,
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
