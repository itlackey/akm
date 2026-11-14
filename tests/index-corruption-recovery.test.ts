// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Real on-disk corruption of `index.db` (issue #865).
 *
 * Only narrow in-column JSON corruption (a bad `document_json` value inside an
 * otherwise-healthy database) had coverage before this file — nothing garbled
 * actual SQLite page bytes on disk to prove the driver's `SQLITE_CORRUPT`
 * report is handled rather than either crashing the CLI or silently serving an
 * empty index (indistinguishable from "found nothing").
 *
 * `index.db` is documented (src/core/state-db.ts, "Why a separate database
 * from index.db") as fully regenerable from the stash on disk, so a corrupt
 * index is recovered by deleting it and rebuilding — but nothing actually did
 * that delete before this fix (see `openIndexDatabase` in
 * src/storage/repositories/index-connection.ts): a garbled file made every
 * open throw `SQLITE_CORRUPT`, including the rebuild attempt itself, so the
 * final failure reached the user as a raw internal error.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../src/core/paths";
import { runCliCapture } from "./_helpers/cli";
import { damageIndexHeader, damageIndexInterior } from "./_helpers/index-damage";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  fs.writeFileSync(
    path.join(storage.stashDir, "knowledge", "deploy.md"),
    "---\ndescription: Deployment guide\n---\n\nDeploy safely to production.\n",
  );
  // Enough entries that index.db has interior pages to damage.
  for (let i = 0; i < 400; i++) {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", `note-${i}.md`),
      `---\ndescription: Note ${i} about topic${i}\n---\n\nBody of note ${i} mentions widget${i} and gadget${i}.\n`,
    );
  }
});

afterEach(() => storage.cleanup());

const DAMAGE = [
  ["header (SQLITE_NOTADB)", damageIndexHeader],
  ["interior pages (SQLITE_CORRUPT)", damageIndexInterior],
] as const;

test.each(DAMAGE)("damaged index.db, %s: reads say no usable index, a build rebuilds it", async (_name, damage) => {
  const built = await runCliCapture(["index", "--full"]);
  expect(built.code).toBe(0);

  const dbPath = getDbPath();
  expect(fs.existsSync(dbPath)).toBe(true);

  // Sanity: the healthy index actually finds the entry before we break it.
  const before = await runCliCapture(["search", "deployment", "--format=json"]);
  expect(before.code).toBe(0);
  expect(JSON.parse(before.stdout).hits.length).toBeGreaterThan(0);

  damage(dbPath);

  // This is the CRITICAL isolation check: prove the corrupted file lives
  // inside this test's own sandboxed data dir, never the developer's real
  // index — never $HOME/.akm or anything outside `storage.root`.
  expect(path.resolve(dbPath).startsWith(path.resolve(storage.dataDir))).toBe(true);

  const damaged = fs.readFileSync(dbPath);
  const after = await runCliCapture(["search", "deployment", "--format=json"]);

  // A read never deletes or rebuilds the file: with a corrupt index it is an
  // empty result at exit 0 that says there is no usable index, not a silent
  // "found nothing" and not a delete under other readers.
  expect(after.code).toBe(0);
  const response = JSON.parse(after.stdout);
  expect(response.hits).toEqual([]);
  expect(response.warnings.join("\n")).toContain("no search index for this library yet");
  expect(fs.readFileSync(dbPath).equals(damaged)).toBe(true);

  const curate = await runCliCapture(["curate", "deployment", "--format=json"]);
  expect(curate.code).toBe(0);

  // feedback never fails internally (exit 70) on a damaged index.
  const feedback = await runCliCapture(["feedback", "knowledge/deploy", "--positive"]);
  expect(feedback.code).not.toBe(70);

  // A build holds the rebuild lock, so it alone deletes and rebuilds the corrupt file.
  const rebuilt = await runCliCapture(["index", "--full"]);
  expect(rebuilt.code).toBe(0);
  const healed = await runCliCapture(["search", "deployment", "--format=json"]);
  expect(healed.code).toBe(0);
  const hits = JSON.parse(healed.stdout).hits;
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((hit: { ref?: string }) => hit.ref?.includes("deploy"))).toBe(true);
});
