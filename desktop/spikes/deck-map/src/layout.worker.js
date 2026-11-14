// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A 3D force layout off the main thread. Links pull linked assets together; every asset is also held, weakly, at its
// position by meaning, so an asset with no links stays where its embedding put it. Positions stream back as the
// simulation cools.
//
// in:  { count, seed: Float32Array(count * 3), edges: Uint32Array(pairs) }
// out: { pos: Float32Array, tick, alpha, tickMs, done }

import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from "d3-force-3d";

const SEND_EVERY = 4;

self.onmessage = ({ data }) => {
  const { count, seed, edges } = data;
  const nodes = Array.from({ length: count }, (_, i) => ({
    x: seed[i * 3],
    y: seed[i * 3 + 1],
    z: seed[i * 3 + 2],
  }));
  const links = [];
  for (let e = 0; e < edges.length; e += 2) links.push({ source: edges[e], target: edges[e + 1] });
  const hold = (axis) =>
    (axis === 0 ? forceX : axis === 1 ? forceY : forceZ)((_, i) => seed[i * 3 + axis]).strength(0.04);
  const sim = forceSimulation(nodes, 3)
    .alphaDecay(0.03)
    .force("link", forceLink(links).distance(18).iterations(1))
    .force("charge", forceManyBody().strength(-6).theta(1.1).distanceMax(160))
    .force("x", hold(0))
    .force("y", hold(1))
    .force("z", hold(2))
    .stop();

  const send = (tick, tickMs, done) => {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = nodes[i].x;
      pos[i * 3 + 1] = nodes[i].y;
      pos[i * 3 + 2] = nodes[i].z;
    }
    self.postMessage({ pos, tick, alpha: sim.alpha(), tickMs, done }, [pos.buffer]);
  };
  let tick = 0;
  let spent = 0;
  const run = () => {
    const started = performance.now();
    for (let k = 0; k < SEND_EVERY && sim.alpha() > sim.alphaMin(); k++, tick++) sim.tick();
    spent += performance.now() - started;
    const done = sim.alpha() <= sim.alphaMin();
    send(tick, spent / Math.max(1, tick), done);
    if (!done) setTimeout(run, 0);
  };
  run();
};
