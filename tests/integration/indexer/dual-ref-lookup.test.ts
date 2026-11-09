// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Post-F5 ref lookup (ref-grammar decision D-R1/D-R4): the repository readers
 * key on the canonical stored `item_ref`. This proves — over a REAL indexed
 * fixture — that a new-grammar `bundle//conceptId` ref (and the short conceptId
 * form, both directly and via `resolveRef`) finds the intended `entries` row.
 * Canonical identity columns reject NULL writes at the schema boundary; there
 * is no nullable-row healing path or transitional legacy lookup fallback.
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
  sandboxAkmDir,
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
  chain = sandboxAkmDir("akm-dual-ref-data", "data", chain).cleanup;
  chain = sandboxAkmDir("akm-dual-ref-state", "state", chain).cleanup;
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

describe("current ref lookup", () => {
  test("bundle//conceptId finds the same row as the short conceptId", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      for (const [shortRef, conceptId] of [
        ["memories/first", "memories/first"],
        ["memories/second", "memories/second"],
        ["skills/deploy", "skills/deploy"],
        ["knowledge/guide", "knowledge/guide"],
      ] as const) {
        const shortId = findEntryIdByRef(db, shortRef);
        expect(shortId, `short lookup ${shortRef}`).toBeDefined();

        // Fully-qualified new ref → item_ref exact match.
        expect(findEntryIdByRef(db, `${bundle}//${conceptId}`), `qualified ${conceptId}`).toBe(shortId);
        // Short conceptId → item_ref //conceptId suffix match.
        expect(findEntryIdByRef(db, conceptId), `short ${conceptId}`).toBe(shortId);
      }
    } finally {
      db.close();
    }
  });

  test("resolveRef resolves a short conceptId to the row's bundle", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      const targetId = findEntryIdByRef(db, "skills/deploy");

      const ctx = refContextFromDb(db, bundle);
      const resolved = resolveRef("skills/deploy", ctx);
      expect(resolved.bundle).toBe(bundle);

      // Serialize the ResolvedRef and re-lookup — round-trips to the same row.
      const qualified = bundleRefToString(resolved);
      expect(qualified).toBe(`${bundle}//skills/deploy`);
      expect(findEntryIdByRef(db, qualified)).toBe(targetId);
    } finally {
      db.close();
    }
  });

  test("markdown extension aliases preserve short and qualified identity", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      const targetId = findEntryIdByRef(db, "knowledge/guide");
      expect(targetId).toBeDefined();
      // .md-suffixed spellings resolve to the same ext-stripped canonical row.
      expect(findEntryIdByRef(db, "knowledge/guide.md")).toBe(targetId);
      expect(findEntryIdByRef(db, `${bundle}//knowledge/guide.md`)).toBe(targetId);
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

  test("canonical identity columns reject NULL writes and preserve the indexed row", () => {
    const db = openDb();
    try {
      const bundle = slugForPath(stashDir);
      const targetId = findEntryIdByRef(db, "memories/second");
      expect(targetId).toBeDefined();

      for (const column of ["item_ref", "concept_id", "bundle_id"] as const) {
        expect(() => db.prepare(`UPDATE entries SET ${column} = NULL WHERE id = ?`).run(targetId as number)).toThrow(
          /NOT NULL constraint failed/i,
        );
      }

      expect(findEntryIdByRef(db, `${bundle}//memories/second`), "qualified new ref").toBe(targetId);
      expect(findEntryIdByRef(db, "memories/second"), "short new ref").toBe(targetId);
    } finally {
      db.close();
    }
  });
});
