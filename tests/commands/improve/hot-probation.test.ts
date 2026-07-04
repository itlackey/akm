// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 0c — hot-probation intake buffer helpers — unit tests.
 *
 * Covers:
 *   - isHotProbation / shouldSkipHotProbationInLlm / buildHotProbationFrontmatter:
 *     captureMode: hot-probation helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  buildHotProbationFrontmatter,
  CAPTURE_MODE_HOT_PROBATION,
  isHotProbation,
  shouldSkipHotProbationInLlm,
} from "../../../src/commands/improve/hot-probation";

describe("CAPTURE_MODE_HOT_PROBATION constant", () => {
  test("has the expected value", () => {
    expect(CAPTURE_MODE_HOT_PROBATION).toBe("hot-probation");
  });
});

describe("isHotProbation", () => {
  test("returns true for hot-probation captureMode", () => {
    expect(isHotProbation("hot-probation")).toBe(true);
  });

  test("returns false for other captureModes", () => {
    expect(isHotProbation("hot")).toBe(false);
    expect(isHotProbation("normal")).toBe(false);
    expect(isHotProbation(undefined)).toBe(false);
    expect(isHotProbation(null)).toBe(false);
    expect(isHotProbation("")).toBe(false);
  });
});

describe("shouldSkipHotProbationInLlm", () => {
  test("returns true when frontmatter has captureMode: hot-probation", () => {
    expect(shouldSkipHotProbationInLlm({ captureMode: "hot-probation" })).toBe(true);
  });

  test("returns false for other values", () => {
    expect(shouldSkipHotProbationInLlm({ captureMode: "hot" })).toBe(false);
    expect(shouldSkipHotProbationInLlm({})).toBe(false);
    expect(shouldSkipHotProbationInLlm({ captureMode: undefined })).toBe(false);
  });
});

describe("buildHotProbationFrontmatter", () => {
  test("returns captureMode: hot-probation object", () => {
    const fm = buildHotProbationFrontmatter();
    expect(fm).toEqual({ captureMode: "hot-probation" });
    expect(fm.captureMode).toBe(CAPTURE_MODE_HOT_PROBATION);
  });
});
