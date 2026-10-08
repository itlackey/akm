// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1063 follow-up: a classifier fix must reach files that did not change.
 *
 * An incremental index skips a directory whose files and adapter variant are
 * unchanged, so a row written by an older matcher kept its old type and ref
 * until `akm index --full`. The adapter version is folded into that variant; a
 * bump makes the next incremental index re-drain the directory and re-file the
 * row through the same diff-persist path as `--full`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../src/core/adapter/adapters/akm-adapter";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex, lookupBundleRef } from "../../src/indexer/indexer";
import { computeDirFingerprint } from "../../src/indexer/passes/dir-staleness";
import { openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      primary: {
        path: storage.stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
    defaultBundle: "primary",
  });
});

afterEach(() => storage.cleanup());

/** The variant the build before the fix stamped on every directory it indexed. */
const PREVIOUS_VARIANT = "akm@0.9.0";
const NEW_REF = "primary//knowledge/skills/demo/references/setup";
const OLD_REF = "primary//commands/skills/demo/references/setup";

test("an incremental index re-files an unchanged file the older matcher typed as a command", async () => {
  const refs = path.join(storage.stashDir, "skills", "demo", "references");
  fs.mkdirSync(refs, { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n# Demo\n");
  fs.writeFileSync(
    path.join(refs, "setup.md"),
    '---\ndescription: Setup.\n---\n# Setup\n\n```bash\nrequire_var() {\n  local var="$1"\n}\n```\n',
  );
  fs.writeFileSync(path.join(refs, "plain.md"), "---\ndescription: Plain.\n---\n# Plain\n");

  await akmIndex({ stashDir: storage.stashDir, full: true });

  // Leave the index as the build before the fix did: the row filed as a command,
  // with history hanging off it, in a directory stamped by the previous adapter version.
  const db = openIndexDatabase(getDbPath());
  let oldId: number;
  try {
    const row = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(NEW_REF) as { id: number };
    oldId = row.id;
    db.prepare(
      "UPDATE entries SET item_ref = ?, concept_id = ?, type = ?, document_json = json_set(document_json, '$.type', 'command') WHERE id = ?",
    ).run(OLD_REF, "commands/skills/demo/references/setup", "command", oldId);
    db.prepare("INSERT INTO embeddings (id, embedding, model) VALUES (?, ?, ?)").run(oldId, new Uint8Array(4), "m");
    db.prepare("INSERT INTO utility_scores (entry_id, utility) VALUES (?, 1)").run(oldId);
    // The directory fingerprint folds the variant in: stamp each directory as the old build did.
    const stamp = db.prepare("UPDATE index_dir_state SET index_variant = ?, file_set_hash = ? WHERE dir_path = ?");
    for (const { dir_path } of db.prepare("SELECT dir_path FROM index_dir_state").all() as { dir_path: string }[]) {
      const files = fs
        .readdirSync(dir_path, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(dir_path, e.name));
      stamp.run(PREVIOUS_VARIANT, computeDirFingerprint(dir_path, files, PREVIOUS_VARIANT).fileSetHash, dir_path);
    }
  } finally {
    db.close();
  }
  expect(
    await lookupBundleRef({ bundle: "primary", conceptId: "commands/skills/demo/references/setup" }),
  ).not.toBeNull();

  // Nothing on disk changes.
  await akmIndex({ stashDir: storage.stashDir });

  expect(await lookupBundleRef({ bundle: "primary", conceptId: "commands/skills/demo/references/setup" })).toBeNull();
  const filed = await lookupBundleRef({ bundle: "primary", conceptId: "knowledge/skills/demo/references/setup" });
  expect(filed?.type).toBe("knowledge");

  const check = openIndexDatabase(getDbPath());
  try {
    const refsNow = (
      check.prepare("SELECT item_ref FROM entries ORDER BY item_ref").all() as { item_ref: string }[]
    ).map((r) => r.item_ref);
    expect(refsNow).toContain(NEW_REF);
    expect(refsNow).not.toContain(OLD_REF);
    expect(refsNow.filter((r) => r.includes("references/setup"))).toHaveLength(1);
    // Nothing keyed by the old row survives it.
    for (const table of ["embeddings", "utility_scores", "asset_links"]) {
      const col = table === "embeddings" ? "id" : "entry_id";
      const orphans = check
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${col} NOT IN (SELECT id FROM entries)`)
        .get() as { n: number };
      expect(orphans.n).toBe(0);
    }
    expect(check.prepare("SELECT count(*) AS n FROM embeddings WHERE id = ?").get(oldId) as { n: number }).toEqual({
      n: 0,
    });
    const variants = check.prepare("SELECT DISTINCT index_variant AS v FROM index_dir_state").all() as { v: string }[];
    expect(variants.map((v) => v.v)).toEqual([`akm@${akmAdapter.version}`]);
  } finally {
    check.close();
  }
});
