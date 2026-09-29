import { describe, expect, test } from "bun:test";
import {
  assessMemoryKnowledgePromotionCandidate,
  deriveKnowledgeRef,
  type PromotionPolicyInput,
} from "../../../src/commands/improve/distill-promotion-policy";
import { assembleAssetFromString } from "../../../src/core/asset/asset-serialize";

function memoryInput(
  name: string,
  frontmatter: string[],
  body: string,
  feedbackSignals: Array<"positive" | "negative">,
): PromotionPolicyInput {
  return {
    inputRef: `memories/${name}`,
    assetContent: assembleAssetFromString(frontmatter.join("\n"), body),
    feedbackEvents: feedbackSignals.map((signal) => ({ metadata: { signal } })),
  };
}

const VPN_FRONTMATTER = [
  "description: VPN required before deploy",
  "source: skill:deploy",
  "observed_at: 2026-04-20",
  "confidence: 0.95",
  "tags: [deploy, ops]",
];
const VPN_BODY = "Always connect the VPN before starting production deploys.";

describe("distill promotion policy", () => {
  test("does not copy a memory project scope into the reusable knowledge namespace", () => {
    expect(deriveKnowledgeRef("memories/project-a/oauth-refresh-race")).toBe("knowledge/oauth-refresh-race");
  });

  test("a reinforced, well-sourced memory promotes and emits knowledge payload content", () => {
    const promoted = assessMemoryKnowledgePromotionCandidate(
      memoryInput("deploy-vpn-required", VPN_FRONTMATTER, VPN_BODY, ["positive", "positive"]),
    );

    expect(promoted.promote).toBe(true);
    expect(promoted.modelName).toBe("balanced-evidence");
    expect(promoted.content).toContain("xrefs:");
    expect(promoted.content).toContain("memories/deploy-vpn-required");
    expect(promoted.content).toContain(VPN_BODY);
  });

  test("blocked memories report why they were rejected", () => {
    const blocked = assessMemoryKnowledgePromotionCandidate(
      memoryInput(
        "subjective-preference",
        [...VPN_FRONTMATTER.slice(0, 1), "subjective: true", ...VPN_FRONTMATTER.slice(1, 4)],
        "I prefer connecting the VPN before starting production deploys.",
        ["positive", "positive"],
      ),
    );

    expect(blocked.promote).toBe(false);
    expect(blocked.blockedBy).toContain("subjective-memory");
    expect(blocked.score).toBe(0);
  });

  test("near misses expose negative signals instead of silently failing", () => {
    const rejected = assessMemoryKnowledgePromotionCandidate(
      memoryInput("weak-single-signal", VPN_FRONTMATTER, VPN_BODY, ["positive"]),
    );

    expect(rejected.promote).toBe(false);
    expect(rejected.score).toBeLessThan(rejected.threshold);
    expect(rejected.negativeSignals).toContain("only one reinforcing feedback event");
    expect(rejected.negativeSignals).not.toContain("tentative language");
  });

  test("a negative feedback event outweighs reinforcement", () => {
    const contested = assessMemoryKnowledgePromotionCandidate(
      memoryInput("contested-fact", VPN_FRONTMATTER, VPN_BODY, ["positive", "negative", "positive"]),
    );

    expect(contested.promote).toBe(false);
    expect(contested.negativeSignals).toContain("1 negative feedback event");
  });
});
