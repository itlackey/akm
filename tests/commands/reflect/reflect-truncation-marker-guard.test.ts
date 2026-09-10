// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the accept-time `reflect-truncation-marker` ProposalValidator
 * (#952 Addendum, dev-team field review 2026-09-09).
 *
 * `sanitizeReflectPayload` already flags-and-defers a proposal whose body
 * echoes `REFLECT_TRUNCATION_MARKER` at CREATION time (see
 * `tests/integration/commands/reflect/reflect-pipeline-fixes.test.ts`'s
 * "Reflect truncation-marker leak guard" describe block). This file locks in
 * the SECOND layer: a REJECT at `proposal accept` / drain promotion time, so
 * a leaked marker cannot be promoted onto disk even if it reaches the
 * validator by a path that skipped creation-time sanitize (a deferred
 * proposal a human accepts anyway, or any future reflect code path that
 * mints proposals directly). Unlike every other validator in
 * proposal-quality-validators.ts, this one is NOT advisory — it blocks,
 * because a truncated body silently replacing a full asset is data loss
 * (AGENTS.md's defensive-code carve-out for data-loss guards), not a prose
 * quality nit.
 */

import { describe, expect, test } from "bun:test";
import type { Proposal, ProposalValidationContext } from "../../../src/commands/proposal/proposal-types";
import { defaultProposalQualityValidators } from "../../../src/commands/proposal/validators/proposal-quality-validators";
import { runProposalValidators } from "../../../src/commands/proposal/validators/proposal-validators";
import { REFLECT_TRUNCATION_MARKER } from "../../../src/integrations/agent/prompts";
import { makeProposal, payloadChanges } from "../../_helpers/factories";

const ctx: ProposalValidationContext = {};

/** Build a proposal fixture with `payload.content` and `changes[0].after` in sync (WI-6.2 invariant). */
function withContent(ref: string, content: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...makeProposal(ref),
    payload: { content },
    changes: payloadChanges(content),
    ...overrides,
  };
}

function findValidator() {
  const validator = defaultProposalQualityValidators.find((v) => v.name === "reflect-truncation-marker");
  if (!validator) throw new Error("reflect-truncation-marker validator is not registered");
  return validator;
}

describe("reflect-truncation-marker validator (#952 Addendum)", () => {
  test("is registered in defaultProposalQualityValidators", () => {
    expect(defaultProposalQualityValidators.some((v) => v.name === "reflect-truncation-marker")).toBe(true);
  });

  test("appliesTo: true for a reflect-sourced proposal with string content", () => {
    const validator = findValidator();
    const proposal = withContent("knowledge/leak", "Rewritten body.");
    expect(proposal.source).toBe("reflect");
    expect(validator.appliesTo(proposal, ctx)).toBe(true);
  });

  test("appliesTo: false for a non-reflect source, even when the body contains the marker", () => {
    const validator = findValidator();
    const proposal = withContent("knowledge/leak", `Body.\n${REFLECT_TRUNCATION_MARKER}`, { source: "distill" });
    expect(validator.appliesTo(proposal, ctx)).toBe(false);
  });

  test("validate: no findings when the body does not contain the marker", () => {
    const validator = findValidator();
    const proposal = withContent("knowledge/leak", "A clean, complete rewrite.");
    expect(validator.validate(proposal, ctx)).toEqual([]);
  });

  test("validate: rejects with a message naming the marker and the remedy to reflect again", () => {
    const validator = findValidator();
    const proposal = withContent("knowledge/leak", `Rewritten body.\n${REFLECT_TRUNCATION_MARKER}`);
    const findings = validator.validate(proposal, ctx);
    expect(findings).toHaveLength(1);
    // No `severity` field — this finding is blocking, not advisory (see
    // ProposalValidationFinding's doc comment: absent severity = error-level).
    expect(findings[0]?.severity).toBeUndefined();
    expect(findings[0]?.message).toContain(REFLECT_TRUNCATION_MARKER);
    expect(findings[0]?.message).toContain("Reflect this ref again");
  });

  test("runProposalValidators: BLOCKS acceptance (ok:false) for a reflect proposal leaking the marker", () => {
    const proposal = withContent("knowledge/leak", `Rewritten body.\n${REFLECT_TRUNCATION_MARKER}`);
    const report = runProposalValidators(proposal);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.kind === "reflect-truncation-marker-leak" && f.severity === undefined)).toBe(
      true,
    );
  });

  test("runProposalValidators: does not block a clean reflect proposal", () => {
    const proposal = withContent("knowledge/leak", "---\ndescription: A clean doc\n---\n\nA clean, complete rewrite.");
    const report = runProposalValidators(proposal);
    expect(report.findings.some((f) => f.kind === "reflect-truncation-marker-leak")).toBe(false);
  });
});
