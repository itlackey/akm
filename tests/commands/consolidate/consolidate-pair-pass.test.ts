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
  buildPairUserPrompt,
  decideRetirement,
  isOwnTwinOrParent,
  type PairAsset,
  type PairSide,
  parsePairJudgeResponse,
  tombstoneReason,
} from "../../../src/commands/improve/consolidate/pair-pass";

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

describe("complete pair evidence (#1195)", () => {
  for (const offset of [11_900, 11_990, 12_100]) {
    for (const uniqueSide of ["A", "B"] as const) {
      for (const padding of ["x", "界🙂"]) {
        test(`keeps ${uniqueSide}'s claim at ${offset} with ${padding} padding`, () => {
          const claim = "Recovery requires vault key K-1195 from the offline safe.";
          const body = `${padding.repeat(13_000).slice(0, offset)}${claim}${padding.repeat(500)}`;
          const a = { ...side(), raw: uniqueSide === "A" ? body : "Shared facts." };
          const b = { ...side({ ref: "memories/b" }), raw: uniqueSide === "B" ? body : "Shared facts." };
          const prompt = buildPairUserPrompt(a, b);
          expect(prompt).toContain(body);
          expect(prompt).toContain(claim);
        });
      }
    }
  }
});

describe("parsePairJudgeResponse", () => {
  for (const [onlyInA, onlyInB, relation, redundant] of [
    [[], [], "duplicate", "A"],
    [[], ["port 9000"], "subsumed", "A"],
    [["port 8000"], [], "subsumed", "B"],
    [["port 8000"], ["port 9000"], "overlap", null],
  ] as const) {
    test(`derives ${relation}/${redundant} from complete claim lists ${JSON.stringify([onlyInA, onlyInB])}`, () => {
      expect(
        parsePairJudgeResponse(JSON.stringify({ onlyInA, onlyInB, confidence: 0.8, reason: "comparison" })),
      ).toEqual({
        onlyInA: [...onlyInA],
        onlyInB: [...onlyInB],
        relation,
        redundant,
        confidence: 0.8,
        reason: "comparison",
      });
    });
  }

  test("an extra model deletion pointer cannot override a distinct claim", () => {
    const verdict = parsePairJudgeResponse(
      JSON.stringify({
        onlyInA: ["requires offline key K-1195"],
        onlyInB: [],
        confidence: 1,
        relation: "duplicate",
        redundant: "A",
        reason: "inconsistent old response",
      }),
    );
    expect(verdict?.relation).toBe("subsumed");
    expect(verdict?.redundant).toBe("B");
    expect(verdict?.onlyInA).toEqual(["requires offline key K-1195"]);
  });

  test("rejects missing, malformed, or non-string claim lists instead of treating them as empty", () => {
    for (const bad of [undefined, null, "", [1]]) {
      for (const side of ["onlyInA", "onlyInB"]) {
        expect(
          parsePairJudgeResponse(JSON.stringify({ onlyInA: [], onlyInB: [], confidence: 1, [side]: bad })),
        ).toBeUndefined();
      }
    }
  });

  test("rejects missing or non-numeric confidence", () => {
    for (const confidence of [undefined, null, "0.8"]) {
      expect(parsePairJudgeResponse(JSON.stringify({ onlyInA: [], onlyInB: [], confidence }))).toBeUndefined();
    }
  });

  test("clamps out-of-range confidence rather than rejecting", () => {
    expect(parsePairJudgeResponse(JSON.stringify({ onlyInA: [], onlyInB: [], confidence: 1.4 }))?.confidence).toBe(1);
  });

  test("rejects malformed JSON and non-object payloads", () => {
    expect(parsePairJudgeResponse("not json")).toBeUndefined();
    expect(parsePairJudgeResponse("[]")).toBeUndefined();
  });

  test("a missing reason defaults to an empty string", () => {
    expect(parsePairJudgeResponse(JSON.stringify({ onlyInA: [], onlyInB: [], confidence: 0.5 }))?.reason).toBe("");
  });

  test("keeps listed claims trimmed and drops blank items", () => {
    const verdict = parsePairJudgeResponse(
      JSON.stringify({ onlyInA: [" `--force` flag ", ""], onlyInB: [], confidence: 1 }),
    );
    expect(verdict?.onlyInA).toEqual(["`--force` flag"]);
    expect(verdict?.onlyInB).toEqual([]);
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
  const NONE = { onlyInA: [], onlyInB: [] };

  test("duplicate retires the older side, keeps the newer", () => {
    const decision = decideRetirement("duplicate", null, older, newer, NONE);
    expect(decision?.retired).toBe(older);
    expect(decision?.successor).toBe(newer);
  });

  test("supersedes retires the older side, keeps the newer — same rule as duplicate", () => {
    const decision = decideRetirement("supersedes", "A", older, newer, NONE);
    expect(decision?.retired).toBe(older);
    expect(decision?.successor).toBe(newer);
  });

  test("subsumed retires whichever side the judge names redundant", () => {
    expect(decideRetirement("subsumed", "A", older, newer, NONE)?.retired).toBe(older);
    expect(decideRetirement("subsumed", "B", older, newer, NONE)?.retired).toBe(newer);
  });

  test("subsumed with a missing or invalid redundant pointer proposes nothing", () => {
    expect(decideRetirement("subsumed", null, older, newer, NONE)).toBeUndefined();
  });

  test("never retires a side the judge listed a claim for, whatever the label says", () => {
    expect(
      decideRetirement("duplicate", "A", older, newer, { onlyInA: ["`-readonly` flag"], onlyInB: [] }),
    ).toBeUndefined();
    expect(decideRetirement("supersedes", "A", older, newer, { onlyInA: ["port 8080"], onlyInB: [] })).toBeUndefined();
    expect(decideRetirement("subsumed", "B", older, newer, { onlyInA: [], onlyInB: ["a path"] })).toBeUndefined();
    // The other side's own claims do not block: the redundant side is the one that must be empty.
    expect(decideRetirement("subsumed", "A", older, newer, { onlyInA: [], onlyInB: ["a path"] })?.retired).toBe(older);
  });

  test("contradicts, overlap and unrelated never propose a retirement", () => {
    expect(decideRetirement("contradicts", null, older, newer, NONE)).toBeUndefined();
    expect(decideRetirement("overlap", null, older, newer, NONE)).toBeUndefined();
    expect(decideRetirement("unrelated", null, older, newer, NONE)).toBeUndefined();
  });
});
