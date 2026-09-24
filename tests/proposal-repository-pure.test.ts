// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { formatUnifiedDiff } from "../src/commands/proposal/diff-format";
// Import directly from the relocated module (the proposals repository split
// out of `validators/proposals.ts`).
import {
  isAutomatedProposalSource,
  isValidProposalSource,
  PROPOSAL_SOURCES,
} from "../src/commands/proposal/repository";
import { proposalRowToProposal, proposalToRowValues } from "../src/storage/repositories/proposals-repository";

const historicalRow = {
  id: "historical",
  stash_dir: "/tmp/stash",
  ref: "team//lessons/history",
  status: "pending",
  source: "reflect",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  content: "historical body",
  frontmatter_json: null,
  metadata_json: "{}",
};

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
    expect(formatUnifiedDiff("a\nb\n", "a\nb\n", "skills/x")).toBe("");
  });

  test("formatUnifiedDiff renders a familiar header + line markers", () => {
    const out = formatUnifiedDiff("one\ntwo", "one\nTWO", "skills/x");
    const lines = out.split("\n");
    expect(lines[0]).toBe("--- skills/x (existing)");
    expect(lines[1]).toBe("+++ skills/x (proposed)");
    expect(lines[2]).toBe("@@ 1,2 1,2 @@");
    // Unchanged line kept with a leading space; changed line shows -/+ pair.
    expect(out).toContain(" one");
    expect(out).toContain("-two");
    expect(out).toContain("+TWO");
  });

  test("tolerates a row without the current proposal envelope (#859)", () => {
    // historicalRow has an entirely empty metadata_json — missing both
    // `changes` and `proposedTarget`. Per the #859 reopening, both are
    // envelope metadata absent from real archived rows (~89% and ~93%
    // respectively) and neither blocks decode on its own: an already-
    // decided proposal is counted/displayed, never re-applied.
    const proposal = proposalRowToProposal(historicalRow);
    expect(proposal.changes).toEqual([]);
    expect(proposal.proposedTarget).toBeUndefined();
  });

  test("tolerates a legacy row missing only `changes` (#858/#859)", () => {
    const proposal = proposalRowToProposal({
      ...historicalRow,
      metadata_json: JSON.stringify({ proposedTarget: { source: "team", root: "/tmp/stash" } }),
    });
    expect(proposal.changes).toEqual([]);
  });

  test("tolerates a legacy row missing only `proposedTarget` (#859)", () => {
    const proposal = proposalRowToProposal({
      ...historicalRow,
      metadata_json: JSON.stringify({ changes: [{ path: "lessons/history.md", op: "update" }] }),
    });
    expect(proposal.proposedTarget).toBeUndefined();
  });

  test("rejects malformed JSON and malformed present envelope fields", () => {
    expect(() => proposalRowToProposal({ ...historicalRow, metadata_json: "{" })).toThrow(/metadata_json/i);
    expect(() => proposalRowToProposal({ ...historicalRow, frontmatter_json: "[]" })).toThrow(/frontmatter_json/i);
    expect(() =>
      proposalRowToProposal({
        ...historicalRow,
        metadata_json: JSON.stringify({ changes: [{ path: 1, op: "create" }] }),
      }),
    ).toThrow(/changes/i);
    expect(() =>
      proposalRowToProposal({
        ...historicalRow,
        metadata_json: JSON.stringify({
          changes: [{ path: "lessons/history.md", op: "update" }],
          proposedTarget: { source: "team" },
        }),
      }),
    ).toThrow(/proposedTarget/i);
  });

  test("current proposal envelopes round-trip", () => {
    const proposal = proposalRowToProposal({
      ...historicalRow,
      metadata_json: JSON.stringify({
        changes: [{ path: "lessons/history.md", op: "update" }],
        proposedTarget: { source: "team", root: "/tmp/stash" },
      }),
    });
    expect(proposalToRowValues(proposal, historicalRow.stash_dir).metadata_json).toContain("proposedTarget");
  });

  // #859: field-by-field real-archive absence combinations (see the
  // reopening comment's evidence table — beforeHash, proposedTarget,
  // changes, eligibilitySource, backupContent, confidence, sourceRun all
  // absent on real rows at meaningful rates). Each combination below is a
  // terminal-status row (archived rows are never re-applied) and must decode
  // without throwing, with the absent fields simply omitted.
  const terminalRow = { ...historicalRow, status: "accepted" };

  test("tolerates a fully envelope-less terminal row (every optional field absent)", () => {
    const proposal = proposalRowToProposal({
      ...terminalRow,
      metadata_json: JSON.stringify({
        sourceRun: "reflect-1",
        review: { outcome: "accepted", decidedAt: "2026-01-01T00:00:00.000Z" },
      }),
    });
    expect(proposal.changes).toEqual([]);
    expect(proposal.proposedTarget).toBeUndefined();
    expect(proposal.beforeHash).toBeUndefined();
    expect(proposal.beforeHashNormalized).toBeUndefined();
    expect(proposal.eligibilitySource).toBeUndefined();
    expect(proposal.backupContent).toBeUndefined();
    expect(proposal.confidence).toBeUndefined();
    expect(proposal.sourceRun).toBe("reflect-1");
  });

  test("tolerates changes + proposedTarget + beforeHash all absent together, gateDecision present", () => {
    const proposal = proposalRowToProposal({
      ...terminalRow,
      metadata_json: JSON.stringify({
        sourceRun: "consolidate-1",
        review: { outcome: "accepted", decidedAt: "2026-01-01T00:00:00.000Z" },
        confidence: 0.92,
        gateDecision: {
          outcome: "auto-accepted",
          reason: "policy-accept",
          gate: "triage:personal-stash",
          decidedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    expect(proposal.changes).toEqual([]);
    expect(proposal.proposedTarget).toBeUndefined();
    expect(proposal.beforeHash).toBeUndefined();
    expect(proposal.confidence).toBe(0.92);
    expect(proposal.gateDecision?.outcome).toBe("auto-accepted");
  });

  test("a fully-populated modern row round-trips every field", () => {
    const metadata = {
      sourceRun: "reflect-modern",
      changes: [{ path: "lessons/history.md", op: "update" }],
      proposedTarget: { source: "team", root: "/tmp/stash" },
      beforeHash: "a".repeat(64),
      beforeHashNormalized: "c".repeat(64),
      review: { outcome: "accepted", decidedAt: "2026-01-01T00:00:00.000Z" },
      confidence: 0.5,
      gateDecision: { outcome: "deferred", reason: "mid-band", decidedAt: "2026-01-01T00:00:00.000Z" },
      backupContent: "prior content",
      acceptedTarget: {
        source: "team",
        root: "/tmp/stash",
        path: "/tmp/stash/lessons/history.md",
        contentHash: "b".repeat(64),
      },
      eligibilitySource: "signal-delta",
    };
    const proposal = proposalRowToProposal({ ...terminalRow, metadata_json: JSON.stringify(metadata) });
    expect(proposal.changes).toEqual([{ path: "lessons/history.md", op: "update", after: "historical body" }]);
    expect(proposal.proposedTarget).toEqual({ source: "team", root: "/tmp/stash" });
    expect(proposal.beforeHash).toBe(metadata.beforeHash);
    expect(proposal.beforeHashNormalized).toBe(metadata.beforeHashNormalized);
    expect(proposal.confidence).toBe(0.5);
    expect(proposal.gateDecision?.outcome).toBe("deferred");
    expect(proposal.backupContent).toBe("prior content");
    expect(proposal.acceptedTarget?.contentHash).toBe(metadata.acceptedTarget.contentHash);
    expect(proposal.eligibilitySource).toBe("signal-delta");
  });

  test("a genuinely corrupt row (present-but-malformed field) is still rejected, not tolerated", () => {
    // Wrong type for a present field is corruption, distinct from the
    // field being absent entirely — absence is tolerated, malformed
    // presence is not.
    expect(() =>
      proposalRowToProposal({ ...terminalRow, metadata_json: JSON.stringify({ confidence: "high" }) }),
    ).toThrow(/confidence/i);
    expect(() =>
      proposalRowToProposal({ ...terminalRow, metadata_json: JSON.stringify({ beforeHash: 12345 }) }),
    ).toThrow(/beforeHash/i);
    expect(() =>
      proposalRowToProposal({ ...terminalRow, metadata_json: JSON.stringify({ eligibilitySource: 7 }) }),
    ).toThrow(/eligibilitySource/i);
  });

  test("write path: pending status still requires the full envelope (write path not weakened)", () => {
    const pendingNoTarget = proposalRowToProposal({
      ...historicalRow,
      metadata_json: JSON.stringify({ changes: [{ path: "lessons/history.md", op: "update" }] }),
    });
    expect(pendingNoTarget.status).toBe("pending");
    expect(() => proposalToRowValues(pendingNoTarget, historicalRow.stash_dir)).toThrow(/proposedTarget/i);

    const pendingNoChanges = proposalRowToProposal({
      ...historicalRow,
      metadata_json: JSON.stringify({ proposedTarget: { source: "team", root: "/tmp/stash" } }),
    });
    expect(() => proposalToRowValues(pendingNoChanges, historicalRow.stash_dir)).toThrow(/no file changes/i);
  });

  test("write path: a terminal-status row carrying forward legacy gaps re-persists without error", () => {
    // Mirrors `proposal revert` re-persisting an already-decoded legacy
    // accepted row: the write path must not block a status transition that
    // does not add new data, only carry forward what the row already had.
    const legacyAccepted = proposalRowToProposal({
      ...terminalRow,
      metadata_json: JSON.stringify({ review: { outcome: "accepted", decidedAt: "2026-01-01T00:00:00.000Z" } }),
    });
    expect(legacyAccepted.changes).toEqual([]);
    expect(legacyAccepted.proposedTarget).toBeUndefined();
    const reverted = { ...legacyAccepted, status: "reverted" as const };
    const row = proposalToRowValues(reverted, historicalRow.stash_dir);
    expect(row.metadata_json).not.toContain("proposedTarget");
    expect(JSON.parse(row.metadata_json).changes).toEqual([]);
  });
});
