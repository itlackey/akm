// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #624-P1 regression (spec §4): a full-rebuild scan that produces ZERO
 * documents must NOT cascade-wipe the last-known-good index when the emptiness
 * is caused by an unreadable/missing source root (a transient scan failure) —
 * it must only wipe when the roots are genuinely readable-but-empty.
 *
 * Under the old truncate-then-rebuild path, `akm index --full` unconditionally
 * `DELETE FROM entries` (+ embeddings/utility/fts) as the first transaction
 * step, so a run that happened to see no files destroyed the entire index. The
 * zero-document preflight guards exactly that case.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getEntryCount } from "../../../src/storage/repositories/index-entries-repository";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};

function writeMemory(name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n# ${name}\n\n${body}\n`, "utf8");
}

function entryCount(): number {
  const db = openExistingDatabase(getDbPath());
  try {
    return getEntryCount(db);
  } finally {
    closeDatabase(db);
  }
}

beforeEach(async () => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-zdp-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-zdp-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  writeSandboxConfig({ semanticSearchMode: "off" });
  writeMemory("seed-memory", "Seed body for the preflight regression.");
  await akmIndex({ stashDir });
});

afterEach(() => {
  cleanup();
});

describe("#624-P1 zero-document preflight on --full", () => {
  test("an unreadable/missing source root preserves the last-known-good index (no wipe)", async () => {
    expect(entryCount()).toBeGreaterThan(0);

    // Simulate a transient scan failure: the configured root vanishes at scan
    // time (mount drop / mid-run removal). The walk sees nothing, but that is
    // NOT a legitimate mass-delete.
    const aside = `${stashDir}.aside`;
    fs.renameSync(stashDir, aside);
    try {
      await akmIndex({ stashDir, full: true });
      // Preflight must have suppressed the wipe — the seeded entry survives.
      expect(entryCount()).toBeGreaterThan(0);
    } finally {
      fs.renameSync(aside, stashDir);
    }
  });

  test("a readable-but-empty root is a legitimate mass-delete (still wipes)", async () => {
    expect(entryCount()).toBeGreaterThan(0);

    // Remove the only asset but keep the root readable — the emptiness is real,
    // so a full rebuild legitimately clears the index.
    fs.rmSync(path.join(stashDir, "memories"), { recursive: true, force: true });
    await akmIndex({ stashDir, full: true });
    expect(entryCount()).toBe(0);
  });
});
