// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { runProposalValidators } from "../../../src/commands/proposal/validators/proposal-validators";
import { REDACTED_CONTENT_MARKER } from "../../../src/core/content-safety";
import { makeProposal, payloadChanges } from "../../_helpers/factories";

function proposalWith(content: string, source = "reflect") {
  return {
    ...makeProposal("knowledge/content-safety"),
    source,
    payload: { content },
    changes: payloadChanges(content),
  };
}

describe("proposal durable-content safety (#962/#963)", () => {
  test("blocks any proposal whose durable body contains a redaction marker", () => {
    const report = runProposalValidators(
      proposalWith(`---\ndescription: Damaged content\n---\n\nprofiles.${REDACTED_CONTENT_MARKER}.default`),
    );

    expect(report.ok).toBe(false);
    expect(
      report.findings.some((finding) => finding.kind === "redacted-content" && finding.severity === undefined),
    ).toBe(true);
  });

  test("blocks reflect prompt scaffolding that bypassed the creation-time sanitizer", () => {
    const report = runProposalValidators(
      proposalWith(
        "---\ndescription: Prompt residue\n---\n\nUseful content.\n\n## Avoid These Patterns\n- unrelated diagnostic",
      ),
    );

    expect(report.ok).toBe(false);
    expect(
      report.findings.some(
        (finding) => finding.kind === "reflect-prompt-scaffolding" && finding.severity === undefined,
      ),
    ).toBe(true);
  });

  test("does not apply the reflect-only scaffolding validator to other proposal sources", () => {
    const report = runProposalValidators(
      proposalWith(
        "---\ndescription: Authored discussion\n---\n\n## Avoid These Patterns\nThis heading was authored directly.",
        "propose",
      ),
    );

    expect(report.findings.some((finding) => finding.kind === "reflect-prompt-scaffolding")).toBe(false);
  });
});
