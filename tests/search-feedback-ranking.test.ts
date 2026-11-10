// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { openStateDatabase } from "../src/core/state-db";
import { akmIndex } from "../src/indexer/indexer";
import {
  applyFeedback,
  FEEDBACK_WEIGHT,
  feedbackFactor,
  RRF_K,
  reciprocalRankFusion,
} from "../src/indexer/search/ranking";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

/**
 * Recorded user feedback scales the fused search score: more positives rank an
 * asset higher, more negatives lower, by the same rule for every asset.
 */

describe("feedbackFactor", () => {
  test("is neutral without feedback and rises with positives, falls with negatives", () => {
    expect(feedbackFactor({ pos: 0, neg: 0 })).toBe(1);
    const positives = [0, 1, 2, 5, 20, 100].map((pos) => feedbackFactor({ pos, neg: 0 }));
    const negatives = [0, 1, 2, 5, 20, 100].map((neg) => feedbackFactor({ pos: 0, neg }));
    for (let i = 1; i < positives.length; i++) {
      expect(positives[i]).toBeGreaterThan(positives[i - 1] as number);
      expect(negatives[i]).toBeLessThan(negatives[i - 1] as number);
    }
  });

  test("gains less per vote as votes accumulate, and stays small", () => {
    const gain = (from: number, to: number) =>
      feedbackFactor({ pos: to, neg: 0 }) - feedbackFactor({ pos: from, neg: 0 });
    expect(gain(0, 1)).toBeGreaterThan(gain(1, 2));
    expect(gain(1, 2)).toBeGreaterThan(gain(10, 11));
    expect(feedbackFactor({ pos: 1000, neg: 0 })).toBeLessThan(1 + 0.4);
  });

  test("a positive and a negative cancel", () => {
    expect(feedbackFactor({ pos: 5, neg: 5 })).toBe(1);
    expect(feedbackFactor({ pos: 5, neg: 0 }) - 1).toBeCloseTo(1 - feedbackFactor({ pos: 0, neg: 5 }), 12);
    expect(FEEDBACK_WEIGHT).toBeGreaterThan(0);
  });
});

describe("applyFeedback", () => {
  test("leaves hits without feedback untouched and reorders the rest", () => {
    const ref = (id: number, name: string) => ({ id, itemRef: `stash//knowledge/${name}` });
    const fused = reciprocalRankFusion([[ref(1, "a"), ref(2, "b"), ref(3, "c")], []]);
    const out = applyFeedback(fused, new Map([["stash//knowledge/c", { pos: 5, neg: 0 }]]));
    expect(out.map((candidate) => candidate.itemRef)).toEqual([
      "stash//knowledge/c",
      "stash//knowledge/a",
      "stash//knowledge/b",
    ]);
    expect(out[1]?.score).toBe(fused[0]?.score as number);
  });
});

describe("akm search with recorded feedback", () => {
  let storage: IsolatedAkmStorage;
  let stashDir = "";

  beforeEach(async () => {
    storage = withIsolatedAkmStorage();
    stashDir = storage.stashDir;
    for (const [name, extra] of [
      ["alpha", "one"],
      ["beta", "two"],
      ["gamma", "three"],
    ] as const) {
      const file = path.join(stashDir, "knowledge", `${name}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\ndescription: zebra note\n---\nzebra ${extra} stripes\n`);
    }
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
    });
    await akmIndex({ stashDir, full: true });
  });

  afterEach(() => {
    storage.cleanup();
  });

  async function order(): Promise<string[]> {
    const result = await akmSearch({ query: "zebra", skipLogging: true });
    return result.results.map((hit) => ("ref" in hit ? hit.ref : "")).filter(Boolean);
  }

  async function vote(ref: string, signal: "positive" | "negative", times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      const args = ["feedback", ref, `--${signal}`, "--format=json"];
      if (signal === "negative") args.push("--reason", "test");
      const { code, stderr } = await runCliCapture(args);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    }
  }

  test("5 positives outrank 2 positives outrank none, for otherwise equal hits", async () => {
    const base = await order();
    expect(base).toHaveLength(3);
    const [first, second, third] = base as [string, string, string];
    await vote(third, "positive", 5);
    await vote(second, "positive", 2);
    expect(await order()).toEqual([third, second, first]);
  });

  test("negatives demote symmetrically", async () => {
    const base = await order();
    const [first, second, third] = base as [string, string, string];
    await vote(first, "negative", 5);
    await vote(second, "negative", 2);
    expect(await order()).toEqual([third, second, first]);
  });

  /** A negative that carries an exact fix, which `akm feedback` applies at once. */
  async function fixNegative(
    ref: string,
    replacement = "one stripe",
  ): Promise<{ code: number | null; json: { fix?: { proposalId: string } } }> {
    const { stdout, stderr, code } = await runCliCapture([
      ...["feedback", ref, "--negative", "--format=json", "--reason", "The count is wrong."],
      ...["--replace", "one stripes", "--with", replacement, "--source", "test"],
    ]);
    return { code, json: JSON.parse(stdout.trim() || stderr.trim()) };
  }

  test("a negative whose exact fix was applied stops demoting the corrected asset (#1249)", async () => {
    const base = await order();
    const first = base[0] as string;
    const { code, json } = await fixNegative(first);
    expect(code).toBe(0);
    expect(json.fix?.proposalId).toBeString();
    expect(await order()).toEqual(base);
  });

  test("a negative whose fix was refused still demotes the asset", async () => {
    const base = await order();
    const [first, second, third] = base as [string, string, string];
    // The accept refuses text holding an output-redaction marker, so the event is recorded and the fix is not.
    const { code } = await fixNegative(first, "[REDACTED]");
    expect(code).not.toBe(0);
    expect(await order()).toEqual([second, first, third]);
  });

  test("a negative counts again once its fix is reverted", async () => {
    const base = await order();
    const [first, second, third] = base as [string, string, string];
    const { json } = await fixNegative(first);
    expect(await order()).toEqual(base);
    const reverted = await runCliCapture(["proposal", "revert", json.fix?.proposalId as string, "--format=json"]);
    expect(reverted.code).toBe(0);
    expect(await order()).toEqual([second, first, third]);
  });

  test("a negative without a fix still demotes after another negative's fix is applied", async () => {
    const base = await order();
    const [first, second, third] = base as [string, string, string];
    await vote(first, "negative", 1);
    expect((await fixNegative(first)).code).toBe(0);
    expect(await order()).toEqual([second, first, third]);
  });

  /** Record `times` user feedback events for `ref`, stamped `ageDays` ago (no index run purges them). */
  function seedFeedback(ref: string, signal: "positive" | "negative", times: number, ageDays: number): void {
    const db = openStateDatabase();
    try {
      for (let i = 0; i < times; i++) {
        db.prepare(
          `INSERT INTO usage_events (event_type, entry_ref, signal, source, created_at)
           VALUES ('feedback', ?, ?, 'user', datetime('now', ?))`,
        ).run(`stash//${ref}`, signal, `-${ageDays} days`);
      }
    } finally {
      db.close();
    }
  }

  test("feedback older than 90 days does not move the ranking, even before an index purges it (#1252)", async () => {
    const base = await order();
    const [first, , third] = base as [string, string, string];
    seedFeedback(third, "positive", 5, 91);
    seedFeedback(first, "negative", 5, 91);
    expect(await order()).toEqual(base);
    seedFeedback(third, "positive", 5, 89);
    expect(await order()).toEqual([third, first, base[1] as string]);
  });

  test("feedback that is not user-attributed does not move the ranking", async () => {
    const base = await order();
    const third = base[2] as string;
    await withEnv({ AKM_EVENT_SOURCE: "improve" }, () => vote(third, "positive", 5));
    expect(await order()).toEqual(base);
  });
});

/**
 * Reciprocal rank fusion of the lexical and vector channels.
 */

const ref = (id: number, name: string) => ({ id, itemRef: `stash//knowledge/${name}` });

describe("reciprocalRankFusion", () => {
  test("sums 1 / (60 + rank) over the channels that returned a candidate", () => {
    const fused = reciprocalRankFusion([
      [ref(1, "a"), ref(2, "b")],
      [ref(2, "b"), ref(3, "c")],
    ]);
    expect(RRF_K).toBe(60);
    expect(fused.map((candidate) => candidate.itemRef)).toEqual([
      "stash//knowledge/b",
      "stash//knowledge/a",
      "stash//knowledge/c",
    ]);
    expect(fused[0]).toEqual({ id: 2, itemRef: "stash//knowledge/b", score: 1 / 62 + 1 / 61, ranks: [2, 1] });
    expect(fused[1]).toEqual({ id: 1, itemRef: "stash//knowledge/a", score: 1 / 61, ranks: [1, undefined] });
    expect(fused[2]).toEqual({ id: 3, itemRef: "stash//knowledge/c", score: 1 / 62, ranks: [undefined, 2] });
  });

  test("weights the channels equally", () => {
    const fused = reciprocalRankFusion([[ref(1, "lexical-first")], [ref(2, "vector-first")]]);
    expect(fused[0]?.score).toBe(fused[1]?.score);
  });

  test("breaks equal scores by item ref, whatever the input order", () => {
    const channels = [
      [ref(1, "zeta"), ref(2, "alpha")],
      [ref(2, "alpha"), ref(1, "zeta")],
    ];
    const forward = reciprocalRankFusion(channels).map((candidate) => candidate.itemRef);
    const reversed = reciprocalRankFusion([...channels].reverse()).map((candidate) => candidate.itemRef);
    expect(forward).toEqual(["stash//knowledge/alpha", "stash//knowledge/zeta"]);
    expect(reversed).toEqual(forward);
  });

  test("counts a candidate once per channel, at its best rank", () => {
    const fused = reciprocalRankFusion([[ref(1, "a"), ref(1, "a")], []]);
    expect(fused).toEqual([{ id: 1, itemRef: "stash//knowledge/a", score: 1 / 61, ranks: [1, undefined] }]);
  });

  test("returns nothing for empty channels", () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});
