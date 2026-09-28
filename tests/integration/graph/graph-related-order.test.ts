// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm show`'s `related` list (`listRelatedPathsForFile`) is deterministic:
 * files sharing more entities come first, ties break by path, and neither the
 * order graph rows were written in nor the order `entries` rows were indexed
 * in changes the result. Opens real SQLite databases, so it lives under
 * tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import { listRelatedPathsForFile } from "../../../src/indexer/graph/graph-related";
import type { GraphFileNode } from "../../../src/indexer/graph/graph-types";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const opened: Database[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  for (const db of opened.splice(0)) closeDatabase(db);
  storage.cleanup();
});

const knowledge = (name: string) => path.join(storage.stashDir, "knowledge", `${name}.md`);

function node(name: string, entities: string[]): GraphFileNode {
  return { path: knowledge(name), type: "knowledge", bodyHash: `${name}-hash`, entities, relations: [] };
}

/** One index holding the same graph and entries, written in the given orders. */
function buildIndex(dbName: string, fileOrder: string[], conceptOrder: string[]): Database {
  const db = openIndexDatabase(path.join(storage.dataDir, dbName));
  opened.push(db);
  const entities: Record<string, string[]> = {
    target: ["Alpha", "Beta"],
    both: ["Beta", "Alpha"],
    a: ["Alpha"],
    b: ["Beta"],
    c: ["alpha"],
    d: ["Beta"],
    e: ["Alpha"],
  };
  for (const conceptName of conceptOrder) {
    // `a-alias` indexes the same file as `a`: two entries rows for one path.
    const fileName = conceptName === "a-alias" ? "a" : conceptName;
    const entry = { name: conceptName, type: "knowledge", filename: `${fileName}.md` };
    const provenance = deriveEntryProvenance(
      { bundleId: "stash", componentId: "stash", adapterId: "akm" },
      "knowledge",
      conceptName,
    );
    upsertEntry(db, knowledge(fileName), entry, provenance);
  }
  replaceStoredGraph(db, {
    schemaVersion: 4,
    generatedAt: "2026-09-27T00:00:00.000Z",
    stashRoot: storage.stashDir,
    files: fileOrder.map((name) => node(name, entities[name] ?? [])),
  });
  return db;
}

describe("related order", () => {
  test("more shared entities first, ties by path, independent of write order", () => {
    const first = buildIndex(
      "first.db",
      ["target", "d", "both", "b", "e", "a", "c"],
      ["a-alias", "a", "b", "c", "d", "e", "both", "target"],
    );
    const second = buildIndex(
      "second.db",
      ["c", "a", "e", "b", "both", "d", "target"],
      ["target", "both", "e", "d", "c", "b", "a", "a-alias"],
    );

    const related = listRelatedPathsForFile(storage.stashDir, knowledge("target"), 5, first);
    expect(related.map((hit) => [path.basename(hit.path), hit.ref, hit.sharedEntities])).toEqual([
      ["both.md", "knowledge/both", ["Alpha", "Beta"]],
      ["a.md", "knowledge/a", ["Alpha"]],
      ["b.md", "knowledge/b", ["Beta"]],
      ["c.md", "knowledge/c", ["alpha"]],
      ["d.md", "knowledge/d", ["Beta"]],
    ]);
    expect(listRelatedPathsForFile(storage.stashDir, knowledge("target"), 5, first)).toEqual(related);
    expect(listRelatedPathsForFile(storage.stashDir, knowledge("target"), 5, second)).toEqual(related);
  });

  test("a shared entity counts once, however many forms of it a file holds", () => {
    const db = openIndexDatabase(path.join(storage.dataDir, "variants.db"));
    opened.push(db);
    // Rows an older extractor wrote: two case forms of one entity in one file.
    replaceStoredGraph(db, {
      schemaVersion: 4,
      generatedAt: "2026-09-27T00:00:00.000Z",
      stashRoot: storage.stashDir,
      files: [
        node("target", ["Redis", "redis", "Kafka", "Zookeeper"]),
        node("x", ["Redis"]),
        node("y", ["Kafka", "Zookeeper"]),
      ],
    });

    const related = listRelatedPathsForFile(storage.stashDir, knowledge("target"), 5, db);
    expect(related.map((hit) => [path.basename(hit.path), hit.sharedEntities])).toEqual([
      ["y.md", ["Kafka", "Zookeeper"]],
      ["x.md", ["Redis"]],
    ]);
  });

  test("related matches entities by the key extraction deduplicates on", () => {
    const db = openIndexDatabase(path.join(storage.dataDir, "normalized.db"));
    opened.push(db);
    replaceStoredGraph(db, {
      schemaVersion: 4,
      generatedAt: "2026-09-27T00:00:00.000Z",
      stashRoot: storage.stashDir,
      files: [node("target", ["`Redis`"]), node("plain", ["Redis"])],
    });

    const related = listRelatedPathsForFile(storage.stashDir, knowledge("target"), 5, db);
    expect(related.map((hit) => path.basename(hit.path))).toEqual(["plain.md"]);
  });
});
