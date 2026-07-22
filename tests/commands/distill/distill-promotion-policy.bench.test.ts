import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROMOTION_POLICY_SELECTION,
  selectPromotionPolicy,
} from "../../../src/commands/improve/distill-promotion-policy";
import { CANDIDATE_MODELS, DEFAULT_PROMOTION_POLICY_CORPUS } from "./promotion-policy-corpus";

describe("distill promotion policy benchmark", () => {
  // The production selection is a frozen constant (no grid search runs at
  // module import). Re-run the grid search over the benchmark corpus here and
  // assert it still selects the frozen winner (model + threshold), so the
  // freeze cannot drift silently from what the corpus would actually select.
  // The rest of the grid-search payload (per-case results, baselines) is
  // recomputed live by the unit suite rather than frozen.
  test("frozen DEFAULT_PROMOTION_POLICY_SELECTION matches a live grid search over the corpus", () => {
    const recomputed = selectPromotionPolicy(DEFAULT_PROMOTION_POLICY_CORPUS, CANDIDATE_MODELS);
    expect({
      name: recomputed.selectedModel.name,
      threshold: recomputed.selectedModel.threshold,
    }).toEqual({
      name: DEFAULT_PROMOTION_POLICY_SELECTION.selectedModel.name,
      threshold: DEFAULT_PROMOTION_POLICY_SELECTION.threshold,
    });
  });
});
