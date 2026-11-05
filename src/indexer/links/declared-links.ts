// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Declared links (#935): the typed asset-to-asset edges an asset names in its
 * own frontmatter and parsed structure, derived with no model from the
 * document the indexer persists.
 *
 * Their nodes are asset refs, not free-text entities extracted by a model (the
 * `graph_*`-tabled LLM entity graph this superseded was retired in
 * 0.9.17-alpha.9), and each link belongs to the entry that declares it, so it
 * is written and replaced with that entry
 * (`asset_links`, `index-links-repository.ts`). Nothing here reads a file or
 * the index: a target is resolved to a `[bundle//]conceptId` from the token
 * alone, and whether that target exists is a join at read time, so a target
 * indexed after its citer resolves without reparsing the citer.
 *
 * Kinds, each pointing from the declaring asset to the target:
 *   - `xref`            — `xrefs:`
 *   - `superseded_by`   — `supersededBy:` (the declaring asset is the old one)
 *   - `contradicted_by` — `contradictedBy:` (the declaring asset lost)
 *   - `belief_peer`     — `currentBeliefRefs:`
 *   - `derived_from`    — a `.derived` memory's parent (`source:` / `derivedFrom:`)
 *   - `cites`           — `sources:` entries that name an asset (wiki raw sources)
 *   - `links_to`        — the resolved `links` an llm-wiki or OKF adapter reads from a page
 *   - `uses`            — a workflow step's or a task's target asset
 */

import type { IndexDocument } from "../../core/adapter/types";
import { stashDirFor } from "../../core/asset/asset-placement";
import { isBundleSlug, parseBundleRef } from "../../core/asset/asset-ref";

export type DeclaredLinkKind =
  | "xref"
  | "superseded_by"
  | "contradicted_by"
  | "belief_peer"
  | "derived_from"
  | "cites"
  | "links_to"
  | "uses";

export interface DeclaredLink {
  kind: DeclaredLinkKind;
  /** The token exactly as authored, legacy spellings included. */
  raw: string;
  /** The target's bundle when the token names one; absent means the declaring asset's own bundle. */
  bundle?: string;
  conceptId: string;
}

/** The declaring asset: its bundle and conceptId. */
export interface DeclaredLinkOwner {
  bundleId: string;
  conceptId: string;
}

/** Channel order is the order links are stored and shown in. */
const CHANNELS: ReadonlyArray<readonly [DeclaredLinkKind, (doc: IndexDocument) => unknown]> = [
  ["xref", (doc) => doc.xrefs],
  ["superseded_by", (doc) => doc.supersededBy],
  ["contradicted_by", (doc) => doc.contradictedBy],
  ["belief_peer", (doc) => doc.currentBeliefRefs],
  ["derived_from", (doc) => doc.derivedFrom],
  ["cites", (doc) => doc.sources],
  ["links_to", (doc) => doc.links],
  ["uses", (doc) => doc.uses],
];

/** The links an indexed document declares, in channel then authored order; one per (kind, target). */
export function declaredLinks(doc: IndexDocument, owner: DeclaredLinkOwner): DeclaredLink[] {
  const links: DeclaredLink[] = [];
  const seen = new Set<string>();
  for (const [kind, read] of CHANNELS) {
    for (const raw of stringValues(read(doc))) {
      const target = linkTarget(raw, owner.conceptId);
      if (!target) continue;
      const bundle = target.bundle ?? owner.bundleId;
      if (bundle === owner.bundleId && target.conceptId === owner.conceptId) continue;
      const key = `${kind}\0${bundle}\0${target.conceptId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ kind, raw, ...target });
    }
  }
  return links;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The target a token names, or `undefined` when the token is not an asset ref
 * (a session id, a URL, prose, a template placeholder). Retired spellings
 * convert in memory: `<type>:<name>` (`memory:x`), `wiki:<wiki>/<path>` (0.8
 * wikis, now knowledge under `wikis/`), a `.md` suffix, and a `#fragment`.
 * Inside a wiki page, `raw/…` and `pages/…` are relative to the wiki root.
 */
function linkTarget(raw: string, ownerConceptId: string): { bundle?: string; conceptId: string } | undefined {
  const token = raw.trim();
  if (!token || /[\s<*]/.test(token) || token.includes("$(") || token.includes("${")) return;
  let bundle: string | undefined;
  let body = token;
  const boundary = token.indexOf("//");
  if (boundary >= 0) {
    bundle = token.slice(0, boundary);
    body = token.slice(boundary + 2);
    if (!isBundleSlug(bundle)) return;
  }
  const conceptId = legacyConceptId(body.split("#", 1)[0] ?? "", ownerConceptId);
  if (conceptId === undefined || conceptId.length <= 1 || conceptId.includes("//")) return;
  try {
    return { ...(bundle ? { bundle } : {}), conceptId: parseBundleRef(conceptId).conceptId };
  } catch {
    return;
  }
}

function legacyConceptId(body: string, ownerConceptId: string): string | undefined {
  const stripped = body.replace(/\.md$/i, "");
  const colon = stripped.indexOf(":");
  if (colon >= 0) {
    const type = stripped.slice(0, colon);
    const name = stripped.slice(colon + 1);
    if (!name || name.includes(":")) return;
    if (type === "wiki") return `knowledge/wikis/${name}`;
    const stashDir = stashDirFor(type);
    return stashDir === undefined ? undefined : `${stashDir}/${name}`;
  }
  const wikiRoot = /^((?:[^/]+\/)*?wikis\/[^/]+\/)/.exec(ownerConceptId)?.[1];
  if (wikiRoot && /^(raw|pages)\//.test(stripped)) return `${wikiRoot}${stripped}`;
  return stripped;
}
