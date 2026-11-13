// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { withAgentIdentity } from "../src/indexer/usage/usage-events";
import { embeddingNote, projectEmbeddings } from "../src/workspace/graph";

test("positions by meaning keep similar vectors together, are the same on every read, and skip missing vectors", async () => {
  // Two groups of vectors in 8 dimensions, far apart, with a little spread inside each.
  const group = (centre: number[], n: number, seed: number) =>
    Array.from({ length: n }, (_, i) =>
      Float32Array.from(centre.map((c, d) => c + (((i * 31 + d * 17 + seed) % 7) - 3) * 0.01)),
    );
  const a = group([1, 0, 0, 0, 0.5, 0, 0, 0], 10, 1);
  const b = group([0, 0, 1, 0, 0, 0, 0.5, 0], 10, 2);
  const vectors = [...a, undefined, ...b];
  const placed = await projectEmbeddings(vectors);
  expect(placed.embedded).toBe(20);
  expect(placed.xyz).toHaveLength(21 * 3);
  expect(placed.xyz.slice(30, 33)).toEqual([null, null, null]);
  const point = (i: number) => placed.xyz.slice(i * 3, i * 3 + 3) as number[];
  const distance = (p: number[], q: number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
  const within = distance(point(0), point(1));
  const across = distance(point(0), point(11));
  expect(across).toBeGreaterThan(within * 10);
  expect(await projectEmbeddings(vectors)).toEqual(placed);
  // Too few vectors, or none: no positions.
  expect((await projectEmbeddings([a[0], undefined])).embedded).toBe(0);
  expect((await projectEmbeddings([])).xyz).toEqual([]);
});

test("the axes are kept for one index build: an asset embedded since lands on them, a new build finds new ones", async () => {
  const vectors = Array.from({ length: 50 }, (_, i) =>
    Float32Array.from({ length: 16 }, (_, d) => Math.sin(i * 0.3 + d)),
  );
  const first = await projectEmbeddings(vectors, "build-1");
  // One more asset, same build: the others keep their places.
  const added = await projectEmbeddings(
    [...vectors, Float32Array.from({ length: 16 }, (_, d) => Math.cos(d))],
    "build-1",
  );
  expect(added.xyz.slice(0, first.xyz.length)).toEqual(first.xyz);
  // A different set under a new build key gets axes of its own.
  const other = vectors.map((vector) => vector.map((value, d) => (d % 2 ? value * 3 : value)));
  const rebuilt = await projectEmbeddings(other, "build-2");
  const fresh = await projectEmbeddings(other);
  expect(rebuilt.xyz).toEqual(fresh.xyz);
});

test("the projection lets other work run while it goes", async () => {
  const vectors = Array.from({ length: 6000 }, (_, i) =>
    Float32Array.from({ length: 64 }, (_, d) => Math.sin(i * 0.17 + d * 0.37)),
  );
  let ranDuring = false;
  let done = false;
  setImmediate(() => {
    ranDuring = !done;
  });
  await projectEmbeddings(vectors);
  done = true;
  expect(ranDuring).toBe(true);
});

test("a usage event records the agent harness and session akm runs under, and nothing without one", () => {
  expect(withAgentIdentity('{"resultCount":2}', { AKM_AGENT_HARNESS: "claude", AKM_SESSION_ID: "s-1" })).toBe(
    '{"agent":{"harness":"claude","session":"s-1"},"resultCount":2}',
  );
  expect(withAgentIdentity(undefined, { AKM_AGENT_HARNESS: "codex" })).toBe('{"agent":{"harness":"codex"}}');
  // A caller's own agent key wins; metadata that is not a JSON object is stored as given.
  expect(withAgentIdentity('{"agent":"x"}', { AKM_AGENT_HARNESS: "claude" })).toBe('{"agent":"x"}');
  expect(withAgentIdentity("[1]", { AKM_AGENT_HARNESS: "claude" })).toBe("[1]");
  expect(withAgentIdentity('{"a":1}', {})).toBe('{"a":1}');
  expect(withAgentIdentity(undefined, {})).toBeNull();
});

test("the note says how many assets are embedded, and names a remainder only when there is one", () => {
  expect(embeddingNote(0, 10)).toBe("No assets are embedded, so there is no arrangement by meaning.");
  expect(embeddingNote(3, 10)).toBe("Only 3 of 10 assets are embedded; at least 4 are needed to arrange by meaning.");
  expect(embeddingNote(7, 10)).toBe("7 of 10 assets are embedded; the rest have no position by meaning.");
  expect(embeddingNote(10, 10)).toBe("All 10 assets are embedded.");
});
