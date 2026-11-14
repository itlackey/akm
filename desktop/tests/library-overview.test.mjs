// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  assetLayout,
  buildOverview,
  DAY,
  folderOf,
  groupLinks,
  makeUp,
  OLD_DAYS,
  RECENT_DAYS,
  rankFor,
  regionLayout,
  regionRadius,
  relationLayout,
  tally,
  useClass,
} from "../src/lib/library-overview.ts";

const now = Date.parse("2026-11-14T12:00:00Z");
const ago = (days) => new Date(now - days * DAY).toISOString();

/** Six assets in two topics, a seventh with no embedding; links inside and across; one of each problem. */
const payload = {
  available: true,
  note: "",
  types: ["knowledge", "memory"],
  bundles: ["wiki", "notes"],
  beliefs: ["superseded"],
  emptyBundles: [],
  use: { since: ago(90), source: "user" },
  unresolvedLinks: 0,
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
    title: ["A", "B", "C", "D", "E", "F", "G"],
    type: [0, 0, 1, 0, 1, 1, 1],
    bundle: [0, 0, 1, 0, 1, 1, 1],
    belief: [-1, 0, -1, -1, -1, -1, -1],
    shows: [9, 0, 2, 0, 0, 1, 0],
    searches: [0, 0, 0, 0, 0, 0, 0],
    lastShownAt: [ago(2), null, ago(60), null, null, ago(10), null],
    modifiedAt: [ago(5), ago(400), ago(30), ago(20), ago(500), ago(1), null],
    positive: [1, 0, 0, 0, 0, 0, 0],
    negative: [0, 0, 0, 2, 0, 0, 0],
    topic: [0, 0, 0, 1, 1, 1, -1],
  },
  // a→b and b→c inside deploy; c→d across; e declares contradicted_by f.
  links: { from: [0, 1, 2, 4], to: [1, 2, 3, 5], kind: [0, 0, 0, 1] },
  meaning: null,
  topics: [
    { label: "deploy · rollout", terms: ["deploy", "rollout"], size: 3, related: [{ topic: 1, cosine: 0.7 }] },
    { label: "auth · token", terms: ["auth", "token"], size: 3, related: [{ topic: 0, cosine: 0.7 }] },
  ],
  duplicates: { threshold: 0.96, a: [3], b: [5], cosine: [0.98], truncated: false },
};

test("groups are akm's topics, with one more for assets that have no embedding", () => {
  const o = buildOverview(payload, now);
  assert.deepEqual(
    o.groups.map((g) => [g.label, g.kind, g.members]),
    [
      ["deploy · rollout", "topic", [0, 1, 2]],
      ["auth · token", "topic", [3, 4, 5]],
      ["No embedding", "unembedded", [6]],
    ],
  );
  assert.deepEqual(o.groups[0].related, [{ group: 1, cosine: 0.7 }]);
});

test("without topics the library is grouped by folder, largest first, ties by name", () => {
  const o = buildOverview({ ...payload, topics: [], duplicates: null }, now);
  assert.deepEqual(
    o.groups.map((g) => [g.label, g.kind, g.members.length]),
    [
      ["knowledge/deploy", "folder", 2],
      ["memories/auth", "folder", 2],
      ["knowledge/auth", "folder", 1],
      ["memories/deploy", "folder", 1],
      ["memories/misc", "folder", 1],
    ],
  );
  assert.equal(folderOf("b//skills/coding/debt/SKILL"), "skills/coding");
  assert.equal(folderOf("b//commands/release"), "commands");
});

test("use: read lately, read only earlier, unread but recently edited, unread and old; unknown edit time is not new", () => {
  assert.equal(useClass(ago(RECENT_DAYS - 1), null, now), "recent");
  assert.equal(useClass(ago(RECENT_DAYS + 1), null, now), "earlier");
  assert.equal(useClass(null, ago(OLD_DAYS - 1), now), "new");
  assert.equal(useClass(null, ago(OLD_DAYS + 1), now), "unread");
  assert.equal(useClass(null, null, now), "unread");
  const o = buildOverview(payload, now);
  assert.deepEqual(o.use, ["recent", "unread", "earlier", "new", "unread", "recent", "unread"]);
  assert.deepEqual(
    tally(o.groups[1].members, (i) => o.use[i], ["recent", "earlier", "new", "unread"]),
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

test("links between groups: counted per pair, links inside a group kept apart", () => {
  const o = buildOverview(payload, now);
  const links = groupLinks(o);
  assert.deepEqual(links.inside, [2, 1, 0]);
  assert.deepEqual(links.pairs, [{ a: 0, b: 1, count: 1 }]);
  assert.deepEqual(links.across, [1, 1, 0]);
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

test("regions do not overlap, their area follows their size, and every asset sits inside its own region", () => {
  const o = buildOverview(payload, now);
  const regions = regionLayout(o);
  assert.equal(regions.length, 3);
  assert.ok(regions[0].radius > regions[2].radius);
  assert.equal(regions[0].radius, regionRadius(3));
  for (let a = 0; a < regions.length; a++)
    for (let b = a + 1; b < regions.length; b++)
      assert.ok(
        Math.hypot(regions[a].x - regions[b].x, regions[a].y - regions[b].y) >= regions[a].radius + regions[b].radius,
        `regions ${a} and ${b} overlap`,
      );
  const pos = assetLayout(o, regions, rankFor(o, "use"));
  for (let i = 0; i < o.count; i++) {
    const r = regions[o.groupOf[i]];
    assert.ok(Math.hypot(pos[i * 2] - r.x, pos[i * 2 + 1] - r.y) < r.radius, `asset ${i} is outside its region`);
  }
  // The use view puts recent reads at the centre of a region.
  const centre = regions[1];
  const d = (i) => Math.hypot(pos[i * 2] - centre.x, pos[i * 2 + 1] - centre.y);
  assert.ok(d(5) < d(3) && d(3) < d(4));
  // The same input gives the same layout.
  assert.deepEqual(regionLayout(o), regions);
});

test("the relation layout gives every group a place in 3D and a size in pixels that grows with it", () => {
  const o = buildOverview(payload, now);
  const nodes = relationLayout(o);
  assert.equal(nodes.length, 3);
  for (const n of nodes) assert.ok([n.x, n.y, n.z].every(Number.isFinite));
  assert.ok(nodes[0].pixels > nodes[2].pixels);
});
