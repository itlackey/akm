// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOverview,
  DAY,
  depthText,
  groupFacts,
  groupJoins,
  groupsOf,
  LENSES,
  lensFor,
  mindMap,
  OLD_DAYS,
  OUTDATED_LINKS,
  placeBy,
  RECENT_DAYS,
  relations,
  tally,
  unplaced,
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
  feedback: { since: ago(90), source: "user" },
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
  // akm reports no edit time (the file could not be read): not new, not old, so not classed.
  assert.equal(useClass(null, null, now), null);
  const o = buildOverview(payload, now);
  assert.deepEqual(o.use, ["recent", "unread", "earlier", "new", "unread", "recent", null]);
  assert.equal(groupFacts(o, [3, 4, 5, 6]).useUnclassed, 1);
  assert.deepEqual(groupFacts(o, [3, 4, 5, 6]).use, { recent: 1, earlier: 0, new: 1, unread: 1 });
  assert.deepEqual(
    tally([3, 4, 5], (i) => o.use[i], ["recent", "earlier", "new", "unread"]),
    { recent: 1, earlier: 0, new: 1, unread: 1 },
  );
  // akm could not read the usage store (`use: null`): use is unknown, not "unread", whatever the note says.
  const none = buildOverview({ ...payload, use: null, note: "Usage is not available." }, now);
  assert.equal(none.useKnown, false);
  assert.ok(none.use.every((u) => u === null));
  // The note is prose for the person: its wording never decides whether use is known.
  assert.equal(buildOverview({ ...payload, note: "No usage history was lost." }, now).useKnown, true);
});

test("problems: outdated by belief or by the link it declares, more negative than positive feedback, near-duplicates", () => {
  const o = buildOverview(payload, now);
  assert.deepEqual(o.problems, [[], ["outdated"], [], ["negative", "duplicate"], ["outdated"], ["duplicate"], []]);
  assert.deepEqual(o.duplicates, [{ a: 3, b: 5, cosine: 0.98 }]);
});

test("feedback and near-duplicates akm could not report are unknown, not none", () => {
  const known = buildOverview(payload, now);
  assert.equal(known.feedbackKnown, true);
  assert.equal(known.duplicatesKnown, true);
  // akm sends feedback: null with every count zero when the state store cannot be read, and duplicates: null when no layout is stored.
  const unknown = buildOverview(
    {
      ...payload,
      feedback: null,
      duplicates: null,
      groups: null,
      nodes: { ...payload.nodes, negative: [0, 0, 0, 5, 0, 0, 0], positive: [0, 0, 0, 0, 0, 0, 0] },
    },
    now,
  );
  assert.equal(unknown.feedbackKnown, false);
  assert.equal(unknown.duplicatesKnown, false);
  // Feedback counts that akm did not measure never make an asset "disliked", and no pair is invented.
  assert.ok(unknown.problems.every((p) => !p.includes("negative") && !p.includes("duplicate")));
  assert.deepEqual(unknown.duplicates, []);
});

test("assets with no group by meaning are counted, so the 3D map can say how many it leaves out", () => {
  const groups = { count: 1, group: [0, 0, -1, 0, -1, 0, 0], x: [], y: [], z: [] };
  const o = buildOverview({ ...payload, groups }, now);
  assert.equal(unplaced(o, [0, 1, 2, 3, 4, 5, 6]), 2);
  assert.equal(unplaced(o, [0, 1, 3]), 0);
  assert.equal(unplaced(buildOverview(payload, now), [0, 1]), 2);
});

test("the overview carries links by kind name, edit times and feedback counts", () => {
  const o = buildOverview(payload, now);
  assert.deepEqual(o.links, [
    { from: 0, to: 1, kind: "xref" },
    { from: 1, to: 2, kind: "xref" },
    { from: 2, to: 3, kind: "xref" },
    { from: 4, to: 5, kind: "contradicted_by" },
  ]);
  assert.equal(o.modified[1], ago(400));
  assert.deepEqual([o.positive[0], o.negative[3]], [1, 2]);
});

test("group facts: use, what is outdated, disliked and duplicated, what links out, and which bundles repeat it", () => {
  const o = buildOverview(payload, now);
  const auth = groupFacts(o, [3, 4, 5]);
  assert.equal(auth.count, 3);
  assert.deepEqual(auth.use, { recent: 1, earlier: 0, new: 1, unread: 1 });
  assert.deepEqual(auth.outdated, [4]);
  assert.deepEqual(auth.disliked, [3]);
  // d and f are both in the group; c links in to d from outside it; e and f link to each other inside it.
  assert.deepEqual(auth.duplicatesInside, [{ a: 3, b: 5, cosine: 0.98 }]);
  assert.deepEqual(auth.duplicatesOutside, []);
  assert.equal(auth.linked, 3);
  assert.equal(auth.linksOut, 1);
  assert.deepEqual(auth.overlap, []);
  // Knowledge holds d; its twin f is a memory in the other bundle.
  const knowledge = groupFacts(o, [0, 1, 3]);
  assert.deepEqual(knowledge.duplicatesOutside, [{ a: 3, b: 5, cosine: 0.98 }]);
  assert.deepEqual(knowledge.overlap, [{ bundle: "notes", pairs: 1 }]);
});

test("relations: the groups joined to the chosen one by links either way or near-duplicates, most joined first", () => {
  const o = buildOverview(payload, now);
  const map = mindMap(o);
  // d (Knowledge's auth) is linked from c (Memories' deploy) and nearly duplicates f (Memories' auth).
  assert.deepEqual(relations(o, map, "f0:auth"), [
    { key: "f1:auth", links: 0, duplicates: 1 },
    { key: "f1:deploy", links: 1, duplicates: 0 },
  ]);
  // A type is joined to other types' tags, never to its own; g carries no drawn tag and counts under its type.
  assert.deepEqual(relations(o, map, "f1"), [
    { key: "f0:auth", links: 1, duplicates: 1 },
    { key: "f0:deploy", links: 1, duplicates: 0 },
    { key: "f0:rollout", links: 1, duplicates: 0 },
  ]);
  // Only some link kinds: e's contradiction of f stays inside the group, so only the duplicate joins it.
  assert.deepEqual(relations(o, map, "f1:auth", OUTDATED_LINKS), [{ key: "f0:auth", links: 0, duplicates: 1 }]);
  assert.deepEqual(relations(o, map, "nothing"), []);
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

test("mind map: a view ranks the tags its own way, and a tag it ranks at zero is not drawn", () => {
  const o = buildOverview(payload, now);
  const reads = (members) => members.reduce((sum, i) => sum + o.shows[i], 0);
  assert.deepEqual(labels(mindMap(o, 44, undefined, reads)), [
    ["f1", "Memories and facts", 4, ["deploy", "auth"]],
    ["f0", "Knowledge", 3, ["deploy", "rollout"]],
  ]);
});

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

/** The same assets placed by meaning: deploy's three in group 0, auth's three in group 1, g not embedded. */
const placed = {
  ...payload,
  groups: {
    count: 2,
    group: [0, 0, 0, 1, 1, 1, -1],
    x: [0, 2, -2, 50, 52, 48, 0],
    y: [0, 1, -1, 0, 1, -1, 0],
    z: [0, 0, 0, 10, 10, 10, 0],
  },
};

test("groups by meaning: named by the tags they carry most particularly, largest first, an asset with no group in none", () => {
  const o = buildOverview(placed, now);
  const groups = groupsOf(o, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.label, g.members]),
    [
      ["g:0", "deploy · rollout", [0, 1, 2]],
      ["g:1", "auth", [3, 4, 5]],
    ],
  );
  assert.deepEqual(
    groupsOf(o, [3, 6]).map((g) => g.members),
    [[3]],
  );
  // No groups in the payload: every asset is ungrouped.
  assert.deepEqual(groupsOf(buildOverview(payload, now), [0, 1, 2]), []);
});

test("group joins: links and near-duplicates across groups, or only the given link kinds", () => {
  const o = buildOverview(placed, now);
  // c→d crosses from deploy to auth; d and f nearly duplicate inside auth.
  assert.deepEqual(groupJoins(o, 0), [{ key: "g:1", links: 1, duplicates: 0 }]);
  assert.deepEqual(groupJoins(o, 1), [{ key: "g:0", links: 1, duplicates: 0 }]);
  // e's contradiction of f stays inside auth.
  assert.deepEqual(groupJoins(o, 1, OUTDATED_LINKS), []);
});

const lens = (id) => LENSES.find((l) => l.id === id);
/** The depth (z) of each asset under a lens. */
const depthsUnder = (o, id, flip = false) => {
  const place = placeBy(o, lens(id), flip);
  return (i) => place[i * 3 + 2];
};

test("depth by meaning: every asset is at the place akm gave it", () => {
  const o = buildOverview(placed, now);
  assert.deepEqual([...o.place.subarray(9, 12)], [50, 0, 10]);
  assert.deepEqual(placeBy(o, lens("meaning")), o.place);
  // Meaning has no front or back, so flipping it changes nothing.
  assert.deepEqual(placeBy(o, lens("meaning"), true), o.place);
});

test("depth by last read: read lately in front, read earlier ahead of the middle, never read behind", () => {
  const o = buildOverview(placed, now);
  const z = depthsUnder(o, "recency");
  // a read lately, c read earlier, b never read; being superseded does not move b under this lens.
  assert.ok(z(0) > z(2) && z(2) > 0 && 0 > z(1));
  // f read lately; d and e never read, the contradicted e no farther back than d.
  assert.ok(z(5) > 10 && z(3) < 10);
  assert.equal(z(3), z(4));
  // x and y stay akm's.
  const place = placeBy(o, lens("recency"));
  assert.deepEqual([place[3 * 3], place[3 * 3 + 1]], [50, 0]);
});

test("depth by how often read: the most read third in front, other read assets in the middle, unread behind", () => {
  const z = depthsUnder(buildOverview(placed, now), "frequency");
  // a has 9 reads, c has 2, b none.
  assert.ok(z(0) > 0 && z(1) < 0);
  assert.equal(z(2), 0);
});

test("depth by feedback: more positive in front, more negative behind, none or balanced in the middle", () => {
  const z = depthsUnder(buildOverview(placed, now), "feedback");
  assert.ok(z(0) > 0 && z(3) < 10);
  assert.deepEqual([z(1), z(2), z(4)], [0, 0, 10]);
});

test("depth by lifecycle: edited lately in front, edited long ago behind the middle, outdated at the back", () => {
  const aged = (modifiedAt) => buildOverview({ ...placed, nodes: { ...placed.nodes, modifiedAt } }, now);
  const edits = placed.nodes.modifiedAt;
  // a edited 5 days ago, c over 180 days ago, b superseded.
  const z = depthsUnder(aged(edits.with(2, ago(OLD_DAYS + 1))), "lifecycle");
  assert.ok(z(0) > 0 && 0 > z(2) && z(2) > z(1));
  // No edit time akm could report: the middle, not the back.
  assert.equal(depthsUnder(aged(edits.with(2, null)), "lifecycle")(2), 0);
});

test("flip mirrors depth about each group's middle; flatten puts every asset at depth 0 and keeps x and y", () => {
  const o = buildOverview(placed, now);
  for (const id of ["recency", "frequency", "feedback", "lifecycle"]) {
    const z = depthsUnder(o, id);
    const flipped = depthsUnder(o, id, true);
    for (const i of [0, 1, 2]) assert.equal(flipped(i), -z(i) || 0);
    for (const i of [3, 4, 5]) assert.ok(Math.abs(flipped(i) - 10 + (z(i) - 10)) < 1e-5);
  }
  const flat = placeBy(o, lens("recency"), false, true);
  for (let i = 0; i < o.count; i++)
    assert.deepEqual([...flat.subarray(i * 3, i * 3 + 3)], [o.place[i * 3], o.place[i * 3 + 1], 0]);
});

test("a lens that needs figures akm did not report cannot be chosen, and says why", () => {
  const o = buildOverview(placed, now);
  assert.deepEqual(
    LENSES.map((l) => l.unavailable(o)),
    ["", "", "", "", ""],
  );
  assert.equal(lensFor(o, "feedback", "meaning").id, "feedback");
  assert.equal(lensFor(o, null, "lifecycle").id, "lifecycle");
  const bare = buildOverview({ ...placed, use: null, feedback: null }, now);
  assert.deepEqual(
    LENSES.filter((l) => l.unavailable(bare)).map((l) => l.id),
    ["recency", "frequency", "feedback"],
  );
  // The choice, then the page's own lens, then Meaning.
  assert.equal(lensFor(bare, "feedback", "lifecycle").id, "lifecycle");
  assert.equal(lensFor(bare, null, "recency").id, "meaning");
});

test("the key says what is at the front, the middle and the back, the other way round when flipped", () => {
  assert.equal(
    depthText(lens("recency")),
    "Depth inside each group: read in the last 30 days at the front, read earlier in the middle, never read at the back.",
  );
  assert.equal(
    depthText(lens("recency"), true),
    "Depth inside each group: never read at the front, read earlier in the middle, read in the last 30 days at the back.",
  );
  assert.match(depthText(lens("meaning"), true), /^Depth is likeness in meaning/);
  assert.match(depthText(lens("lifecycle"), true, true), /^Flattened/);
});
