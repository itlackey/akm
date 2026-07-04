// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the fall-through contract of `promoteMemoryToKnowledge`, the
 * memory→knowledge promotion branch extracted out of `akmDistill`.
 *
 * The positive (promotion fires) path is characterization-covered end-to-end in
 * `tests/distill.test.ts` ("reinforced stable memory can queue a knowledge
 * proposal without LLM help"). Here we pin the `null` return contract — the
 * caller relies on it to fall through to the ordinary lesson/knowledge path —
 * and prove the branch short-circuits BEFORE touching any I/O seam (chat,
 * lookup) when it is not a promotion candidate.
 */

import { describe, expect, test } from "bun:test";
import {
  type PromoteMemoryContext,
  promoteMemoryToKnowledge,
} from "../../../src/commands/improve/distill/promote-memory";
import type { AkmConfig } from "../../../src/core/config/config";

function makeCtx(overrides: Partial<PromoteMemoryContext>): PromoteMemoryContext {
  return {
    targetKind: "lesson",
    inputRef: "memory:deploy-fact",
    assetContent: "Some reinforced memory content about deploys.",
    filteredEvents: [],
    config: {} as AkmConfig,
    chat: async () => {
      throw new Error("chat must not be called on the fall-through path");
    },
    stash: "/nonexistent-stash-should-not-be-touched",
    lookup: async () => {
      throw new Error("lookup must not be called on the fall-through path");
    },
    fetchSimilarLessonsFn: async () => {
      throw new Error("fetchSimilarLessonsFn must not be called on the fall-through path");
    },
    existingRefVocabulary: new Set<string>(),
    outcomeWeightEnabled: true,
    eligMeta: {},
    exclusionSetSize: 0,
    filteredFeedbackCount: 0,
    feedbackFullyFiltered: false,
    ...overrides,
  };
}

describe("promoteMemoryToKnowledge — fall-through contract", () => {
  test("targetKind 'lesson' short-circuits to null without touching any I/O seam", async () => {
    const result = await promoteMemoryToKnowledge(makeCtx({ targetKind: "lesson" }));
    expect(result).toBeNull();
  });

  test("returns null (no promotion) when the ref has zero reinforcing feedback", async () => {
    // With no positive feedback signals the deterministic promotion policy does
    // not fire, so the branch falls through — again without any I/O.
    const result = await promoteMemoryToKnowledge(makeCtx({ targetKind: "auto", filteredEvents: [] }));
    expect(result).toBeNull();
  });
});
