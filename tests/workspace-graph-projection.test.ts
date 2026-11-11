// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { withAgentIdentity } from "../src/indexer/usage/usage-events";
import { projectEmbeddings } from "../src/workspace/graph";

test("positions by meaning keep similar vectors together, are the same on every read, and skip missing vectors", () => {
  // Two groups of vectors in 8 dimensions, far apart, with a little spread inside each.
  const group = (centre: number[], n: number, seed: number) =>
    Array.from({ length: n }, (_, i) =>
      Float32Array.from(centre.map((c, d) => c + (((i * 31 + d * 17 + seed) % 7) - 3) * 0.01)),
    );
  const a = group([1, 0, 0, 0, 0.5, 0, 0, 0], 10, 1);
  const b = group([0, 0, 1, 0, 0, 0, 0.5, 0], 10, 2);
  const vectors = [...a, undefined, ...b];
  const placed = projectEmbeddings(vectors);
  expect(placed.embedded).toBe(20);
  expect(placed.xyz).toHaveLength(21 * 3);
  expect(placed.xyz.slice(30, 33)).toEqual([null, null, null]);
  const point = (i: number) => placed.xyz.slice(i * 3, i * 3 + 3) as number[];
  const distance = (p: number[], q: number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
  const within = distance(point(0), point(1));
  const across = distance(point(0), point(11));
  expect(across).toBeGreaterThan(within * 10);
  expect(projectEmbeddings(vectors)).toEqual(placed);
  // Too few vectors, or none: no positions.
  expect(projectEmbeddings([a[0], undefined]).embedded).toBe(0);
  expect(projectEmbeddings([]).xyz).toEqual([]);
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
