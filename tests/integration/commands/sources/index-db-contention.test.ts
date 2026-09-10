// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index` against a genuinely contended index.db (field follow-up to
 * #956, F1). Mirrors `index-sigterm-promptness.test.ts`: spawns the REAL CLI
 * child process (`bun src/cli.ts index`) rather than the in-process
 * `runCliCapture` harness, since the point is what the real SQLite driver
 * does under contention from a second connection. A held write transaction
 * on index.db forces the busy connection to exhaust SQLite's own
 * `busy_timeout` (30s, `SQLITE_BUSY_TIMEOUT_MS` in
 * src/storage/sqlite-pragmas.ts) before returning `SQLITE_BUSY` — this test
 * necessarily takes about that long for its first assertion; see the PR
 * description for why that floor cannot be shortened without touching that
 * shared constant, out of scope for this change.
 *
 * Integration-scoped (ORG-03/06): spawns a real child process and opens a
 * real index.db (a second connection here, plus the child's own).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { getIndexRebuildLockPath } from "../../../../src/core/paths";
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

/** Plant the opt-in rebuild-lock sentinel as if another `akm index` run already holds it (mirrors index-skip-if-locked.test.ts). */
function plantHeldRebuildLock(): void {
  const lockPath = getIndexRebuildLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
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
  test("without --skip-if-locked: a busy index.db reclassifies to exit 75 INDEX_DB_CONTENDED; " +
    "--skip-if-locked on the same setup still skips at exit 0 without ever touching the DB", async () => {
    writeMemory("note-0");

    // Simulate a second `akm index` already in progress: it holds the
    // rebuild-lock sentinel AND has an open write transaction on
    // index.db — the two independent mechanisms `--skip-if-locked`
    // (#956) and this contention reclassification (field follow-up)
    // each react to.
    plantHeldRebuildLock();
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
      expect(envelope.hint).toContain("--skip-if-locked");

      // --skip-if-locked, same live rebuild-lock + held index.db
      // transaction: skips because of the rebuild-lock sentinel alone,
      // before ever attempting to write index.db, so the still-open
      // BEGIN IMMEDIATE above is irrelevant to this run — exit 0, no
      // 30s wait.
      const skipped = await runIndexChild(["--full", "--skip-if-locked", "--format=json"]);
      expect(skipped.code).toBe(0);
      const skippedEnvelope = JSON.parse(skipped.stdout) as {
        ok: boolean;
        skipped: { reason: string; pid: number; launcherPid: number | null; startedAt: string };
      };
      expect(skippedEnvelope.ok).toBe(true);
      expect(skippedEnvelope.skipped).toEqual({
        reason: "lock-held",
        pid: process.pid,
        launcherPid: null,
        startedAt: expect.any(String),
      });
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
