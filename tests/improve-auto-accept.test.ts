import { describe, expect, mock, test } from "bun:test";
import type { AutoAcceptGateConfig, ProposalCandidate } from "../src/commands/improve-auto-accept";
import { makeGateConfig, resolveExtractConfidence, runAutoAcceptGate } from "../src/commands/improve-auto-accept";
import type { AkmConfig } from "../src/core/config";
import type { EventsContext } from "../src/core/events";

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
      [
        candidate("low", 0.7),
        candidate("missing", undefined),
        candidate("high", 0.95),
        candidate("exact", 0.9),
      ],
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
    expect(
      resolveExtractConfidence({ payload: { frontmatter: { confidence: 0.91 } }, confidence: 0.5 }),
    ).toBe(0.91);
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
