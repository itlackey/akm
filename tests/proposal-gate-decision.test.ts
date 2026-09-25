// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Per-proposal gate-decision persistence + rendering (#577) — drain-scoped.
//
// The triage drain must stamp WHY each proposal landed where it did
// (auto-accepted / deferred / auto-rejected, with a reason) onto the proposal
// row, and the `proposal show` / `list` surfaces
// must expose it. Proposals that have not passed through a gate omit the gate
// fields from rendered output.
//
// FS-bound (real createProposal/listProposals against the sandboxed state.db),
// no process.env mutation — the stash dir is passed explicitly and the preload
// sandbox owns HOME/XDG, so no extra env helper is required.

import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageJudgedProposal } from "../src/commands/improve/distill/quality-gate";
import { drainProposals } from "../src/commands/proposal/drain";
import {
  akmProposalReject,
  type ProposalAcceptResult,
  type ProposalRejectResult,
} from "../src/commands/proposal/proposal";
import { createProposal, getProposal, type Proposal, recordGateDecision } from "../src/commands/proposal/repository";
import { shapeProposalEntry } from "../src/output/shapes/helpers";
import { formatProposalListPlain, formatProposalShowPlain } from "../src/output/text/helpers";

// ── Setup ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-gate-stash-");
  for (const dir of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

function seed(stash: string, ref: string, source: string, content: string): Proposal {
  const result = createProposal(stash, {
    ref,
    source,
    sourceRun: "run-x",
    target: { source: "stash", root: stash },
    payload: { content, frontmatter: { description: `${ref} fixture` } },
  });
  return result;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg over grep.\n`;
const EMPTY_LESSON = `---\ndescription: A lesson with an intentionally empty body\nwhen_to_use: Testing empty-diff proposal handling\n---\n\n`;
const BIG_CONSOLIDATE = `---\ndescription: A large consolidated lesson\nwhen_to_use: Testing maximum diff-line proposal handling\n---\n\n${Array.from(
  { length: 300 },
  (_, i) => `line ${i}`,
).join("\n")}\n`;

// ── recordGateDecision core ─────────────────────────────────────────────────

describe("recordGateDecision (#577)", () => {
  test("stamps the decision without changing status or archiving the proposal", () => {
    const stash = makeStashDir();
    const created = seed(stash, "lessons/rg", "reflect", VALID_LESSON);

    const updated = recordGateDecision(stash, created.id, {
      outcome: "deferred",
      reason: "max-diff-lines",
      measured: 210,
      thresholds: { maxDiffLines: 200 },
      gate: "triage:personal-stash",
    });

    expect(updated?.gateDecision?.outcome).toBe("deferred");
    // Status is untouched — a deferred proposal stays pending.
    expect(updated?.status).toBe("pending");
    const decidedAt = updated?.gateDecision?.decidedAt ?? "";
    expect(decidedAt).toBeTruthy();

    // Persisted: a fresh read sees the same decision.
    const reread = getProposal(stash, created.id);
    expect(reread.gateDecision).toEqual({
      outcome: "deferred",
      reason: "max-diff-lines",
      measured: 210,
      thresholds: { maxDiffLines: 200 },
      gate: "triage:personal-stash",
      decidedAt,
    });
  });

  test("returns undefined (no throw) for an unknown proposal id", () => {
    const stash = makeStashDir();
    expect(recordGateDecision(stash, "does-not-exist", { outcome: "deferred", reason: "x" })).toBeUndefined();
  });
});

// ── Drain engine records on each decision path ──────────────────────────────

describe("drainProposals records a gate decision per path (#577)", () => {
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

  test("queue-mode judge-passed accepts keep their staged stamp — no terminal outcome", async () => {
    const stash = makeStashDir();
    const p = stageJudgedProposal(stash, seed(stash, "lessons/ok", "extract", VALID_LESSON));

    await drainProposals(
      { stashDir: stash, applyMode: "queue", maxAccepts: 25, dryRun: false },
      fakeAccept(),
      fakeReject(),
    );

    const decision = getProposal(stash, p.id).gateDecision;
    expect(decision).toMatchObject({ outcome: "staged", reason: "quality-judge", gate: "quality-gate" });
  });

  test("a mocked empty-diff rejection does not pre-stamp a terminal outcome", async () => {
    const stash = makeStashDir();
    const p = seed(stash, "lessons/empty", "reflect", EMPTY_LESSON);
    const rejectFn = fakeReject();

    await drainProposals(
      { stashDir: stash, applyMode: "queue", maxAccepts: 25, dryRun: false },
      fakeAccept(),
      rejectFn,
    );

    const decision = getProposal(stash, p.id).gateDecision;
    expect(decision).toBeUndefined();
    expect(rejectFn).toHaveBeenCalledWith(
      expect.objectContaining({
        gateDecision: {
          outcome: "auto-rejected",
          reason: "empty-diff",
          gate: "triage",
        },
      }),
    );
  });

  test("real rejection persists status, review, and gate decision together", async () => {
    const stash = makeStashDir();
    const p = seed(stash, "lessons/terminal-reject", "extract", EMPTY_LESSON);

    await drainProposals(
      { stashDir: stash, applyMode: "queue", maxAccepts: 25, dryRun: false },
      fakeAccept(),
      akmProposalReject,
    );

    expect(getProposal(stash, p.id)).toMatchObject({
      status: "rejected",
      review: { outcome: "rejected", reason: "empty diff" },
      gateDecision: { outcome: "auto-rejected", reason: "empty-diff", gate: "triage" },
    });
  });

  test("deferred (no-judge-configured): an unjudged proposal with no runner", async () => {
    const stash = makeStashDir();
    const p = seed(stash, "lessons/dup", "distill", VALID_LESSON);

    await drainProposals(
      { stashDir: stash, applyMode: "queue", maxAccepts: 25, dryRun: false },
      fakeAccept(),
      fakeReject(),
    );

    const decision = getProposal(stash, p.id).gateDecision;
    expect(decision?.outcome).toBe("deferred");
    expect(decision?.reason).toBe("no-judge-configured");
  });

  test("dry-run performs zero writes — no decision is recorded", async () => {
    const stash = makeStashDir();
    const p = seed(stash, "lessons/dry", "consolidate", BIG_CONSOLIDATE);

    await drainProposals(
      { stashDir: stash, applyMode: "queue", maxAccepts: 25, dryRun: true },
      fakeAccept(),
      fakeReject(),
    );

    expect(getProposal(stash, p.id).gateDecision).toBeUndefined();
  });
});

// ── show / list expose the decision ────────────────────────────────────────

describe("proposal show / list expose the gate decision (#577)", () => {
  const withDecision = {
    id: "uuid-1",
    ref: "lessons/rg",
    status: "pending",
    source: "improve",
    createdAt: "2026-06-11T00:00:00.000Z",
    confidence: 0.72,
    gateDecision: {
      outcome: "deferred",
      reason: "min-content-lines",
      measured: 1,
      thresholds: { minContentLines: 5 },
      gate: "triage:personal-stash",
      decidedAt: "2026-06-11T00:00:01.000Z",
    },
  };
  // A drain over-band defer: the measured line count is persisted alongside the
  // bound so the full "210 > 200" comparison renders (#577 finding 4).
  const drainBand = {
    id: "uuid-drain",
    ref: "lessons/big",
    status: "pending",
    source: "consolidate",
    createdAt: "2026-06-11T00:00:00.000Z",
    gateDecision: {
      outcome: "deferred",
      reason: "max-diff-lines",
      measured: 210,
      thresholds: { maxDiffLines: 200 },
      gate: "triage:personal-stash",
      decidedAt: "2026-06-11T00:00:01.000Z",
    },
  };
  const ungated = {
    id: "uuid-ungated",
    ref: "lessons/new",
    status: "pending",
    source: "reflect",
    createdAt: "2026-06-11T00:00:00.000Z",
  };

  test("shapeProposalEntry projects confidence + gateDecision at normal/full detail", () => {
    const normal = shapeProposalEntry(withDecision, "normal");
    expect(normal.confidence).toBe(0.72);
    expect((normal.gateDecision as Record<string, unknown>).reason).toBe("min-content-lines");

    const full = shapeProposalEntry(withDecision, "full");
    expect(full.gateDecision).toBeDefined();
  });

  test("formatProposalShowPlain renders decision + reason + reconstructable comparison", () => {
    const out = formatProposalShowPlain({ proposal: withDecision });
    expect(out).toContain("gate.decision: deferred");
    expect(out).toContain("gate.reason: min-content-lines");
    expect(out).toContain("1 < 5");
    expect(out).toContain("gate.by: triage:personal-stash");
  });

  test("formatProposalShowPlain renders the full '210 > 200' comparison for a drain band defer", () => {
    const out = formatProposalShowPlain({ proposal: drainBand });
    expect(out).toContain("gate.decision: deferred");
    expect(out).toContain("gate.reason: max-diff-lines");
    expect(out).toContain("gate.thresholds: 210 > 200");
    expect(out).toContain("gate.by: triage:personal-stash");
  });

  test("formatProposalListPlain surfaces the full drain comparison inline", () => {
    const out = formatProposalListPlain({ totalCount: 1, proposals: [drainBand] });
    expect(out).toContain("gate=deferred:max-diff-lines (210 > 200)");
  });

  test("formatProposalShowPlain omits gate fields when no decision exists", () => {
    const out = formatProposalShowPlain({ proposal: ungated });
    expect(out).not.toContain("gate.");
    expect(out).not.toContain("undefined");
  });

  test("formatProposalListPlain surfaces the decision inline and omits it for ungated rows", () => {
    const out = formatProposalListPlain({ totalCount: 2, proposals: [withDecision, ungated] });
    expect(out).toContain("gate=deferred:min-content-lines (1 < 5)");
    const ungatedLine = out.split("\n").find((l) => l.includes("uuid-ungated")) ?? "";
    expect(ungatedLine).not.toContain("gate=");
    expect(ungatedLine).not.toContain("undefined");
  });
});
