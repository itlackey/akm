// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Per-proposal gate-decision persistence + rendering (#577) — drain-scoped.
//
// The deterministic drain/triage engine must stamp WHY each proposal landed
// where it did (auto-accepted / deferred / auto-rejected, with reason +
// thresholds) onto the proposal row, and the `proposal show` / `list` surfaces
// must expose it. Legacy proposals carry no decision and must render cleanly
// as "unknown". Historical rows written by the deleted (0.9.0) improve
// confidence gate must keep rendering — the render fixtures below pin that.
//
// FS-bound (real createProposal/listProposals against the sandboxed state.db),
// no process.env mutation — the stash dir is passed explicitly and the preload
// sandbox owns HOME/XDG, so no extra env helper is required.

import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drainProposals } from "../../src/commands/proposal/drain";
import { PERSONAL_STASH } from "../../src/commands/proposal/drain-policies";
import type { ProposalAcceptResult, ProposalRejectResult } from "../../src/commands/proposal/proposal";
import {
  createProposal,
  getProposal,
  isProposalSkipped,
  type Proposal,
  recordGateDecision,
} from "../../src/commands/proposal/repository";
import { shapeProposalEntry } from "../../src/output/shapes/helpers";
import { formatProposalListPlain, formatProposalShowPlain } from "../../src/output/text/helpers";

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
    force: true,
    sourceRun: "run-x",
    payload: { content, frontmatter: { description: `${ref} fixture` } },
  });
  if (isProposalSkipped(result)) throw new Error(`unexpected skip: ${result.message}`);
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
      reason: "below-threshold",
      confidence: 0.72,
      thresholds: { autoAccept: 0.9 },
      gate: "improve:reflect",
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
      reason: "below-threshold",
      confidence: 0.72,
      thresholds: { autoAccept: 0.9 },
      gate: "improve:reflect",
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

  test("auto-accepted: deterministic accept stamps outcome=auto-accepted", async () => {
    const stash = makeStashDir();
    const p = seed(stash, "lessons/ok", "extract", VALID_LESSON);

    await drainProposals(
      { stashDir: stash, policy: PERSONAL_STASH, applyMode: "queue", maxAccepts: 25, dryRun: false },
      fakeAccept(),
      fakeReject(),
    );

    const decision = getProposal(stash, p.id).gateDecision;
    expect(decision?.outcome).toBe("auto-accepted");
    expect(decision?.gate).toBe("triage:personal-stash");
  });

  test("auto-rejected: empty diff stamps outcome=auto-rejected reason=empty-diff", async () => {
    const stash = makeStashDir();
    const p = seed(stash, "lessons/empty", "reflect", EMPTY_LESSON);

    await drainProposals(
      { stashDir: stash, policy: PERSONAL_STASH, applyMode: "queue", maxAccepts: 25, dryRun: false },
      fakeAccept(),
      fakeReject(),
    );

    const decision = getProposal(stash, p.id).gateDecision;
    expect(decision?.outcome).toBe("auto-rejected");
    expect(decision?.reason).toBe("empty-diff");
  });

  test("deferred (max-diff-lines): over-band consolidate carries the threshold", async () => {
    const stash = makeStashDir();
    const p = seed(stash, "lessons/big", "consolidate", BIG_CONSOLIDATE);

    await drainProposals(
      { stashDir: stash, policy: PERSONAL_STASH, applyMode: "queue", maxAccepts: 25, dryRun: false },
      fakeAccept(),
      fakeReject(),
    );

    const decision = getProposal(stash, p.id).gateDecision;
    expect(decision?.outcome).toBe("deferred");
    expect(decision?.reason).toBe("max-diff-lines");
    // 200 is the personal-stash consolidate band — reconstructable later.
    expect(decision?.thresholds?.maxDiffLines).toBe(200);
    // The measured line count is persisted alongside the bound so the full
    // "<measured> > 200" comparison stays reconstructable (#577 finding 4).
    expect(decision?.measured).toBeGreaterThan(200);
  });

  test("deferred (no-judge-configured): defer-list source with no runner", async () => {
    const stash = makeStashDir();
    const p = seed(stash, "lessons/dup", "distill", VALID_LESSON);

    await drainProposals(
      { stashDir: stash, policy: PERSONAL_STASH, applyMode: "queue", maxAccepts: 25, dryRun: false },
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
      { stashDir: stash, policy: PERSONAL_STASH, applyMode: "queue", maxAccepts: 25, dryRun: true },
      fakeAccept(),
      fakeReject(),
    );

    expect(getProposal(stash, p.id).gateDecision).toBeUndefined();
  });
});

// ── show / list expose the decision (and legacy renders cleanly) ────────────

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
      reason: "below-threshold",
      confidence: 0.72,
      thresholds: { autoAccept: 0.9 },
      gate: "improve:reflect",
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
  const legacy = {
    id: "uuid-legacy",
    ref: "lessons/old",
    status: "pending",
    source: "reflect",
    createdAt: "2026-06-11T00:00:00.000Z",
  };

  test("shapeProposalEntry projects confidence + gateDecision at normal/full detail", () => {
    const normal = shapeProposalEntry(withDecision, "normal");
    expect(normal.confidence).toBe(0.72);
    expect((normal.gateDecision as Record<string, unknown>).reason).toBe("below-threshold");

    const full = shapeProposalEntry(withDecision, "full");
    expect(full.gateDecision).toBeDefined();
  });

  test("formatProposalShowPlain renders decision + reason + reconstructable comparison", () => {
    const out = formatProposalShowPlain({ proposal: withDecision });
    expect(out).toContain("gate.decision: deferred");
    expect(out).toContain("gate.reason: below-threshold");
    expect(out).toContain("0.72 < 0.90");
    expect(out).toContain("gate.by: improve:reflect");
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

  test("formatProposalShowPlain renders 'unknown' for a legacy proposal with no decision", () => {
    const out = formatProposalShowPlain({ proposal: legacy });
    expect(out).toContain("gate.decision: unknown");
    // Must not throw or emit a malformed line.
    expect(out).not.toContain("undefined");
  });

  test("formatProposalListPlain surfaces the decision inline and omits it for legacy rows", () => {
    const out = formatProposalListPlain({ totalCount: 2, proposals: [withDecision, legacy] });
    expect(out).toContain("gate=deferred:below-threshold (0.72 < 0.90)");
    // Legacy row renders with no gate suffix and no stray text.
    const legacyLine = out.split("\n").find((l) => l.includes("uuid-legacy")) ?? "";
    expect(legacyLine).not.toContain("gate=");
    expect(legacyLine).not.toContain("undefined");
  });
});
