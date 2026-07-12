import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutoAcceptGateConfig, ProposalCandidate } from "../../../src/commands/improve/improve-auto-accept";
import {
  makeGateConfig,
  resolveExtractConfidence,
  runAutoAcceptGate,
} from "../../../src/commands/improve/improve-auto-accept";
import { createProposal, getProposal, isProposalSkipped } from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import { UsageError } from "../../../src/core/errors";
import { type EventsContext, readEvents } from "../../../src/core/events";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const STUB_CONFIG = {} as AkmConfig;
const STUB_CTX: EventsContext | undefined = {};
const STUB_STASH = "/tmp/test-stash";

function makePromotion(proposalId: string) {
  return {
    ref: `memory:test-${proposalId}`,
    assetPath: `/tmp/test-stash/memory/test-${proposalId}.md`,
    proposal: { id: proposalId, source: "extract", sourceRun: undefined },
  };
}

function baseConfig(overrides: Partial<AutoAcceptGateConfig> = {}): AutoAcceptGateConfig {
  return {
    phase: "test",
    globalThreshold: 90,
    dryRun: false,
    stashDir: STUB_STASH,
    config: STUB_CONFIG,
    eventsCtx: STUB_CTX,
    ...overrides,
  };
}

function candidate(proposalId: string, confidence: number | undefined): ProposalCandidate {
  return { proposalId, confidence };
}

// ---------------------------------------------------------------------------
// Guard conditions — gate must be a no-op
// ---------------------------------------------------------------------------

describe("runAutoAcceptGate — no-op guards", () => {
  test("dryRun=true: all candidates land in skipped, promoteFn never called", async () => {
    const promoteFn = mock(async () => makePromotion("p1"));
    const result = await runAutoAcceptGate(
      [candidate("p1", 0.95), candidate("p2", 1.0)],
      baseConfig({ dryRun: true }),
      promoteFn as never,
    );
    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual(["p1", "p2"]);
    expect(result.failed).toEqual([]);
  });

  test("globalThreshold=undefined: all candidates skipped", async () => {
    const promoteFn = mock(async () => makePromotion("p1"));
    const result = await runAutoAcceptGate(
      [candidate("p1", 0.99)],
      baseConfig({ globalThreshold: undefined }),
      promoteFn as never,
    );
    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["p1"]);
  });

  test("stashDir=undefined: all candidates skipped", async () => {
    const promoteFn = mock(async () => makePromotion("p1"));
    const result = await runAutoAcceptGate(
      [candidate("p1", 0.99)],
      baseConfig({ stashDir: undefined }),
      promoteFn as never,
    );
    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["p1"]);
  });

  test("empty candidates list: returns all-empty result", async () => {
    const promoteFn = mock(async () => makePromotion("p1"));
    const result = await runAutoAcceptGate([], baseConfig(), promoteFn as never);
    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Threshold logic
// ---------------------------------------------------------------------------

describe("runAutoAcceptGate — threshold decisions", () => {
  test("candidate with confidence=undefined lands in skipped", async () => {
    const promoteFn = mock(async () => makePromotion("p1"));
    const result = await runAutoAcceptGate(
      [candidate("p1", undefined)],
      baseConfig({ globalThreshold: 90 }),
      promoteFn as never,
    );
    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["p1"]);
  });

  test("candidate below threshold lands in skipped", async () => {
    const promoteFn = mock(async () => makePromotion("p1"));
    const result = await runAutoAcceptGate(
      [candidate("p1", 0.89)],
      baseConfig({ globalThreshold: 90 }),
      promoteFn as never,
    );
    expect(promoteFn).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["p1"]);
  });

  test("candidate exactly at threshold is promoted", async () => {
    const promoteFn = mock(async (_stash, _cfg, id: string) => makePromotion(id));
    const result = await runAutoAcceptGate(
      [candidate("p1", 0.9)],
      baseConfig({ globalThreshold: 90 }),
      promoteFn as never,
    );
    expect(promoteFn).toHaveBeenCalledTimes(1);
    expect(result.promoted).toEqual(["p1"]);
    expect(result.skipped).toEqual([]);
  });

  test("candidate above threshold is promoted", async () => {
    const promoteFn = mock(async (_stash, _cfg, id: string) => makePromotion(id));
    const result = await runAutoAcceptGate(
      [candidate("p1", 0.97)],
      baseConfig({ globalThreshold: 90 }),
      promoteFn as never,
    );
    expect(result.promoted).toEqual(["p1"]);
  });

  test("forwards the resolved named write target to proposal promotion", async () => {
    const promoteFn = mock(async (_stash, _cfg, id: string) => makePromotion(id));
    const config = { defaultWriteTarget: "team" } as AkmConfig;

    await runAutoAcceptGate([candidate("p1", 0.97)], baseConfig({ config }), promoteFn as never);

    expect(promoteFn).toHaveBeenCalledWith(
      STUB_STASH,
      config,
      "p1",
      expect.objectContaining({ target: "team", eventMetadata: expect.objectContaining({ autoAccept: true }) }),
      undefined,
    );
  });

  test("minimumThreshold floors a permissive globalThreshold", async () => {
    // globalThreshold=80 would pass 0.85, but minimumThreshold=95 raises the bar
    const promoteFn = mock(async (_stash, _cfg, id: string) => makePromotion(id));
    const cfg = baseConfig({ globalThreshold: 80, minimumThreshold: 95 });

    const below = await runAutoAcceptGate([candidate("p1", 0.85)], cfg, promoteFn as never);
    expect(below.skipped).toEqual(["p1"]);
    expect(below.promoted).toEqual([]);

    const above = await runAutoAcceptGate([candidate("p2", 0.96)], cfg, promoteFn as never);
    expect(above.promoted).toEqual(["p2"]);
  });

  test("mixed batch: each candidate routed independently", async () => {
    const promoteFn = mock(async (_stash, _cfg, id: string) => makePromotion(id));
    const result = await runAutoAcceptGate(
      [candidate("low", 0.7), candidate("missing", undefined), candidate("high", 0.95), candidate("exact", 0.9)],
      baseConfig({ globalThreshold: 90 }),
      promoteFn as never,
    );
    expect(result.promoted.sort()).toEqual(["exact", "high"]);
    expect(result.skipped.sort()).toEqual(["low", "missing"]);
    expect(result.failed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("runAutoAcceptGate — error handling", () => {
  test("promoteFn throw: candidate lands in failed, loop continues for next", async () => {
    const promoteFn = mock(async (_stash, _cfg, id: string) => {
      if (id === "bad") throw new Error("validation failed");
      return makePromotion(id);
    });

    const result = await runAutoAcceptGate(
      [candidate("bad", 0.95), candidate("good", 0.95)],
      baseConfig({ globalThreshold: 90 }),
      promoteFn as never,
    );
    expect(result.failed).toEqual(["bad"]);
    expect(result.promoted).toEqual(["good"]);
    expect(result.skipped).toEqual([]);
    // Both were attempted
    expect(promoteFn).toHaveBeenCalledTimes(2);
  });

  test("all failures: promoted stays empty, no throw from gate", async () => {
    const promoteFn = mock(async () => {
      throw new Error("always fails");
    });
    const result = await runAutoAcceptGate(
      [candidate("p1", 0.95), candidate("p2", 0.95)],
      baseConfig({ globalThreshold: 90 }),
      promoteFn as never,
    );
    expect(result.failed).toEqual(["p1", "p2"]);
    expect(result.promoted).toEqual([]);
  });

  test("failedByReason captures the validation finding kind (no longer a blind leak)", async () => {
    const promoteFn = mock(async (_stash, _cfg, id: string) => {
      if (id === "trunc")
        throw new Error("Proposal trunc failed validation:\n[description-quality] description is truncated");
      if (id === "other") throw new Error("disk on fire");
      return makePromotion(id);
    });
    const result = await runAutoAcceptGate(
      [candidate("trunc", 0.95), candidate("other", 0.95), candidate("ok", 0.95)],
      baseConfig({ globalThreshold: 90 }),
      promoteFn as never,
    );
    expect(result.failed.sort()).toEqual(["other", "trunc"]);
    expect(result.promoted).toEqual(["ok"]);
    // Validation findings are bucketed by kind; non-validation throws → promote-error.
    expect(result.failedByReason["validation:description-quality"]).toBe(1);
    expect(result.failedByReason["promote-error"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M4: validation failures are permanent → archive (not left pending forever)
// ---------------------------------------------------------------------------

describe("runAutoAcceptGate — archives validation-failed proposals (M4)", () => {
  // FS-bound: seeds real proposals via createProposal into a per-test temp stash
  // and reads status back via getProposal. No process.env mutation — stashDir is
  // passed explicitly — so the isolation lint stays satisfied.
  const tempDirs: string[] = [];

  function makeStashDir(): string {
    const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-autoaccept-stash-"));
    tempDirs.push(stash);
    for (const dir of ["lessons", "memories"]) fs.mkdirSync(path.join(stash, dir), { recursive: true });
    return stash;
  }

  function seedPending(stash: string, ref: string): string {
    const result = createProposal(stash, {
      ref,
      source: "extract",
      force: true,
      sourceRun: "run-x",
      payload: { content: `---\ndescription: ${ref} fixture\n---\n\nBody line.\n`, frontmatter: { description: ref } },
    });
    if (isProposalSkipped(result)) throw new Error(`unexpected skip: ${result.message}`);
    return result.id;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("permanent validation failure archives the proposal as rejected (stops the pending-zombie retry loop)", async () => {
    const stash = makeStashDir();
    const id = seedPending(stash, "lesson:validation-zombie");
    // promoteProposal throws exactly this on the validateProposal failure branch.
    const promoteFn = mock(async () => {
      throw new UsageError(
        "Proposal failed validation:\n[description-quality] description is truncated",
        "MISSING_REQUIRED_ARGUMENT",
      );
    });

    const result = await runAutoAcceptGate(
      [candidate(id, 0.99)],
      baseConfig({ stashDir: stash, globalThreshold: 90 }),
      promoteFn as never,
    );

    expect(result.failed).toEqual([id]);
    // The proposal is no longer pending — it has been archived as rejected.
    expect(getProposal(stash, id)?.status).toBe("rejected");
  });

  test("transient git-push rejection with a bracketed word does NOT archive (message-sniffing false positive guard)", async () => {
    const stash = makeStashDir();
    const id = seedPending(stash, "lesson:git-push-rejected");
    // A git-backed write target's non-fast-forward push failure is a plain Error
    // whose message contains "[rejected]". The archive must key on the structured
    // UsageError code, NOT the message, so this retryable failure stays pending.
    const promoteFn = mock(async () => {
      throw new Error("git push failed: ! [rejected]        main -> main (non-fast-forward)");
    });

    await runAutoAcceptGate(
      [candidate(id, 0.99)],
      baseConfig({ stashDir: stash, globalThreshold: 90 }),
      promoteFn as never,
    );

    // Transient, content-independent failure — the proposal must remain pending.
    expect(getProposal(stash, id)?.status).toBe("pending");
  });

  test("non-validation failure leaves the proposal pending (only permanent failures are archived)", async () => {
    const stash = makeStashDir();
    const id = seedPending(stash, "lesson:transient-failure");
    const promoteFn = mock(async () => {
      throw new Error("disk on fire");
    });

    await runAutoAcceptGate(
      [candidate(id, 0.99)],
      baseConfig({ stashDir: stash, globalThreshold: 90 }),
      promoteFn as never,
    );

    // A transient/unknown error must NOT archive — the proposal stays pending.
    expect(getProposal(stash, id)?.status).toBe("pending");
  });

  test("real auto-accept composition emits exactly one promoted event", async () => {
    const stash = makeStashDir();
    const proposal = createProposal(stash, {
      ref: "lesson:single-promoted-event",
      source: "extract",
      force: true,
      payload: {
        content:
          "---\ndescription: Single promoted event fixture\nwhen_to_use: Testing real auto accept composition\n---\n\nOne event.\n",
      },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
    const config = {
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
    } as AkmConfig;

    const result = await runAutoAcceptGate(
      [{ proposalId: proposal.id, confidence: 0.99 }],
      baseConfig({ stashDir: stash, config, globalThreshold: 90 }),
    );
    expect(result.promoted).toEqual([proposal.id]);
    const events = readEvents({ type: "promoted", ref: proposal.ref }).events.filter(
      (event) => event.metadata?.proposalId === proposal.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata?.autoAccept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveExtractConfidence
// ---------------------------------------------------------------------------

describe("resolveExtractConfidence", () => {
  test("reads from payload.frontmatter.confidence when present", () => {
    expect(resolveExtractConfidence({ payload: { frontmatter: { confidence: 0.92 } } })).toBe(0.92);
  });

  test("falls back to top-level confidence when frontmatter has none", () => {
    expect(resolveExtractConfidence({ payload: { frontmatter: {} }, confidence: 0.88 })).toBe(0.88);
  });

  test("returns undefined when neither source has a value", () => {
    expect(resolveExtractConfidence({ payload: {} })).toBeUndefined();
  });

  test("frontmatter takes precedence over top-level", () => {
    expect(resolveExtractConfidence({ payload: { frontmatter: { confidence: 0.91 } }, confidence: 0.5 })).toBe(0.91);
  });
});

// ---------------------------------------------------------------------------
// makeGateConfig helper
// ---------------------------------------------------------------------------

describe("makeGateConfig", () => {
  const shared = {
    globalThreshold: 90 as number | undefined,
    dryRun: false,
    stashDir: STUB_STASH,
    config: STUB_CONFIG,
    eventsCtx: STUB_CTX,
  };

  test("builds config with correct phase label", () => {
    const cfg = makeGateConfig("extract", shared);
    expect(cfg.phase).toBe("extract");
  });

  test("applies minimumThreshold override", () => {
    const cfg = makeGateConfig("consolidate", shared, { minimumThreshold: 95 });
    expect(cfg.minimumThreshold).toBe(95);
  });

  test("no override leaves minimumThreshold undefined", () => {
    const cfg = makeGateConfig("reflect", shared);
    expect(cfg.minimumThreshold).toBeUndefined();
  });
});
