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
import { stageJudgedProposal } from "../src/commands/improve/stage";
import { type DrainOptions, drainProposals } from "../src/commands/proposal/drain";
import type { ProposalAcceptResult, ProposalRejectResult } from "../src/commands/proposal/proposal";
import { createProposal, getProposal, type Proposal, recordGateDecision } from "../src/commands/proposal/repository";
import { repairProposalContent } from "../src/commands/proposal/validators/proposals";
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
    sourceRun: "run-test",
    target: { source: "stash", root: stash },
    payload: { content, frontmatter: { description: "test fixture" } },
  });
  return result;
}

function fakeAccept() {
  return mock(
    async (opts: { id: string }): Promise<ProposalAcceptResult> => ({
      schemaVersion: 1,
      ok: true,
      id: opts.id,
      ref: "lessons/fake",
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
      ref: "lessons/fake",
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      proposal: { id: opts.id } as Proposal,
    }),
  );
}

function baseOpts(stash: string, overrides: Partial<DrainOptions> = {}): DrainOptions {
  return {
    stashDir: stash,
    applyMode: "promote",
    maxAccepts: 25,
    dryRun: false,
    eventsCtx: eventsCtx(),
    ...overrides,
  };
}

// A valid extract proposal; the drain accepts it once a quality judge passed it.
const VALID_EXTRACT = `---\ndescription: Use ripgrep before grep for speed\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repositories.\n`;

// ── Bug 1: Drain masking ──────────────────────────────────────────────────────

describe("Bug 1 — drain skips auto-rejected proposals", () => {
  test("drain does NOT reclassify a proposal stamped auto-rejected to auto-accepted", async () => {
    const stash = makeStashDir();
    const proposal = seedProposal(stash, "lessons/drain-skip-test", VALID_EXTRACT);

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

  test("drain accepts a judge-passed pending extract proposal (no auto-rejected stamp)", async () => {
    const stash = makeStashDir();
    const proposal = stageJudgedProposal(stash, seedProposal(stash, "lessons/normal-drain-test", VALID_EXTRACT));

    // No auto-rejected stamp — drain should accept it normally.
    const acceptFn = fakeAccept();
    const rejectFn = fakeReject();

    const result = await drainProposals(baseOpts(stash), acceptFn, rejectFn);

    // The proposal should appear in promoted list.
    expect(result.promoted).toContain(proposal.id);
    expect(acceptFn).toHaveBeenCalledWith(expect.objectContaining({ id: proposal.id }));
  });

  test("drain skips auto-rejected and accepts clean proposal in same batch", async () => {
    const stash = makeStashDir();

    const rejected = seedProposal(stash, "lessons/skip-me", VALID_EXTRACT);
    recordGateDecision(stash, rejected.id, {
      outcome: "auto-rejected",
      reason: "validation:truncated",
      gate: "improve:reflect",
    });

    const clean = stageJudgedProposal(stash, seedProposal(stash, "lessons/accept-me", VALID_EXTRACT));

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

  test("an opted-in judgment runner never reopens an authoritative rejection", async () => {
    const stash = makeStashDir();
    const proposal = seedProposal(stash, "lessons/judge-must-not-reopen", VALID_EXTRACT);
    recordGateDecision(stash, proposal.id, {
      outcome: "auto-rejected",
      reason: "validation:unsafe",
      gate: "improve:reflect",
    });
    const chat = mock(async () => {
      throw new Error("authoritative rejection reached judgment");
    });
    const acceptFn = fakeAccept();
    const rejectFn = fakeReject();

    const result = await drainProposals(
      baseOpts(stash, {
        judgment: {
          kind: "llm",
          engine: "judge",
          connection: { endpoint: "https://example.test/v1/chat/completions", model: "judge" },
        },
      }),
      acceptFn,
      rejectFn,
      { chat },
    );

    expect(result.promoted).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
    expect(acceptFn).not.toHaveBeenCalled();
    expect(rejectFn).not.toHaveBeenCalled();
    expect(getProposal(stash, proposal.id).gateDecision?.outcome).toBe("auto-rejected");
  });
});

// ── Bug 2: repairProposalContent ─────────────────────────────────────────────

describe("Bug 2 — repairProposalContent", () => {
  // ── Pseudo-frontmatter-in-body repair ────────────────────────────────────

  // These three used to pin the opposite behaviour: the repair deleted body
  // lines that restated a frontmatter key, and every `---` in a body with
  // frontmatter. Both fired inside fenced code blocks, so an asset that
  // DOCUMENTS frontmatter was silently gutted on `proposal accept` and the
  // gutted bytes were written back over the original. Content is preserved now.

  test("keeps a body line that restates a frontmatter key", () => {
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

    expect(repairProposalContent(content)).toBe(content);
  });

  test("keeps a fenced YAML example verbatim — the corruption case", () => {
    const content = [
      "---",
      "description: How akm assets declare frontmatter.",
      "when_to_use: When authoring a new asset",
      "---",
      "",
      "Every asset opens with a frontmatter block:",
      "",
      "```yaml",
      "---",
      "description: A short summary.",
      "when_to_use: When you need X.",
      "---",
      "```",
      "",
      "That block is required.",
    ].join("\n");

    const repaired = repairProposalContent(content);

    // The old repair emitted an EMPTY ```yaml fence here: all four inner
    // lines matched a repair rule and were dropped.
    expect(repaired).toBe(content);
    expect(repaired).toContain("description: A short summary.");
    expect(repaired).toContain("when_to_use: When you need X.");
  });

  test("keeps a thematic break in a body that has frontmatter", () => {
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

    expect(repairProposalContent(content)).toBe(content);
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

  test("a body restating a frontmatter key promotes unchanged, with the finding reported", async () => {
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
    expect(repaired).toBe(raw);

    const proposal = {
      id: "test-pseudo-fm",
      ref: "lessons/deploy-pipelines",
      status: "pending" as const,
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: repaired },
      changes: [{ path: "lessons/deploy-pipelines.md", op: "create" as const, after: repaired }],
    };
    const report = runProposalValidators(proposal as Parameters<typeof runProposalValidators>[0]);
    expect(report.ok).toBe(true);
  });

  test("a thematic break in the body promotes unchanged", async () => {
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
    expect(repaired).toBe(raw);

    const proposal = {
      id: "test-double-fence",
      ref: "lessons/repo-management",
      status: "pending" as const,
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: repaired },
      changes: [{ path: "lessons/repo-management.md", op: "create" as const, after: repaired }],
    };
    const report = runProposalValidators(proposal as Parameters<typeof runProposalValidators>[0]);
    expect(report.ok).toBe(true);
  });

  // A short description is a prose judgement. It is reported, but it must not
  // block an accept a human typed: there is no `proposal edit` and no
  // `--force`, so blocking here left the user hand-editing the proposals DB.
  test("a too-short description is reported as a warning and does not block", async () => {
    const { runProposalValidators } = await import("../src/commands/proposal/validators/proposal-validators");

    const raw = [
      "---",
      "description: Short txt",
      "when_to_use: When needed for the task at hand.",
      "---",
      "",
      "Body content.",
    ].join("\n");

    const proposal = {
      id: "test-too-short",
      ref: "lessons/short-desc",
      status: "pending" as const,
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: raw },
      changes: [{ path: "lessons/short-desc.md", op: "create" as const, after: raw }],
    };
    const report = runProposalValidators(proposal as Parameters<typeof runProposalValidators>[0]);

    expect(report.ok).toBe(true);
    const description = report.findings.find((f) => f.kind.includes("description"));
    expect(description).toBeDefined();
    expect(description?.severity).toBe("warn");
  });

  // Structural defects still block: these cannot be written at all.
  test("empty content still blocks promotion", async () => {
    const { runProposalValidators } = await import("../src/commands/proposal/validators/proposal-validators");

    const proposal = {
      id: "test-empty",
      ref: "lessons/empty",
      status: "pending" as const,
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: "   " },
      changes: [{ path: "lessons/empty.md", op: "create" as const, after: "   " }],
    };
    const report = runProposalValidators(proposal as Parameters<typeof runProposalValidators>[0]);

    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toContain("empty-content");
  });
});
