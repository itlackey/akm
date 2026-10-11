// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Recorded user feedback scales the fused search score: more positives rank an
 * asset higher, more negatives lower, by the same rule for every asset.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { applyFeedback, FEEDBACK_WEIGHT, feedbackFactor, reciprocalRankFusion } from "../src/indexer/search/ranking";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

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
      defaultWriteTarget: "stash",
    });
    await akmIndex({ stashDir, full: true });
  });

  afterEach(() => {
    storage.cleanup();
  });

  async function order(): Promise<string[]> {
    const result = await akmSearch({ query: "zebra", skipLogging: true });
    return result.hits.map((hit) => ("ref" in hit ? hit.ref : "")).filter(Boolean);
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

  test("feedback that is not user-attributed does not move the ranking", async () => {
    const base = await order();
    const third = base[2] as string;
    await withEnv({ AKM_EVENT_SOURCE: "improve" }, () => vote(third, "positive", 5));
    expect(await order()).toEqual(base);
  });
});
