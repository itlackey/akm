// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
// Import directly from the relocated module (the proposals repository split
// out of `validators/proposals.ts`).
import {
  formatUnifiedDiff,
  isAutomatedProposalSource,
  isValidProposalSource,
  PROPOSAL_SOURCES,
} from "../src/commands/proposal/repository";

describe("proposal repository — pure helpers (post-split)", () => {
  test("isValidProposalSource accepts known sources and rejects typos", () => {
    for (const s of PROPOSAL_SOURCES) {
      expect(isValidProposalSource(s)).toBe(true);
    }
    expect(isValidProposalSource("reflct")).toBe(false);
    expect(isValidProposalSource("")).toBe(false);
  });

  test("isAutomatedProposalSource distinguishes automated from human sources", () => {
    expect(isAutomatedProposalSource("reflect")).toBe(true);
    expect(isAutomatedProposalSource("distill")).toBe(true);
    // Human-initiated sources are not automated.
    expect(isAutomatedProposalSource("propose")).toBe(false);
    expect(isAutomatedProposalSource("remember")).toBe(false);
    expect(isAutomatedProposalSource("import")).toBe(false);
  });

  test("formatUnifiedDiff returns empty string when sides are identical", () => {
    expect(formatUnifiedDiff("a\nb\n", "a\nb\n", "skill:x")).toBe("");
  });

  test("formatUnifiedDiff renders a familiar header + line markers", () => {
    const out = formatUnifiedDiff("one\ntwo", "one\nTWO", "skill:x");
    const lines = out.split("\n");
    expect(lines[0]).toBe("--- skill:x (existing)");
    expect(lines[1]).toBe("+++ skill:x (proposed)");
    expect(lines[2]).toBe("@@ 1,2 1,2 @@");
    // Unchanged line kept with a leading space; changed line shows -/+ pair.
    expect(out).toContain(" one");
    expect(out).toContain("-two");
    expect(out).toContain("+TWO");
  });
});
