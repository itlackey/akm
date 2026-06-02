import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProposalAcceptResult, ProposalRejectResult } from "../src/commands/proposal";
import { classifyProposal, type DrainOptions, drainProposals, isEmptyDiff } from "../src/commands/proposal-drain";
import { CONSERVATIVE, MANUAL, PERSONAL_STASH, resolveDrainPolicy } from "../src/commands/proposal-drain-policies";
import type { EventsContext } from "../src/core/events";
import { createProposal, isProposalSkipped, listProposals, type Proposal } from "../src/core/proposals";

// ── Test setup ────────────────────────────────────────────────────────────
//
// These tests are FS-bound (they seed real proposal files via createProposal
// and read them back via listProposals) but DO NOT mutate process.env — the
// stash dir is passed explicitly and events are routed to a per-test temp DB,
// so no sandbox/env helper is required and the isolation lint stays satisfied.

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-drain-stash-");
  for (const dir of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

function eventsCtx(): EventsContext {
  return { dbPath: path.join(makeTempDir("akm-drain-db-"), "state.db") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repos.\n`;
const EMPTY_LESSON = `---\ndescription: Empty body lesson\nwhen_to_use: never\n---\n\n`;
// A valid lesson whose body exceeds the personal-stash consolidate band (>200 lines).
const BIG_LESSON = `---\ndescription: A large consolidated lesson\nwhen_to_use: When the body is intentionally long\n---\n\n${Array.from(
  { length: 300 },
  (_, i) => `line ${i}`,
).join("\n")}\n`;

function seed(stash: string, ref: string, source: string, content: string): Proposal {
  // The consolidate source requires a non-empty frontmatter.description at
  // createProposal time, so always pass a parsed frontmatter for seeded fixtures.
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

// ── Policy presets ──────────────────────────────────────────────────────────

describe("resolveDrainPolicy", () => {
  test("resolves built-in presets by name", () => {
    expect(resolveDrainPolicy("personal-stash")).toBe(PERSONAL_STASH);
    expect(resolveDrainPolicy("conservative")).toBe(CONSERVATIVE);
    expect(resolveDrainPolicy("manual")).toBe(MANUAL);
  });

  test("defaults to personal-stash when undefined", () => {
    expect(resolveDrainPolicy(undefined)).toBe(PERSONAL_STASH);
  });

  test("throws on unknown preset that is not a file", () => {
    expect(() => resolveDrainPolicy("does-not-exist")).toThrow(/Unknown policy/);
  });

  test("loads and validates a custom policy file", () => {
    const dir = makeTempDir("akm-drain-policy-");
    const file = path.join(dir, "policy.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ name: "custom", accept: [{ generator: "extract" }], rejectEmpty: true, defer: [] }),
    );
    const policy = resolveDrainPolicy(file);
    expect(policy.name).toBe("custom");
    expect(policy.accept).toEqual([{ generator: "extract" }]);
  });

  test("rejects a custom policy file that fails schema validation", () => {
    const dir = makeTempDir("akm-drain-policy-bad-");
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ name: "x", accept: "nope", rejectEmpty: true, defer: [] }));
    expect(() => resolveDrainPolicy(file)).toThrow(/Invalid policy file/);
  });
});

// ── classifyProposal (pure) ───────────────────────────────────────────────

describe("classifyProposal", () => {
  test("extract with real content → accept", () => {
    const p = { source: "extract", payload: { content: VALID_LESSON } } as Proposal;
    expect(classifyProposal(p, PERSONAL_STASH)?.verdict).toBe("accept");
  });

  test("empty diff → reject", () => {
    const p = { source: "extract", payload: { content: EMPTY_LESSON } } as Proposal;
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision?.verdict).toBe("reject");
  });

  test("mid-band consolidate (in defer list, no accept match) → defer", () => {
    // A consolidate proposal that exceeds the accept band's maxDiffLines defers.
    const big = `---\nd: x\n---\n${Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const p = { source: "consolidate", payload: { content: big } } as Proposal;
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision?.verdict).toBe("defer");
  });

  test("unmatched generator → null (left pending)", () => {
    const p = { source: "propose", payload: { content: VALID_LESSON } } as Proposal;
    expect(classifyProposal(p, PERSONAL_STASH)).toBeNull();
  });

  test("global maxDiffLines defers an otherwise-acceptable extract", () => {
    const p = { source: "extract", payload: { content: VALID_LESSON } } as Proposal;
    expect(classifyProposal(p, PERSONAL_STASH, 2)?.verdict).toBe("defer");
  });
});

describe("isEmptyDiff", () => {
  test("frontmatter-only content is empty", () => {
    expect(isEmptyDiff({ payload: { content: EMPTY_LESSON } } as Proposal)).toBe(true);
  });
  test("content with a body is not empty", () => {
    expect(isEmptyDiff({ payload: { content: VALID_LESSON } } as Proposal)).toBe(false);
  });
});

// ── drainProposals (engine) ─────────────────────────────────────────────────

describe("drainProposals — policy matching", () => {
  test("extract→accept, empty→reject, consolidate mid-band→defer", async () => {
    const stash = makeStashDir();
    const accepted = seed(stash, "lesson:good", "extract", VALID_LESSON);
    const empty = seed(stash, "lesson:empty", "extract", EMPTY_LESSON);
    const deferred = seed(stash, "lesson:big", "consolidate", BIG_LESSON);

    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();
    const result = await drainProposals(baseOpts(stash), promoteFn, rejectFn);

    expect(result.promoted).toEqual([accepted.id]);
    expect(result.rejected).toEqual([empty.id]);
    expect(result.deferred.map((d) => d.id)).toEqual([deferred.id]);
    expect(promoteFn).toHaveBeenCalledTimes(1);
    expect(rejectFn).toHaveBeenCalledTimes(1);
  });
});

describe("drainProposals — excludeIds", () => {
  test("fresh ids are filtered out (decision #2)", async () => {
    const stash = makeStashDir();
    const fresh = seed(stash, "lesson:fresh", "extract", VALID_LESSON);
    const old = seed(stash, "lesson:old", "extract", VALID_LESSON);

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash, { excludeIds: new Set([fresh.id]) }), promoteFn, fakeReject());

    expect(result.promoted).toEqual([old.id]);
    expect(result.promoted).not.toContain(fresh.id);
  });
});

describe("drainProposals — maxAccepts ceiling", () => {
  test("ceiling stops promotion and reports skippedByCap", async () => {
    const stash = makeStashDir();
    seed(stash, "lesson:a", "extract", VALID_LESSON);
    seed(stash, "lesson:b", "extract", VALID_LESSON);
    seed(stash, "lesson:c", "extract", VALID_LESSON);

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash, { maxAccepts: 1 }), promoteFn, fakeReject());

    expect(result.promoted).toHaveLength(1);
    expect(result.skippedByCap).toHaveLength(2);
    expect(promoteFn).toHaveBeenCalledTimes(1);
  });
});

describe("drainProposals — applyMode queue", () => {
  test("queue mode never calls promoteFn but still rejects empties", async () => {
    const stash = makeStashDir();
    seed(stash, "lesson:a", "extract", VALID_LESSON);
    const empty = seed(stash, "lesson:empty", "extract", EMPTY_LESSON);

    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();
    const result = await drainProposals(baseOpts(stash, { applyMode: "queue" }), promoteFn, rejectFn);

    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.promoted).toEqual([]);
    expect(result.rejected).toEqual([empty.id]);
    expect(rejectFn).toHaveBeenCalledTimes(1);
  });
});

describe("drainProposals — maxDiffLines", () => {
  test("defers large proposals instead of promoting", async () => {
    const stash = makeStashDir();
    const small = seed(stash, "lesson:small", "extract", VALID_LESSON);
    const large = seed(stash, "lesson:large", "extract", BIG_LESSON);

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash, { maxDiffLines: 10 }), promoteFn, fakeReject());

    expect(result.promoted).toEqual([small.id]);
    expect(result.deferred.map((d) => d.id)).toContain(large.id);
  });
});

describe("drainProposals — dry-run", () => {
  test("performs zero writes (promote/reject never called)", async () => {
    const stash = makeStashDir();
    const accepted = seed(stash, "lesson:good", "extract", VALID_LESSON);
    const empty = seed(stash, "lesson:empty", "extract", EMPTY_LESSON);

    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();
    const result = await drainProposals(baseOpts(stash, { dryRun: true }), promoteFn, rejectFn);

    expect(promoteFn).not.toHaveBeenCalled();
    expect(rejectFn).not.toHaveBeenCalled();
    // dry-run still REPORTS what it would do
    expect(result.promoted).toEqual([accepted.id]);
    expect(result.rejected).toEqual([empty.id]);

    // and the queue is untouched on disk
    const stillPending = listProposals(stash, { status: "pending" });
    expect(stillPending.map((p) => p.id).sort()).toEqual([accepted.id, empty.id].sort());
  });
});
