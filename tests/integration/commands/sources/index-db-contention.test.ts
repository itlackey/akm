// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index` against a genuinely contended index.db (field follow-up to
 * #956, F1). Spawns the REAL CLI child process (`bun src/cli.ts index`)
 * rather than the in-process `runCliCapture` harness, since the point is
 * what the real SQLite driver does under contention from a second
 * connection. A held write transaction on index.db forces the busy
 * connection to exhaust SQLite's own `busy_timeout` (30s,
 * `SQLITE_BUSY_TIMEOUT_MS` in src/storage/sqlite-pragmas.ts) before returning
 * `SQLITE_BUSY` — this test necessarily takes about that long; see the PR
 * description for why that floor cannot be shortened without touching that
 * shared constant, out of scope for this change.
 *
 * index-redesign B5a retired the rebuild-lock sentinel and `--skip-if-locked`
 * this test used to plant/exercise alongside the contention reclassification
 * — `reclassifyIndexDbContention` (indexer.ts) is the one mechanism left, and
 * it no longer names a lock holder (there is no longer a sentinel file to
 * read a pid from): a busy connection is just reported as busy.
 * `--skip-if-locked` is still accepted (a one-line deprecation warning, no
 * other effect), so it no longer has anything special to prove here either.
 *
 * Integration-scoped (ORG-03/06): spawns a real child process and opens a
 * real index.db (a second connection here, plus the child's own).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import type { Database } from "../../../../src/storage/database";
import { openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
});

function writeMemory(name: string): void {
  const filePath = path.join(storage.stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\nContent for ${name}.\n`, "utf8");
}

async function runIndexChild(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "src/cli.ts", "index", ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** The CLI's JSON error envelope is pretty-printed (emitJsonError uses JSON.stringify(..., null, 2)), so it can span
 * several lines after any plain warn/info lines already on stderr — take the LAST top-level `{...}` block. */
function parseTrailingJsonEnvelope(stderr: string): { ok: boolean; error: string; code?: string; hint?: string } {
  const start = stderr.lastIndexOf("{\n");
  return JSON.parse(stderr.slice(start));
}

describe("akm index — index.db contention (field follow-up to #956, F1)", () => {
  test("a busy index.db reclassifies to exit 75 INDEX_DB_CONTENDED", async () => {
    writeMemory("note-0");

    // Simulate a second `akm index` already writing: an open write
    // transaction on index.db is the one thing left for this run to
    // contend against (the rebuild-lock sentinel this test used to also
    // plant is gone — B5a).
    const holder: Database = openIndexDatabase();
    holder.exec("BEGIN IMMEDIATE");

    try {
      const contended = await runIndexChild(["--full", "--format=json"]);

      expect(contended.stdout.trim()).toBe("");
      expect(contended.code).toBe(75);
      const envelope = parseTrailingJsonEnvelope(contended.stderr);
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("INDEX_DB_CONTENDED");
      expect(envelope.error).toContain("index database is busy");
    } finally {
      try {
        holder.exec("ROLLBACK");
      } catch {
        // Best-effort — the connection is closed unconditionally next.
      }
      holder.close();
    }
  }, 45_000);
});
