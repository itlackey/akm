// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The set of refs one fixture library indexes to, pinned whole. A change to what the walk lists or
 * how a file's ref is derived shows up here as a diff, not as a missing assertion elsewhere.
 *
 * To change the set deliberately: review the diff below, then overwrite
 * tests/fixtures/goldens/indexed-refs.golden.txt with the received refs, one per line.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const FIXTURE = path.resolve(import.meta.dir, "../../fixtures/stashes/all-types");
const GOLDEN = path.resolve(import.meta.dir, "../../fixtures/goldens/indexed-refs.golden.txt");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => storage.cleanup());

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

test("the fixture library indexes to the golden set of refs", async () => {
  fs.cpSync(FIXTURE, storage.stashDir, { recursive: true });
  write("top.md", "# Top\n\nA file at the bundle root.\n");
  write("topscript.sh", "#!/usr/bin/env bash\necho top\n");
  write(".scratch/notes.md", "# Scratch\n\nWorking notes.\n");
  write(".hidden/guide.md", "# Hidden\n\nIn a dot directory.\n");
  write("node_modules/pkg/readme.md", "# Dependency\n\nVendored.\n");
  write("knowledge/ignored.md", "# Ignored\n\nListed in .gitignore.\n");
  write(".gitignore", "knowledge/ignored.md\n");
  write("env/extra.env", "EXTRA=1\n");
  write("secrets/extra-secret", "value\n");
  write("real/guide.md", "# Real\n\nIn a directory a link points at.\n");
  fs.symlinkSync(path.join(storage.stashDir, "real"), path.join(storage.stashDir, "linked"), "dir");
  execFileSync("git", ["init", "--quiet"], { cwd: storage.stashDir });

  await akmIndex({ stashDir: storage.stashDir, full: true });

  const db = openExistingDatabase(getDbPath());
  try {
    const refs = (db.prepare("SELECT item_ref FROM entries").all() as { item_ref: string }[])
      .map((row) => row.item_ref)
      .sort();
    expect(`${refs.join("\n")}\n`).toBe(fs.readFileSync(GOLDEN, "utf8"));
  } finally {
    closeDatabase(db);
  }
}, 30_000);
