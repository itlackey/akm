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
import { akmCurate } from "../../../src/commands/read/curate";
import { akmShowUnified } from "../../../src/commands/read/show";
import { assembleInfo } from "../../../src/commands/sources/info";
import { handleApiRequest } from "../../../src/commands/ui/api";
import { resetConfigCache } from "../../../src/core/config/config";
import { getConfigPath, getDbPath } from "../../../src/core/paths";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { rekeyEntryInPlace, renameEntriesBundleId } from "../../../src/storage/repositories/index-entries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

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
  write(
    "workflows/cut-release.md",
    "---\ntype: workflow\ndescription: Cut a release branch\nsteps:\n  - id: cut\n---\n\n## cut\n\nCut the branch.\n",
  );
  write(
    "workflows/release.md",
    [
      "---",
      "type: workflow",
      "steps:",
      "  - id: cut",
      "    unit:",
      "      workflow: workflows/cut-release",
      "---",
      "",
      "## cut",
      "",
      "Run the cut.",
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
  for (const adapter of ["okf", "llm-wiki"] as const) {
    test(`${adapter} code edits remove relationships, backlinks and support; full rebuild agrees`, async () => {
      const portable = path.join(storage.root, "portable");
      const put = (rel: string, body: string) => {
        const file = path.join(portable, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          `---\ntype: concept\npageKind: concept\ndescription: ${path.basename(rel, ".md")}\n---\n\n${body}\n`,
        );
        return file;
      };
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } },
          portable: { path: portable, components: { main: { root: ".", adapter } } },
        },
      });
      const source = "portable//pages/zeppelin-rollout";
      const harbor = "portable//pages/harbor";
      const mooring = "portable//pages/mooring";
      put("schema.md", "# Wiki schema");
      put("pages/zeppelin-rollout.md", "[Harbor](./harbor.md) [Mooring](./mooring.md) `[Example](./example.md)`");
      put("pages/harbor.md", "Safe harbor.");
      const mooringFile = put("pages/mooring.md", "Mooring instructions.");
      put("pages/example.md", "Illustrative placeholder, not a reference.");
      // Identical title in another bundle must not receive the portable edge.
      write("knowledge/harbor.md", "---\ndescription: harbor\n---\n\nUnrelated harbor.\n");
      await akmIndex({ stashDir: storage.stashDir });
      const original = storedLinks();
      expect(original).toEqual([
        `${source} links_to pages/harbor -> ${harbor}`,
        `${source} links_to pages/mooring -> ${mooring}`,
      ]);
      expect((await akmShowUnified({ ref: source })).links?.outgoing?.links_to?.refs).toEqual([harbor, mooring]);
      expect((await akmShowUnified({ ref: harbor })).links?.incoming?.links_to?.refs).toEqual([source]);
      const uiLinks = async (ref: string) => {
        const detail = (await handleApiRequest("/api/asset", new URLSearchParams({ ref }), {
          startedAt: "2026-10-20T00:00:00Z",
          host: "127.0.0.1",
          port: 0,
        })) as { asset: Awaited<ReturnType<typeof akmShowUnified>> };
        return detail.asset.links;
      };
      expect((await uiLinks(source))?.outgoing?.links_to?.refs).toEqual([harbor, mooring]);
      expect((await akmShowUnified({ ref: "knowledge/harbor" })).links).toBeUndefined();
      const support = async () => {
        const item = (await akmCurate({ query: "zeppelin rollout", limit: 1 })).items[0];
        expect(item && "ref" in item ? item.ref : undefined).toBe(source);
        return item && "supportRefs" in item ? item.supportRefs?.map((entry) => entry.ref) : undefined;
      };
      expect(await support()).toEqual([harbor, mooring]);

      // An edited real link becomes code; a deleted target becomes unresolved,
      // while its still-authored link remains (the tolerant missing-link contract).
      put(
        "pages/zeppelin-rollout.md",
        "``[Harbor](./harbor.md) ` literal`` [Mooring](./mooring.md)\n\n~~~md\n[Example](./example.md)\n~~~",
      );
      fs.rmSync(mooringFile);
      await akmIndex({ stashDir: storage.stashDir });
      expect(storedLinks()).toEqual([`${source} links_to pages/mooring -> null`]);
      expect((await akmShowUnified({ ref: source })).links).toEqual({
        unresolved: { links_to: { total: 1, refs: ["pages/mooring"] } },
      });
      expect((await akmShowUnified({ ref: harbor })).links).toBeUndefined();
      expect(await support()).toBeUndefined();
      expect((await uiLinks(source))?.unresolved?.links_to?.refs).toEqual(["pages/mooring"]);
      expect(await uiLinks(harbor)).toBeUndefined();
      const incremental = storedLinks();
      await akmIndex({ stashDir: storage.stashDir, full: true });
      expect(storedLinks()).toEqual(incremental);

      // Changing the actual target and then deleting its citer removes old edges.
      put("pages/zeppelin-rollout.md", "[Harbor](./harbor.md) `[Mooring](./mooring.md)`");
      await akmIndex({ stashDir: storage.stashDir });
      expect(storedLinks()).toEqual([`${source} links_to pages/harbor -> ${harbor}`]);
      expect(await support()).toEqual([harbor]);
      fs.rmSync(path.join(portable, "pages/zeppelin-rollout.md"));
      await akmIndex({ stashDir: storage.stashDir });
      expect(storedLinks()).toEqual([]);
      expect((await akmShowUnified({ ref: harbor })).links).toBeUndefined();
      await akmIndex({ stashDir: storage.stashDir, full: true });
      expect(storedLinks()).toEqual([]);
    });
  }

  test("index --full reparses unchanged files to remove old code-example links", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "stash",
      bundles: { stash: { path: storage.stashDir, components: { main: { root: ".", adapter: "okf" } } } },
    });
    write("pages/start.md", "---\ntype: concept\ndescription: Start\n---\n\n`[Example](./example.md)`\n");
    write("pages/example.md", "---\ntype: concept\ndescription: Example\n---\n\nExample.\n");
    await akmIndex({ stashDir: storage.stashDir });
    expect(storedLinks()).toEqual([]);
    // Simulate the previous release's stored document plus its false edge.
    const db = openIndexDatabase(getDbPath());
    try {
      const row = db.prepare("SELECT id, document_json FROM entries WHERE item_ref = ?").get("stash//pages/start") as {
        id: number;
        document_json: string;
      };
      const document = { ...JSON.parse(row.document_json), links: ["pages/example"] };
      db.prepare("UPDATE entries SET document_json = ? WHERE id = ?").run(JSON.stringify(document), row.id);
      db.prepare(
        "INSERT INTO asset_links (entry_id, ord, kind, raw, dst_bundle, dst_concept) VALUES (?, 0, 'links_to', 'pages/example', NULL, 'pages/example')",
      ).run(row.id);
    } finally {
      closeDatabase(db);
    }
    expect((await akmShowUnified({ ref: "pages/example" })).links?.incoming?.links_to?.refs).toEqual(["pages/start"]);
    await akmIndex({ stashDir: storage.stashDir });
    expect(storedLinks()).toHaveLength(1); // Unchanged-file indexing keeps prior results.
    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(storedLinks()).toEqual([]);
    expect((await akmShowUnified({ ref: "pages/example" })).links).toBeUndefined();
  });

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
      "stash//workflows/release uses workflows/cut-release -> stash//workflows/cut-release",
    ]);

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

  test("akm show lists outgoing, incoming and unresolved links grouped by kind", async () => {
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

    const target = await akmShowUnified({ ref: "memories/deploy-window-moved" });
    expect(target.links).toEqual({
      incoming: {
        contradicted_by: { total: 1, refs: ["memories/deploy-window"] },
        derived_from: { total: 1, refs: ["memories/deploy-window-moved.derived"] },
      },
    });

    const successor = await akmShowUnified({ ref: "knowledge/release-guide-v2" });
    expect(successor.links).toEqual({ incoming: { superseded_by: { total: 1, refs: ["knowledge/release-guide"] } } });
    const command = await akmShowUnified({ ref: "workflows/cut-release" });
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

  test("curate's support refs are the item's declared links, outgoing first", async () => {
    write(
      "knowledge/zeppelin-rollout.md",
      "---\ndescription: Zeppelin rollout plan\nxrefs:\n  - memories/hangar-incident\n  - knowledge/mooring-runbook\n---\n\n# Plan\n",
    );
    write("memories/hangar-incident.md", "---\ndescription: A hangar door jammed\n---\n\nJammed.\n");
    write("knowledge/mooring-runbook.md", "---\ndescription: Mooring the airship\n---\n\n# Mooring\n");
    write(
      "memories/crew-notes.md",
      "---\ndescription: Crew notes\nxrefs:\n  - knowledge/zeppelin-rollout\n---\n\nN.\n",
    );
    // An unrelated distractor doc: absent, corpus-relative scoring reorders the
    // "both" assertion below (crew-notes outscores mooring-runbook).
    write("knowledge/balloon-basics.md", "---\ndescription: Balloon basics\n---\n\n# Basics\n");
    await akmIndex({ stashDir: storage.stashDir });

    const [plan] = (await akmCurate({ query: "zeppelin rollout plan", limit: 1 })).items;
    expect(plan && "ref" in plan ? plan.ref : undefined).toBe("knowledge/zeppelin-rollout");
    expect(plan && "supportRefs" in plan ? plan.supportRefs : undefined).toEqual([
      { ref: "memories/hangar-incident", type: "memory", reason: "Declared link (xref) from this asset." },
      { ref: "knowledge/mooring-runbook", type: "knowledge", reason: "Declared link (xref) from this asset." },
    ]);

    // A linked asset curate already selected is not repeated; the next declared link fills in.
    const both = (await akmCurate({ query: "zeppelin rollout plan mooring", limit: 2 })).items;
    expect(both.map((item) => ("ref" in item ? item.ref : undefined))).toEqual([
      "knowledge/zeppelin-rollout",
      "knowledge/mooring-runbook",
    ]);
    expect(both[0] && "supportRefs" in both[0] ? both[0].supportRefs : undefined).toEqual([
      { ref: "memories/hangar-incident", type: "memory", reason: "Declared link (xref) from this asset." },
      { ref: "memories/crew-notes", type: "memory", reason: "Declared link (xref) to this asset." },
    ]);
    expect(both[1] && "supportRefs" in both[1] ? both[1].supportRefs : undefined).toBeUndefined();
  });

  test("show lists at most 10 refs per kind and counts every link in total", async () => {
    write("knowledge/hub.md", "---\ndescription: A hub\n---\n\n# Hub\n");
    for (let i = 0; i < 12; i++) {
      write(
        `memories/cites-hub-${String(i).padStart(2, "0")}.md`,
        "---\ndescription: n\nxrefs:\n  - knowledge/hub\n---\n\nN.\n",
      );
    }
    await akmIndex({ stashDir: storage.stashDir });
    const hub = await akmShowUnified({ ref: "knowledge/hub" });
    expect(hub.links?.incoming?.xref?.total).toBe(12);
    expect(hub.links?.incoming?.xref?.refs).toEqual(
      Array.from({ length: 10 }, (_, i) => `memories/cites-hub-${String(i).padStart(2, "0")}`),
    );
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
