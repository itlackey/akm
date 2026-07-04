import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROMOTION_POLICY_SELECTION,
  selectPromotionPolicy,
} from "../../../src/commands/improve/distill-promotion-policy";
import { DEFAULT_PROMOTION_POLICY_CORPUS } from "./promotion-policy-corpus";

describe("distill promotion policy benchmark", () => {
  // The production selection is a frozen constant (no grid search runs at
  // module import). Re-run the grid search over the benchmark corpus here and
  // assert it still reproduces the frozen constant, so the freeze cannot drift
  // silently from what the corpus would actually select.
  test("frozen DEFAULT_PROMOTION_POLICY_SELECTION matches a live grid search over the corpus", () => {
    const recomputed = selectPromotionPolicy(DEFAULT_PROMOTION_POLICY_CORPUS);
    expect(recomputed).toEqual(DEFAULT_PROMOTION_POLICY_SELECTION);
  });
});
