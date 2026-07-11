// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { decodeImproveResult } from "../src/core/improve-result";

const common = {
  ok: true,
  scope: { mode: "all" },
  dryRun: false,
  memorySummary: { eligible: 1, derived: 0 },
  plannedRefs: [],
  actions: [],
};

describe("decodeImproveResult", () => {
  test("decodes v1 legacyProfile without inventing a strategy", () => {
    const decoded = decodeImproveResult({ schemaVersion: 1, profile: "nightly", ...common });
    expect(decoded.strategy).toBeNull();
    expect(decoded.legacyProfile).toBe("nightly");
  });

  test("decodes v2 strategy without inventing a legacyProfile", () => {
    const decoded = decodeImproveResult({ schemaVersion: 2, strategy: "thorough", ...common });
    expect(decoded.strategy).toBe("thorough");
    expect(decoded.legacyProfile).toBeNull();
  });

  test("rejects mixed selector generations", () => {
    expect(() => decodeImproveResult({ schemaVersion: 1, strategy: "default", ...common })).toThrow(/unknown field/);
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "default", profile: "old", ...common })).toThrow(
      /unknown field/,
    );
  });

  test("rejects unknown versions, unknown fields, and malformed required fields", () => {
    expect(() => decodeImproveResult({ schemaVersion: 3, ...common })).toThrow(/unsupported schemaVersion/);
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "default", extra: true, ...common })).toThrow(
      /unknown field/,
    );
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "", ...common })).toThrow(/non-empty/);
    expect(() => decodeImproveResult("not json")).toThrow(/not valid JSON/);
  });
});
