// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Declared links (#935): the typed edges an asset's own frontmatter and parsed
 * structure name, derived without a model from the document the indexer
 * persists. Pure, no database.
 */

import { describe, expect, test } from "bun:test";
import type { IndexDocument } from "../../src/core/adapter/types";
import { declaredLinks } from "../../src/indexer/links/declared-links";

const OWNER = { bundleId: "stash", conceptId: "memories/deploy-window" };

function doc(fields: Partial<IndexDocument>): IndexDocument {
  return { name: "deploy-window", type: "memory", ...fields };
}

describe("declaredLinks", () => {
  test("each relation channel becomes its own kind, in channel then authored order", () => {
    const links = declaredLinks(
      doc({
        xrefs: ["memories/release-checklist", "akm//knowledge/runbook"],
        supersededBy: ["memories/deploy-window-v2"],
        contradictedBy: ["memories/deploy-window-moved"],
        currentBeliefRefs: ["memories/deploy-policy"],
        derivedFrom: "memories/deploy-notes",
        uses: ["commands/cut-release"],
      }),
      OWNER,
    );
    expect(links).toEqual([
      { kind: "xref", raw: "memories/release-checklist", conceptId: "memories/release-checklist" },
      { kind: "xref", raw: "akm//knowledge/runbook", bundle: "akm", conceptId: "knowledge/runbook" },
      { kind: "superseded_by", raw: "memories/deploy-window-v2", conceptId: "memories/deploy-window-v2" },
      { kind: "contradicted_by", raw: "memories/deploy-window-moved", conceptId: "memories/deploy-window-moved" },
      { kind: "belief_peer", raw: "memories/deploy-policy", conceptId: "memories/deploy-policy" },
      { kind: "derived_from", raw: "memories/deploy-notes", conceptId: "memories/deploy-notes" },
      { kind: "uses", raw: "commands/cut-release", conceptId: "commands/cut-release" },
    ]);
  });

  test("retired spellings convert in memory: type:name, wiki:, a .md suffix and a #fragment", () => {
    const links = declaredLinks(
      doc({
        contradictedBy: ["memory:deploy-window-moved"],
        xrefs: [
          "knowledge:projects/akm/checklist",
          "wiki:notes/pages/release-train",
          "memories/release-checklist.md",
          "knowledge/runbook#rollback",
        ],
      }),
      OWNER,
    );
    expect(links.map((link) => [link.kind, link.bundle, link.conceptId])).toEqual([
      ["xref", undefined, "knowledge/projects/akm/checklist"],
      ["xref", undefined, "knowledge/wikis/notes/pages/release-train"],
      ["xref", undefined, "memories/release-checklist"],
      ["xref", undefined, "knowledge/runbook"],
      ["contradicted_by", undefined, "memories/deploy-window-moved"],
    ]);
    // The authored token is kept exactly as written.
    expect(links.map((link) => link.raw)).toEqual([
      "knowledge:projects/akm/checklist",
      "wiki:notes/pages/release-train",
      "memories/release-checklist.md",
      "knowledge/runbook#rollback",
      "memory:deploy-window-moved",
    ]);
  });

  test("a wiki page's raw/ and pages/ tokens resolve against its own wiki root", () => {
    const links = declaredLinks(
      { name: "wikis/notes/pages/release-train", type: "knowledge", sources: ["raw/train-source.md"] },
      { bundleId: "stash", conceptId: "knowledge/wikis/notes/pages/release-train" },
    );
    expect(links).toEqual([
      { kind: "cites", raw: "raw/train-source.md", conceptId: "knowledge/wikis/notes/raw/train-source" },
    ]);
  });

  test("an llm-wiki or OKF bundle's resolved links and raw citations stay in the owner's bundle", () => {
    const links = declaredLinks(
      { name: "release-train", type: "concept", links: ["pages/deploys", "tables/customers"], sources: ["raw/a"] },
      { bundleId: "wiki", conceptId: "pages/release-train" },
    );
    expect(links.map((link) => [link.kind, link.bundle, link.conceptId])).toEqual([
      ["cites", undefined, "raw/a"],
      ["links_to", undefined, "pages/deploys"],
      ["links_to", undefined, "tables/customers"],
    ]);
  });

  test("tokens that are not asset refs make no link: session ids, URLs, prose, placeholders, other schemes", () => {
    const links = declaredLinks(
      doc({
        sources: [
          "session:claude-code:agent-a0000000000000001",
          "https://github.com/itlackey/akm/issues/935",
          "reference:some-book",
        ],
        xrefs: ["Run npm run typecheck", "skills/<name>", "memories/$(date)", "", "x"],
      }),
      OWNER,
    );
    expect(links).toEqual([]);
  });

  test("a repeated target is one link per kind, and the asset never links to itself", () => {
    const links = declaredLinks(
      doc({
        xrefs: ["memories/a", "memory:a", "memories/a.md", "memories/deploy-window", "stash//memories/deploy-window"],
        contradictedBy: ["memories/a"],
      }),
      OWNER,
    );
    expect(links.map((link) => [link.kind, link.conceptId])).toEqual([
      ["xref", "memories/a"],
      ["contradicted_by", "memories/a"],
    ]);
  });
});
