// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { assetMap, fit } from "../src/lib/asset-map-model.ts";

const label = (kind) => ({ xref: "Cross-reference", superseded_by: "Superseded by" })[kind] ?? kind;

test("the link map puts what links here on the left and what this links to on the right", () => {
  const map = assetMap(
    [
      { direction: "outgoing", kind: "xref", refs: ["shared//knowledge/a", "knowledge/b"], total: 14 },
      { direction: "incoming", kind: "superseded_by", refs: ["memories/old"], total: 1 },
      { direction: "unresolved", kind: "xref", refs: ["knowledge/not-written"], total: 1 },
    ],
    [],
    label,
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
  const map = assetMap([{ direction: "outgoing", kind: "xref", refs: ["knowledge/b"], total: 1 }], similar, label);
  assert.deepEqual(
    map.left.map((group) => [group.title, group.inferred, group.links[0].label, group.links[0].note]),
    [["Similar content", true, "Shared A", "cosine 0.994"]],
  );
  assert.equal(map.right[0].inferred, false);
  // Nothing recorded and nothing similar is an empty map, not a crash.
  assert.deepEqual(assetMap([], [], label), { height: 96, centre: 48, left: [], right: [] });
});

test("a long label keeps its end, which names the asset", () => {
  assert.equal(fit("knowledge/a", 20), "knowledge/a");
  assert.equal(fit("knowledge/disk-imaging/resume-a-restore", 16), "…esume-a-restore");
});
