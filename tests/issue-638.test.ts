// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RED tests for #638 — per-asset accept cooldown at the drain boundary.
 *
 * All tests are UNIT-tier: no Bun.spawn, no Bun.serve, no 60s timeouts.
 *
 * Each test is written to FAIL for a semantic implementation reason:
 *   1. `recordLastAcceptedAt` / `getLastAcceptedAt` are not exported from
 *      state-db.ts yet → tests that import them fail at the module level.
 *   2. `classifyProposal` does not accept a `cooldown` 4th argument → tests
 *      that pass one fail because the cooldown is silently ignored (the normal
 *      accept verdict returns rather than "defer").
 *   3. `DrainOptions` does not have a `cooldown` key → drainProposals tests
 *      fail because the engine never persists or consults the cooldown.
 *
 * None of these are typo errors — every identifier is correct per the design
 * in #638. The tests will turn GREEN once the implementation lands.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyProposal, type DrainOptions, drainProposals } from "../src/commands/proposal/drain";
import { PERSONAL_STASH } from "../src/commands/proposal/drain-policies";
import type { ProposalAcceptResult, ProposalRejectResult } from "../src/commands/proposal/proposal";
import {
  createProposal,
  isProposalSkipped,
  listProposals,
  type Proposal,
} from "../src/commands/proposal/validators/proposals";
import type { EventsContext } from "../src/core/events";
import { openStateDatabase } from "../src/core/state-db";

// ── Test infrastructure ────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-638-stash-");
  for (const sub of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

function makeStateDb(dir?: string): ReturnType<typeof openStateDatabase> {
  const base = dir ?? makeTempDir("akm-638-db-");
  return openStateDatabase(path.join(base, "state.db"));
}

function eventsCtx(): EventsContext {
  return { dbPath: path.join(makeTempDir("akm-638-evtdb-"), "state.db") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep when scanning large code repos.\n`;

function seed(stash: string, ref: string, source: string, content: string, eligibilitySource?: string): Proposal {
  const input: Parameters<typeof createProposal>[1] = {
    ref,
    source,
    force: true,
    sourceRun: "run-638",
    payload: { content, frontmatter: { description: `${ref} fixture` } },
    ...(eligibilitySource !== undefined
      ? { eligibilitySource: eligibilitySource as Proposal["eligibilitySource"] }
      : {}),
  };
  const result = createProposal(stash, input);
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

// ── Minimal CooldownOptions shape expected by the implementation ────────────
//
// The implementation will add `cooldown?: CooldownOptions` to DrainOptions and
// a 4th optional parameter to `classifyProposal`. These types are defined here
// in the test file so the tests can compile and fail at runtime rather than at
// the TypeScript layer.

interface CooldownOptions {
  stashDir: string;
  db: ReturnType<typeof openStateDatabase>;
  /** Cooldown window in ms for proactive-origin proposals (longer). */
  proactiveCooldownMs: number;
  /** Cooldown window in ms for user-initiated-origin proposals (shorter). */
  userCooldownMs: number;
}

// ── state-db: getLastAcceptedAt / recordLastAcceptedAt ─────────────────────
//
// These helpers are dynamically imported so the failure stays per-test rather
// than collapsing into a single module-level import error. Each test asserts
// the export exists and behaves correctly; they FAIL until #638 adds the
// migration and the helper functions.

describe("state-db: recordLastAcceptedAt + getLastAcceptedAt (#638)", () => {
  test("exports recordLastAcceptedAt and getLastAcceptedAt from state-db", async () => {
    // If the functions do not exist, this destructuring throws → RED.
    const mod = await import("../src/core/state-db");
    expect(typeof (mod as Record<string, unknown>).recordLastAcceptedAt).toBe("function");
    expect(typeof (mod as Record<string, unknown>).getLastAcceptedAt).toBe("function");
  });

  test("roundtrip: recorded timestamp is returned for (stashDir, ref)", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;
    const getLastAcceptedAt = (mod as Record<string, unknown>).getLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
    ) => number | null | undefined;

    const db = makeStateDb();
    const stash = "/tmp/fake-stash";
    const ref = "lesson:alpha";
    const ts = new Date("2026-06-20T10:00:00.000Z").getTime();

    recordLastAcceptedAt(db, stash, ref, ts);
    const retrieved = getLastAcceptedAt(db, stash, ref);
    expect(retrieved).toBe(ts);
  });

  test("returns undefined/null for a ref that has never been accepted", async () => {
    const mod = await import("../src/core/state-db");
    const getLastAcceptedAt = (mod as Record<string, unknown>).getLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
    ) => number | null | undefined;

    const db = makeStateDb();
    const result = getLastAcceptedAt(db, "/tmp/fake-stash", "lesson:never-accepted");
    expect(result == null).toBe(true);
  });

  test("scoped to (stashDir, ref): different stash returns independent result", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;
    const getLastAcceptedAt = (mod as Record<string, unknown>).getLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
    ) => number | null | undefined;

    const db = makeStateDb();
    const ts = Date.now();
    recordLastAcceptedAt(db, "/tmp/stash-a", "lesson:alpha", ts);

    // Same ref, different stash — must not return the other stash's timestamp.
    const result = getLastAcceptedAt(db, "/tmp/stash-b", "lesson:alpha");
    expect(result == null).toBe(true);
  });

  test("upsert semantics: recording again updates the timestamp", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;
    const getLastAcceptedAt = (mod as Record<string, unknown>).getLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
    ) => number | null | undefined;

    const db = makeStateDb();
    const stash = "/tmp/fake-stash";
    const ref = "lesson:beta";
    const ts1 = new Date("2026-06-20T10:00:00.000Z").getTime();
    const ts2 = new Date("2026-06-20T11:00:00.000Z").getTime();

    recordLastAcceptedAt(db, stash, ref, ts1);
    recordLastAcceptedAt(db, stash, ref, ts2);

    const result = getLastAcceptedAt(db, stash, ref);
    expect(result).toBe(ts2);
  });

  test("persists across two openStateDatabase calls (durable across concurrent runs)", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;
    const getLastAcceptedAt = (mod as Record<string, unknown>).getLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
    ) => number | null | undefined;

    const dbDir = makeTempDir("akm-638-persist-");
    const dbPath = path.join(dbDir, "state.db");
    const stash = "/tmp/fake-stash-persist";
    const ref = "lesson:gamma";
    const ts = new Date("2026-06-20T12:00:00.000Z").getTime();

    // Open, write, close (simulating "process A").
    {
      const db1 = openStateDatabase(dbPath);
      recordLastAcceptedAt(db1, stash, ref, ts);
      db1.close();
    }

    // Re-open and read (simulating "process B").
    const db2 = openStateDatabase(dbPath);
    const result = getLastAcceptedAt(db2, stash, ref);
    db2.close();

    expect(result).toBe(ts);
  });
});

// ── classifyProposal cooldown guard ─────────────────────────────────────────
//
// classifyProposal will gain an optional 4th parameter `cooldown: CooldownOptions`.
// When the last-accepted-at for the proposal's ref is within the cooldown
// window it returns { verdict: "defer", reason: "cooldown-active", ... }.
//
// Until the implementation lands, classifyProposal ignores the 4th arg and
// returns { verdict: "accept" } for all valid reflect proposals — so every
// test that expects "defer" will FAIL semantically.

describe("classifyProposal: cooldown DEFER when ref was recently accepted (#638)", () => {
  test("reflect proposal for ref accepted 5 min ago is DEFERRED (proactive window = 30 min)", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;

    const db = makeStateDb();
    const stash = makeStashDir();
    const ref = "lesson:hot";
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;

    recordLastAcceptedAt(db, stash, ref, fiveMinAgo);

    const proposal = {
      ref,
      source: "reflect",
      payload: { content: VALID_LESSON },
    } as Proposal;

    const cooldown: CooldownOptions = {
      stashDir: stash,
      db,
      proactiveCooldownMs: 30 * 60 * 1000,
      userCooldownMs: 5 * 60 * 1000,
    };

    // classifyProposal 4th param does not exist yet — ignored, returns "accept".
    // This test FAILS because we expect "defer".
    const decision = (
      classifyProposal as (
        p: Proposal,
        policy: typeof PERSONAL_STASH,
        maxDiff?: number,
        cooldown?: CooldownOptions,
      ) => ReturnType<typeof classifyProposal>
    )(proposal, PERSONAL_STASH, undefined, cooldown);

    expect(decision?.verdict).toBe("defer");
    expect(decision?.gate.reason).toBe("cooldown-active");
  });

  test("reflect proposal for ref accepted OUTSIDE the window passes (aged-out)", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;

    const db = makeStateDb();
    const stash = makeStashDir();
    const ref = "lesson:aged";
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

    recordLastAcceptedAt(db, stash, ref, twoHoursAgo);

    const proposal = { ref, source: "reflect", payload: { content: VALID_LESSON } } as Proposal;
    const cooldown: CooldownOptions = {
      stashDir: stash,
      db,
      proactiveCooldownMs: 30 * 60 * 1000,
      userCooldownMs: 5 * 60 * 1000,
    };

    const decision = (
      classifyProposal as (
        p: Proposal,
        policy: typeof PERSONAL_STASH,
        maxDiff?: number,
        cooldown?: CooldownOptions,
      ) => ReturnType<typeof classifyProposal>
    )(proposal, PERSONAL_STASH, undefined, cooldown);

    // Aged-out → normal accept.
    // Once #638 is implemented this should pass; for now classifyProposal
    // already returns "accept" (ignoring cooldown), so this test passes even
    // in RED state — intentionally green to confirm the aged-out path works.
    expect(decision?.verdict).toBe("accept");
  });

  test("first accept (no prior record) always passes the cooldown guard", async () => {
    const db = makeStateDb();
    const stash = makeStashDir();
    const proposal = {
      ref: "lesson:brand-new",
      source: "reflect",
      payload: { content: VALID_LESSON },
    } as Proposal;

    const cooldown: CooldownOptions = {
      stashDir: stash,
      db,
      proactiveCooldownMs: 60 * 60 * 1000,
      userCooldownMs: 10 * 60 * 1000,
    };

    const decision = (
      classifyProposal as (
        p: Proposal,
        policy: typeof PERSONAL_STASH,
        maxDiff?: number,
        cooldown?: CooldownOptions,
      ) => ReturnType<typeof classifyProposal>
    )(proposal, PERSONAL_STASH, undefined, cooldown);

    // No prior record → must pass regardless of window.
    // This passes in RED state too (classifyProposal returns "accept") — a
    // permanent green that validates the first-accept contract.
    expect(decision?.verdict).toBe("accept");
  });

  test("user-origin window is shorter: proactive is deferred, user-scope is accepted", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;

    const db = makeStateDb();
    const stash = makeStashDir();
    const ref = "lesson:user-vs-proactive";
    const eightMinAgo = Date.now() - 8 * 60 * 1000;
    recordLastAcceptedAt(db, stash, ref, eightMinAgo);

    const proactiveProposal = {
      ref,
      source: "reflect",
      // No eligibilitySource → proactive / background lane → longer window.
      payload: { content: VALID_LESSON },
    } as Proposal;

    const userProposal = {
      ref,
      source: "reflect",
      eligibilitySource: "scope" as const, // user-initiated → shorter window.
      payload: { content: VALID_LESSON },
    } as Proposal;

    const cooldown: CooldownOptions = {
      stashDir: stash,
      db,
      proactiveCooldownMs: 30 * 60 * 1000, // 30 min: 8 min < 30 → still in cooldown
      userCooldownMs: 5 * 60 * 1000, // 5 min:  8 min > 5  → aged out for user
    };

    const classify = classifyProposal as (
      p: Proposal,
      policy: typeof PERSONAL_STASH,
      maxDiff?: number,
      cooldown?: CooldownOptions,
    ) => ReturnType<typeof classifyProposal>;

    const proactiveDecision = classify(proactiveProposal, PERSONAL_STASH, undefined, cooldown);
    const userDecision = classify(userProposal, PERSONAL_STASH, undefined, cooldown);

    // Proactive: within its longer window → DEFERRED (fails in RED state).
    expect(proactiveDecision?.verdict).toBe("defer");
    expect(proactiveDecision?.gate.reason).toBe("cooldown-active");
    // User: past its shorter window → accepted.
    expect(userDecision?.verdict).toBe("accept");
  });

  test("escalation/contradiction/homeostatic origin bypasses the cooldown", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;

    const db = makeStateDb();
    const stash = makeStashDir();
    const ref = "lesson:escalation";
    // Accepted 1 min ago — within any reasonable window.
    recordLastAcceptedAt(db, stash, ref, Date.now() - 60 * 1000);

    const proposal = {
      ref,
      source: "reflect",
      // signal-delta = contradiction / escalation lane → must bypass cooldown.
      eligibilitySource: "signal-delta" as const,
      payload: { content: VALID_LESSON },
    } as Proposal;

    const cooldown: CooldownOptions = {
      stashDir: stash,
      db,
      proactiveCooldownMs: 60 * 60 * 1000,
      userCooldownMs: 30 * 60 * 1000,
    };

    const decision = (
      classifyProposal as (
        p: Proposal,
        policy: typeof PERSONAL_STASH,
        maxDiff?: number,
        cooldown?: CooldownOptions,
      ) => ReturnType<typeof classifyProposal>
    )(proposal, PERSONAL_STASH, undefined, cooldown);

    // Escalation bypass → must NOT be deferred. Passes in RED state only because
    // classifyProposal currently ignores the cooldown entirely and returns "accept".
    // After #638 this must actively bypass even when a recent record exists.
    expect(decision?.verdict).toBe("accept");
    expect(decision?.gate.reason).not.toBe("cooldown-active");
  });

  test("default 0 / disabled cooldown (default-preserving): no deferral applied", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;

    const db = makeStateDb();
    const stash = makeStashDir();
    const ref = "lesson:no-cooldown";
    recordLastAcceptedAt(db, stash, ref, Date.now() - 60 * 1000); // 1 min ago

    const proposal = { ref, source: "reflect", payload: { content: VALID_LESSON } } as Proposal;

    const cooldown: CooldownOptions = {
      stashDir: stash,
      db,
      proactiveCooldownMs: 0, // DEFAULT = disabled
      userCooldownMs: 0,
    };

    const decision = (
      classifyProposal as (
        p: Proposal,
        policy: typeof PERSONAL_STASH,
        maxDiff?: number,
        cooldown?: CooldownOptions,
      ) => ReturnType<typeof classifyProposal>
    )(proposal, PERSONAL_STASH, undefined, cooldown);

    // Window = 0 → disabled → normal accept path runs.
    expect(decision?.verdict).toBe("accept");
    expect(decision?.gate?.reason).not.toBe("cooldown-active");
  });

  test("WITHOUT cooldown arg: behavior is byte-identical to pre-#638 (default-preserving guard)", () => {
    // Calling classifyProposal without the 4th arg must return the same result
    // as before. This is a permanent green regression guard.
    const proposal = {
      ref: "lesson:any",
      source: "reflect",
      payload: { content: VALID_LESSON },
    } as Proposal;

    const decision = classifyProposal(proposal, PERSONAL_STASH);
    expect(decision?.verdict).toBe("accept");
  });
});

// ── drainProposals integration: cooldown in engine ─────────────────────────
//
// drainProposals will gain an optional `cooldown` key in DrainOptions.
// Until the implementation lands, the engine never defers on cooldown,
// so the "2nd within window → deferred" assertion FAILS semantically.

describe("drainProposals: second accept within window is DEFERRED (not accepted) (#638)", () => {
  test("same ref, two proposals, second drain within window → 2nd is deferred (stays pending)", async () => {
    const stash = makeStashDir();
    const dbDir = makeTempDir("akm-638-engine-db-");
    const dbPath = path.join(dbDir, "state.db");
    const ref = "lesson:repeat";

    // First proposal: seed and drain — should be accepted.
    const p1 = seed(stash, ref, "reflect", VALID_LESSON);
    const promoteFn1 = fakeAccept();

    // Cast through unknown to inject the new `cooldown` key which DrainOptions
    // does not have yet — the engine will ignore it in RED state.
    const opts1 = baseOpts(stash, {
      cooldown: {
        dbPath,
        proactiveCooldownMs: 30 * 60 * 1000,
        userCooldownMs: 5 * 60 * 1000,
      },
    } as unknown as Partial<DrainOptions>);

    const result1 = await drainProposals(opts1, promoteFn1, fakeReject());
    expect(result1.promoted).toContain(p1.id);

    // Second proposal for the same ref — seeded immediately (within window).
    const p2 = seed(stash, ref, "reflect", VALID_LESSON);
    const promoteFn2 = fakeAccept();
    const opts2 = baseOpts(stash, {
      cooldown: {
        dbPath,
        proactiveCooldownMs: 30 * 60 * 1000,
        userCooldownMs: 5 * 60 * 1000,
      },
    } as unknown as Partial<DrainOptions>);

    const result2 = await drainProposals(opts2, promoteFn2, fakeReject());

    // Within the cooldown window → DEFERRED, not promoted.
    // FAILS in RED state: engine promotes p2 (cooldown not implemented).
    expect(result2.promoted).not.toContain(p2.id);
    expect(result2.deferred.map((d) => d.id)).toContain(p2.id);
    expect(promoteFn2).not.toHaveBeenCalled();

    // The deferred proposal must still be in the pending queue.
    const stillPending = listProposals(stash, { status: "pending" });
    expect(stillPending.map((p) => p.id)).toContain(p2.id);
  });

  test("cooldown persists across simulated concurrent runs (second process sees first's timestamp)", async () => {
    const mod = await import("../src/core/state-db");
    const recordLastAcceptedAt = (mod as Record<string, unknown>).recordLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
      ts: number,
    ) => void;
    const getLastAcceptedAt = (mod as Record<string, unknown>).getLastAcceptedAt as (
      db: ReturnType<typeof openStateDatabase>,
      stashDir: string,
      ref: string,
    ) => number | null | undefined;

    const dbDir = makeTempDir("akm-638-concurrent-");
    const dbPath = path.join(dbDir, "state.db");
    const stash = "/tmp/fake-stash-concurrent";
    const ref = "lesson:concurrent";
    const now = Date.now();

    // "Process A" records the accept.
    {
      const dbA = openStateDatabase(dbPath);
      recordLastAcceptedAt(dbA, stash, ref, now);
      dbA.close();
    }

    // "Process B" reads back the timestamp.
    const dbB = openStateDatabase(dbPath);
    const ts = getLastAcceptedAt(dbB, stash, ref);
    dbB.close();

    expect(ts).not.toBeNull();
    expect(ts).not.toBeUndefined();
    const elapsed = now - (ts as number);
    expect(elapsed).toBeLessThan(30 * 60 * 1000);
  });
});
