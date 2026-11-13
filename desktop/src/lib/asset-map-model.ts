// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { linkLabel } from "./link-kinds.ts";

/** One asset in the middle, what links to it on the left, what it links to on the right: rows for the link map to draw. */

export type MapLink = { ref: string; label: string; note: string; y: number };
/** `inferred` is similarity, not a recorded link; `missing` is a link whose target akm could not find. */
export type MapGroup = {
  title: string;
  y: number;
  inferred: boolean;
  missing: boolean;
  links: MapLink[];
  /** Links akm counted but did not return, and where to say so. */
  more: number;
  moreY: number;
};
export interface AssetMap {
  height: number;
  centre: number;
  left: MapGroup[];
  right: MapGroup[];
  /** What each column is headed; null for an empty column. */
  leftHeading: string | null;
  rightHeading: string | null;
  /** Similar assets left out because the map already shows them as links. */
  similarLeftOut: number;
}

const HEAD = 24;
const ROW = 26;
const GAP = 14;
const name = (ref: string) => ref.split("//").at(-1) ?? ref;
const bundle = (ref: string) => (ref.includes("//") ? (ref.split("//")[0] ?? "") : "");

/** Give each group and link its vertical place, and return the column's height. */
function stack(groups: MapGroup[]): number {
  let y = 0;
  for (const group of groups) {
    group.y = y + HEAD / 2;
    y += HEAD;
    for (const link of group.links) {
      link.y = y + ROW / 2;
      y += ROW;
    }
    if (group.more) {
      group.moreY = y + ROW / 2;
      y += ROW;
    }
    y += GAP;
  }
  return Math.max(0, y - GAP);
}

/** A column holding only inferred similarity is not "Linked from" or "Links to": nothing was recorded. */
export function columnHeading(groups: MapGroup[], side: "left" | "right"): string | null {
  if (!groups.length) return null;
  if (groups.every((group) => group.inferred)) return "Not recorded links";
  return side === "left" ? "Linked from" : "Links to";
}

/**
 * The map of one asset's links. `connections` is `typedLinks(asset.links)`; `similar` is what `assets.related` returned,
 * when the reader asked for it. Similar content goes under the shorter column,
 * without the assets already shown as links (matched by ref).
 */
export function assetMap(
  connections: Array<{ direction: string; kind: string; refs: string[]; total: number }>,
  similar: Array<{ ref: string; title: string; cosine: number }>,
  self: string,
): AssetMap {
  const left: MapGroup[] = [];
  const right: MapGroup[] = [];
  for (const group of connections) {
    if (!group.refs.length && !group.total) continue;
    const missing = group.direction === "unresolved";
    (group.direction === "incoming" ? left : right).push({
      title: missing ? `${linkLabel(group.kind)} (missing)` : linkLabel(group.kind),
      y: 0,
      inferred: false,
      missing,
      links: group.refs.map((ref) => ({ ref, label: name(ref), note: bundle(ref), y: 0 })),
      more: Math.max(0, group.total - group.refs.length),
      moreY: 0,
    });
  }
  // A recorded link may name no bundle (it is in this asset's bundle); similar content always does.
  const home = bundle(self);
  const linked = new Set(
    connections.flatMap((group) => group.refs.map((ref) => (ref.includes("//") || !home ? ref : `${home}//${ref}`))),
  );
  const fresh = similar.filter((match) => !linked.has(match.ref));
  if (fresh.length)
    (stack(left) <= stack(right) ? left : right).push({
      title: "Similar content",
      y: 0,
      inferred: true,
      missing: false,
      links: fresh.map((match) => ({
        ref: match.ref,
        label: match.title || name(match.ref),
        note: `cosine ${match.cosine.toFixed(3)}`,
        y: 0,
      })),
      more: 0,
      moreY: 0,
    });
  const height = Math.max(stack(left), stack(right), 96);
  return {
    height,
    centre: height / 2,
    left,
    right,
    leftHeading: columnHeading(left, "left"),
    rightHeading: columnHeading(right, "right"),
    similarLeftOut: similar.length - fresh.length,
  };
}

/** A label cut to `max` characters, keeping its end: the last part of a path is the part that names the asset. */
export function fit(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - Math.max(1, max - 1))}`;
}
