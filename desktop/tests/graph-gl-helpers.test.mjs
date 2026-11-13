// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  drawnDiameter,
  fitDistance,
  HIT_PAD_PX,
  hitRadius,
  POINT_CAP_PX,
  POINT_MAX_PX,
  POINT_MIN_PX,
  panVector,
  pointDiameter,
  RING_GAP_PX,
  RING_WIDTH_PX,
} from "../src/lib/ui/graph-gl.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test("point diameter spans the stated CSS-pixel range and its area follows the value", () => {
  assert.equal(pointDiameter(0, 100), POINT_MIN_PX);
  assert.equal(pointDiameter(100, 100), POINT_MAX_PX);
  assert.equal(pointDiameter(5, 0), POINT_MIN_PX);
  // Radius grows with sqrt(value): a quarter of the maximum is halfway up the range.
  near(pointDiameter(25, 100), (POINT_MIN_PX + POINT_MAX_PX) / 2);
  // Small values stay apart (the old 2 px floor made 0-2 shows identical).
  assert.ok(pointDiameter(1, 500) > pointDiameter(0, 500));
});

test("emphasis keeps the point's own diameter and adds a ring; the hit radius follows the ringed size", () => {
  const ring = 2 * (RING_GAP_PX + RING_WIDTH_PX);
  assert.equal(RING_GAP_PX, 1);
  assert.equal(RING_WIDTH_PX, 1.5);
  assert.equal(drawnDiameter(8, 1), 8);
  assert.equal(drawnDiameter(8, 0), 8);
  // The point inside the ring is its own size: sprite minus the ring's outset is the diameter.
  assert.equal(drawnDiameter(8, 2) - ring, 8);
  assert.equal(drawnDiameter(POINT_MIN_PX, 2), POINT_MIN_PX + ring);
  assert.equal(drawnDiameter(8, 3), 0);
  assert.ok(drawnDiameter(POINT_MAX_PX, 2) <= POINT_CAP_PX);
  assert.equal(hitRadius(drawnDiameter(8, 2)), (8 + ring) / 2 + HIT_PAD_PX);
  assert.ok(hitRadius(drawnDiameter(8, 2)) > hitRadius(drawnDiameter(8, 1)));
});

test("keyboard pan follows the screen axes at any yaw", () => {
  const [x0, z0] = panVector(0, 1, 0);
  near(x0, 1);
  near(z0, 0);
  const [x1, z1] = panVector(0, 0, 1);
  near(x1, 0);
  near(z1, -1);
  // Turned a quarter, screen-right is world -z; the vector keeps its length.
  const [x2, z2] = panVector(Math.PI / 2, 1, 0);
  near(x2, 0);
  near(z2, -1);
  const [x3, z3] = panVector(0.6, 3, 4);
  near(Math.hypot(x3, z3), 5);
});

test("fit distance frames the drawn bounding box, by size not by distance from the origin", () => {
  const fov = 0.8;
  const view = { flat: true, fov, aspect: 1.5 };
  const small = fitDistance({ min: [0, 0, 0], max: [100, 0, 100] }, view);
  const far = fitDistance({ min: [5000, 0, 5000], max: [5100, 0, 5100] }, view);
  near(small, far);
  assert.ok(fitDistance({ min: [0, 0, 0], max: [200, 0, 200] }, view) > small);
  assert.equal(fitDistance(null, view), 2150);
  assert.equal(fitDistance({ min: [0, 0, 0], max: [0, 0, 0] }, view), 60);
  // 3D uses the bounding sphere, so it is never closer than the flat view of the same box.
  const cube = { min: [0, 0, 0], max: [100, 100, 100] };
  assert.ok(fitDistance(cube, { ...view, flat: false }) > small);
  // With the farthest point's distance from the centre, the sphere is the points', not the box's corners'.
  const ball = fitDistance({ ...cube, radius: 50 }, { ...view, flat: false });
  near(ball * Math.sqrt(3), fitDistance(cube, { ...view, flat: false }));
});
