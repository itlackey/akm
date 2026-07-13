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

const publishedStalenessDetection = {
  considered: 8,
  deprecated: 2,
  confirmed: 4,
  skipped: 2,
  durationMs: 125,
  warnings: ["one candidate was unreadable"],
};

describe("decodeImproveResult", () => {
  test("decodes v1 legacyProfile without inventing a strategy", () => {
    const decoded = decodeImproveResult({ schemaVersion: 1, profile: "nightly", ...common });
    expect(decoded.strategy).toBeNull();
    expect(decoded.legacyProfile).toBe("nightly");
    expect(decoded.normalizedLegacyPartial).toBe(false);
  });

  test("decodes v2 strategy without inventing a legacyProfile", () => {
    const decoded = decodeImproveResult({ schemaVersion: 2, strategy: "thorough", ...common });
    expect(decoded.strategy).toBe("thorough");
    expect(decoded.legacyProfile).toBeNull();
    expect(decoded.normalizedLegacyPartial).toBe(false);
  });

  test("accepts the exact published 0.8 stalenessDetection result on v1 only", () => {
    const decoded = decodeImproveResult({
      schemaVersion: 1,
      profile: "nightly",
      ...common,
      stalenessDetection: publishedStalenessDetection,
    });

    expect((decoded.envelope as unknown as Record<string, unknown>).stalenessDetection).toEqual(
      publishedStalenessDetection,
    );
    expect(decoded.normalizedLegacyPartial).toBe(false);
    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "default",
        ...common,
        stalenessDetection: publishedStalenessDetection,
      }),
    ).toThrow(/stalenessDetection/);
  });

  test("rejects malformed published stalenessDetection near-misses", () => {
    const { warnings: _warnings, ...withoutWarnings } = publishedStalenessDetection;
    for (const stalenessDetection of [
      withoutWarnings,
      { ...publishedStalenessDetection, skipped: "2" },
      { ...publishedStalenessDetection, warnings: [1] },
      { ...publishedStalenessDetection, extra: true },
      [],
    ]) {
      expect(() =>
        decodeImproveResult({ schemaVersion: 1, profile: "nightly", ...common, stalenessDetection }),
      ).toThrow(/stalenessDetection/);
    }
  });

  test("normalizes only interrupted v1 rows that predate memorySummary", () => {
    const { memorySummary: _memorySummary, ...withoutSummary } = common;
    const interrupted = {
      schemaVersion: 1,
      profile: "nightly",
      ...withoutSummary,
      ok: false,
      terminated: { reason: "signal", at: "2026-07-01T00:00:00Z" },
    };
    const decoded = decodeImproveResult(interrupted);
    expect(decoded.normalizedLegacyPartial).toBe(true);
    expect(decoded.envelope.memorySummary).toEqual({ eligible: 0, derived: 0 });

    for (const malformed of [
      { ...interrupted, ok: true },
      { ...interrupted, plannedRefs: [{ ref: "memory:unfinished" }] },
      { ...interrupted, actions: [{ ref: "memory:unfinished", mode: "error", result: { ok: false } }] },
      { ...interrupted, guidance: "not part of the historical partial envelope" },
      { ...interrupted, terminated: {} },
    ]) {
      expect(() => decodeImproveResult(malformed)).toThrow(/memorySummary/);
    }
    expect(() => decodeImproveResult({ schemaVersion: 1, profile: "nightly", ...withoutSummary })).toThrow(
      /memorySummary/,
    );
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
