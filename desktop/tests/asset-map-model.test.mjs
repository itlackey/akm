// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { assetMap, fit } from "../src/lib/asset-map-model.ts";

test("the link map puts what links here on the left and what this links to on the right", () => {
  const map = assetMap(
    [
      { direction: "outgoing", kind: "xref", refs: ["shared//knowledge/a", "knowledge/b"], total: 14 },
      { direction: "incoming", kind: "superseded_by", refs: ["memories/old"], total: 1 },
      { direction: "unresolved", kind: "xref", refs: ["knowledge/not-written"], total: 1 },
    ],
    [],
    "personal//knowledge/self",
  );
  assert.deepEqual(
    map.left.map((group) => [group.title, group.links.map((link) => link.ref)]),
    [["Superseded by", ["memories/old"]]],
  );
  assert.deepEqual(
    map.right.map((group) => [group.title, group.missing, group.more]),
    [
      ["Cross-reference", false, 12],
      ["Cross-reference (missing)", true, 0],
    ],
  );
  // A link is named by its path inside the bundle, and says which bundle when the ref names one.
  assert.deepEqual(
    map.right[0].links.map((link) => [link.label, link.note]),
    [
      ["knowledge/a", "shared"],
      ["knowledge/b", ""],
    ],
  );
  // Every row has its own place, the count of links not returned has one too, and the middle sits halfway down.
  const rows = map.right.flatMap((group) => [group.y, ...group.links.map((link) => link.y), group.more && group.moreY]);
  assert.deepEqual(
    rows.filter(Boolean),
    [...rows.filter(Boolean)].sort((a, b) => a - b),
  );
  assert.equal(new Set(rows.filter(Boolean)).size, rows.filter(Boolean).length);
  assert.equal(map.centre, map.height / 2);
});

test("similar content is marked as inferred and goes under the shorter column", () => {
  const similar = [{ ref: "shared//knowledge/a", title: "Shared A", cosine: 0.99412 }];
  const map = assetMap(
    [{ direction: "outgoing", kind: "xref", refs: ["knowledge/b"], total: 1 }],
    similar,
    "personal//knowledge/self",
  );
  assert.deepEqual(
    map.left.map((group) => [group.title, group.inferred, group.links[0].label, group.links[0].note]),
    [["Similar content", true, "Shared A", "cosine 0.994"]],
  );
  assert.equal(map.right[0].inferred, false);
  // Nothing recorded and nothing similar is an empty map, not a crash.
  assert.deepEqual(assetMap([], [], "personal//x"), {
    height: 96,
    centre: 48,
    left: [],
    right: [],
    leftHeading: null,
    rightHeading: null,
    similarLeftOut: 0,
  });
});

test("a long label keeps its end, which names the asset", () => {
  assert.equal(fit("knowledge/a", 20), "knowledge/a");
  assert.equal(fit("knowledge/disk-imaging/resume-a-restore", 16), "…esume-a-restore");
});

test("a column holding only similar content is not headed as links", () => {
  const similar = [{ ref: "shared//knowledge/a", title: "Shared A", cosine: 0.9 }];
  const only = assetMap(
    [{ direction: "outgoing", kind: "xref", refs: ["knowledge/b"], total: 1 }],
    similar,
    "personal//knowledge/self",
  );
  assert.deepEqual([only.leftHeading, only.rightHeading], ["Similar, not linked", "Links to"]);
  // With recorded links in the same column, the heading stays.
  const mixed = assetMap(
    [
      { direction: "incoming", kind: "xref", refs: ["knowledge/c"], total: 1 },
      { direction: "outgoing", kind: "xref", refs: ["knowledge/b", "knowledge/d", "knowledge/e"], total: 3 },
    ],
    similar,
    "personal//knowledge/self",
  );
  assert.deepEqual([mixed.leftHeading, mixed.rightHeading], ["Linked from", "Links to"]);
  assert.deepEqual(assetMap([], similar, "personal//x").leftHeading, "Similar, not linked");
});

test("similar content leaves out assets already shown as links, matched by ref", () => {
  const similar = [
    { ref: "shared//knowledge/a", title: "A friendly title", cosine: 0.99 },
    { ref: "personal//knowledge/b", title: "knowledge/b", cosine: 0.98 },
    { ref: "personal//knowledge/new", title: "New", cosine: 0.9 },
  ];
  const map = assetMap(
    [
      { direction: "outgoing", kind: "xref", refs: ["shared//knowledge/a"], total: 1 },
      { direction: "incoming", kind: "xref", refs: ["knowledge/b"], total: 1 },
    ],
    similar,
    "personal//knowledge/self",
  );
  const inferred = [...map.left, ...map.right].find((group) => group.inferred);
  assert.deepEqual(
    inferred.links.map((link) => link.ref),
    ["personal//knowledge/new"],
  );
  assert.equal(map.similarLeftOut, 2);
  // All similar assets already linked: no similar group at all, and the count says why.
  const none = assetMap(
    [{ direction: "outgoing", kind: "xref", refs: ["knowledge/b"], total: 1 }],
    [similar[1]],
    "personal//knowledge/self",
  );
  assert.equal(
    [...none.left, ...none.right].some((group) => group.inferred),
    false,
  );
  assert.equal(none.similarLeftOut, 1);
  // A recorded link that names no bundle is in this asset's bundle: the same asset, under another name.
  const bare = assetMap(
    [{ direction: "outgoing", kind: "xref", refs: ["knowledge/a"], total: 1 }],
    [
      { ref: "personal//knowledge/a", title: "A", cosine: 0.9 },
      { ref: "other//knowledge/a", title: "Elsewhere", cosine: 0.8 },
    ],
    "personal//knowledge/self",
  );
  assert.deepEqual(
    bare.left.flatMap((group) => group.links.map((link) => link.ref)),
    ["other//knowledge/a"],
  );
});

test("kind labels come from the one table", () => {
  const map = assetMap([{ direction: "unresolved", kind: "belief_peer", refs: ["x"], total: 1 }], [], "personal//x");
  assert.equal(map.right[0].title, "Related belief (missing)");
});
