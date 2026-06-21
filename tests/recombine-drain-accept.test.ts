// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RED tests for Phase 2: recombine drain-accept path via requireType filter.
 *
 * Covers:
 *   (a) recombine type:lesson proposal within diff band → ACCEPTED by PERSONAL_STASH
 *   (b) recombine type:hypothesis proposal → NOT accepted (stays pending/defer)
 *   (c) existing extract/reflect/consolidate rules unchanged (requireType absent
 *       = match by generator as before — backward-compatible)
 *
 * These tests call classifyProposal and drainProposals directly so they are
 * pure unit tests with no subprocess spawning (UNIT-tier boundary satisfied).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyProposal, type DrainOptions, drainProposals } from "../src/commands/proposal/drain";
import { PERSONAL_STASH } from "../src/commands/proposal/drain-policies";
import type { ProposalAcceptResult, ProposalRejectResult } from "../src/commands/proposal/proposal";
import { createProposal, isProposalSkipped, type Proposal } from "../src/commands/proposal/validators/proposals";
import type { EventsContext } from "../src/core/events";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-recombine-drain-stash-");
  for (const dir of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

function eventsCtx(): EventsContext {
  return { dbPath: path.join(makeTempDir("akm-recombine-drain-db-"), "state.db") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixtures — recombine proposal content matching what recombine.ts produces.
// The `type` field lives in the YAML frontmatter of the content string;
// payload.frontmatter only carries `description`.
// ---------------------------------------------------------------------------

const LESSON_CONTENT = `---
type: lesson
description: Prefer rg over grep for large repos
when_to_use: Searching large codebases
source_refs:
  - memory:grep-usage
---

Use rg (ripgrep) instead of grep when scanning large repositories.
It is significantly faster and respects .gitignore by default.
`;

const HYPOTHESIS_CONTENT = `---
type: hypothesis
description: Prefer rg over grep for large repos
when_to_use: Searching large codebases
source_refs:
  - memory:grep-usage
---

Use rg (ripgrep) instead of grep when scanning large repositories.
It is significantly faster and respects .gitignore by default.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecombineProposal(content: string): Proposal {
  return {
    id: "test-id",
    ref: "lesson:grep-tip",
    status: "pending",
    source: "recombine",
    sourceRun: "run-x",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload: { content, frontmatter: { description: "Prefer rg over grep for large repos" } },
  };
}

function seedRecombine(stash: string, ref: string, content: string): Proposal {
  const result = createProposal(stash, {
    ref,
    source: "recombine",
    force: true,
    sourceRun: "run-x",
    payload: { content, frontmatter: { description: "recombine fixture" } },
  });
  if (isProposalSkipped(result)) throw new Error(`unexpected skip: ${result.message}`);
  return result;
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

// ---------------------------------------------------------------------------
// (a) recombine type:lesson → ACCEPTED by PERSONAL_STASH
// ---------------------------------------------------------------------------

describe("classifyProposal — recombine type:lesson with requireType", () => {
  test("recombine type:lesson within diff band → accept", () => {
    // PERSONAL_STASH must have a recombine accept rule with requireType:"lesson".
    // Currently it does NOT have this rule, so this test will FAIL (red).
    const p = makeRecombineProposal(LESSON_CONTENT);
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision).not.toBeNull();
    expect(decision?.verdict).toBe("accept");
  });

  test("PERSONAL_STASH accept rules include a recombine entry with requireType:lesson", () => {
    // Structural check: the rule must exist in the policy.
    const recombineRule = PERSONAL_STASH.accept.find((r) => r.generator === "recombine");
    expect(recombineRule).toBeDefined();
    // requireType must be "lesson" (the gating field that Phase 2 adds).
    expect((recombineRule as { requireType?: string })?.requireType).toBe("lesson");
  });
});

describe("drainProposals — recombine type:lesson promoted via PERSONAL_STASH", () => {
  test("recombine type:lesson proposal within 200 lines is promoted", async () => {
    const stash = makeStashDir();
    const proposal = seedRecombine(stash, "lesson:grep-tip", LESSON_CONTENT);

    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();
    const result = await drainProposals(baseOpts(stash), promoteFn, rejectFn);

    expect(result.promoted).toContain(proposal.id);
    expect(result.deferred.map((d) => d.id)).not.toContain(proposal.id);
    expect(promoteFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (b) recombine type:hypothesis → NOT accepted by PERSONAL_STASH rule
// ---------------------------------------------------------------------------

describe("classifyProposal — recombine type:hypothesis not matched by requireType rule", () => {
  test("recombine type:hypothesis → null (left pending, no rule matches)", () => {
    // The requireType:"lesson" rule should NOT match a hypothesis proposal.
    // No other rule matches recombine, so classifyProposal must return null.
    const p = makeRecombineProposal(HYPOTHESIS_CONTENT);
    const decision = classifyProposal(p, PERSONAL_STASH);
    // null = left pending untouched (the correct outcome for hypothesis proposals)
    expect(decision).toBeNull();
  });
});

describe("drainProposals — recombine type:hypothesis stays pending", () => {
  test("recombine type:hypothesis proposal is not promoted or rejected", async () => {
    const stash = makeStashDir();
    const proposal = seedRecombine(stash, "lesson:grep-tip-hyp", HYPOTHESIS_CONTENT);

    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();
    const result = await drainProposals(baseOpts(stash), promoteFn, rejectFn);

    expect(result.promoted).not.toContain(proposal.id);
    expect(result.rejected).not.toContain(proposal.id);
    // Must NOT appear in deferred either — it is simply left pending (null classify)
    expect(result.deferred.map((d) => d.id)).not.toContain(proposal.id);
    expect(promoteFn).not.toHaveBeenCalled();
    expect(rejectFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (c) backward-compatibility: rules without requireType match by generator only
// ---------------------------------------------------------------------------

describe("classifyProposal — requireType absent = match by generator (backward-compat)", () => {
  test("extract rule (no requireType) matches any extract proposal", () => {
    const p: Proposal = {
      id: "test-extract",
      ref: "lesson:extract-test",
      status: "pending",
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: LESSON_CONTENT },
    };
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision?.verdict).toBe("accept");
  });

  test("reflect rule (no requireType) matches any reflect proposal within band", () => {
    const smallContent = `---\ndescription: A small reflection\nwhen_to_use: always\n---\n\nSmall reflected insight.\n`;
    const p: Proposal = {
      id: "test-reflect",
      ref: "lesson:reflect-test",
      status: "pending",
      source: "reflect",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: smallContent },
    };
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision?.verdict).toBe("accept");
  });

  test("consolidate rule (no requireType) matches consolidate within band", () => {
    const smallContent = `---\ndescription: Small consolidation\nwhen_to_use: always\n---\n\nConsolidated insight.\n`;
    const p: Proposal = {
      id: "test-consolidate",
      ref: "lesson:consolidate-test",
      status: "pending",
      source: "consolidate",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: smallContent },
    };
    const decision = classifyProposal(p, PERSONAL_STASH);
    // Small consolidate (within 200 lines) → accept
    expect(decision?.verdict).toBe("accept");
  });

  test("extract rule without requireType does not require frontmatter type field", () => {
    // An extract proposal whose content has no `type:` frontmatter field must
    // still match (extract rule has no requireType — it matches unconditionally
    // by generator). This ensures requireType is opt-in and doesn't break old rules.
    const noTypeContent = `---\ndescription: No type field here\nwhen_to_use: always\n---\n\nContent with no type frontmatter field.\n`;
    const p: Proposal = {
      id: "test-extract-no-type",
      ref: "lesson:no-type-test",
      status: "pending",
      source: "extract",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: { content: noTypeContent },
    };
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision?.verdict).toBe("accept");
  });
});
