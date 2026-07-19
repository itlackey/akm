// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Pins the warn-vs-error rendering of `akm proposal show` plain text (#557).
// `severity: "warn"` findings are non-blocking and must read as advisory
// (yellow `⚠ warning ... (non-blocking)`), visually distinct from blocking
// errors (red `✗ error`). The JSON shape is unchanged — these tests only
// assert the text renderer.

import { describe, expect, it } from "bun:test";
import { formatProposalShowPlain } from "../src/output/text/helpers";

const baseProposal = {
  id: "uuid-1",
  ref: "lessons/rg-over-grep",
  status: "pending",
  source: "distill",
};

describe("formatProposalShowPlain — severity rendering (#557)", () => {
  it("renders a warn-only proposal as valid with a non-blocking warning", () => {
    const out = formatProposalShowPlain({
      proposal: baseProposal,
      validation: {
        ok: true,
        findings: [{ kind: "invalid-description", message: "description starts with 'When'", severity: "warn" }],
      },
    });
    expect(out).toContain("✓ valid (1 warning(s))");
    expect(out).toContain("⚠ warning  [invalid-description] description starts with 'When' (non-blocking)");
    // Must NOT render the warn finding with the blocking-error icon/label.
    expect(out).not.toContain("✗ error");
    expect(out).not.toContain("✗ invalid");
  });

  it("renders a blocking error as invalid with the error icon", () => {
    const out = formatProposalShowPlain({
      proposal: baseProposal,
      validation: {
        ok: false,
        findings: [{ kind: "missing-field", message: "ref is required" }],
      },
    });
    expect(out).toContain("✗ invalid (1 error(s))");
    expect(out).toContain("✗ error  [missing-field] ref is required");
    expect(out).not.toContain("⚠ warning");
  });

  it("distinguishes errors from warnings when both are present (errors first)", () => {
    const out = formatProposalShowPlain({
      proposal: baseProposal,
      validation: {
        ok: false,
        findings: [
          { kind: "invalid-description", message: "starts with 'When'", severity: "warn" },
          { kind: "missing-field", message: "ref is required" },
        ],
      },
    });
    expect(out).toContain("✗ invalid (1 error(s), 1 warning(s))");
    const errorIdx = out.indexOf("✗ error  [missing-field]");
    const warnIdx = out.indexOf("⚠ warning  [invalid-description]");
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    // Blocking errors render before advisory warnings.
    expect(errorIdx).toBeLessThan(warnIdx);
  });

  it("renders a clean proposal as valid with no findings", () => {
    const out = formatProposalShowPlain({
      proposal: baseProposal,
      validation: { ok: true, findings: [] },
    });
    expect(out).toContain("✓ valid");
    expect(out).not.toContain("warning");
    expect(out).not.toContain("✗ error");
  });
});
