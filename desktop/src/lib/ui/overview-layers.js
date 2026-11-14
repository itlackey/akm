// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @ts-nocheck -- presentation code: deck.gl layers, not type-checked here.
// The library map's layers. `library-overview.ts` decides what is where and what each mark means; this draws it.
//
// regionLayers: each part of the library a circle (area by its number of assets), each asset a dot inside it.
// relationLayers: each part a ball in 3D, joined by its declared links (solid, wider for more) and, dashed, to the part
//   most alike in content.
// `paint(token, alpha)` gives a token's colour as [r, g, b, a].

import { PathStyleExtension } from "@deck.gl/extensions";
import { LineLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";

export function regionLayers({
  count,
  regions,
  positions,
  dotRadius,
  assetColour,
  selected,
  paint,
  onGroup,
  onAsset,
  key,
}) {
  const groups = regions.map((_, k) => k);
  return [
    new ScatterplotLayer({
      id: "regions",
      data: groups,
      getPosition: (k) => [regions[k].x, regions[k].y],
      getRadius: (k) => regions[k].radius,
      radiusUnits: "common",
      filled: true,
      getFillColor: paint("--surface-2", 200),
      stroked: true,
      getLineColor: (k) => (k === selected ? paint("--text") : paint("--border-strong", 140)),
      getLineWidth: (k) => (k === selected ? 2.5 : 1),
      lineWidthUnits: "pixels",
      pickable: true,
      onClick: ({ object }) => onGroup(object),
      updateTriggers: { getLineColor: [selected, key], getLineWidth: selected, getFillColor: key },
    }),
    new ScatterplotLayer({
      id: "assets",
      data: { length: count },
      getPosition: (_, { index }) => [positions[index * 2], positions[index * 2 + 1]],
      getFillColor: (_, { index }) => assetColour(index),
      getRadius: dotRadius,
      radiusUnits: "common",
      radiusMinPixels: 0.8,
      pickable: true,
      onClick: ({ index }) => onAsset(index),
      updateTriggers: { getPosition: positions, getFillColor: key },
    }),
  ];
}

export function relationLayers({ nodes, pairs, alike, nodeColour, selected, paint, onGroup, key }) {
  const most = pairs[0]?.count ?? 1;
  const at = (k) => [nodes[k].x, nodes[k].y, nodes[k].z];
  const touches = (p) => selected < 0 || p.a === selected || p.b === selected;
  return [
    new LineLayer({
      id: "group-links",
      data: pairs,
      getSourcePosition: (p) => at(p.a),
      getTargetPosition: (p) => at(p.b),
      getWidth: (p) => 1 + 7 * Math.sqrt(p.count / most),
      widthUnits: "pixels",
      getColor: (p) => (touches(p) ? paint("--text", 120) : paint("--text", 25)),
      pickable: true,
      parameters: { depthWriteEnabled: false },
      updateTriggers: { getColor: [selected, key] },
    }),
    new PathLayer({
      id: "group-alike",
      data: alike,
      getPath: (p) => [at(p.a), at(p.b)],
      getColor: paint("--accent", 150),
      getWidth: 1.5,
      widthUnits: "pixels",
      billboard: true,
      extensions: [new PathStyleExtension({ dash: true })],
      getDashArray: [4, 4],
      dashUnits: "pixels",
      pickable: true,
      parameters: { depthWriteEnabled: false },
      updateTriggers: { getColor: key },
    }),
    new ScatterplotLayer({
      id: "groups",
      data: nodes.map((_, k) => k),
      getPosition: at,
      // A pixel size, so a topic stays the same size as the camera moves: 5 px, growing with the square root of its assets.
      getRadius: (k) => nodes[k].pixels,
      radiusUnits: "pixels",
      billboard: true,
      getFillColor: (k) => nodeColour(k),
      stroked: true,
      getLineColor: (k) => (k === selected ? paint("--text") : paint("--bg")),
      getLineWidth: (k) => (k === selected ? 3 : 1),
      lineWidthUnits: "pixels",
      pickable: true,
      onClick: ({ object }) => onGroup(object),
      parameters: { depthWriteEnabled: true, depthCompare: "less-equal" },
      updateTriggers: { getFillColor: [selected, key], getLineColor: [selected, key], getLineWidth: selected },
    }),
  ];
}
