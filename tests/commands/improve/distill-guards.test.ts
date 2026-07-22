// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b distill-stage guards — unit tests.
 *
 * Covers:
 *   - buildClsContext: CLS adjacent-lesson context block construction (step 9).
 *   - checkDistillFidelity: heuristic negation-pattern contradiction detection (step 10).
 */

import { describe, expect, test } from "bun:test";
import { buildClsContext, checkDistillFidelity } from "../../../src/commands/improve/distill-guards";

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

  test("returns formatted context block when enabled and items present", () => {
    const ctx = buildClsContext(
      [
        { ref: "lessons/alpha", content: "Learn from past mistakes." },
        { ref: "knowledge/beta", content: "The sky is blue." },
      ],
      { enabled: true },
    );
    expect(ctx).toContain("## Existing adjacent lessons / knowledge (CLS context)");
    expect(ctx).toContain("lessons/alpha");
    expect(ctx).toContain("Learn from past mistakes.");
    expect(ctx).toContain("knowledge/beta");
    expect(ctx).toContain("The sky is blue.");
  });

  test("truncates long content to 400 chars", () => {
    const longContent = "x".repeat(1000);
    const ctx = buildClsContext([{ ref: "lessons/long", content: longContent }], { enabled: true });
    // Only first 400 chars should appear
    expect(ctx).toContain("x".repeat(400));
    expect(ctx).not.toContain("x".repeat(401));
  });
});

// ── checkDistillFidelity ──────────────────────────────────────────────────────

describe("checkDistillFidelity", () => {
  test("returns no contradiction when disabled", () => {
    const result = checkDistillFidelity("you must never deploy on Friday", ["always deploy on Friday"], {
      enabled: false,
    });
    expect(result.contradictionDetected).toBe(false);
  });

  test("returns no contradiction when sourceBodies is empty", () => {
    const result = checkDistillFidelity("you must never fail", [], { enabled: true });
    expect(result.contradictionDetected).toBe(false);
  });

  test("returns no contradiction when proposal has no strong claims", () => {
    const result = checkDistillFidelity("this is a mild suggestion", ["this is a mild suggestion"], { enabled: true });
    expect(result.contradictionDetected).toBe(false);
  });

  test("detects contradiction: proposal 'always X' vs source 'never X'", () => {
    // Proposal: "always deploy" creates positive claim { polarity: positive, term: "deploy" }
    // Source: "never deploy" creates negative claim for "deploy" → contradiction
    const result = checkDistillFidelity(
      "always deploy the latest build immediately",
      ["never deploy directly without review"],
      { enabled: true },
    );
    expect(result.contradictionDetected).toBe(true);
    expect(result.reason).toContain("deploy");
  });

  test("detects contradiction: proposal 'never X' vs source 'always X'", () => {
    // Proposal: "never push" (negative), source: "always push" (positive) → contradiction
    const result = checkDistillFidelity("never push to main without CI", ["always push to main when tests pass"], {
      enabled: true,
    });
    expect(result.contradictionDetected).toBe(true);
  });

  test("no false positive when proposal and source agree", () => {
    const result = checkDistillFidelity("always test before merging", ["always test before merging your changes"], {
      enabled: true,
    });
    // Both say "always test" — not a contradiction
    expect(result.contradictionDetected).toBe(false);
  });
});
