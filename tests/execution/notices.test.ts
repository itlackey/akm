// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { mergeNotices, type Notice, noticeSet } from "../../src/execution/notices";

const A: Notice = { code: "a", severity: "info", adapter: "x", message: "first" };
const B: Notice = { code: "b", severity: "warning", adapter: "x", field: "inference.topP", message: "second" };

describe("mergeNotices", () => {
  test("keeps first-seen order across groups and collapses exact duplicates", () => {
    expect(mergeNotices([A, B], undefined, [B, A])).toEqual([A, B]);
  });

  test("is undefined when there is nothing to report, and frozen when there is", () => {
    expect(mergeNotices()).toBeUndefined();
    expect(mergeNotices([], undefined)).toBeUndefined();
    expect(Object.isFrozen(mergeNotices([A]))).toBe(true);
  });

  test("details count, key order does not", () => {
    const one: Notice = { ...A, details: { x: 1, y: { p: 1, q: 2 } } };
    const reordered: Notice = { ...A, details: { y: { q: 2, p: 1 }, x: 1 } };
    const different: Notice = { ...A, details: { x: 2 } };
    expect(mergeNotices([one], [reordered], [different])).toEqual([one, different]);
  });
});

describe("noticeSet", () => {
  test("merges what its sink was given, and forwards each batch as it arrives", () => {
    const forwarded: number[] = [];
    const notices = noticeSet((batch) => forwarded.push(batch.length));
    expect(notices.fields()).toEqual({});
    expect(notices.list()).toEqual([]);

    notices.add([A, B]);
    notices.add([B]);

    expect(forwarded).toEqual([2, 1]);
    expect(notices.list()).toEqual([A, B]);
    expect(notices.fields()).toEqual({ notices: [A, B] });
  });
});
