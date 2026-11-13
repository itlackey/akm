// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The one table of link-kind labels: what the Connections tab, the Link map and the library map call each kind. */
export const LINK_LABELS: Record<string, string> = {
  links_to: "Link",
  xref: "Cross-reference",
  cites: "Citation",
  derived_from: "Derived from",
  uses: "Uses",
  belief_peer: "Related belief",
  superseded_by: "Superseded by",
  contradicted_by: "Contradicted by",
};
export const linkLabel = (kind: string) => LINK_LABELS[kind] ?? kind.replaceAll("_", " ");
