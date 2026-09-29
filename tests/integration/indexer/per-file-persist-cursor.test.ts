// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A one-file change in a flat directory re-persists only that file. The
 * directory is still drained whole (its walk fingerprint changed), but a
 * sibling whose content hash, path and adapter variant are unchanged is
 * already stored exactly as the drain would store it — including any LLM
 * enrichment layered onto the row — so it is neither rewritten nor handed to
 * the enrichment pass. `akm index --full` re-persists every entry.
 *
 * The sentinel below stands in for an enriched description: a row that is
 * rewritten from the freshly drained document loses it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { openDatabase } from "../../../src/storage/database";
import {
  type IsolatedAkmStorage,
  makeStashDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const SENTINEL = "sentinel-enriched-description";
let storage: IsolatedAkmStorage;

function writeNote(name: string, body: string): void {
  const file = path.join(storage.stashDir, "knowledge", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${name} note\n---\n\n# ${name}\n\n${body}\n`, "utf8");
}

function markAllRowsEnriched(): void {
  const db = openDatabase(getDbPath());
  try {
    db.prepare("UPDATE entries SET document_json = json_set(document_json, '$.description', ?)").run(SENTINEL);
  } finally {
    db.close();
  }
}

function descriptionsByConcept(): Record<string, string> {
  const db = openDatabase(getDbPath(), { readonly: true });
  try {
    const rows = db
      .prepare("SELECT concept_id, json_extract(document_json, '$.description') AS description FROM entries")
      .all() as Array<{ concept_id: string; description: string }>;
    return Object.fromEntries(rows.map((row) => [row.concept_id, row.description]));
  } finally {
    db.close();
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  for (const name of ["alpha", "bravo", "charlie", "delta"]) writeNote(name, `${name} body.`);
});

afterEach(() => storage.cleanup());

describe("per-file persist cursor", () => {
  test("an incremental run rewrites only the changed file in a drained directory", async () => {
    await akmIndex({ stashDir: storage.stashDir });
    markAllRowsEnriched();

    writeNote("bravo", "bravo body, edited.");
    const result = await akmIndex({ stashDir: storage.stashDir });
    expect(result.mode).toBe("incremental");
    expect(result.directoriesScanned).toBeGreaterThan(0);

    expect(descriptionsByConcept()).toEqual({
      "knowledge/alpha": SENTINEL,
      "knowledge/bravo": "bravo note",
      "knowledge/charlie": SENTINEL,
      "knowledge/delta": SENTINEL,
    });
  });

  test("`--full` re-persists every entry", async () => {
    await akmIndex({ stashDir: storage.stashDir });
    markAllRowsEnriched();

    await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(Object.values(descriptionsByConcept()).includes(SENTINEL)).toBe(false);
  });
});

describe("full run source reconciliation", () => {
  test("`--full` purges the rows of a bundle that is no longer configured", async () => {
    const team = makeStashDir();
    try {
      fs.mkdirSync(path.join(team.dir, "knowledge"), { recursive: true });
      fs.writeFileSync(path.join(team.dir, "knowledge", "team-note.md"), "---\ndescription: team note\n---\n\nBody.\n");
      writeSandboxConfig({
        semanticSearchMode: "off",
        bundles: { primary: { path: storage.stashDir, writable: true }, team: { path: team.dir } },
        defaultBundle: "primary",
      });
      resetConfigCache();
      await akmIndex({ stashDir: storage.stashDir });
      expect(Object.keys(descriptionsByConcept())).toContain("knowledge/team-note");

      writeSandboxConfig({
        semanticSearchMode: "off",
        bundles: { primary: { path: storage.stashDir, writable: true } },
        defaultBundle: "primary",
      });
      resetConfigCache();
      await akmIndex({ stashDir: storage.stashDir, full: true });

      expect(Object.keys(descriptionsByConcept()).sort()).toEqual([
        "knowledge/alpha",
        "knowledge/bravo",
        "knowledge/charlie",
        "knowledge/delta",
      ]);
    } finally {
      team.cleanup();
      resetConfigCache();
    }
  });
});
