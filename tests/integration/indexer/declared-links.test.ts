// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Declared links (#935), end to end: `akm index` with no engine stores the
 * relations a stash declares (xrefs, supersession, contradiction, derivation,
 * wiki citations, workflow and task targets) as typed links in their own
 * table, replaces an entry's links with the entry, resolves a target when it
 * is indexed rather than when its citer was, and `akm show` lists them both
 * ways. Runs the indexer against real databases, so it lives under
 * tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../../src/commands/read/show";
import { assembleInfo } from "../../../src/commands/sources/info";
import { resetConfigCache } from "../../../src/core/config/config";
import { getConfigPath, getDbPath } from "../../../src/core/paths";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { rekeyEntryInPlace, renameEntriesBundleId } from "../../../src/storage/repositories/index-entries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

function write(rel: string, content: string): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Every stored link as `owner kind raw -> resolved target | null`, sorted. */
function storedLinks(): string[] {
  const db = openIndexDatabase(getDbPath());
  try {
    const rows = db
      .prepare(
        `SELECT o.item_ref AS owner, l.kind AS kind, l.raw AS raw, t.item_ref AS target
           FROM asset_links l
           JOIN entries o ON o.id = l.entry_id
           LEFT JOIN entries t ON t.item_ref = COALESCE(l.dst_bundle, o.bundle_id) || '//' || l.dst_concept`,
      )
      .all() as Array<{ owner: string; kind: string; raw: string; target: string | null }>;
    return rows.map((row) => `${row.owner} ${row.kind} ${row.raw} -> ${row.target ?? "null"}`).sort();
  } finally {
    closeDatabase(db);
  }
}

function writeStash(): void {
  write(
    "memories/deploy-window.md",
    [
      "---",
      "description: Deploys run in the Tuesday window",
      "beliefState: contradicted",
      "contradictedBy:",
      "  - memory:deploy-window-moved",
      "sources:",
      "  - session:claude-code:agent-a0000000000000001",
      "xrefs:",
      "  - memories/release-checklist",
      "  - wiki:notes/pages/release-train",
      "---",
      "",
      "Deploys run in the Tuesday window.",
    ].join("\n"),
  );
  write("memories/deploy-window-moved.md", "---\ndescription: The window moved to Thursday\n---\n\nThursday.\n");
  write(
    "memories/deploy-window-moved.derived.md",
    "---\ndescription: Derived Thursday summary\ninferred: true\nsource: memories/deploy-window-moved\n---\n\nThu.\n",
  );
  write(
    "knowledge/release-guide.md",
    "---\ndescription: How releases are cut\nsupersededBy:\n  - stash//knowledge/release-guide-v2\n---\n\n# Guide\n",
  );
  write("knowledge/release-guide-v2.md", "---\ndescription: Second edition\n---\n\n# Guide v2\n");
  write("knowledge/standalone.md", "---\ndescription: Links nothing and nothing links it\n---\n\n# Alone\n");
  write(
    "wikis/notes/pages/release-train.md",
    "---\ndescription: The release train\npageKind: concept\nsources:\n  - raw/train-source.md\n---\n\n# Train\n",
  );
  write("wikis/notes/raw/train-source.md", "---\ndescription: Train source snapshot\n---\n\nSource.\n");
  write("commands/cut-release.md", "---\ndescription: Cut a release branch\n---\n\nCut $ARGUMENTS.\n");
  write(
    "workflows/release.yml",
    [
      "name: release",
      "on:",
      "  workflow_dispatch: {}",
      "jobs:",
      "  release:",
      "    runs-on: [self-hosted]",
      "    steps:",
      "      - id: cut",
      "        uses: commands/cut-release",
    ].join("\n"),
  );
  write(
    "tasks/nightly-release.yml",
    "version: 4\nname: Nightly release\nuses: workflows/release\nschedule: '0 3 * * *'\n",
  );
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  fs.writeFileSync(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "off" }));
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

describe("declared links", () => {
  test("indexing with no engine stores every declared relation as a typed link, resolved or not", async () => {
    writeStash();
    await akmIndex({ stashDir: storage.stashDir });

    expect(storedLinks()).toEqual([
      "stash//knowledge/release-guide superseded_by stash//knowledge/release-guide-v2 -> stash//knowledge/release-guide-v2",
      "stash//knowledge/wikis/notes/pages/release-train cites raw/train-source.md -> stash//knowledge/wikis/notes/raw/train-source",
      "stash//memories/deploy-window contradicted_by memory:deploy-window-moved -> stash//memories/deploy-window-moved",
      "stash//memories/deploy-window xref memories/release-checklist -> null",
      "stash//memories/deploy-window xref wiki:notes/pages/release-train -> stash//knowledge/wikis/notes/pages/release-train",
      "stash//memories/deploy-window-moved.derived derived_from memories/deploy-window-moved -> stash//memories/deploy-window-moved",
      "stash//tasks/nightly-release uses workflows/release -> stash//workflows/release",
      "stash//workflows/release uses commands/cut-release -> stash//commands/cut-release",
    ]);

    // The LLM entity graph is a separate model: indexing writes nothing to it.
    const db = openIndexDatabase(getDbPath());
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM graph_files").get()).toEqual({ n: 0 });
    } finally {
      closeDatabase(db);
    }

    // `akm info` reports links per kind with the unresolved count.
    expect(assembleInfo().indexStats.links).toEqual({
      cites: { total: 1, unresolved: 0 },
      contradicted_by: { total: 1, unresolved: 0 },
      derived_from: { total: 1, unresolved: 0 },
      superseded_by: { total: 1, unresolved: 0 },
      uses: { total: 2, unresolved: 0 },
      xref: { total: 2, unresolved: 1 },
    });
  });

  test("akm show lists outgoing, incoming and unresolved links grouped by kind; related is unchanged", async () => {
    writeStash();
    await akmIndex({ stashDir: storage.stashDir });

    const citer = await akmShowUnified({ ref: "memories/deploy-window" });
    expect(citer.links).toEqual({
      outgoing: {
        contradicted_by: { total: 1, refs: ["memories/deploy-window-moved"] },
        xref: { total: 1, refs: ["knowledge/wikis/notes/pages/release-train"] },
      },
      unresolved: { xref: { total: 1, refs: ["memories/release-checklist"] } },
    });
    expect(citer.related).toEqual({ total: 0, hits: [] });

    const target = await akmShowUnified({ ref: "memories/deploy-window-moved" });
    expect(target.links).toEqual({
      incoming: {
        contradicted_by: { total: 1, refs: ["memories/deploy-window"] },
        derived_from: { total: 1, refs: ["memories/deploy-window-moved.derived"] },
      },
    });

    const successor = await akmShowUnified({ ref: "knowledge/release-guide-v2" });
    expect(successor.links).toEqual({ incoming: { superseded_by: { total: 1, refs: ["knowledge/release-guide"] } } });
    const command = await akmShowUnified({ ref: "commands/cut-release" });
    expect(command.links).toEqual({ incoming: { uses: { total: 1, refs: ["workflows/release"] } } });

    // An asset with no declared links in either direction has no links field.
    const standalone = await akmShowUnified({ ref: "knowledge/standalone" });
    expect(standalone.links).toBeUndefined();
  });

  test("an incremental reindex replaces an entry's links, drops a deleted entry's, and resolves a target added later", async () => {
    writeStash();
    await akmIndex({ stashDir: storage.stashDir });

    // The missing target appears: the citer's unchanged link now resolves.
    write("memories/release-checklist.md", "---\ndescription: The release checklist\n---\n\nCheck.\n");
    // A citer changes its declared links.
    write(
      "knowledge/release-guide.md",
      "---\ndescription: How releases are cut\nxrefs:\n  - memories/deploy-window\n---\n\n# Guide\n",
    );
    // An entry is deleted.
    fs.rmSync(path.join(storage.stashDir, "tasks", "nightly-release.yml"));
    await akmIndex({ stashDir: storage.stashDir });

    const links = storedLinks();
    expect(links).toContain(
      "stash//memories/deploy-window xref memories/release-checklist -> stash//memories/release-checklist",
    );
    expect(links).toContain(
      "stash//knowledge/release-guide xref memories/deploy-window -> stash//memories/deploy-window",
    );
    expect(links.some((line) => line.includes("superseded_by"))).toBe(false);
    expect(links.some((line) => line.startsWith("stash//tasks/nightly-release"))).toBe(false);
  });

  test("a memory whose own file is gone resolves to its .derived child, the reachability rule lint applies", async () => {
    write(
      "memories/old-window.md",
      "---\ndescription: The old window\nbeliefState: contradicted\ncontradictedBy:\n  - memory:pruned-winner\n---\n\nOld.\n",
    );
    write(
      "memories/pruned-winner.derived.md",
      "---\ndescription: What survived of the winner\ninferred: true\nsource: memories/pruned-winner\n---\n\nKept.\n",
    );
    await akmIndex({ stashDir: storage.stashDir });

    const loser = await akmShowUnified({ ref: "memories/old-window" });
    expect(loser.links).toEqual({
      outgoing: { contradicted_by: { total: 1, refs: ["memories/pruned-winner.derived"] } },
    });
    // The child's own parent link stays unresolved: it never resolves to itself.
    const child = await akmShowUnified({ ref: "memories/pruned-winner.derived" });
    expect(child.links).toEqual({
      incoming: { contradicted_by: { total: 1, refs: ["memories/old-window"] } },
      unresolved: { derived_from: { total: 1, refs: ["memories/pruned-winner"] } },
    });
    expect(assembleInfo().indexStats.links).toEqual({
      contradicted_by: { total: 1, unresolved: 0 },
      derived_from: { total: 1, unresolved: 1 },
    });
  });

  test("a bundle rename carries short refs along; a ref that names the old bundle no longer resolves", async () => {
    writeStash();
    await akmIndex({ stashDir: storage.stashDir });
    const db = openIndexDatabase(getDbPath());
    try {
      renameEntriesBundleId(db, "stash", "renamed");
    } finally {
      closeDatabase(db);
    }
    const links = storedLinks();
    expect(links).toContain(
      "renamed//memories/deploy-window contradicted_by memory:deploy-window-moved -> renamed//memories/deploy-window-moved",
    );
    // The guide's content still spells `stash//…`: rename reports such refs and never rewrites them.
    expect(links).toContain("renamed//knowledge/release-guide superseded_by stash//knowledge/release-guide-v2 -> null");
  });

  test("re-keying a moved entry re-derives its links from the patched document", async () => {
    writeStash();
    await akmIndex({ stashDir: storage.stashDir });
    const db = openIndexDatabase(getDbPath());
    try {
      const moved = path.join(storage.stashDir, "memories", "window-thursday.derived.md");
      rekeyEntryInPlace(db, {
        newName: "window-thursday.derived",
        newFilePath: moved,
        oldRef: "memories/deploy-window-moved.derived",
        newRef: "memories/window-thursday.derived",
        sourceName: "stash",
        sourceRoot: storage.stashDir,
        newDerivedFrom: "memories/window-thursday",
      });
    } finally {
      closeDatabase(db);
    }
    expect(storedLinks()).toContain(
      "stash//memories/window-thursday.derived derived_from memories/window-thursday -> null",
    );
  });

  test("a write-path index (akm remember) records the new asset's links at once", async () => {
    writeStash();
    await akmIndex({ stashDir: storage.stashDir });

    const file = write(
      "memories/new-note.md",
      "---\ndescription: A new note\nxrefs:\n  - memories/deploy-window\n---\n\nNote.\n",
    );
    expect(await indexWrittenAssets(storage.stashDir, [file])).toBe(true);

    expect(storedLinks()).toContain(
      "stash//memories/new-note xref memories/deploy-window -> stash//memories/deploy-window",
    );
    const target = await akmShowUnified({ ref: "memories/deploy-window" });
    expect(target.links?.incoming).toEqual({ xref: { total: 1, refs: ["memories/new-note"] } });
  });
});
