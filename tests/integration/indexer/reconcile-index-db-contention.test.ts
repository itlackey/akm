// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression, fix-contention-labels field follow-up, defect 1:
 * `reconcile.ts`'s own `withImmediateTransaction`/`beginImmediateTransaction`
 * call sites (index.db writers — `entries`/`files`/`entry_units`/
 * `unit_texts`) used to omit the `dbKind` argument, so an exhausted-retry
 * `BEGIN IMMEDIATE` under ordinary index.db contention silently defaulted to
 * `dbKind: "state"` and reported `STATE_DB_CONTENDED` — the wrong database,
 * the wrong message, the wrong hint — to a user mid-reconcile.
 *
 * This drives the REAL bug shape end to end: a real index.db, a second real
 * connection holding `BEGIN IMMEDIATE`, and an actual `reconcileRoots` write
 * through `applyChange`'s `withImmediateTransaction` — not a synthetic error
 * fed to the classifier, and not the shared helper exercised through a fake
 * `Database` (both of those pass unchanged whether or not `reconcile.ts`
 * itself passes `"index"`, so neither would catch a regression here). The
 * contended connection's `busy_timeout` is lowered to keep the retry
 * exhaustion (`WITH_IMMEDIATE_TX_MAX_ATTEMPTS` attempts in `state-db.ts`)
 * fast and deterministic instead of waiting out the managed open's real 30s
 * `SQLITE_BUSY_TIMEOUT_MS` per attempt.
 *
 * Lives under tests/integration/ because it opens a real index database via
 * `openIndexDatabase` (AGENTS.md classification rule) — like its sibling
 * tests/integration/indexer/reconcile.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TransientError } from "../../../src/core/errors";
import { reconcileRoots } from "../../../src/indexer/reconcile";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const BUNDLE_ID = "test-bundle";

let stashDir = "";
let cleanup: Cleanup = () => {};
let tmpDirs: string[] = [];

beforeEach(() => {
  const stash = sandboxStashDir();
  cleanup = stash.cleanup;
  stashDir = stash.dir;
  const cfg = sandboxXdgConfigHome(cleanup);
  cleanup = cfg.cleanup;
  const cache = sandboxXdgCacheHome(cleanup);
  cleanup = cache.cleanup;
  writeSandboxConfig({});
  tmpDirs = [];
});

afterEach(() => {
  cleanup();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function newDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-reconcile-contention-db-"));
  tmpDirs.push(dir);
  return path.join(dir, "index.db");
}

function writeNote(relPath: string, body: string): void {
  const filePath = path.join(stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${relPath}\n---\n\n# note\n\n${body}\n`, "utf8");
}

describe("reconcileRoots under real index.db contention (regression: reported code, not just the shared classifier)", () => {
  test("a second connection holding BEGIN IMMEDIATE makes reconcileRoots's own write throw INDEX_DB_CONTENDED, never STATE_DB_CONTENDED", async () => {
    const dbPath = newDbPath();
    const db = openIndexDatabase(dbPath);
    let holder: Database | undefined;
    try {
      // Uncontended first reconcile: builds the canonical schema and writes
      // one entry. No second connection is open yet, so this cannot contend.
      writeNote("memories/note-0.md", "Content for note-0.");
      await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      // Keep the retry-exhaustion fast and deterministic: lower busy_timeout
      // on the connection that is about to contend (reconcileRoots's own
      // `db`), rather than waiting out the real 30s managed-open default
      // across up to 5 retry attempts.
      db.exec("PRAGMA busy_timeout = 50");

      // A second, independent connection holds the write lock — the same
      // shape the skeptic reproduced against reconcile.ts.
      holder = openIndexDatabase(dbPath);
      holder.exec("BEGIN IMMEDIATE");

      writeNote("memories/note-1.md", "Content for note-1.");

      let caught: unknown;
      try {
        await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TransientError);
      expect((caught as TransientError).code).toBe("INDEX_DB_CONTENDED");
      expect((caught as Error).message).toContain("index database is busy");
      expect((caught as TransientError).hint()).toContain("index.db");
      // The exact regression this guards: before the fix, this same write
      // path defaulted `dbKind` to "state" and reported this instead.
      expect((caught as TransientError | undefined)?.code).not.toBe("STATE_DB_CONTENDED");
    } finally {
      try {
        holder?.exec("ROLLBACK");
      } catch {
        // best-effort
      }
      if (holder) closeDatabase(holder);
      closeDatabase(db);
    }
  });
});
