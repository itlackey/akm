// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { DUPLICATE_COSINE, findTopics, nameTopic, topicCount, words } from "../src/workspace/graph-topics";

/** `n` vectors around `centre`, each a little different, in 8 dimensions. */
const around = (centre: number[], n: number, spread: number, seed: number) =>
  Array.from({ length: n }, (_, i) =>
    Float32Array.from(centre.map((c, d) => c + (((i * 31 + d * 17 + seed) % 11) - 5) * spread)),
  );

test("assets with alike vectors share a topic, named by the words particular to it, the same on every read", async () => {
  const deploy = around([1, 0, 0, 0, 0, 0, 0, 0], 12, 0.05, 1);
  const auth = around([0, 0, 0, 1, 0, 0, 0, 0], 12, 0.05, 2);
  const vectors = [...deploy, undefined, ...auth];
  const names = [
    ...deploy.map((_, i) => `knowledge/deploy/rollout-${i} Deploy rollout canary`),
    "knowledge/none No vector",
    ...auth.map((_, i) => `knowledge/auth/token-${i} Auth token refresh`),
  ];
  const found = await findTopics(vectors, names);
  expect(found.topic[12]).toBe(-1);
  // 24 vectors make three topics: one group may split, but no topic mixes the two.
  const deployTopics = new Set(found.topic.slice(0, 12));
  const authTopics = new Set(found.topic.slice(13));
  expect([...deployTopics].some((t) => authTopics.has(t))).toBe(false);
  for (const t of deployTopics) expect(found.topics[t]!.terms).toContain("deploy");
  for (const t of authTopics) expect(found.topics[t]!.terms).toContain("auth");
  // Topics run largest first, and sizes count their assets.
  expect(found.topics.map((t) => t.size)).toEqual([...found.topics.map((t) => t.size)].sort((a, b) => b - a));
  expect(found.topics.map((t) => t.size).reduce((a, b) => a + b, 0)).toBe(24);
  expect(await findTopics(vectors, names)).toEqual(found);
});

test("near-duplicates are pairs of one topic at or above the threshold, most alike first", async () => {
  const base = around([1, 0, 0, 0, 0, 0, 0, 0], 10, 0.2, 3);
  const copy = Float32Array.from(base[0]!, (v) => v * 1.001);
  const far = around([0, 0, 0, 0, 0, 0, 1, 0], 10, 0.2, 4);
  const vectors = [...base, copy, ...far];
  const found = await findTopics(
    vectors,
    vectors.map((_, i) => `knowledge/n-${i}`),
  );
  expect(found.duplicates.threshold).toBe(DUPLICATE_COSINE);
  const pairs = found.duplicates.a.map((a, k) => [a, found.duplicates.b[k]]);
  expect(pairs[0]).toEqual([0, 10]);
  expect(found.duplicates.cosine[0]).toBeGreaterThan(0.999);
  expect(found.duplicates.cosine.every((c) => c >= DUPLICATE_COSINE)).toBe(true);
  for (let k = 1; k < found.duplicates.cosine.length; k++)
    expect(found.duplicates.cosine[k]!).toBeLessThanOrEqual(found.duplicates.cosine[k - 1]!);
  expect(found.duplicates.truncated).toBe(false);
});

test("too few vectors give no topics; the topic count grows with the library and stops at 36", async () => {
  const few = await findTopics(around([1, 0, 0, 0, 0, 0, 0, 0], 5, 0.1, 5), ["a", "b", "c", "d", "e"]);
  expect(few.topics).toEqual([]);
  expect(few.topic).toEqual([-1, -1, -1, -1, -1]);
  expect(topicCount(8)).toBe(2);
  expect(topicCount(264)).toBe(11);
  expect(topicCount(20000)).toBe(36);
});

test("a topic is named by its most particular words, not by words every asset has", () => {
  expect(words("knowledge/deploy/Canary-rollout v2 README.md")).toEqual(["deploy", "canary", "rollout"]);
  const all = [
    "team guide deploy canary",
    "team guide deploy rollout",
    "team guide auth token",
    "team guide auth refresh",
  ];
  expect(nameTopic(all.slice(0, 2), all).terms[0]).toBe("deploy");
  expect(nameTopic(all.slice(0, 2), all).terms).not.toContain("team");
});
