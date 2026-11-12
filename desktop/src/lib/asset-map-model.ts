// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

/**
 * The map of one asset's links. `connections` is `typedLinks(asset.links)`; `similar` is what `assets.related` returned,
 * when the reader asked for it. Similar content goes under the shorter column.
 */
export function assetMap(
  connections: Array<{ direction: string; kind: string; refs: string[]; total: number }>,
  similar: Array<{ ref: string; title: string; cosine: number }>,
  kindLabel: (kind: string) => string,
): AssetMap {
  const left: MapGroup[] = [];
  const right: MapGroup[] = [];
  for (const group of connections) {
    if (!group.refs.length && !group.total) continue;
    const missing = group.direction === "unresolved";
    (group.direction === "incoming" ? left : right).push({
      title: missing ? `${kindLabel(group.kind)} (missing)` : kindLabel(group.kind),
      y: 0,
      inferred: false,
      missing,
      links: group.refs.map((ref) => ({ ref, label: name(ref), note: bundle(ref), y: 0 })),
      more: Math.max(0, group.total - group.refs.length),
      moreY: 0,
    });
  }
  if (similar.length)
    (stack(left) <= stack(right) ? left : right).push({
      title: "Similar content",
      y: 0,
      inferred: true,
      missing: false,
      links: similar.map((match) => ({
        ref: match.ref,
        label: match.title || name(match.ref),
        note: `cosine ${match.cosine.toFixed(3)}`,
        y: 0,
      })),
      more: 0,
      moreY: 0,
    });
  const height = Math.max(stack(left), stack(right), 96);
  return { height, centre: height / 2, left, right };
}

/** A label cut to `max` characters, keeping its end: the last part of a path is the part that names the asset. */
export function fit(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - Math.max(1, max - 1))}`;
}
