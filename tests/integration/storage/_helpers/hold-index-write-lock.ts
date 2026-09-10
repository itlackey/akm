// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Subprocess driver for
 * tests/integration/storage/index-write-immediate-contention.test.ts.
 *
 * NOT a *.test.ts file: spawned as a real `bun` child so the parent test
 * contends against a genuinely SEPARATE OS process/connection holding
 * index.db's write lock. This matters for the timed release specifically: a
 * `db.exec("BEGIN IMMEDIATE")` (and the parent's own blocked write attempt)
 * is a synchronous native call that blocks Bun's single JS thread for its
 * whole duration, so a `setTimeout` release scheduled on the SAME process as
 * the contended writer would never fire while that writer is blocked waiting
 * on it. Running the holder in its own process/event loop is what lets the
 * release genuinely happen on a bounded timer regardless of what the parent
 * is doing — the parent test cannot hang on this holder even if its own
 * assertions or polling logic misbehave.
 *
 * Env contract:
 *   HOLD_DB_PATH     (required) index.db path to open.
 *   HOLD_DATA_DIR    (required) directory passed to applyStandardPragmas
 *                     (journal-mode / network-FS probe base).
 *   HOLD_MARKER_FILE (required) file created the instant BEGIN IMMEDIATE
 *                     succeeds — the parent polls for this before attempting
 *                     its own contended write.
 *   HOLD_MS          (required) milliseconds to hold the write transaction
 *                     before COMMIT.
 *
 * Exit code 0 on a clean hold+release; non-zero (with a stderr message) if
 * BEGIN IMMEDIATE itself fails.
 */

import fs from "node:fs";
import { openDatabase } from "../../../../src/storage/database";
import { applyStandardPragmas } from "../../../../src/storage/sqlite-pragmas";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`hold-index-write-lock: missing required env var ${name}`);
  return value;
}

const dbPath = requiredEnv("HOLD_DB_PATH");
const dataDir = requiredEnv("HOLD_DATA_DIR");
const markerFile = requiredEnv("HOLD_MARKER_FILE");
const holdMs = Number(requiredEnv("HOLD_MS"));

const db = openDatabase(dbPath);
try {
  applyStandardPragmas(db, { dataDir });
  db.exec("BEGIN IMMEDIATE");
  // Signal the holder AFTER the write lock is genuinely taken, never before.
  fs.writeFileSync(markerFile, String(process.pid));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  db.exec("COMMIT");
} finally {
  db.close();
}
