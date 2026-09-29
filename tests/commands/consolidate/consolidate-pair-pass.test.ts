// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure unit tests for the consolidate pair pass's response parsing and
 * outcome-decision logic (0.9.17-alpha.9). No DB, network or spawned
 * process — see tests/commands/ vs tests/integration/ (ORG-05).
 */

import { describe, expect, test } from "bun:test";
import {
  decideRetirement,
  isOwnTwinOrParent,
  type PairAsset,
  type PairSide,
  parsePairJudgeResponse,
  tombstoneReason,
} from "../../../src/commands/improve/consolidate/pair-pass";
import type { ConsolidatePairJudgeLabel } from "../../../src/core/improve-types";

function asset(overrides: Partial<PairAsset> = {}): PairAsset {
  return { ref: "memories/a", type: "memory", name: "a", filePath: "/tmp/a.md", entryId: 1, ...overrides };
}

function side(overrides: Partial<PairAsset> = {}): PairSide {
  return {
    asset: asset(overrides),
    frontmatter: {},
    raw: "Body.\n",
    createdIso: "2026-01-01T00:00:00.000Z",
    updatedIso: "2026-01-01T00:00:00.000Z",
  };
}

describe("parsePairJudgeResponse", () => {
  test("accepts a well-formed verdict for each of the six labels", () => {
    const labels: ConsolidatePairJudgeLabel[] = [
      "duplicate",
      "subsumed",
      "supersedes",
      "contradicts",
      "overlap",
      "unrelated",
    ];
    for (const relation of labels) {
      const raw = JSON.stringify({ relation, redundant: null, stale: null, confidence: 0.8, reason: "why" });
      expect(parsePairJudgeResponse(raw)?.relation).toBe(relation);
    }
  });

  test("accepts redundant: A or B", () => {
    const raw = JSON.stringify({ relation: "duplicate", redundant: "A", stale: null, confidence: 0.9, reason: "x" });
    expect(parsePairJudgeResponse(raw)?.redundant).toBe("A");
  });

  test("rejects an unknown relation label", () => {
    const raw = JSON.stringify({ relation: "merge", redundant: null, stale: null, confidence: 0.9, reason: "x" });
    expect(parsePairJudgeResponse(raw)).toBeUndefined();
  });

  test("rejects an invalid redundant value", () => {
    const raw = JSON.stringify({ relation: "duplicate", redundant: "C", stale: null, confidence: 0.9, reason: "x" });
    expect(parsePairJudgeResponse(raw)).toBeUndefined();
  });

  test("rejects a missing or non-numeric confidence", () => {
    const raw = JSON.stringify({ relation: "duplicate", redundant: null, stale: null, reason: "x" });
    expect(parsePairJudgeResponse(raw)).toBeUndefined();
  });

  test("clamps an out-of-range confidence into [0, 1] rather than rejecting it", () => {
    const raw = JSON.stringify({ relation: "overlap", redundant: null, stale: null, confidence: 1.4, reason: "x" });
    expect(parsePairJudgeResponse(raw)?.confidence).toBe(1);
  });

  test("rejects malformed JSON and non-object payloads", () => {
    expect(parsePairJudgeResponse("not json")).toBeUndefined();
    expect(parsePairJudgeResponse("[]")).toBeUndefined();
  });

  test("a missing reason defaults to an empty string rather than rejecting", () => {
    const raw = JSON.stringify({ relation: "unrelated", redundant: null, stale: null, confidence: 0.5 });
    expect(parsePairJudgeResponse(raw)?.reason).toBe("");
  });
});

describe("isOwnTwinOrParent", () => {
  test("a memory and its own .derived child are twins", () => {
    const parent = asset({ ref: "memories/foo", type: "memory", name: "foo" });
    const child = asset({ ref: "memories/foo.derived", type: "memory", name: "foo.derived" });
    expect(isOwnTwinOrParent(parent, child)).toBe(true);
    expect(isOwnTwinOrParent(child, parent)).toBe(true);
  });

  test("two different .derived children of the same parent are NOT twins (a legitimate candidate pair)", () => {
    const a = asset({ ref: "memories/foo.derived", type: "memory", name: "foo.derived" });
    const b = asset({ ref: "memories/bar.derived", type: "memory", name: "bar.derived" });
    expect(isOwnTwinOrParent(a, b)).toBe(false);
  });

  test("unrelated memories are not twins", () => {
    const a = asset({ ref: "memories/foo", type: "memory", name: "foo" });
    const b = asset({ ref: "memories/bar", type: "memory", name: "bar" });
    expect(isOwnTwinOrParent(a, b)).toBe(false);
  });

  test("a knowledge/lesson pair is never a twin, even with matching names", () => {
    const a = asset({ ref: "knowledge/foo", type: "knowledge", name: "foo" });
    const b = asset({ ref: "knowledge/foo.derived", type: "knowledge", name: "foo.derived" });
    expect(isOwnTwinOrParent(a, b)).toBe(false);
  });
});

describe("tombstoneReason", () => {
  test("supersedes maps to superseded; duplicate/subsumed pass through unchanged", () => {
    expect(tombstoneReason("supersedes")).toBe("superseded");
    expect(tombstoneReason("duplicate")).toBe("duplicate");
    expect(tombstoneReason("subsumed")).toBe("subsumed");
  });
});

describe("decideRetirement — the calibrated outcome table (owner grades, O5)", () => {
  const older = side({ ref: "memories/older" });
  const newer = side({ ref: "memories/newer" });

  test("duplicate retires the older side, keeps the newer", () => {
    const decision = decideRetirement("duplicate", null, older, newer);
    expect(decision?.retired).toBe(older);
    expect(decision?.successor).toBe(newer);
  });

  test("supersedes retires the older side, keeps the newer — same rule as duplicate", () => {
    const decision = decideRetirement("supersedes", "A", older, newer);
    expect(decision?.retired).toBe(older);
    expect(decision?.successor).toBe(newer);
  });

  test("subsumed retires whichever side the judge names redundant", () => {
    expect(decideRetirement("subsumed", "A", older, newer)?.retired).toBe(older);
    expect(decideRetirement("subsumed", "B", older, newer)?.retired).toBe(newer);
  });

  test("subsumed with a missing or invalid redundant pointer proposes nothing", () => {
    expect(decideRetirement("subsumed", null, older, newer)).toBeUndefined();
  });

  test("contradicts, overlap and unrelated never propose a retirement", () => {
    expect(decideRetirement("contradicts", null, older, newer)).toBeUndefined();
    expect(decideRetirement("overlap", null, older, newer)).toBeUndefined();
    expect(decideRetirement("unrelated", null, older, newer)).toBeUndefined();
  });
});
