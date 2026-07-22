// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Post-F5 ref lookup (ref-grammar decision D-R1/D-R4): the repository readers
 * key on the canonical stored `item_ref`. This proves — over a REAL indexed
 * fixture — that a new-grammar `bundle//conceptId` ref (and the short conceptId
 * form, both directly and via `resolveRef`) finds the intended `entries` row,
 * and that a NULL-`item_ref` row is NOT findable by ref (it heals on the next
 * full index) now that the transitional legacy `entry_key` fallback is gone.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { bundleRefToString } from "../../../src/core/asset/asset-ref";
import { type RefContext, resolveRef } from "../../../src/core/asset/resolve-ref";
import { getDbPath } from "../../../src/core/paths";
import * as indexerModule from "../../../src/indexer/indexer";
import { slugForPath } from "../../../src/indexer/installations";
import type { Database as AkmDatabase } from "../../../src/storage/database";
import { findEntryIdByRef, getEntryByRef } from "../../../src/storage/repositories/index-entries-repository";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
} from "../../_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};

function writeMemory(name: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n# ${name}\n\nBody.\n`, "utf8");
}

function writeSkill(name: string): void {
  const filePath = path.join(stashDir, "skills", name, "SKILL.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\nBody.\n`, "utf8");
}

function writeKnowledge(name: string): void {
  const filePath = path.join(stashDir, "knowledge", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n# ${name}\n\nBody.\n`, "utf8");
}

/** Open the live index.db as an AkmDatabase handle the repositories accept. */
function openDb(): AkmDatabase {
  return new Database(getDbPath()) as unknown as AkmDatabase;
}

/**
 * Build a {@link RefContext} from the live index: one bundle per distinct
 * `bundle_id`, whose membership probe is an existence check on
 * `(bundle_id, concept_id)`.
 */
function refContextFromDb(db: AkmDatabase, defaultBundle?: string): RefContext {
  const rows = db.prepare("SELECT DISTINCT bundle_id FROM entries WHERE bundle_id IS NOT NULL").all() as Array<{
    bundle_id: string;
  }>;
  const hasStmt = db.prepare("SELECT 1 FROM entries WHERE bundle_id = ? AND concept_id = ? LIMIT 1");
  return {
    bundles: rows.map((r) => ({
      id: r.bundle_id,
      hasConcept: (conceptId: string) => hasStmt.get(r.bundle_id, conceptId) !== null,
    })),
    defaultBundle,
  };
}

beforeEach(async () => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-dual-ref-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-dual-ref-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  writeMemory("first");
  writeMemory("second");
  writeSkill("deploy");
  writeKnowledge("guide");
  await indexerModule.akmIndex({ stashDir });
});

afterEach(() => {
  cleanup();
});

describe("dual-keyed ref lookup (Chunk-5 flip F1)", () => {
  test("new-grammar bundle//conceptId finds the same row as legacy type:name", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      for (const [legacy, conceptId] of [
        ["memories/first", "memories/first"],
        ["memories/second", "memories/second"],
        ["skills/deploy", "skills/deploy"],
        ["knowledge/guide", "knowledge/guide"],
      ] as const) {
        const legacyId = findEntryIdByRef(db, legacy);
        expect(legacyId, `legacy lookup ${legacy}`).toBeDefined();

        // Fully-qualified new ref → item_ref exact match.
        expect(findEntryIdByRef(db, `${bundle}//${conceptId}`), `qualified ${conceptId}`).toBe(legacyId);
        // Short conceptId → item_ref //conceptId suffix match.
        expect(findEntryIdByRef(db, conceptId), `short ${conceptId}`).toBe(legacyId);
      }
    } finally {
      db.close();
    }
  });

  test("resolveRef resolves a short conceptId to the row's bundle", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      const legacyId = findEntryIdByRef(db, "skills/deploy");

      const ctx = refContextFromDb(db, bundle);
      const resolved = resolveRef("skills/deploy", ctx);
      expect(resolved.bundle).toBe(bundle);

      // Serialize the ResolvedRef and re-lookup — round-trips to the same row.
      const qualified = bundleRefToString(resolved);
      expect(qualified).toBe(`${bundle}//skills/deploy`);
      expect(findEntryIdByRef(db, qualified)).toBe(legacyId);
    } finally {
      db.close();
    }
  });

  test("markdown ext-variant parity across both grammars", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      const legacyId = findEntryIdByRef(db, "knowledge/guide");
      expect(legacyId).toBeDefined();
      // .md-suffixed spellings resolve to the same ext-stripped canonical row.
      expect(findEntryIdByRef(db, "knowledge/guide.md")).toBe(legacyId);
      expect(findEntryIdByRef(db, `${bundle}//knowledge/guide.md`)).toBe(legacyId);
      expect(findEntryIdByRef(db, "knowledge/guide.md")).toBe(legacyId);
    } finally {
      db.close();
    }
  });

  test("getEntryByRef resolves a new-grammar ref (short and qualified)", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      const targetId = findEntryIdByRef(db, "memories/first");
      expect(getEntryByRef(db, `${bundle}//memories/first`)).toEqual({ id: targetId as number });
      expect(getEntryByRef(db, "memories/first")).toEqual({ id: targetId as number });
      expect(getEntryByRef(db, "memories/does-not-exist")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a NULL-item_ref row is no longer findable by ref (heals on next index)", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      const targetId = findEntryIdByRef(db, "memories/second");
      expect(targetId).toBeDefined();

      // Simulate a write-back row: clear its provenance columns.
      db.prepare("UPDATE entries SET item_ref = NULL, concept_id = NULL, bundle_id = NULL WHERE id = ?").run(
        targetId as number,
      );

      // With the transitional legacy `entry_key` fallback gone, an item_ref-only
      // lookup no longer resolves the row until the next full index re-writes it.
      expect(findEntryIdByRef(db, `${bundle}//memories/second`), "qualified new ref").toBeUndefined();
      expect(findEntryIdByRef(db, "memories/second"), "short new ref").toBeUndefined();
    } finally {
      db.close();
    }
  });
});
