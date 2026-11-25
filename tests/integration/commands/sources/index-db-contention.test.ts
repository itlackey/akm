// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A held index.db write transaction forces a second connection to exhaust
 * SQLite's busy timeout. Run that write path in-process to shorten the wait.
 * The lock-held check uses a child so the sentinel belongs to another PID.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { getIndexRebuildLockPath } from "../../../../src/core/paths";
import type { Database } from "../../../../src/storage/database";
import * as indexConnection from "../../../../src/storage/repositories/index-connection";
import { runCliCapture } from "../../../_helpers/cli";
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
  test("SQLite contention exits 75; a live rebuild lock skips before writing and exits 0", async () => {
    writeMemory("note-0");

    // A writer outside any akm build holds an open write transaction on
    // index.db: a plain `akm index` takes the rebuild lock, then runs out
    // the busy timeout (this contention reclassification, a field follow-up).
    const openIndexDatabase = indexConnection.openIndexDatabase;
    const holder: Database = openIndexDatabase();
    holder.exec("BEGIN IMMEDIATE");

    try {
      const writer = spyOn(indexConnection, "openIndexDatabase").mockImplementation((dbPath, options) =>
        openIndexDatabase(dbPath, { ...options, busyTimeoutMs: 300 }),
      );
      const contended = await runCliCapture(["index", "--full", "--format=json"]).finally(() => writer.mockRestore());

      expect(contended.stdout.trim()).toBe("");
      expect(contended.code).toBe(75);
      const envelope = parseTrailingJsonEnvelope(contended.stderr);
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("INDEX_DB_CONTENDED");
      expect(envelope.error).toContain("index database is busy");
      expect(envelope.hint).toContain("retry shortly");

      // A second `akm index` already in progress holds the rebuild lock.
      plantHeldRebuildLock();

      // Same live rebuild lock and held index.db transaction: the build skips on the
      // rebuild lock alone, before it would write index.db, so the open BEGIN
      // IMMEDIATE above never matters to it: exit 0, no busy-timeout wait.
      const skipped = await runIndexChild(["--full", "--format=json"]);
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
  });
});
