// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk-5 Step 2 (spec §14.4): the writer persists the durable bundle-adapter
 * identity + provenance (`item_ref`/`bundle_id`/`component_id`/`concept_id`/
 * `adapter_id`/`type`) into the canonical `entries` schema.
 *
 * This pins the write-boundary derivation to the exact spelling the Step-3
 * `scanComponent` swap will emit as `IndexDocument.ref` (proven equivalent by
 * `shadow-scan-parity.test.ts`):
 *   - conceptId == the qualified placement plus `document_json.name`;
 *   - item_ref  == `<bundle>//<conceptId>` where the bundle id is the
 *     `deriveInstallations` slug of the source root;
 *   - component_id == bundle_id (single-component akm layout);
 *   - adapter_id  == the detected adapter ("akm" for a plain workspace stash);
 *   - type        == the open asset-type token.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { stashDirFor } from "../../../src/core/asset/asset-placement";
import { getDbPath } from "../../../src/core/paths";
import * as indexerModule from "../../../src/indexer/indexer";
import { slugForPath } from "../../../src/indexer/installations";
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

type ProvRow = {
  file_path: string;
  document_json: string;
  item_ref: string;
  bundle_id: string;
  component_id: string;
  concept_id: string;
  adapter_id: string;
  type: string;
};

function readRows(): ProvRow[] {
  const db = new Database(getDbPath());
  try {
    return db
      .query(
        "SELECT file_path, document_json, item_ref, bundle_id, component_id, concept_id, adapter_id, type FROM entries",
      )
      .all() as ProvRow[];
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-entries-prov-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-entries-prov-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  writeMemory("first");
  writeMemory("second");
  writeSkill("deploy");
  await indexerModule.akmIndex({ stashDir });
});

afterEach(() => {
  cleanup();
});

describe("canonical entries provenance", () => {
  test("every persisted row carries the item_ref/provenance identity", () => {
    const rows = readRows();
    expect(rows.length).toBeGreaterThan(0);
    const expectedBundle = slugForPath(stashDir);

    for (const row of rows) {
      const entry = JSON.parse(row.document_json) as { name: string; type: string };

      // The typed column and stored document agree on the open token.
      expect(row.type).toBe(entry.type);

      // conceptId == the D-R2 QUALIFIED spelling: `stashDirFor(type)/name`
      // (ref-grammar decision D-R2; bare-name fallback only for a foreign type
      // with no placement stash-subdir).
      const typeStashDir = stashDirFor(entry.type);
      const expectedConceptId = typeStashDir !== undefined ? `${typeStashDir}/${entry.name}` : entry.name;
      expect(row.concept_id, `concept_id for ${row.file_path}`).toBe(expectedConceptId);

      // Bundle/component provenance: the single-component akm layout couples
      // component id == bundle id == the source-root slug.
      expect(row.bundle_id, `bundle_id for ${row.file_path}`).toBe(expectedBundle);
      expect(row.component_id, `component_id for ${row.file_path}`).toBe(expectedBundle);
      expect(row.adapter_id, `adapter_id for ${row.file_path}`).toBe("akm");

      // item_ref == `<bundle>//<conceptId>` — the canonical stored spelling
      // (== IndexDocument.ref emitted by scanComponent).
      expect(row.item_ref, `item_ref for ${row.file_path}`).toBe(`${expectedBundle}//${expectedConceptId}`);
    }
  });

  test("item_ref is unique across the indexed set", () => {
    const rows = readRows();
    const refs = rows.map((r) => r.item_ref);
    expect(refs.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
