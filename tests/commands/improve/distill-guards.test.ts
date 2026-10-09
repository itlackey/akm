// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b distill-stage guards — unit tests.
 *
 * Covers:
 *   - buildClsContext: CLS adjacent-lesson context block construction (step 9).
 */

import { describe, expect, test } from "bun:test";
import { buildClsContext } from "../../../src/commands/improve/distill-guards";

// ── buildClsContext ───────────────────────────────────────────────────────────

describe("buildClsContext", () => {
  test("returns empty string when disabled", () => {
    const ctx = buildClsContext([{ ref: "lessons/x", content: "foo" }], { enabled: false });
    expect(ctx).toBe("");
  });

  test("returns empty string when adjacentItems is empty", () => {
    const ctx = buildClsContext([], { enabled: true });
    expect(ctx).toBe("");
  });

  test("is on unless the config turns it off", () => {
    expect(buildClsContext([{ ref: "lessons/x", content: "foo" }], {})).toContain("lessons/x");
  });

  test("returns formatted context block when enabled and items present", () => {
    const ctx = buildClsContext(
      [
        { ref: "lessons/alpha", content: "Learn from past mistakes." },
        { ref: "knowledge/beta", content: "The sky is blue." },
      ],
      { enabled: true },
    );
    expect(ctx).toContain("## Related assets already in the library");
    expect(ctx).toContain("answer NONE");
    expect(ctx).toContain("lessons/alpha");
    expect(ctx).toContain("Learn from past mistakes.");
    expect(ctx).toContain("knowledge/beta");
    expect(ctx).toContain("The sky is blue.");
  });

  test("truncates long content to 600 chars", () => {
    const longContent = "x".repeat(1000);
    const ctx = buildClsContext([{ ref: "lessons/long", content: longContent }], { enabled: true });
    // Only first 600 chars should appear
    expect(ctx).toContain("x".repeat(600));
    expect(ctx).not.toContain("x".repeat(601));
  });
});
