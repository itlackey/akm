// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Refs the index recorded as moved (`akm index` pairs a file renamed or moved on disk with its old entry and appends a
 * `moved` event) and the rewrite of links to them. `akm lint` reports a link to a moved ref as a `missing-ref` that
 * carries the new ref, and `--fix` rewrites it: only a ref with a recorded move is ever rewritten.
 */

import { rewritePathTokens } from "../../core/asset/ref-rewrite";
import { readEvents } from "../../core/events";
import { findFenceRegions } from "./markdown-insertion";

/** The ref a moved asset has now, and the link spelled as it is written to name it (a bare link stays bare). */
export interface MovedTarget {
  to: string;
  spelled: string;
}

export interface MovedRefs {
  /** Where a link as it is written (`bundle//concept` or a bare concept id, with any `#fragment`) now points. */
  target(link: string): MovedTarget | undefined;
  /** Concept ids some move left: a path ref outside the type folders is checked only when a move names it. */
  concepts: ReadonlySet<string>;
}

const conceptOf = (itemRef: string): string => itemRef.slice(itemRef.indexOf("//") + 2);
const bundleOf = (itemRef: string): string => itemRef.slice(0, itemRef.indexOf("//"));

/** The recorded moves, each old ref with the ref its asset has now (a later move re-keys the earlier events). */
export function readMovedRefs(): MovedRefs {
  const current = new Map<string, string>();
  for (const event of readEvents({ type: "moved" }, { readOnly: true }).events) {
    const from = event.metadata?.from;
    if (typeof from === "string" && event.ref !== undefined && event.ref !== from) current.set(from, event.ref);
  }
  const byConcept = new Map<string, string[]>();
  for (const from of current.keys()) byConcept.set(conceptOf(from), [...(byConcept.get(conceptOf(from)) ?? []), from]);
  return {
    concepts: new Set(byConcept.keys()),
    target(link) {
      const written = link.split("#", 1)[0] as string;
      // A bare link names the one moved asset with that path; two bundles that moved one path leave it ambiguous.
      const candidates = byConcept.get(written);
      const from = written.includes("//") ? written : candidates?.length === 1 ? candidates[0] : undefined;
      const to = from === undefined ? undefined : current.get(from);
      if (from === undefined || to === undefined) return undefined;
      return { to, spelled: written.includes("//") || bundleOf(to) !== bundleOf(from) ? to : conceptOf(to) };
    },
  };
}

/**
 * `raw` with each link of `spellings` (as written, without a fragment) rewritten to its new spelling, outside code
 * fences, where a link is an example and not a reference.
 */
export function rewriteMovedLinks(raw: string, spellings: ReadonlyMap<string, string>): string {
  const lines = raw.split("\n");
  const fenced = new Set<number>();
  for (const { start, end } of findFenceRegions(lines)) for (let i = start; i <= end; i++) fenced.add(i);
  const spell = (bundleId: string | undefined, stem: string) =>
    spellings.get(bundleId === undefined ? stem : `${bundleId}//${stem}`);
  return lines.map((line, index) => (fenced.has(index) ? line : rewritePathTokens(line, spell).text)).join("\n");
}
