import { describe, expect, test } from "bun:test";
import {
  assessMemoryKnowledgePromotionCandidate,
  DEFAULT_PROMOTION_POLICY_SELECTION,
  deriveKnowledgeRef,
  evaluateMemoryPromotionBenchmark,
  type PromotionBenchmarkCase,
  selectPromotionPolicy,
} from "../../../src/commands/improve/distill-promotion-policy";
import { DEFAULT_PROMOTION_POLICY_CORPUS } from "./promotion-policy-corpus";

function fixtureByName(name: string): PromotionBenchmarkCase {
  const fixture = DEFAULT_PROMOTION_POLICY_CORPUS.find((candidate) => candidate.name === name);
  expect(fixture).toBeDefined();
  return fixture as PromotionBenchmarkCase;
}

describe("distill promotion policy", () => {
  test("does not copy a memory project scope into the reusable knowledge namespace", () => {
    expect(deriveKnowledgeRef("memory:project-a/oauth-refresh-race")).toBe("knowledge:oauth-refresh-race");
  });

  test("selected model is derived from a larger train/held-out corpus", () => {
    const selection = selectPromotionPolicy(DEFAULT_PROMOTION_POLICY_CORPUS);

    expect(DEFAULT_PROMOTION_POLICY_CORPUS.length).toBeGreaterThanOrEqual(20);
    expect(selection.trainingSize).toBeGreaterThan(0);
    expect(selection.heldOutSize).toBeGreaterThan(0);
    expect(selection.selectedModel.name.length).toBeGreaterThan(0);
    expect(selection.selectedModel.threshold).toBeGreaterThan(0);
  });

  test("selected model beats simpler held-out baselines", () => {
    const selection = selectPromotionPolicy(DEFAULT_PROMOTION_POLICY_CORPUS);

    expect(selection.heldOut.f1).toBeGreaterThanOrEqual(0.8);
    expect(selection.heldOut.netOutcomeScore).toBeGreaterThan(0);
    expect(selection.strictlyBeatsBaselines).toBe(true);
    for (const baseline of selection.baselines) {
      expect(baseline.noWorseThanSelected).toBe(true);
      expect(baseline.strictWin).toBe(true);
      expect(baseline.strictWinMetrics.length).toBeGreaterThan(0);
      expect(selection.heldOut.f1).toBeGreaterThanOrEqual(baseline.heldOut.f1);
      expect(selection.heldOut.netOutcomeScore).toBeGreaterThanOrEqual(baseline.heldOut.netOutcomeScore);
    }
  });

  test("full-corpus evaluation stays accurate and exposes downstream outcome metrics", () => {
    const benchmark = evaluateMemoryPromotionBenchmark(DEFAULT_PROMOTION_POLICY_CORPUS);

    expect(benchmark.total).toBe(DEFAULT_PROMOTION_POLICY_CORPUS.length);
    expect(benchmark.accuracy).toBeGreaterThanOrEqual(0.85);
    expect(benchmark.precision).toBeGreaterThanOrEqual(0.8);
    expect(benchmark.recall).toBeGreaterThanOrEqual(0.8);
    expect(benchmark.f1).toBeGreaterThanOrEqual(0.8);
    expect(benchmark.netOutcomeScore).toBeGreaterThan(0);
    expect(benchmark.capturedPromoteValue).toBeGreaterThan(0);
    expect(benchmark.preventedFalsePromotionCost).toBeGreaterThan(0);
  });

  test("promoted fixtures emit knowledge payload content", () => {
    const promoted = assessMemoryKnowledgePromotionCandidate(DEFAULT_PROMOTION_POLICY_CORPUS[0].input);

    expect(promoted.promote).toBe(true);
    expect(promoted.modelName).toBe(DEFAULT_PROMOTION_POLICY_SELECTION.selectedModel.name);
    expect(promoted.content).toContain("xrefs:");
    expect(promoted.content).toContain("memory:deploy-vpn-required");
    expect(promoted.content).toContain("Always connect the VPN before starting production deploys.");
  });

  test("blocked fixtures report why they were rejected", () => {
    const blocked = assessMemoryKnowledgePromotionCandidate(fixtureByName("subjective-preference").input);

    expect(blocked.promote).toBe(false);
    expect(blocked.blockedBy).toContain("subjective-memory");
    expect(blocked.score).toBe(0);
  });

  test("near-miss fixtures expose negative signals instead of silently failing", () => {
    const rejected = assessMemoryKnowledgePromotionCandidate(fixtureByName("weak-single-signal").input);

    expect(rejected.promote).toBe(false);
    expect(rejected.score).toBeLessThan(rejected.threshold);
    expect(rejected.negativeSignals).toContain("only one reinforcing feedback event");
    expect(rejected.negativeSignals).not.toContain("tentative language");
  });
});
