// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the pure content-repair + quality-validation stages extracted
 * from `akmDistill` into `distill/content-repair`. These functions were
 * previously inline in the god-function and only reachable end-to-end; the
 * extraction makes each normalization pass directly testable with no I/O.
 *
 * The known-good frontmatter strings mirror the ones proven valid by the
 * end-to-end auto-repair/auto-swap cases in `tests/distill.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  autoRepairLessonFrontmatter,
  autoSwapDescriptionWhenToUse,
  collectLessonQualityFindings,
  repairLessonDescriptionTruncation,
} from "../../../src/commands/improve/distill/content-repair";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";

const REF = "skill:deploy";

// A lesson whose description and when_to_use are both valid and distinct
// (the exact post-swap pairing proven valid by the e2e swap test).
const VALID_LESSON = `---
description: Always validate the ripgrep installation before running searches across very large monorepos.
when_to_use: When searching multi-thousand-file repos, prefer ripgrep to GNU grep because it respects .gitignore by default.
---

Body content explaining why ripgrep wins on large monorepos.`;

describe("autoRepairLessonFrontmatter", () => {
  test("no-op on a lesson that already has valid description + when_to_use", () => {
    expect(autoRepairLessonFrontmatter(VALID_LESSON, REF)).toBe(VALID_LESSON);
  });

  test("harvests a real 'When …' line from the body when when_to_use is missing", () => {
    const lesson = `---
description: Always validate the ripgrep installation before running searches across very large monorepos.
---

When searching multi-thousand-file repos, prefer ripgrep to GNU grep — it is faster and respects .gitignore by default.`;
    const out = autoRepairLessonFrontmatter(lesson, REF);
    const fm = parseFrontmatter(out).data as Record<string, unknown>;
    expect(typeof fm.when_to_use).toBe("string");
    expect((fm.when_to_use as string).toLowerCase()).toContain("when ");
    // Never the circular auto-repair fallback.
    expect((fm.when_to_use as string).toLowerCase()).not.toContain("when working with");
  });

  test("never fabricates placeholder fields when the body offers no harvestable prose", () => {
    // Missing both fields; the only body line is a YAML-like leak (skipped by
    // the harvester), so no description/when_to_use is synthesised.
    const lesson = "---\ntitle: junk\n---\n\ndescription: Key Takeaways";
    const fm = parseFrontmatter(autoRepairLessonFrontmatter(lesson, REF)).data as Record<string, unknown>;
    expect(fm.description).toBeUndefined();
    expect(fm.when_to_use).toBeUndefined();
  });
});

describe("autoSwapDescriptionWhenToUse", () => {
  test("swaps mis-fielded description/when_to_use and reports swapped:1", () => {
    const lesson = `---
description: When searching multi-thousand-file repos, prefer ripgrep to GNU grep because it respects .gitignore by default.
when_to_use: Always validate the ripgrep installation before running searches across very large monorepos.
---

Body content explaining why ripgrep wins on large monorepos.`;
    const { content, swapped } = autoSwapDescriptionWhenToUse(lesson, REF);
    expect(swapped).toBe(1);
    const fm = parseFrontmatter(content).data as Record<string, unknown>;
    expect((fm.description as string).toLowerCase()).not.toMatch(/^(when|if)\b/);
    expect((fm.when_to_use as string).toLowerCase()).toMatch(/^when\b/);
  });

  test("no swap (byte-identical) when description is already declarative", () => {
    const { content, swapped } = autoSwapDescriptionWhenToUse(VALID_LESSON, REF);
    expect(swapped).toBe(0);
    expect(content).toBe(VALID_LESSON);
  });
});

describe("repairLessonDescriptionTruncation", () => {
  test("no-op when there is no description field", () => {
    const lesson = "---\ntitle: x\n---\n\nBody.";
    expect(repairLessonDescriptionTruncation(lesson)).toBe(lesson);
  });

  test("no-op on an already-complete description", () => {
    expect(repairLessonDescriptionTruncation(VALID_LESSON)).toBe(VALID_LESSON);
  });
});

describe("collectLessonQualityFindings", () => {
  test("flags a missing description as invalid-description", () => {
    const lesson = `---
when_to_use: When searching multi-thousand-file repos, prefer ripgrep to GNU grep because it respects .gitignore by default.
---

Body.`;
    const findings = collectLessonQualityFindings(lesson, REF);
    expect(findings.some((f) => f.kind === "invalid-description")).toBe(true);
  });

  test("returns no findings for a valid, distinct lesson", () => {
    expect(collectLessonQualityFindings(VALID_LESSON, REF)).toEqual([]);
  });
});
