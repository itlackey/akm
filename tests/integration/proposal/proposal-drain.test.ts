import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildJudgmentPrompt,
  classifyProposal,
  type DrainOptions,
  drainProposals,
  isEmptyDiff,
  type JudgmentSeams,
} from "../../../src/commands/proposal/drain";
import {
  CONSERVATIVE,
  MANUAL,
  PERSONAL_STASH,
  resolveDrainPolicy,
} from "../../../src/commands/proposal/drain-policies";
import type { ProposalAcceptResult, ProposalRejectResult } from "../../../src/commands/proposal/proposal";
import {
  createProposal,
  getProposal,
  isProposalSkipped,
  listProposals,
  type Proposal,
  recordGateDecision,
} from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import type { EventsContext } from "../../../src/core/events";
import { getStateDbPath } from "../../../src/core/state-db";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import type { AgentRunResult } from "../../../src/integrations/agent";
import type { RunnerSpec } from "../../../src/integrations/agent/runner";
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
    target: { source: "stash", root: stash },
    payload: { content, frontmatter: { description: `${ref} fixture` } },
  });
  if (isProposalSkipped(result)) throw new Error(`unexpected skip: ${result.message}`);
  return result;
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

  test("a `_comment` or newer-akm field is ignored and warned about, not rejected", () => {
    const dir = makeTempDir("akm-drain-policy-extra-");
    const file = path.join(dir, "commented.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        name: "custom",
        _comment: "this policy pins the personal-stash defaults",
        accept: [{ generator: "extract", futureField: "written-for-a-newer-akm" }],
        rejectEmpty: true,
        defer: [],
      }),
    );

    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    let policy: ReturnType<typeof resolveDrainPolicy>;
    try {
      policy = resolveDrainPolicy(file);
    } finally {
      _setWarnSinkForTests(undefined);
    }

    expect(policy.name).toBe("custom");
    expect(policy.accept).toMatchObject([{ generator: "extract" }]);
    expect((policy.accept[0] as unknown as { futureField?: string }).futureField).toBe("written-for-a-newer-akm");
    expect(warnings.some((w) => w.includes(file) && w.includes("_comment"))).toBe(true);
    expect(warnings.some((w) => w.includes("accept[0]") && w.includes("futureField"))).toBe(true);
  });
});

// ── classifyProposal (pure) ───────────────────────────────────────────────

describe("classifyProposal", () => {
  test("extract with real content → accept", () => {
    const p = proposalFixture("extract", VALID_LESSON);
    expect(classifyProposal(p, PERSONAL_STASH)?.verdict).toBe("accept");
  });

  test("extract exceeding the accept band's maxDiffLines → defer (no uncapped auto-promote)", () => {
    // An arbitrarily large extract must not auto-promote with zero LLM calls.
    const big = `---\nd: x\n---\n${Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const p = proposalFixture("extract", big);
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision?.verdict).toBe("defer");
  });

  test("empty diff → reject", () => {
    const p = proposalFixture("extract", EMPTY_LESSON);
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision?.verdict).toBe("reject");
  });

  test("mid-band consolidate (in defer list, no accept match) → defer", () => {
    // A consolidate proposal that exceeds the accept band's maxDiffLines defers.
    const big = `---\nd: x\n---\n${Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const p = proposalFixture("consolidate", big);
    const decision = classifyProposal(p, PERSONAL_STASH);
    expect(decision?.verdict).toBe("defer");
  });

  test("unmatched generator → null (left pending)", () => {
    const p = proposalFixture("propose", VALID_LESSON);
    expect(classifyProposal(p, PERSONAL_STASH)).toBeNull();
  });

  test("global maxDiffLines defers an otherwise-acceptable extract", () => {
    const p = proposalFixture("extract", VALID_LESSON);
    expect(classifyProposal(p, PERSONAL_STASH, 2)?.verdict).toBe("defer");
  });
});

describe("isEmptyDiff", () => {
  test("frontmatter-only content is empty", () => {
    expect(isEmptyDiff(proposalFixture("extract", EMPTY_LESSON))).toBe(true);
  });
  test("content with a body is not empty", () => {
    expect(isEmptyDiff(proposalFixture("extract", VALID_LESSON))).toBe(false);
  });
});

// ── drainProposals (engine) ─────────────────────────────────────────────────

describe("drainProposals — policy matching", () => {
  test("extract→accept, empty→reject, consolidate mid-band→defer", async () => {
    const stash = makeStashDir();
    const accepted = seed(stash, "lessons/good", "extract", VALID_LESSON);
    const empty = seed(stash, "lessons/empty", "extract", EMPTY_LESSON);
    const deferred = seed(stash, "lessons/big", "consolidate", BIG_LESSON);

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
    const fresh = seed(stash, "lessons/fresh", "extract", VALID_LESSON);
    const old = seed(stash, "lessons/old", "extract", VALID_LESSON);

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash, { excludeIds: new Set([fresh.id]) }), promoteFn, fakeReject());

    expect(result.promoted).toEqual([old.id]);
    expect(result.promoted).not.toContain(fresh.id);
  });
});

describe("drainProposals — maxAccepts ceiling", () => {
  test("ceiling stops promotion and reports skippedByCap", async () => {
    const stash = makeStashDir();
    seed(stash, "lessons/a", "extract", VALID_LESSON);
    seed(stash, "lessons/b", "extract", VALID_LESSON);
    seed(stash, "lessons/c", "extract", VALID_LESSON);

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash, { maxAccepts: 1 }), promoteFn, fakeReject());

    expect(result.promoted).toHaveLength(1);
    expect(result.skippedByCap).toHaveLength(2);
    expect(promoteFn).toHaveBeenCalledTimes(1);
  });

  test("deterministic promotion receives the frozen target and config", async () => {
    const stash = makeStashDir();
    seed(stash, "lessons/a", "extract", VALID_LESSON);
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
    const det = seed(stash, "lessons/det", "extract", VALID_LESSON);
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
    const det = seed(stash, "lessons/det", "extract", VALID_LESSON);
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
    seed(stash, "lessons/a", "extract", VALID_LESSON);
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

describe("drainProposals — maxDiffLines", () => {
  test("defers large proposals instead of promoting", async () => {
    const stash = makeStashDir();
    const small = seed(stash, "lessons/small", "extract", VALID_LESSON);
    const large = seed(stash, "lessons/large", "extract", BIG_LESSON);

    const promoteFn = fakeAccept();
    const result = await drainProposals(baseOpts(stash, { maxDiffLines: 10 }), promoteFn, fakeReject());

    expect(result.promoted).toEqual([small.id]);
    expect(result.deferred.map((d) => d.id)).toContain(large.id);
  });
});

describe("drainProposals — dry-run", () => {
  test("performs zero writes (promote/reject never called)", async () => {
    const stash = makeStashDir();
    const accepted = seed(stash, "lessons/good", "extract", VALID_LESSON);
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
    const advisoryOnly = seed(
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
    const accepted = seed(stash, "lessons/promote-boom", "extract", VALID_LESSON);
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

  test("a stale-target refusal is categorized by its message, not lost as a generic failure", async () => {
    const stash = makeStashDir();
    const accepted = seed(stash, "lessons/promote-stale", "extract", VALID_LESSON);
    const promoteFn = mock(async () => {
      throw new Error(
        `Proposal target changed after proposal ${accepted.id} was created; refusing to overwrite newer content.`,
      );
    });

    const result = await drainProposals(baseOpts(stash), promoteFn, fakeReject());

    expect(result.failed).toEqual([
      {
        id: accepted.id,
        reason: "stale-target",
        detail: `Proposal target changed after proposal ${accepted.id} was created; refusing to overwrite newer content.`,
      },
    ]);
  });

  test("dry-run predicts the same stale-target refusal a real promote hits (parity)", async () => {
    const stash = makeStashDir();
    const assetPath = path.join(stash, "lessons", "dry-run-stale.md");
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Prefer rg", "Original: prefer rg"), "utf8");
    const created = createProposal(stash, {
      ref: "lessons/dry-run-stale",
      source: "extract",
      force: true,
      sourceRun: "run-x",
      target: { source: "stash", root: stash },
      payload: { content: VALID_LESSON, frontmatter: { description: "dry-run-stale fixture" } },
    });
    if (isProposalSkipped(created)) throw new Error(`unexpected skip: ${created.message}`);
    // The target changes again after the proposal is minted — the exact
    // condition both the dry-run preflight and the real promote must refuse.
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Prefer rg", "Newer: someone else edited this"), "utf8");

    const dryRunResult = await drainProposals(
      baseOpts(stash, { dryRun: true, config: makeConfig(stash) }),
      fakeAccept(),
      fakeReject(),
    );
    expect(dryRunResult.promoted).toEqual([]);
    expect(dryRunResult.failed).toEqual([expect.objectContaining({ id: created.id, reason: "stale-target" })]);

    // The real run (no promote/reject seams — exercises the actual write path)
    // must refuse the exact same candidate, so the two never disagree.
    const realResult = await drainProposals(baseOpts(stash, { config: makeConfig(stash) }));
    expect(realResult.promoted).toEqual([]);
    expect(realResult.failed).toEqual([expect.objectContaining({ id: created.id, reason: "stale-target" })]);
    expect(fs.readFileSync(assetPath, "utf8")).toContain("Newer: someone else edited this");
  });
});

// ── Judgment tier (Phase 3) ─────────────────────────────────────────────────
//
// The judgment tier adjudicates the *deferred* items. PERSONAL_STASH defers
// large consolidate proposals (mid-band). We inject a fake runner that returns
// a verdict and assert the ENGINE performs the resulting accept / reject write
// (the runner only judges). Mirrors reflect's dual test seams: an `llm`-mode
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
  test("an unused judgment credential is not materialized when deterministic policy leaves no deferred work", async () => {
    const stash = makeStashDir();
    const accepted = seed(stash, "lessons/deterministic-only", "extract", VALID_LESSON);
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

  test("all deferred judgments use the credential captured before drain mutations", async () => {
    const stash = makeStashDir();
    const first = seed(stash, "lessons/lease-first", "consolidate", BIG_LESSON);
    const second = seed(stash, "lessons/lease-second", "consolidate", BIG_LESSON);
    const secret = "drain-lease-original-092";
    const runner: RunnerSpec = {
      ...FAKE_LLM_RUNNER,
      credential: { names: ["AKM_DRAIN_LEASE_KEY"], required: true },
    };
    const observed: Array<string | undefined> = [];
    const chat = mock(async (dispatched: Extract<RunnerSpec, { kind: "llm" }>) => {
      observed.push(dispatched.connection.apiKey);
      if (observed.length === 1) mutateScopedEnv("AKM_DRAIN_LEASE_KEY", undefined);
      return JSON.stringify({ decision: "reject", reason: "lease fixture" });
    });
    const rejectFn = fakeReject();

    const result = await withEnv({ AKM_DRAIN_LEASE_KEY: secret }, () =>
      drainProposals(baseOpts(stash, { judgment: runner }), fakeAccept(), rejectFn, { chat }),
    );

    expect(result.rejected.sort()).toEqual([first.id, second.id].sort());
    expect(observed).toEqual([secret, secret]);
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
          content: buildJudgmentPrompt(deferred, "mid-band", { liveAsset: undefined, siblings: [] }),
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
      buildJudgmentPrompt(deferred, "mid-band", { liveAsset: undefined, siblings: [] }),
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

  test("a staged personal-stash judgment is not consumed by the manual policy", async () => {
    const stash = makeStashDir();
    const deferred = seed(stash, "lessons/cross-policy", "consolidate", BIG_LESSON);
    const stageJudge = mock(async () => agentResult(JSON.stringify({ decision: "accept", reason: "personal" })));
    await drainProposals(
      baseOpts(stash, { policy: PERSONAL_STASH, judgment: FAKE_AGENT_RUNNER, applyMode: "queue" }),
      fakeAccept(),
      fakeReject(),
      { runAgentFn: stageJudge },
    );

    const manualJudge = mock(async () => agentResult(JSON.stringify({ decision: "accept", reason: "manual" })));
    const promoteFn = fakeAccept();
    const result = await drainProposals(
      baseOpts(stash, { policy: MANUAL, judgment: FAKE_AGENT_RUNNER, applyMode: "promote" }),
      promoteFn,
      fakeReject(),
      { runAgentFn: manualJudge },
    );

    expect(result.promoted).toEqual([]);
    expect(promoteFn).not.toHaveBeenCalled();
    expect(manualJudge).not.toHaveBeenCalled();
    expect(getProposal(stash, deferred.id).gateDecision).toMatchObject({
      outcome: "staged",
      gate: "triage:personal-stash",
    });
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
  });
});

// ── REVIEW: the quality gate's review_needed band must reach a human ────────
//
// `writeQualityRejection` (distill/quality-gate.ts) stamps a `review_needed`
// mint `deferred`/`quality-gate`. `classifyPendingProposals` must skip that
// row entirely — not classify it, not re-stamp it, not send it to the
// judgment tier, which could auto-accept it under `applyMode: promote` with
// no human ever seeing content the gate explicitly refused to auto-queue. An
// unstamped `distill` row is unaffected and still reaches judgment normally
// (PERSONAL_STASH defers `distill` to the judgment tier).

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
