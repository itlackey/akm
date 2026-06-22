// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for Bug 1 (drain masking) and Bug 2 (bounded auto-repair).
 *
 * Bug 1: drainProposals must SKIP proposals already stamped auto-rejected —
 *        it must never overwrite the rejection with auto-accepted.
 *
 * Bug 2: repairProposalContent strips pseudo-frontmatter-in-body, stray
 *        `---` fences, and truncated descriptions, then re-validates.
 *        Genuinely-unrepairable proposals (e.g. description too short) must
 *        remain pending (not promoted, not fabricated).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DrainOptions, drainProposals } from "../src/commands/proposal/drain";
import { PERSONAL_STASH } from "../src/commands/proposal/drain-policies";
import type { ProposalAcceptResult, ProposalRejectResult } from "../src/commands/proposal/proposal";
import {
  createProposal,
  getProposal,
  isProposalSkipped,
  type Proposal,
  recordGateDecision,
  repairProposalContent,
} from "../src/commands/proposal/validators/proposals";
import type { EventsContext } from "../src/core/events";

// ── Helpers ───────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-stuck-repair-stash-");
  for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

function eventsCtx(): EventsContext {
  return { dbPath: path.join(makeTempDir("akm-stuck-repair-db-"), "state.db") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedProposal(stash: string, ref: string, content: string): Proposal {
  const result = createProposal(stash, {
    ref,
    source: "extract",
    force: true,
    sourceRun: "run-test",
    payload: { content, frontmatter: { description: "test fixture" } },
  });
  if (isProposalSkipped(result)) throw new Error(`unexpected skip: ${result.message}`);
  return result;
}

function fakeAccept() {
  return mock(
    async (opts: { id: string }): Promise<ProposalAcceptResult> => ({
      schemaVersion: 1,
      ok: true,
      id: opts.id,
      ref: "lesson:fake",
      assetPath: "/tmp/fake.md",
      proposal: { id: opts.id } as Proposal,
    }),
  );
}

function fakeReject() {
  return mock(
    (opts: { id: string; reason?: string }): ProposalRejectResult => ({
      schemaVersion: 1,
      ok: true,
      id: opts.id,
      ref: "lesson:fake",
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      proposal: { id: opts.id } as Proposal,
    }),
  );
}

function baseOpts(stash: string, overrides: Partial<DrainOptions> = {}): DrainOptions {
  return {
    stashDir: stash,
    policy: PERSONAL_STASH,
    applyMode: "promote",
    maxAccepts: 25,
    dryRun: false,
    eventsCtx: eventsCtx(),
    ...overrides,
  };
}

// A valid extract proposal that PERSONAL_STASH would auto-accept.
const VALID_EXTRACT = `---\ndescription: Use ripgrep before grep for speed\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repositories.\n`;

// ── Bug 1: Drain masking ──────────────────────────────────────────────────────

describe("Bug 1 — drain skips auto-rejected proposals", () => {
  test("drain does NOT reclassify a proposal stamped auto-rejected to auto-accepted", async () => {
    const stash = makeStashDir();
    const proposal = seedProposal(stash, "lesson:drain-skip-test", VALID_EXTRACT);

    // Stamp the proposal as auto-rejected (as the improve confidence gate would).
    recordGateDecision(stash, proposal.id, {
      outcome: "auto-rejected",
      reason: "validation:invalid-description",
      gate: "improve:reflect",
    });

    // Verify the stamp is in place.
    const before = getProposal(stash, proposal.id);
    expect(before.gateDecision?.outcome).toBe("auto-rejected");
    expect(before.status).toBe("pending");

    const acceptFn = fakeAccept();
    const rejectFn = fakeReject();

    await drainProposals(baseOpts(stash), acceptFn, rejectFn);

    // The proposal must NOT have been reclassified to auto-accepted.
    const after = getProposal(stash, proposal.id);
    expect(after.status).toBe("pending");
    expect(after.gateDecision?.outcome).toBe("auto-rejected"); // unchanged

    // acceptFn must never have been called for this proposal.
    expect(acceptFn).not.toHaveBeenCalledWith(expect.objectContaining({ id: proposal.id }));
  });

  test("drain accepts normal pending extract proposal (no auto-rejected stamp)", async () => {
    const stash = makeStashDir();
    const proposal = seedProposal(stash, "lesson:normal-drain-test", VALID_EXTRACT);

    // No gateDecision stamp — drain should accept it normally.
    const acceptFn = fakeAccept();
    const rejectFn = fakeReject();

    const result = await drainProposals(baseOpts(stash), acceptFn, rejectFn);

    // The proposal should appear in promoted list.
    expect(result.promoted).toContain(proposal.id);
    expect(acceptFn).toHaveBeenCalledWith(expect.objectContaining({ id: proposal.id }));
  });

  test("drain skips auto-rejected and accepts clean proposal in same batch", async () => {
    const stash = makeStashDir();

    const rejected = seedProposal(stash, "lesson:skip-me", VALID_EXTRACT);
    recordGateDecision(stash, rejected.id, {
      outcome: "auto-rejected",
      reason: "validation:truncated",
      gate: "improve:reflect",
    });

    const clean = seedProposal(stash, "lesson:accept-me", VALID_EXTRACT);

    const acceptFn = fakeAccept();
    const rejectFn = fakeReject();

    const result = await drainProposals(baseOpts(stash), acceptFn, rejectFn);

    // Clean proposal promoted; rejected proposal skipped.
    expect(result.promoted).toContain(clean.id);
    expect(result.promoted).not.toContain(rejected.id);

    // The auto-rejected stamp must still be `auto-rejected` (not overwritten).
    const rejectedAfter = getProposal(stash, rejected.id);
    expect(rejectedAfter.gateDecision?.outcome).toBe("auto-rejected");
  });
});

// ── Bug 2: repairProposalContent ─────────────────────────────────────────────

describe("Bug 2 — repairProposalContent", () => {
  // ── Pseudo-frontmatter-in-body repair ────────────────────────────────────

  test("strips pseudo-frontmatter restatement from body", () => {
    const content = [
      "---",
      "description: A good description of the thing.",
      "when_to_use: When you need it",
      "---",
      "",
      "Some body text here.",
      "**description**: A good description of the thing.",
      "More body text.",
    ].join("\n");

    const repaired = repairProposalContent(content);

    // The pseudo-frontmatter line must be gone from the body.
    expect(repaired).not.toMatch(/\*\*description\*\*:/);
    // The frontmatter description must still be intact.
    expect(repaired).toContain("description: A good description of the thing.");
    // The legitimate body content must remain.
    expect(repaired).toContain("Some body text here.");
    expect(repaired).toContain("More body text.");
  });

  test("strips `when_to_use:` restatement from body", () => {
    const content = [
      "---",
      "description: A good description here.",
      "when_to_use: When you need it daily",
      "---",
      "",
      "when_to_use: When you need it daily",
      "Real content.",
    ].join("\n");

    const repaired = repairProposalContent(content);
    // Body pseudo-frontmatter line stripped.
    const bodyLines = repaired.split("\n").slice(5); // skip fm
    expect(bodyLines.every((l) => !/^when_to_use:/.test(l))).toBe(true);
    expect(repaired).toContain("Real content.");
  });

  // ── Stray `---` in body repair ────────────────────────────────────────────

  test("removes extra `---` horizontal rule lines from body, keeps fm fences", () => {
    const content = [
      "---",
      "description: A good description of the test.",
      "when_to_use: When testing body fences",
      "---",
      "",
      "First paragraph.",
      "---",
      "Second paragraph.",
    ].join("\n");

    const repaired = repairProposalContent(content);

    const lines = repaired.split("\n");
    // Only 2 `---` lines must remain (the frontmatter fences).
    const fenceLines = lines.filter((l) => /^---\s*$/.test(l));
    expect(fenceLines.length).toBe(2);

    // Content must be preserved.
    expect(repaired).toContain("First paragraph.");
    expect(repaired).toContain("Second paragraph.");
  });

  // ── Truncated description repair ──────────────────────────────────────────

  test("repairs truncated description ending with ':'", () => {
    // "description" ending with ':' is detected as truncated.
    const content = [
      "---",
      "description: This explains how to configure the",
      "when_to_use: When setting up configuration files",
      "---",
      "",
      "Use this approach for configuration management in large projects.",
    ].join("\n");

    const repaired = repairProposalContent(content);

    // The trailing truncated fragment must be removed or fixed.
    const descMatch = repaired.match(/^description:\s*(.+)$/m);
    expect(descMatch).toBeTruthy();
    const desc = descMatch?.[1] ?? "";
    // Must not end with a truncation indicator word or `:`.
    expect(desc.endsWith(":")).toBe(false);
    expect(desc.endsWith(",")).toBe(false);
    // Must not end with hanging connector word "the".
    expect(desc.trim().toLowerCase().endsWith(" the")).toBe(false);
  });

  // ── Unrepairable: description too short ───────────────────────────────────

  test("does NOT fabricate or alter content when description is too short to repair", () => {
    // 11-char description — too short to be repairable (MIN is 20).
    const content = ["---", "description: Short txt", "when_to_use: When needed", "---", "", "Body text."].join("\n");

    // repairProposalContent must return something (possibly unchanged or lightly
    // repaired), but must NOT fabricate a description.
    const repaired = repairProposalContent(content);

    // The description must not have been replaced with invented text.
    const descMatch = repaired.match(/^description:\s*(.+)$/m);
    const desc = descMatch?.[1] ?? "";
    // It must still be the short original (or trimmed equivalent).
    expect(desc.length).toBeLessThan(20);
    // Must not contain text not from the original.
    expect(desc).not.toMatch(/configuration|project|approach/i);
  });
});

// ── Promote boundary: repair + re-validate integration ───────────────────────

describe("Bug 2 — promote boundary re-validate after repair", () => {
  // These tests call repairProposalContent directly and then verify that the
  // repaired content is valid according to the same validators used by
  // promoteProposal. We test the repair function standalone here because
  // promoteProposal requires a full stash + config setup.

  test("repaired pseudo-frontmatter content passes validators", async () => {
    const { runProposalValidators } = await import("../src/commands/proposal/validators/proposal-validators");

    const raw = [
      "---",
      "description: A reliable method for configuring deployment pipelines.",
      "when_to_use: When automating deployment steps in CI/CD.",
      "---",
      "",
      "**description**: A reliable method for configuring deployment pipelines.",
      "Use this when you need repeatable deployments.",
    ].join("\n");

    const repaired = repairProposalContent(raw);

    // The pseudo-frontmatter line must be gone.
    expect(repaired).not.toMatch(/\*\*description\*\*:/);

    // Build a minimal proposal and validate.
    const proposal = {
      id: "test-pseudo-fm",
      ref: "lesson:deploy-pipelines",
      status: "pending" as const,
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: repaired },
    };
    const report = runProposalValidators(proposal as Parameters<typeof runProposalValidators>[0]);
    expect(report.ok).toBe(true);
  });

  test("repaired double-`---` content passes validators", async () => {
    const { runProposalValidators } = await import("../src/commands/proposal/validators/proposal-validators");

    const raw = [
      "---",
      "description: A solid guide for repository management practices.",
      "when_to_use: When managing code repositories at scale.",
      "---",
      "",
      "Key practices for repository management.",
      "---",
      "Additional notes on branching strategy.",
    ].join("\n");

    const repaired = repairProposalContent(raw);

    // Only 2 fence lines remain.
    const fences = repaired.split("\n").filter((l) => /^---\s*$/.test(l));
    expect(fences.length).toBe(2);

    const proposal = {
      id: "test-double-fence",
      ref: "lesson:repo-management",
      status: "pending" as const,
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: repaired },
    };
    const report = runProposalValidators(proposal as Parameters<typeof runProposalValidators>[0]);
    expect(report.ok).toBe(true);
  });

  test("unrepairable (too short description) stays invalid after repair", async () => {
    const { runProposalValidators } = await import("../src/commands/proposal/validators/proposal-validators");

    // 11 chars — too short for DESCRIPTION_MIN_CHARS (20).
    const raw = [
      "---",
      "description: Short txt",
      "when_to_use: When needed for the task at hand.",
      "---",
      "",
      "Body content.",
    ].join("\n");

    const repaired = repairProposalContent(raw);

    const proposal = {
      id: "test-too-short",
      ref: "lesson:short-desc",
      status: "pending" as const,
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: repaired },
    };
    const report = runProposalValidators(proposal as Parameters<typeof runProposalValidators>[0]);

    // Must still be invalid — repair cannot fabricate a longer description.
    expect(report.ok).toBe(false);
    const kinds = report.findings.map((f) => f.kind);
    // Should have a description-related finding.
    expect(kinds.some((k) => k.includes("description"))).toBe(true);
  });
});
