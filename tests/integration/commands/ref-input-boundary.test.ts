// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk-5 flip F1b (ref-grammar decision D-R1/D-R4): the CLI/API input
 * boundaries route raw refs through `parseRefInput`, which accepts BOTH the new
 * `[bundle//]conceptId` grammar and the pre-0.9.0 `[origin//]type:name` grammar.
 *
 * This drives THREE representative commands (`show`, `feedback`, `graph`) at the
 * command level and proves that the SAME asset resolves through all three
 * spellings of its ref — legacy `type:name`, the short new-grammar `conceptId`,
 * and the fully-qualified `bundle//conceptId` — so F2's re-keyed test literals
 * no longer throw at the parse edge before reaching the F1 dual-keyed readers.
 *
 * The asset lives ONLY in an installed source whose id (`catalog`) is a legal
 * bundle slug, so the `catalog//…` spelling exercises real origin resolution
 * (registryId match), not a primary-stash shortcut. ADDITIVE-stage coverage:
 * the old suite never speaks the new grammar, so every assertion is net-new.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmGraphRelated } from "../../../src/commands/graph/graph";
import { akmShowUnified } from "../../../src/commands/read/show";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import { GRAPH_FILE_SCHEMA_VERSION } from "../../../src/indexer/graph/graph-extraction";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
// Trigger source-provider self-registration.
import "../../../src/sources/providers/index";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let catalogRoot = "";
let guidePath = "";

/** The three spellings of the SAME `knowledge/guide` concept in the `catalog` bundle. */
const SPELLINGS = ["knowledge/guide", "knowledge/guide", "catalog//knowledge/guide"] as const;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  catalogRoot = path.join(storage.root, "catalog");
  guidePath = path.join(catalogRoot, "knowledge", "guide.md");
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  fs.writeFileSync(guidePath, "---\ndescription: http caching guide\n---\n\n# Guide\n\nHTTP caching notes.\n", "utf8");

  // The asset lives only in the `catalog` installed source. Its id is a legal
  // bundle slug, so `deriveInstallations` mints the bundle id `catalog` and
  // `resolveSourcesForOrigin("catalog", …)` matches it by registryId.
  saveConfig({
    semanticSearchMode: "off",
    installed: [
      {
        id: "catalog",
        source: "npm",
        ref: "catalog",
        artifactUrl: "https://example.com/catalog.tgz",
        stashRoot: catalogRoot,
        cacheDir: catalogRoot,
        installedAt: new Date().toISOString(),
      },
    ],
  });

  await akmIndex({ stashDir: storage.stashDir });
});

afterEach(() => {
  storage.cleanup();
  catalogRoot = "";
  guidePath = "";
});

describe("F1b input boundaries accept both ref grammars (command level)", () => {
  test("`akm show` resolves the same file via type:name, conceptId, and bundle//conceptId", async () => {
    const paths: string[] = [];
    for (const ref of SPELLINGS) {
      const result = await akmShowUnified({ ref });
      expect(result.type, `show ${ref} type`).toBe("knowledge");
      expect(result.name, `show ${ref} name`).toBe("guide");
      paths.push(result.path ?? "");
    }
    // Every spelling resolves to the SAME on-disk file.
    expect(paths[0]).toBe(guidePath);
    expect(paths[1]).toBe(guidePath);
    expect(paths[2]).toBe(guidePath);
  });

  test("`akm feedback` records against the same asset via all three spellings", async () => {
    // Sanity: the index the beforeEach built must be present for feedback.
    expect(fs.existsSync(getDbPath())).toBe(true);
    for (const ref of SPELLINGS) {
      const res = await runCliCapture(["feedback", ref, "--positive"]);
      expect(res.code, `feedback ${ref} exit (stderr: ${res.stderr})`).toBe(0);
    }
  });

  test("`akm graph related` resolves the same target via all three spellings", async () => {
    // Seed a stored graph snapshot for the catalog source so `graph related`
    // gets past its data-load step; the entry rows already exist (akmIndex).
    const db = openIndexDatabase(getDbPath());
    try {
      replaceStoredGraph(db, {
        schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: catalogRoot,
        files: [
          {
            path: guidePath,
            type: "knowledge",
            bodyHash: "guide-body-hash",
            entities: ["caching", "http"],
            relations: [{ from: "caching", to: "http", type: "uses" }],
          },
        ],
        entities: ["caching", "http"],
        relations: [{ from: "caching", to: "http", type: "uses" }],
      });
    } finally {
      closeDatabase(db);
    }

    const targets: string[] = [];
    for (const ref of SPELLINGS) {
      const result = await akmGraphRelated({ ref });
      expect(result.shape, `graph ${ref} shape`).toBe("graph-related");
      targets.push(result.path);
    }
    expect(targets[0]).toBe(guidePath);
    expect(targets[1]).toBe(guidePath);
    expect(targets[2]).toBe(guidePath);
  });
});
