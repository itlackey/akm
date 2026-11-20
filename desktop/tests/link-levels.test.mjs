// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { joinsOf, LEVEL_CAP, LEVEL_STYLES, reach } from "../src/lib/link-levels.ts";

const join = (a, b, what = "xref") => ({ a, b, what });
// 0 - 1 - 2 - 3 - 4 - 5 in a line, with 1 - 6 (another neighbour's neighbour) and a pair 7 - 8 apart from the rest.
const line = [join(0, 1), join(1, 2), join(2, 3), join(3, 4), join(4, 5), join(1, 6), join(7, 8)];

test("reach: the assets one, two and three joins out, and nothing further or unconnected", () => {
  const r = reach(line, 9, 0);
  assert.deepEqual(
    r.levels.map((l) => [...l.nodes].sort()),
    [[1], [2, 6], [3]],
  );
  assert.deepEqual(
    r.levels.map((l) => l.cut),
    [0, 0, 0],
  );
});

test("reach: a join is drawn once, at the nearest level it belongs to, and a join out of reach is not drawn", () => {
  const r = reach(line, 9, 0);
  assert.deepEqual(
    r.links.map((l) => [l.a, l.b, l.level]),
    [
      [0, 1, 1],
      [1, 2, 2],
      [2, 3, 3],
      [1, 6, 2],
    ],
  );
});

test("reach: a join between two assets of one level belongs to the next level, not a level of its own", () => {
  // 0 joins 1 and 2; 1 and 2 join each other; 2 and 3 join; 1 and 3 do not.
  const r = reach([join(0, 1), join(0, 2), join(1, 2), join(2, 3)], 4, 0);
  assert.deepEqual(
    r.links.map((l) => [l.a, l.b, l.level]),
    [
      [0, 1, 1],
      [0, 2, 1],
      [1, 2, 2],
      [2, 3, 2],
    ],
  );
  assert.deepEqual(r.levels[1].nodes, [3]);
});

test("reach: the same pair joined twice, either way round, is one join", () => {
  const r = reach([join(0, 1, "a"), join(1, 0, "b"), join(0, 1, "near-duplicate 0.980")], 2, 0);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].what, "a");
});

test("reach: a selection with no joins reaches nothing", () => {
  const r = reach([join(1, 2)], 3, 0);
  assert.deepEqual(
    r.levels.map((l) => [l.nodes.length, l.cut]),
    [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  );
  assert.deepEqual(r.links, []);
});

test("reach: a level past the cap keeps the most joined, counts the rest as cut, and the next level walks from the kept", () => {
  // 0 joins 1..10; 1 joins 11, and 2 joins 12; every other neighbour joins nothing else. Cap of 2 keeps 1 and 2 (the
  // only neighbours with a second join), so 11 and 12 are reached and nothing else is.
  const joins = [...Array.from({ length: 10 }, (_, k) => join(0, k + 1)), join(1, 11), join(2, 12)];
  const r = reach(joins, 13, 0, 2);
  assert.deepEqual(r.levels[0].nodes, [1, 2]);
  assert.equal(r.levels[0].cut, 8);
  assert.deepEqual(r.levels[1].nodes, [11, 12]);
  // A cut asset has no join drawn: only the two kept neighbours are joined to 0.
  assert.deepEqual(
    r.links.filter((l) => l.level === 1).map((l) => l.b),
    [1, 2],
  );
});

test("reach: the default cap is the one the legend reports", () => {
  const joins = Array.from({ length: LEVEL_CAP + 5 }, (_, k) => join(0, k + 1));
  const r = reach(joins, LEVEL_CAP + 6, 0);
  assert.equal(r.levels[0].nodes.length, LEVEL_CAP);
  assert.equal(r.levels[0].cut, 5);
});

test("joinsOf: declared links of the kinds asked for, and every near-duplicate pair", () => {
  const o = {
    links: [
      { from: 0, to: 1, kind: "superseded_by" },
      { from: 1, to: 2, kind: "xref" },
    ],
    duplicates: [{ a: 2, b: 3, cosine: 0.98 }],
  };
  assert.deepEqual(
    joinsOf(o).map((j) => [j.a, j.b, j.what]),
    [
      [0, 1, "superseded by"],
      [1, 2, "xref"],
      [2, 3, "near-duplicate 0.980"],
    ],
  );
  assert.deepEqual(
    joinsOf(o, ["superseded_by"]).map((j) => j.what),
    ["superseded by", "near-duplicate 0.980"],
  );
});

test("the levels step down in width and the third is dashed, so no level is told by colour alone", () => {
  const widths = LEVEL_STYLES.map((s) => s.width);
  assert.deepEqual(
    [...widths].sort((a, b) => b - a),
    widths,
  );
  assert.equal(new Set(widths).size, 3);
  assert.deepEqual(
    LEVEL_STYLES.map((s) => s.dash),
    [false, false, true],
  );
  const mutes = LEVEL_STYLES.map((s) => s.mute);
  assert.deepEqual(
    [...mutes].sort((a, b) => a - b),
    mutes,
  );
});
