// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOverview,
  DAY,
  makeUp,
  mindMap,
  OLD_DAYS,
  RECENT_DAYS,
  tally,
  useClass,
} from "../src/lib/library-overview.ts";

const now = Date.parse("2026-11-14T12:00:00Z");
const ago = (days) => new Date(now - days * DAY).toISOString();

/** Seven assets of two types carrying tags (some of them not subjects), links, and one of each problem. */
const payload = {
  available: true,
  note: "",
  types: ["knowledge", "memory"],
  bundles: ["wiki", "notes"],
  beliefs: ["superseded"],
  use: { since: ago(90), source: "user" },
  kinds: ["xref", "contradicted_by"],
  nodes: {
    ref: [
      "wiki//knowledge/deploy/a",
      "wiki//knowledge/deploy/b",
      "notes//memories/deploy/c",
      "wiki//knowledge/auth/d",
      "notes//memories/auth/e",
      "notes//memories/auth/f",
      "notes//memories/misc/g",
    ],
    type: [0, 0, 1, 0, 1, 1, 1],
    bundle: [0, 0, 1, 0, 1, 1, 1],
    belief: [-1, 0, -1, -1, -1, -1, -1],
    shows: [9, 0, 2, 0, 0, 1, 0],
    lastShownAt: [ago(2), null, ago(60), null, null, ago(10), null],
    modifiedAt: [ago(5), ago(400), ago(30), ago(20), ago(500), ago(1), null],
    positive: [1, 0, 0, 0, 0, 0, 0],
    negative: [0, 0, 0, 2, 0, 0, 0],
    // deploy, auth, rollout; skill, creating, 2026, example.com and a1b2c3d4 name no subject.
    tags: [[0, 2, 3, 4, 5], [0, 2, 6], [0, 7], [1], [1], [1, 3], []],
  },
  // a→b and b→c inside deploy; c→d across; e declares contradicted_by f.
  links: { from: [0, 1, 2, 4], to: [1, 2, 3, 5], kind: [0, 0, 0, 1] },
  tags: ["deploy", "auth", "rollout", "skill", "creating", "2026", "example.com", "a1b2c3d4"],
  duplicates: { threshold: 0.96, a: [3], b: [5], cosine: [0.98], truncated: false },
};

test("use: read lately, read only earlier, unread but recently edited, unread and old; unknown edit time is not new", () => {
  assert.equal(useClass(ago(RECENT_DAYS - 1), null, now), "recent");
  assert.equal(useClass(ago(RECENT_DAYS + 1), null, now), "earlier");
  assert.equal(useClass(null, ago(OLD_DAYS - 1), now), "new");
  assert.equal(useClass(null, ago(OLD_DAYS + 1), now), "unread");
  assert.equal(useClass(null, null, now), "unread");
  const o = buildOverview(payload, now);
  assert.deepEqual(o.use, ["recent", "unread", "earlier", "new", "unread", "recent", "unread"]);
  assert.deepEqual(
    tally([3, 4, 5], (i) => o.use[i], ["recent", "earlier", "new", "unread"]),
    { recent: 1, earlier: 0, new: 1, unread: 1 },
  );
  // No usage history: use is unknown, not "unread".
  const none = buildOverview({ ...payload, note: "Use counts are zero: no usage history is available." }, now);
  assert.equal(none.useKnown, false);
  assert.ok(none.use.every((u) => u === null));
});

test("problems: outdated by belief or by the link it declares, more negative than positive feedback, near-duplicates", () => {
  const o = buildOverview(payload, now);
  assert.deepEqual(o.problems, [[], ["outdated"], [], ["negative", "duplicate"], ["outdated"], ["duplicate"], []]);
  assert.deepEqual(o.duplicates, [{ a: 3, b: 5, cosine: 0.98 }]);
});

test("make-up counts families and bundles, largest first", () => {
  const o = buildOverview(payload, now);
  const m = makeUp(o);
  assert.deepEqual(
    m.families.map((r) => [r.label, r.count]),
    [
      ["Memories and facts", 4],
      ["Knowledge", 3],
    ],
  );
  assert.deepEqual(
    m.bundles.map((r) => [r.label, r.count]),
    [
      ["notes", 4],
      ["wiki", 3],
    ],
  );
});

test("the overview carries each asset's tags as indexes into the tag names", () => {
  const o = buildOverview(payload, now);
  assert.equal(o.tagNames.length, 8);
  assert.deepEqual(
    o.tags[1].map((t) => o.tagNames[t]),
    ["deploy", "rollout", "example.com"],
  );
  assert.deepEqual(o.tags[6], []);
});

const labels = (branches) => branches.map((b) => [b.key, b.label, b.members.length, b.leaves.map((l) => l.label)]);

test("mind map: one branch per type that has assets, largest first, with keys f<family> and f<family>:<tag>", () => {
  const o = buildOverview(payload, now);
  const map = mindMap(o);
  assert.deepEqual(labels(map), [
    ["f1", "Memories and facts", 4, ["auth", "deploy"]],
    ["f0", "Knowledge", 3, ["deploy", "rollout", "auth"]],
  ]);
  assert.deepEqual(
    map.flatMap((b) => b.leaves.map((l) => l.key)),
    ["f1:auth", "f1:deploy", "f0:deploy", "f0:rollout", "f0:auth"],
  );
  // A leaf is the type's assets that carry the tag: most carried first, ties by name.
  assert.deepEqual(
    map[0].leaves.map((l) => l.members),
    [[4, 5], [2]],
  );
  assert.deepEqual(
    map[1].leaves.map((l) => l.members),
    [[0, 1], [0, 1], [3]],
  );
  assert.deepEqual(
    map.map((b) => b.untagged),
    [1, 0],
  );
});

test("mind map: filler, layout words, verbs, years, domains and hashes are not subjects, however many carry them", () => {
  const o = buildOverview(payload, now);
  const drawn = mindMap(o).flatMap((b) => b.leaves.map((l) => l.label));
  for (const tag of ["skill", "creating", "2026", "example.com", "a1b2c3d4"]) assert.ok(!drawn.includes(tag), tag);
  // The asset keeps the tag; only the map leaves it off.
  assert.ok(o.tags[0].map((t) => o.tagNames[t]).includes("skill"));
});

test("mind map: the leaf budget is shared by the square root of each type's size, at least one each", () => {
  const o = buildOverview(payload, now);
  assert.deepEqual(
    mindMap(o, 2).map((b) => b.leaves.length),
    [1, 1],
  );
  assert.deepEqual(
    mindMap(o, 2).map((b) => b.untagged),
    [2, 1],
  );
  assert.deepEqual(
    mindMap(o, 0).map((b) => b.leaves.length),
    [1, 1],
  );
  assert.deepEqual(
    mindMap(o, 5).map((b) => b.leaves.length),
    [2, 2],
  );
});

test("mind map: only the given assets are mapped, and a type with none of them has no branch", () => {
  const o = buildOverview(payload, now);
  assert.deepEqual(labels(mindMap(o, 44, [0, 1])), [["f0", "Knowledge", 2, ["deploy", "rollout"]]]);
  assert.deepEqual(labels(mindMap(o, 44, new Set([3, 6]))), [
    ["f0", "Knowledge", 1, ["auth"]],
    ["f1", "Memories and facts", 1, []],
  ]);
  assert.deepEqual(mindMap(o, 44, []), []);
});

test("mind map: a tag carried by one asset of a big type is not a leaf", () => {
  const n = 10;
  const big = {
    ...payload,
    types: ["knowledge"],
    bundles: ["wiki"],
    tags: ["shared", "lonely"],
    nodes: {
      ref: Array.from({ length: n }, (_, i) => `wiki//knowledge/${i}`),
      type: Array(n).fill(0),
      bundle: Array(n).fill(0),
      belief: Array(n).fill(-1),
      shows: Array(n).fill(0),
      lastShownAt: Array(n).fill(null),
      modifiedAt: Array(n).fill(null),
      positive: Array(n).fill(0),
      negative: Array(n).fill(0),
      tags: Array.from({ length: n }, (_, i) => (i === 0 ? [0, 1] : i < 4 ? [0] : [])),
    },
    links: { from: [], to: [], kind: [] },
    duplicates: null,
    beliefs: [],
  };
  assert.deepEqual(labels(mindMap(buildOverview(big, now))), [["f0", "Knowledge", 10, ["shared"]]]);
});
