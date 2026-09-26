import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageJudgedProposal } from "../../../src/commands/improve/stage";
import {
  buildJudgmentPrompt,
  type DrainOptions,
  drainProposals,
  isEmptyDiff,
  type JudgmentSeams,
} from "../../../src/commands/proposal/drain";
import type { ProposalAcceptResult, ProposalRejectResult } from "../../../src/commands/proposal/proposal";
import {
  createProposal,
  getProposal,
  listProposals,
  type Proposal,
  recordGateDecision,
} from "../../../src/commands/proposal/repository";
import { writeSalienceToFrontmatter } from "../../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import type { EventsContext } from "../../../src/core/events";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import type { AgentRunResult } from "../../../src/integrations/agent";
import type { RunnerSpec } from "../../../src/integrations/agent/runner";
import { getImproveLedgerRow } from "../../../src/storage/repositories/improve-ledger-repository";
import { makeConfig } from "../../_helpers/factories";
import { mutateScopedEnv, withEnv } from "../../_helpers/sandbox";

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

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = "directory";
        visit(fullPath);
      } else {
        snapshot[relativePath] = createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
      }
    }
  };
  visit(root);
  return snapshot;
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
const EMPTY_LESSON = `---\ndescription: A lesson with an intentionally empty body\nwhen_to_use: Testing empty-diff proposal handling\n---\n\n`;
// A valid, unjudged lesson with a long body — left for judgment.
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
    sourceRun: "run-x",
    target: { source: "stash", root: stash },
    payload: { content, frontmatter: { description: `${ref} fixture` } },
  });
  return result;
}

/** Seed a proposal whose quality judge passed on its content (a `staged` stamp). */
function seedJudged(stash: string, ref: string, source: string, content: string): Proposal {
  return stageJudgedProposal(stash, seed(stash, ref, source, content));
}

function ledgerRow(stash: string, ref: string, source: string) {
  const db = openStateDatabase();
  try {
    return getImproveLedgerRow(db, stash, ref, source);
  } finally {
    db.close();
  }
}

function proposalFixture(source: string, content: string): Proposal {
  return {
    source,
    payload: { content },
    changes: [{ path: "lessons/fixture.md", op: "create", after: content }],
  } as Proposal;
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

describe("isEmptyDiff", () => {
  test("frontmatter-only content is empty", () => {
    expect(isEmptyDiff(proposalFixture("extract", EMPTY_LESSON))).toBe(true);
  });
  test("content with a body is not empty", () => {
    expect(isEmptyDiff(proposalFixture("extract", VALID_LESSON))).toBe(false);
  });
});

// ── drainProposals (engine) ─────────────────────────────────────────────────

describe("drainProposals — the one rule", () => {
  test("judge-passed→accept, empty→reject, unjudged→left for judgment", async () => {
    const stash = makeStashDir();
    const accepted = seedJudged(stash, "lessons/good", "extract", VALID_LESSON);
    const empty = seed(stash, "lessons/empty", "extract", EMPTY_LESSON);
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();
    const result = await drainProposals(baseOpts(stash), promoteFn, rejectFn);

    expect(result.promoted).toEqual([accepted.id]);
    expect(result.rejected).toEqual([empty.id]);
    expect(result.deferred.map((d) => d.id)).toEqual([deferred.id]);
    expect(result.deferred).toEqual([{ id: deferred.id, reason: "needs-judgment" }]);
    expect(promoteFn).toHaveBeenCalledTimes(1);
    expect(rejectFn).toHaveBeenCalledTimes(1);
    expect(promoteFn).toHaveBeenCalledWith(
      expect.objectContaining({ gateDecision: { outcome: "auto-accepted", reason: "judge-passed", gate: "triage" } }),
    );
  });

  test("an edit after judging sends the proposal back for judgment", async () => {
    const stash = makeStashDir();
    const judged = seedJudged(stash, "lessons/edited", "extract", VALID_LESSON);
    const db = openStateDatabase();
    try {
      db.prepare("UPDATE proposals SET content = content || ? WHERE id = ?").run("\nedited", judged.id);
    } finally {
      db.close();
    }

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash), promoteFn, fakeReject());

    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.deferred.map((d) => d.id)).toEqual([judged.id]);
  });
});

describe("drainProposals — excludeIds", () => {
  test("fresh ids are filtered out (decision #2)", async () => {
    const stash = makeStashDir();
    const fresh = seedJudged(stash, "lessons/fresh", "extract", VALID_LESSON);
    const old = seedJudged(stash, "lessons/old", "extract", VALID_LESSON);

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash, { excludeIds: new Set([fresh.id]) }), promoteFn, fakeReject());

    expect(result.promoted).toEqual([old.id]);
    expect(result.promoted).not.toContain(fresh.id);
  });
});

describe("drainProposals — maxAccepts ceiling", () => {
  test("ceiling stops promotion and reports skippedByCap", async () => {
    const stash = makeStashDir();
    seedJudged(stash, "lessons/a", "extract", VALID_LESSON);
    seedJudged(stash, "lessons/b", "extract", VALID_LESSON);
    seedJudged(stash, "lessons/c", "extract", VALID_LESSON);

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash, { maxAccepts: 1 }), promoteFn, fakeReject());

    expect(result.promoted).toHaveLength(1);
    expect(result.skippedByCap).toHaveLength(2);
    expect(promoteFn).toHaveBeenCalledTimes(1);
  });

  test("deterministic promotion receives the frozen target and config", async () => {
    const stash = makeStashDir();
    seedJudged(stash, "lessons/a", "extract", VALID_LESSON);
    const config = { semanticSearchMode: "off" } as AkmConfig;
    const promoteFn = fakeAccept();

    await drainProposals(baseOpts(stash, { target: "team", config }), promoteFn, fakeReject());

    expect(promoteFn).toHaveBeenCalledWith(expect.objectContaining({ target: "team", config }));
  });
});

describe("drainProposals — maxAccepts bounds judgment-tier promotions (FIX 1)", () => {
  test("total promotions (deterministic + judgment) never exceed maxAccepts", async () => {
    const stash = makeStashDir();
    // 1 deterministic accept (extract) + 2 deferred consolidate items the judge
    // will accept. maxAccepts=1 → the deterministic accept consumes the whole
    // budget, so BOTH judged-accepts must be skipped by the cap.
    const det = seedJudged(stash, "lessons/det", "extract", VALID_LESSON);
    const big1 = seed(stash, "lessons/big1", "consolidate", BIG_LESSON);
    const big2 = seed(stash, "lessons/big2", "consolidate", BIG_LESSON);

    const chat = mock(async () => JSON.stringify({ decision: "accept", reason: "ok" }));
    const promoteFn = fakeAccept();

    const result = await drainProposals(
      baseOpts(stash, { maxAccepts: 1, judgment: FAKE_LLM_RUNNER }),
      promoteFn,
      fakeReject(),
      { chat },
    );

    // Only the deterministic accept was promoted; the cap bounds the total.
    expect(result.promoted).toEqual([det.id]);
    expect(promoteFn).toHaveBeenCalledTimes(1);
    // Both judged-accept items dropped by the shared cap.
    expect(result.skippedByCap.sort()).toEqual([big1.id, big2.id].sort());
    expect(result.deferred).toEqual([]);
  });

  test("judgment promotions consume the remaining budget after deterministic ones", async () => {
    const stash = makeStashDir();
    // 1 deterministic accept + 2 judged-accepts, maxAccepts=2 → deterministic
    // promotes 1, judgment may promote 1 more, the 2nd judged-accept is capped.
    const det = seedJudged(stash, "lessons/det", "extract", VALID_LESSON);
    seed(stash, "lessons/big1", "consolidate", BIG_LESSON);
    seed(stash, "lessons/big2", "consolidate", BIG_LESSON);

    const chat = mock(async () => JSON.stringify({ decision: "accept", reason: "ok" }));
    const promoteFn = fakeAccept();

    const result = await drainProposals(
      baseOpts(stash, { maxAccepts: 2, judgment: FAKE_LLM_RUNNER }),
      promoteFn,
      fakeReject(),
      { chat },
    );

    expect(result.promoted).toContain(det.id);
    expect(result.promoted).toHaveLength(2);
    expect(result.skippedByCap).toHaveLength(1);
    expect(promoteFn).toHaveBeenCalledTimes(2);
  });
});

describe("drainProposals — applyMode queue", () => {
  test("queue mode never calls promoteFn but still rejects empties", async () => {
    const stash = makeStashDir();
    seedJudged(stash, "lessons/a", "extract", VALID_LESSON);
    const empty = seed(stash, "lessons/empty", "extract", EMPTY_LESSON);

    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();
    const result = await drainProposals(baseOpts(stash, { applyMode: "queue" }), promoteFn, rejectFn);

    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.promoted).toEqual([]);
    expect(result.rejected).toEqual([empty.id]);
    expect(rejectFn).toHaveBeenCalledTimes(1);
  });
});

describe("drainProposals — dry-run", () => {
  test("performs zero writes (promote/reject never called)", async () => {
    const stash = makeStashDir();
    const accepted = seedJudged(stash, "lessons/good", "extract", VALID_LESSON);
    const empty = seed(stash, "lessons/empty", "extract", EMPTY_LESSON);

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

  test("reports a candidate the real preflight only flags advisorily as promotable", async () => {
    const stash = makeStashDir();
    const advisoryOnly = seedJudged(
      stash,
      "lessons/preflight-advisory",
      "extract",
      "---\ndescription: Proposal lint:blocks invalid output.\nwhen_to_use: Testing drain preflight\n---\n\nUseful body.\n",
    );

    const result = await drainProposals(
      baseOpts(stash, { dryRun: true, config: makeConfig(stash) }),
      fakeAccept(),
      fakeReject(),
    );

    expect(result.promoted).toEqual([advisoryOnly.id]);
    expect(getProposal(stash, advisoryOnly.id).status).toBe("pending");
  });
});

describe("drainProposals — failed reporting (#921)", () => {
  test("a promote failure lands in result.failed, not silently as failed:0", async () => {
    const stash = makeStashDir();
    const accepted = seedJudged(stash, "lessons/promote-boom", "extract", VALID_LESSON);
    const promoteFn = mock(async () => {
      throw new Error("simulated write failure");
    });

    const result = await drainProposals(baseOpts(stash), promoteFn, fakeReject());

    expect(result.promoted).toEqual([]);
    expect(result.failed).toEqual([{ id: accepted.id, reason: "promote-error", detail: "simulated write failure" }]);
  });

  test("a reject failure lands in result.failed", async () => {
    const stash = makeStashDir();
    const empty = seed(stash, "lessons/reject-boom", "extract", EMPTY_LESSON);
    const rejectFn = mock(() => {
      throw new Error("simulated reject failure");
    });

    const result = await drainProposals(baseOpts(stash), fakeAccept(), rejectFn);

    expect(result.rejected).toEqual([]);
    expect(result.failed).toEqual([{ id: empty.id, reason: "reject-error", detail: "simulated reject failure" }]);
  });

  test("a stale-target refusal is auto-rejected once, not left as a generic failure (STALE, R20)", async () => {
    const stash = makeStashDir();
    const accepted = seedJudged(stash, "lessons/promote-stale", "extract", VALID_LESSON);
    const promoteFn = mock(async () => {
      throw new Error(
        `Proposal target changed after proposal ${accepted.id} was created; refusing to overwrite newer content.`,
      );
    });
    const rejectFn = fakeReject();

    const result = await drainProposals(baseOpts(stash), promoteFn, rejectFn);

    // The stale-target category is not a merit rejection, so the drain
    // resolves it with a structured auto-reject instead of retrying forever
    // — it lands in `rejected`, not `failed`.
    expect(result.failed).toEqual([]);
    expect(result.rejected).toEqual([accepted.id]);
    expect(rejectFn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: accepted.id,
        gateDecision: { outcome: "auto-rejected", reason: "stale-target", gate: "triage" },
      }),
    );
  });

  test("dry-run predicts the same stale-target refusal a real promote hits, then auto-rejects (parity)", async () => {
    const stash = makeStashDir();
    const assetPath = path.join(stash, "lessons", "dry-run-stale.md");
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Prefer rg", "Original: prefer rg"), "utf8");
    const created = createProposal(stash, {
      ref: "lessons/dry-run-stale",
      source: "extract",
      sourceRun: "run-x",
      target: { source: "stash", root: stash },
      payload: { content: VALID_LESSON, frontmatter: { description: "dry-run-stale fixture" } },
    });
    stageJudgedProposal(stash, created);
    // The target changes again after the proposal is minted — the exact
    // condition both the dry-run preflight and the real promote must refuse.
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Prefer rg", "Newer: someone else edited this"), "utf8");

    const dryRunResult = await drainProposals(
      baseOpts(stash, { dryRun: true, config: makeConfig(stash) }),
      fakeAccept(),
      fakeReject(),
    );
    // Dry-run performs zero writes, but still predicts the same outcome as a
    // real run: the stale-target refusal is not a merit rejection, so it is
    // reported under `rejected`, not `failed`.
    expect(dryRunResult.promoted).toEqual([]);
    expect(dryRunResult.failed).toEqual([]);
    expect(dryRunResult.rejected).toEqual([created.id]);

    // The real run (no promote/reject seams — exercises the actual write
    // path) hits the exact same guard, then resolves it with the drain's
    // stale-target auto-reject (STALE, R20) instead of leaving it pending.
    const realResult = await drainProposals(baseOpts(stash, { config: makeConfig(stash) }));
    expect(realResult.promoted).toEqual([]);
    expect(realResult.failed).toEqual([]);
    expect(realResult.rejected).toEqual([created.id]);
    expect(fs.readFileSync(assetPath, "utf8")).toContain("Newer: someone else edited this");
    expect(getProposal(stash, created.id)).toMatchObject({
      status: "rejected",
      gateDecision: { outcome: "auto-rejected", reason: "stale-target" },
    });
  });

  test("a bookkeeping-only target rewrite stays normalized-fresh: dry-run predicts promotion, the real run promotes and keeps salience (STALE, R20)", async () => {
    const stash = makeStashDir();
    const assetPath = path.join(stash, "lessons", "bookkeeping-fresh.md");
    fs.writeFileSync(assetPath, VALID_LESSON, "utf8");
    const created = createProposal(stash, {
      ref: "lessons/bookkeeping-fresh",
      source: "extract",
      sourceRun: "run-x",
      target: { source: "stash", root: stash },
      payload: {
        content: VALID_LESSON.replace("Prefer rg", "Prefer rg (revised)"),
        frontmatter: { description: "bookkeeping-fresh fixture" },
      },
    });
    stageJudgedProposal(stash, created);

    // A same-run bookkeeping-only rewrite of the target after mint — the real
    // writer distill uses, not a hand-edited fixture. Changes the raw bytes
    // (a `salience` key is added) but not the normalized before-hash.
    const rewritten = writeSalienceToFrontmatter(VALID_LESSON, 0.8, {
      novelty: 0.7,
      magnitude: 0.6,
      predictionError: 0.5,
    });
    expect(rewritten).not.toBe(VALID_LESSON);
    fs.writeFileSync(assetPath, rewritten, "utf8");

    const dryRunResult = await drainProposals(
      baseOpts(stash, { dryRun: true, config: makeConfig(stash) }),
      fakeAccept(),
      fakeReject(),
    );
    expect(dryRunResult.promoted).toEqual([created.id]);
    expect(dryRunResult.failed).toEqual([]);

    // The real run (no promote/reject seams) hits the same normalized-fresh
    // guard and actually promotes, keeping the bookkeeping `salience` field
    // that was written after mint.
    const realResult = await drainProposals(baseOpts(stash, { config: makeConfig(stash) }));
    expect(realResult.promoted).toEqual([created.id]);
    expect(realResult.failed).toEqual([]);
    const finalContent = fs.readFileSync(assetPath, "utf8");
    expect(finalContent).toContain("salience:");
  });

  test("a stale-target auto-reject records `failed` in the improve ledger — no rejection window (STALE, R20)", async () => {
    const stash = makeStashDir();
    const assetPath = path.join(stash, "lessons", "reproposable.md");
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Prefer rg", "Original: prefer rg"), "utf8");
    const created = createProposal(stash, {
      ref: "lessons/reproposable",
      source: "extract",
      sourceRun: "run-x",
      target: { source: "stash", root: stash },
      payload: { content: VALID_LESSON, frontmatter: { description: "reproposable fixture" } },
    });
    stageJudgedProposal(stash, created);
    // A real content edit after mint — the drain's promote will hit the
    // stale-target guard and auto-reject.
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Prefer rg", "Newer: someone else edited this"), "utf8");

    const result = await drainProposals(baseOpts(stash, { config: makeConfig(stash) }));
    expect(result.rejected).toEqual([created.id]);

    // A stale-target rejection is procedural, not a judgement on the content:
    // the ref stays re-proposable against its current content at once.
    expect(ledgerRow(stash, "stash//lessons/reproposable", "extract")).toMatchObject({
      outcome: "failed",
      nextEligibleAt: null,
      proposalId: created.id,
    });
  });
});

// ── Judgment tier (Phase 3) ─────────────────────────────────────────────────
//
// The judgment tier adjudicates the items no quality judge has passed. We
// inject a fake runner that returns a verdict and assert the ENGINE performs
// the resulting accept / reject write (the runner only judges). Mirrors reflect's dual test seams: an `llm`-mode
// test injects a fake `chat`; an `agent`-mode test injects a fake `runAgentFn`.

/** A minimal `llm` RunnerSpec — the injected `chat` seam ignores the connection. */
const FAKE_LLM_RUNNER: RunnerSpec = {
  kind: "llm",
  engine: "fake-llm-judge",
  connection: {
    endpoint: "http://fake.invalid/v1/chat/completions",
    model: "provider/exact-fake-judge",
    temperature: 0.11,
    maxTokens: 77,
    contextLength: 8_192,
  },
};

/** A minimal `agent` RunnerSpec — the injected `runAgentFn` ignores the profile. */
const FAKE_AGENT_RUNNER: RunnerSpec = {
  kind: "agent",
  engine: "fake-agent-judge",
  timeoutMs: 1_234,
  profile: {
    name: "fake-judge",
    platform: "opencode",
    bin: "fake-judge",
    args: [],
    stdio: "captured",
    envPassthrough: [],
    parseOutput: "text",
    model: "provider/exact-agent-judge",
  },
};

function agentResult(stdout: string): AgentRunResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

describe("drainProposals — judgment tier (llm mode)", () => {
  test("an unused judgment credential is not materialized when every proposal is already judged", async () => {
    const stash = makeStashDir();
    const accepted = seedJudged(stash, "lessons/deterministic-only", "extract", VALID_LESSON);
    const runner: RunnerSpec = {
      ...FAKE_LLM_RUNNER,
      credential: { names: ["AKM_UNUSED_DRAIN_REQUIRED_KEY"], required: true },
    };
    const chat = mock(async () => {
      throw new Error("deterministic-only drain reached judgment provider");
    });

    const result = await withEnv({ AKM_UNUSED_DRAIN_REQUIRED_KEY: undefined }, () =>
      drainProposals(baseOpts(stash, { judgment: runner }), fakeAccept(), fakeReject(), { chat }),
    );

    expect(result.promoted).toEqual([accepted.id]);
    expect(result.deferred).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  test("missing required judgment credential propagates before proposal or event mutation", async () => {
    const stash = makeStashDir();
    seed(stash, "lessons/credential-boundary", "consolidate", BIG_LESSON);
    const before = snapshotTree(stash);
    const stateDir = path.dirname(getStateDbPath());
    const stateBefore = snapshotTree(stateDir);
    const eventContext = eventsCtx();
    const runner: RunnerSpec = {
      ...FAKE_LLM_RUNNER,
      credential: { names: ["AKM_DRAIN_REQUIRED_KEY"], required: true },
    };
    const chat = mock(async () => {
      throw new Error("required-credential judgment reached provider");
    });

    await withEnv({ AKM_DRAIN_REQUIRED_KEY: undefined }, async () => {
      await expect(
        drainProposals(baseOpts(stash, { judgment: runner, eventsCtx: eventContext }), fakeAccept(), fakeReject(), {
          chat,
        }),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    expect(chat).not.toHaveBeenCalled();
    expect(snapshotTree(stash)).toEqual(before);
    expect(snapshotTree(stateDir)).toEqual(stateBefore);
    expect(fs.existsSync(eventContext.dbPath ?? "")).toBe(false);
  });

  test("each deferred judgment reads the credential current at its dispatch", async () => {
    const stash = makeStashDir();
    const first = seed(stash, "lessons/rotation-first", "consolidate", BIG_LESSON);
    const second = seed(stash, "lessons/rotation-second", "consolidate", BIG_LESSON);
    const secret = "drain-original-092";
    const rotated = "drain-rotated-092";
    const runner: RunnerSpec = {
      ...FAKE_LLM_RUNNER,
      credential: { names: ["AKM_DRAIN_ROTATING_KEY"], required: true },
    };
    const observed: Array<string | undefined> = [];
    const chat = mock(async (dispatched: Extract<RunnerSpec, { kind: "llm" }>) => {
      observed.push(dispatched.connection.apiKey);
      if (observed.length === 1) mutateScopedEnv("AKM_DRAIN_ROTATING_KEY", rotated);
      return JSON.stringify({ decision: "reject", reason: "rotation fixture" });
    });
    const rejectFn = fakeReject();

    const result = await withEnv({ AKM_DRAIN_ROTATING_KEY: secret }, () =>
      drainProposals(baseOpts(stash, { judgment: runner }), fakeAccept(), rejectFn, { chat }),
    );

    expect(result.rejected.sort()).toEqual([first.id, second.id].sort());
    expect(observed).toEqual([secret, rotated]);
    expect(rejectFn).toHaveBeenCalledTimes(2);
  });

  test("engine accepts a deferred item when the llm verdict is accept", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    const chat = mock(async () => JSON.stringify({ decision: "accept", reason: "valuable consolidation" }));
    const seams: JudgmentSeams = { chat };
    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();

    const result = await drainProposals(baseOpts(stash, { judgment: FAKE_LLM_RUNNER }), promoteFn, rejectFn, seams);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          model: "provider/exact-fake-judge",
          temperature: 0.11,
          maxTokens: 77,
          contextLength: 8_192,
        }),
      }),
      [
        {
          role: "user",
          content: buildJudgmentPrompt(deferred, "needs-judgment", { liveAsset: undefined, siblings: [] }),
        },
      ],
    );
    expect(result.notices).toBeUndefined();
    // The ENGINE performed the accept (promote mode), not the runner.
    expect(result.promoted).toEqual([deferred.id]);
    expect(result.deferred).toEqual([]);
    expect(promoteFn).toHaveBeenCalledTimes(1);
    expect(rejectFn).not.toHaveBeenCalled();
  });

  test("judgment promotion receives the frozen target and config", async () => {
    const stash = makeStashDir();
    seed(stash, "lessons/big", "consolidate", BIG_LESSON);
    const config = { semanticSearchMode: "off" } as AkmConfig;
    const promoteFn = fakeAccept();
    const chat = mock(async () => JSON.stringify({ decision: "accept", reason: "valuable" }));

    await drainProposals(
      baseOpts(stash, { judgment: FAKE_LLM_RUNNER, target: "team", config }),
      promoteFn,
      fakeReject(),
      { chat },
    );

    expect(promoteFn).toHaveBeenCalledWith(expect.objectContaining({ target: "team", config }));
  });

  test("engine rejects a deferred item when the llm verdict is reject", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    const chat = mock(async () => '```json\n{"decision":"reject","reason":"duplicate"}\n```');
    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();

    const result = await drainProposals(baseOpts(stash, { judgment: FAKE_LLM_RUNNER }), promoteFn, rejectFn, { chat });

    expect(result.rejected).toEqual([deferred.id]);
    expect(result.deferred).toEqual([]);
    expect(rejectFn).toHaveBeenCalledTimes(1);
    expect(promoteFn).not.toHaveBeenCalled();
  });

  test("verdict 'defer' leaves the item unresolved (triage_deferred)", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    const chat = mock(async () => JSON.stringify({ decision: "defer", reason: "need more context" }));
    const promoteFn = fakeAccept();

    const result = await drainProposals(baseOpts(stash, { judgment: FAKE_LLM_RUNNER }), promoteFn, fakeReject(), {
      chat,
    });

    expect(result.promoted).toEqual([]);
    expect(result.deferred.map((d) => d.id)).toEqual([deferred.id]);
    expect(promoteFn).not.toHaveBeenCalled();
  });

  test("provider rejection remains deferred without fabricating lowering notices", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/provider-reject", "consolidate", BIG_LESSON);
    const chat = mock(async () => {
      throw new Error("PROVIDER-BODY-SENTINEL");
    });

    const result = await drainProposals(baseOpts(stash, { judgment: FAKE_LLM_RUNNER }), fakeAccept(), fakeReject(), {
      chat,
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.deferred.map((item) => item.id)).toEqual([deferred.id]);
    expect(result.notices).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PROVIDER-BODY-SENTINEL");
  });

  test("a judged-accept promote that hits the stale-target guard is auto-rejected, not left deferred (STALE, R20)", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/judged-stale", "distill", VALID_LESSON);
    const chat = mock(async () => JSON.stringify({ decision: "accept", reason: "valuable" }));
    const promoteFn = mock(async () => {
      throw new Error(
        `Proposal target changed after proposal ${deferred.id} was created; refusing to overwrite newer content.`,
      );
    });
    const rejectFn = fakeReject();

    const result = await drainProposals(baseOpts(stash, { judgment: FAKE_LLM_RUNNER }), promoteFn, rejectFn, {
      chat,
    });

    expect(result.rejected).toEqual([deferred.id]);
    expect(result.promoted).toEqual([]);
    expect(result.deferred).toEqual([]);
    expect(rejectFn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: deferred.id,
        gateDecision: { outcome: "auto-rejected", reason: "stale-target", gate: "triage" },
      }),
    );
  });

  test("a judged-accept stale-target auto-reject that itself fails leaves the item unresolved", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/judged-stale-reject-fails", "distill", VALID_LESSON);
    const chat = mock(async () => JSON.stringify({ decision: "accept", reason: "valuable" }));
    const promoteFn = mock(async () => {
      throw new Error(
        `Proposal target changed after proposal ${deferred.id} was created; refusing to overwrite newer content.`,
      );
    });
    const rejectFn = mock(() => {
      throw new Error("simulated reject failure");
    });

    const result = await drainProposals(baseOpts(stash, { judgment: FAKE_LLM_RUNNER }), promoteFn, rejectFn, {
      chat,
    });

    expect(result.rejected).toEqual([]);
    expect(result.promoted).toEqual([]);
    expect(result.deferred.map((item) => item.id)).toEqual([deferred.id]);
  });

  test("judgment-tier dry-run predicts the same stale-target refusal a real judged promote would hit (parity)", async () => {
    const stash = makeStashDir();
    const assetPath = path.join(stash, "lessons", "judgment-dry-run-stale.md");
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Prefer rg", "Original: prefer rg"), "utf8");
    const created = createProposal(stash, {
      ref: "lessons/judgment-dry-run-stale",
      source: "distill",
      sourceRun: "run-x",
      target: { source: "stash", root: stash },
      payload: { content: VALID_LESSON, frontmatter: { description: "judgment-dry-run-stale fixture" } },
    });
    // The target changes again after the proposal is minted — the exact
    // condition the judged-accept preflight must refuse.
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Prefer rg", "Newer: someone else edited this"), "utf8");

    const chat = mock(async () => JSON.stringify({ decision: "accept", reason: "valuable distill" }));
    const promoteFn = fakeAccept();
    const rejectFn = fakeReject();

    const result = await drainProposals(
      baseOpts(stash, { judgment: FAKE_LLM_RUNNER, dryRun: true, config: makeConfig(stash) }),
      promoteFn,
      rejectFn,
      { chat },
    );

    // Dry-run performs zero writes, but still predicts the same outcome a real
    // judged promote would hit: the stale-target refusal, reported under
    // `rejected` rather than as a promotion.
    expect(result.promoted).toEqual([]);
    expect(result.rejected).toEqual([created.id]);
    expect(promoteFn).not.toHaveBeenCalled();
    expect(rejectFn).not.toHaveBeenCalled();
    expect(getProposal(stash, created.id).status).toBe("pending");
    expect(fs.readFileSync(assetPath, "utf8")).toContain("Newer: someone else edited this");
  });
});

describe("drainProposals — judgment tier (agent mode)", () => {
  test("engine accepts a deferred item when the agent verdict is accept", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    let capturedDispatch: Record<string, unknown> | undefined;
    const runAgentFn: NonNullable<JudgmentSeams["runAgentFn"]> = mock(async (_profile, _prompt, options) => {
      capturedDispatch = options.dispatch;
      return agentResult(JSON.stringify({ decision: "accept", reason: "merge is correct" }));
    });
    const promoteFn = fakeAccept();

    const result = await drainProposals(baseOpts(stash, { judgment: FAKE_AGENT_RUNNER }), promoteFn, fakeReject(), {
      runAgentFn,
    });

    expect(runAgentFn).toHaveBeenCalledTimes(1);
    expect(runAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "provider/exact-agent-judge" }),
      buildJudgmentPrompt(deferred, "needs-judgment", { liveAsset: undefined, siblings: [] }),
      expect.objectContaining({
        stdio: "captured",
        parseOutput: "text",
        timeoutMs: 1_234,
        dispatch: expect.objectContaining({
          model: "provider/exact-agent-judge",
        }),
      }),
    );
    expect(capturedDispatch).not.toHaveProperty("tools");
    expect(capturedDispatch).not.toHaveProperty("schema");
    expect(result.notices).toBeUndefined();
    expect(result.promoted).toEqual([deferred.id]);
    expect(result.deferred).toEqual([]);
    expect(promoteFn).toHaveBeenCalledTimes(1);
  });

  test("a failed agent run leaves the item unresolved", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    const runAgentFn = mock(
      async (): Promise<AgentRunResult> => ({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "boom",
        durationMs: 1,
        reason: "non_zero_exit",
        error: "boom",
      }),
    );
    const promoteFn = fakeAccept();

    const result = await drainProposals(baseOpts(stash, { judgment: FAKE_AGENT_RUNNER }), promoteFn, fakeReject(), {
      runAgentFn,
    });

    expect(result.promoted).toEqual([]);
    expect(result.deferred.map((d) => d.id)).toEqual([deferred.id]);
    expect(promoteFn).not.toHaveBeenCalled();
  });

  test("queue applyMode stages an accept verdict rather than promoting", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    const runAgentFn = mock(async () => agentResult(JSON.stringify({ decision: "accept", reason: "ok" })));
    const promoteFn = fakeAccept();

    const result = await drainProposals(
      baseOpts(stash, { judgment: FAKE_AGENT_RUNNER, applyMode: "queue" }),
      promoteFn,
      fakeReject(),
      { runAgentFn },
    );

    // queue mode never writes; the staged accept is RESOLVED (judge decided)
    // and surfaces under result.staged, NOT as an unresolved deferral (FIX 7).
    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.promoted).toEqual([]);
    expect(result.staged).toEqual([deferred.id]);
    expect(result.deferred).toEqual([]);
    expect(getProposal(stash, deferred.id).gateDecision).toMatchObject({
      outcome: "staged",
      reason: "judgment-accept",
    });

    const secondJudge = mock(async () => agentResult(JSON.stringify({ decision: "reject", reason: "should not run" })));
    const promoted = fakeAccept();
    const second = await drainProposals(
      baseOpts(stash, { judgment: FAKE_AGENT_RUNNER, applyMode: "promote" }),
      promoted,
      fakeReject(),
      { runAgentFn: secondJudge },
    );
    expect(secondJudge).not.toHaveBeenCalled();
    expect(second.promoted).toEqual([deferred.id]);
  });
});

describe("drainProposals — terminal transition ordering", () => {
  test("a failed rejection does not leave an auto-rejected pre-stamp and is retried", async () => {
    const stash = makeStashDir();
    const empty = seed(stash, "lessons/retry-empty", "extract", EMPTY_LESSON);
    const failingReject = mock(async () => {
      throw new Error("transient");
    });

    await drainProposals(baseOpts(stash), fakeAccept(), failingReject);
    expect(getProposal(stash, empty.id).gateDecision).toBeUndefined();

    const retry = fakeReject();
    const result = await drainProposals(baseOpts(stash), fakeAccept(), retry);
    expect(result.rejected).toEqual([empty.id]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("content changes invalidate a staged judgment", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/staged-change", "consolidate", BIG_LESSON);
    const acceptJudge = mock(async () => agentResult(JSON.stringify({ decision: "accept", reason: "ok" })));
    await drainProposals(
      baseOpts(stash, { judgment: FAKE_AGENT_RUNNER, applyMode: "queue" }),
      fakeAccept(),
      fakeReject(),
      { runAgentFn: acceptJudge },
    );

    const { openStateDatabase } = await import("../../../src/core/state-db");
    const db = openStateDatabase();
    try {
      db.prepare("UPDATE proposals SET content = content || ? WHERE id = ?").run("\nchanged", deferred.id);
    } finally {
      db.close();
    }
    const rejudge = mock(async () => agentResult(JSON.stringify({ decision: "defer", reason: "changed" })));
    await drainProposals(
      baseOpts(stash, { judgment: FAKE_AGENT_RUNNER, applyMode: "promote" }),
      fakeAccept(),
      fakeReject(),
      { runAgentFn: rejudge },
    );
    expect(rejudge).toHaveBeenCalledTimes(1);
  });
});

// ── FIX 7: queue-mode staged accept is not reported as "unresolved" ─────────

describe("drainProposals — queue-mode staged accept (FIX 7)", () => {
  test("a judged-accept in queue mode does NOT emit triage_deferred 'unresolved'", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    const ctx = eventsCtx();
    const runAgentFn = mock(async () => agentResult(JSON.stringify({ decision: "accept", reason: "ok" })));

    const result = await drainProposals(
      baseOpts(stash, { judgment: FAKE_AGENT_RUNNER, applyMode: "queue", eventsCtx: ctx }),
      fakeAccept(),
      fakeReject(),
      { runAgentFn },
    );

    // The staged accept is resolved, so the unresolved deferred list is empty.
    expect(result.staged).toEqual([deferred.id]);
    expect(result.deferred).toEqual([]);

    // No triage_deferred "left unresolved" event should be present.
    const { readEvents } = await import("../../../src/core/events");
    const { events } = readEvents({ type: "triage_deferred" }, ctx);
    expect(events).toEqual([]);
  });
});

describe("drainProposals — judgment disabled", () => {
  test("deferred items stay unresolved when no runner is configured", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

    const result = await drainProposals(baseOpts(stash, { judgment: null }), fakeAccept(), fakeReject(), {});

    expect(result.deferred.map((d) => d.id)).toEqual([deferred.id]);
    // Left for review: a per-proposal reason, and `review_needed` in the ledger.
    expect(getProposal(stash, deferred.id).gateDecision).toMatchObject({
      outcome: "deferred",
      reason: "no-judge-configured",
      gate: "triage",
    });
    expect(ledgerRow(stash, "stash//lessons/big", "consolidate")).toMatchObject({ outcome: "review_needed" });
  });
});

// ── REVIEW: the quality gate's review_needed band must reach a human ────────
//
// `writeQualityRejection` (distill.ts) stamps a `review_needed`
// mint `deferred`/`quality-gate`. `classifyPendingProposals` must skip that
// row entirely — not classify it, not re-stamp it, not send it to the
// judgment tier, which could auto-accept it under `applyMode: promote` with
// no human ever seeing content the gate explicitly refused to auto-queue. An
// unstamped `distill` row is unaffected and still reaches judgment normally.

describe("drainProposals — REVIEW: quality-gate review-band rows are skipped, not judged", () => {
  test("a distill row stamped deferred/quality-gate stays pending and untouched; the judgment seam is never called", async () => {
    const stash = makeStashDir();
    const reviewNeeded = seed(stash, "lessons/review-needed", "distill", VALID_LESSON);
    recordGateDecision(stash, reviewNeeded.id, {
      outcome: "deferred",
      reason: "quality-review",
      gate: "quality-gate",
    });
    const before = getProposal(stash, reviewNeeded.id);

    const chat = mock(async () => {
      throw new Error("quality-gate review_needed row reached the judgment tier");
    });

    const result = await drainProposals(
      baseOpts(stash, { judgment: FAKE_LLM_RUNNER, applyMode: "promote" }),
      fakeAccept(),
      fakeReject(),
      { chat },
    );

    expect(chat).not.toHaveBeenCalled();
    expect(result.promoted).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.deferred).toEqual([]);
    expect(getProposal(stash, reviewNeeded.id)).toEqual(before);
  });

  test("an unstamped distill row still reaches the judgment tier", async () => {
    const stash = makeStashDir();
    const distillRow = seed(stash, "lessons/unstamped-distill", "distill", VALID_LESSON);

    const chat = mock(async () => JSON.stringify({ decision: "accept", reason: "genuinely useful" }));

    const result = await drainProposals(
      baseOpts(stash, { judgment: FAKE_LLM_RUNNER, applyMode: "promote" }),
      fakeAccept(),
      fakeReject(),
      { chat },
    );

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.promoted).toEqual([distillRow.id]);
  });
});
