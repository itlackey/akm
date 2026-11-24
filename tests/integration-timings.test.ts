// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The integration runner's shard plan and the junit reports it learns file times from (`scripts/integration-timings.ts`). */

import { describe, expect, test } from "bun:test";
import { planShards, readJunitTimings } from "../scripts/integration-timings";

describe("planShards", () => {
  test("deals the longest files first, each to the least-loaded shard", () => {
    const timings = { "a.ts": 10, "b.ts": 6, "c.ts": 5, "d.ts": 4, "e.ts": 1 };
    expect(planShards(Object.keys(timings), timings, 2)).toEqual([
      ["a.ts", "d.ts"],
      ["b.ts", "c.ts", "e.ts"],
    ]);
  });

  test("a file with no recorded time weighs the median of the recorded ones", () => {
    const timings = { "a.ts": 9, "b.ts": 3, "c.ts": 2, "d.ts": 1 };
    // The median is 2.5: new.ts goes after b.ts (3) and before c.ts (2).
    expect(planShards(["a.ts", "b.ts", "c.ts", "d.ts", "new.ts"], timings, 2)).toEqual([
      ["a.ts"],
      ["b.ts", "new.ts", "c.ts", "d.ts"],
    ]);
  });

  test("is the same whatever order the files come in, ties going by path", () => {
    const files = ["z.ts", "m.ts", "a.ts", "q.ts"];
    const plan = planShards(files, {}, 2);
    expect(plan).toEqual([
      ["a.ts", "q.ts"],
      ["m.ts", "z.ts"],
    ]);
    expect(planShards([...files].reverse(), {}, 2)).toEqual(plan);
  });

  test("files that weigh nothing still spread across the shards", () => {
    expect(planShards(["a.ts", "b.ts", "c.ts"], { "a.ts": 0, "b.ts": 0, "c.ts": 0 }, 3)).toEqual([
      ["a.ts"],
      ["b.ts"],
      ["c.ts"],
    ]);
  });
});

test("readJunitTimings sums the times of each file's tests, at any depth", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" time="2.5">
  <testsuite name="tests/integration/a.test.ts" file="tests/integration/a.test.ts" tests="3" time="0.25">
    <testcase name="w" classname="" time="0.25" file="tests/integration/a.test.ts" line="2" />
    <testsuite name="group" file="tests/integration/a.test.ts" tests="2" time="1.5">
      <testcase name="x" classname="group" time="1.5" file="tests/integration/a.test.ts" line="4" />
      <testsuite name="inner" file="tests/integration/a.test.ts" tests="1" time="0.5">
        <testcase name="y" classname="inner &amp;gt; group" time="0.5" file="tests/integration/a.test.ts" line="5" />
      </testsuite>
    </testsuite>
  </testsuite>
  <testsuite name="tests/integration/b.test.ts" file="tests/integration/b.test.ts" tests="1" time="0.25">
    <testcase name="z" classname="" time="0.25" file="tests/integration/b.test.ts" line="2" />
  </testsuite>
</testsuites>`;
  expect(readJunitTimings(xml)).toEqual({ "tests/integration/a.test.ts": 2.25, "tests/integration/b.test.ts": 0.25 });
});
