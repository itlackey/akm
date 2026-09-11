// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository-level regression test for the index-redesign's "every index
 * write is a short immediate transaction" promise (docs/plans/index-redesign.md
 * rule 5, field follow-up to #956). Opens TWO REAL connections on one on-disk
 * index.db: a real `bun` subprocess holds a `BEGIN IMMEDIATE` write
 * transaction for a bounded time (released from its own timer — see
 * `_helpers/hold-index-write-lock.ts` for why the release must live in a
 * SEPARATE process), while this process runs a converted read-then-write
 * repository path (`deleteEntriesByDirAndBundle`) against the SAME database
 * file.
 *
 * Measured mechanism this pins (probed directly, not inferred): under WAL, a
 * bare deferred `db.transaction()` whose body reads (a SELECT establishing a
 * read snapshot) before it writes fails with SQLITE_BUSY in single-digit
 * milliseconds against a competing writer — SQLite does not invoke the busy
 * handler for a SHARED→RESERVED lock upgrade, so `busy_timeout` is never
 * consulted. `BEGIN IMMEDIATE` (via `withImmediateTransaction`) takes the
 * write lock BEFORE any read, so it waits out `busy_timeout` and succeeds
 * once the holder releases. This test proves the SECOND connection's call
 * both succeeds AND genuinely waited (not merely got lucky on scheduling) —
 * before the fix it fails in single-digit ms; after it, it blocks for
 * roughly the holder's hold duration and then succeeds.
 *
 * Integration-scoped (ORG-03/06): opens two real index.db connections and
 * spawns a real `bun` child process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../../src/storage/database";
import { deleteEntriesByDirAndBundle } from "../../../src/storage/repositories/index-entries-repository";
import { ensureSchema } from "../../../src/storage/repositories/index-schema";
import { loadVecExtension } from "../../../src/storage/repositories/index-vec-repository";
import { applyStandardPragmas } from "../../../src/storage/sqlite-pragmas";
import { pollUntil } from "../_helpers/workflow-crossproc";

const RUNNER = path.join(__dirname, "_helpers/hold-index-write-lock.ts");
const HOLD_MS = 300;
const DIM = 4;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-index-immediate-tx-"));
  dbPath = path.join(dir, "index.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("index write transactions serialize under real two-connection contention", () => {
  test("a converted read-then-write repository path (deleteEntriesByDirAndBundle) waits out a competing holder instead of failing instantly", async () => {
    const memoriesDir = path.join(dir, "stash", "memories");
    fs.mkdirSync(memoriesDir, { recursive: true });
    const filePath = path.join(memoriesDir, "note.md");

    // Seed the schema and one entries row directly — a single, uncontended
    // connection, closed before the two contending connections open.
    const setup = openDatabase(dbPath);
    applyStandardPragmas(setup, { dataDir: dir });
    loadVecExtension(setup);
    ensureSchema(setup, DIM);
    setup
      .prepare(
        `INSERT INTO entries (item_ref, bundle_id, component_id, concept_id, adapter_id, type, file_path, document_json, search_text)
         VALUES ('stash//note', 'stash', 'stash', 'note', 'akm', 'memory', ?, '{}', '')`,
      )
      .run(filePath);
    setup.close();

    const markerFile = path.join(dir, "locked.marker");
    const child = spawn("bun", [RUNNER], {
      env: {
        ...process.env,
        HOLD_DB_PATH: dbPath,
        HOLD_DATA_DIR: dir,
        HOLD_MARKER_FILE: markerFile,
        HOLD_MS: String(HOLD_MS),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = new Promise<number | null>((resolve) => child.on("exit", resolve));

    // Wait for the holder to genuinely own the write lock (never a bare sleep).
    await pollUntil(() => fs.existsSync(markerFile), { timeoutMs: 10_000, label: "holder marker" });

    const contender = openDatabase(dbPath);
    applyStandardPragmas(contender, { dataDir: dir });
    let deletedIds: number[];
    const start = performance.now();
    try {
      // rowsInDirectory's SELECT then deleteEntryRows' DELETEs is exactly the
      // read-then-write shape that fails instantly under a bare deferred
      // transaction. Converted to withImmediateTransaction, this must wait.
      deletedIds = deleteEntriesByDirAndBundle(contender, memoriesDir, "stash");
    } finally {
      contender.close();
    }
    const elapsedMs = performance.now() - start;

    const code = await exitCode;
    expect(stderr).toBe("");
    expect(code).toBe(0);

    // Succeeded (not a thrown SQLITE_BUSY)...
    expect(deletedIds).toHaveLength(1);
    // ...and genuinely waited for the holder rather than getting lucky: an
    // instant-fail (pre-fix) completes in single-digit ms, well under half
    // the holder's bounded hold time.
    expect(elapsedMs).toBeGreaterThan(HOLD_MS / 2);

    // Functional correctness: the row is actually gone once the wait ends.
    const verify = openDatabase(dbPath);
    applyStandardPragmas(verify, { dataDir: dir });
    try {
      expect(verify.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).toEqual({ n: 0 });
    } finally {
      verify.close();
    }
  }, 20_000);
});
