// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Side-effect-free SQLite snapshots for planning and preview paths.
 *
 * A normal SQLite read-only connection can still write lock bytes into an
 * existing `-shm` file when the source database is in WAL mode. Dry planning
 * must not do that. This helper copies a stable main/WAL pair and opens that
 * private copy, so SQLite never attaches to the operator's original
 * main/WAL/SHM files.
 *
 * The copy itself is made by a child process, never by this one: see
 * {@link copyFileOutsideThisProcess} for why an in-process read of a live
 * database is unsafe.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleepSync } from "../runtime";
import type { Database } from "./database";
import { openDatabaseFinalizing } from "./database";

const SNAPSHOT_MAX_ATTEMPTS = 8;
const SNAPSHOT_BACKOFF_MS = 25;

export class SqliteReadSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteReadSnapshotUnavailableError";
  }
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface FileFingerprint {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface DatabaseFingerprint {
  main: FileFingerprint;
  wal?: FileFingerprint;
}

function fileFingerprint(filePath: string): FileFingerprint | undefined {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function databaseFingerprint(dbPath: string): DatabaseFingerprint {
  const main = fileFingerprint(dbPath);
  if (!main) {
    throw new SqliteReadSnapshotUnavailableError("SQLite snapshot source disappeared while it was being inspected");
  }
  const wal = fileFingerprint(`${dbPath}-wal`);
  return { main, ...(wal ? { wal } : {}) };
}

function fingerprintsEqual(left: DatabaseFingerprint, right: DatabaseFingerprint): boolean {
  const sameFile = (a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean =>
    a?.size === b?.size && a?.mtimeNs === b?.mtimeNs && a?.ctimeNs === b?.ctimeNs;
  return sameFile(left.main, right.main) && sameFile(left.wal, right.wal);
}

/**
 * Copy `source` to `destination` without opening `source` in THIS process.
 *
 * POSIX advisory locks belong to the process, not to the descriptor: when a
 * process closes ANY descriptor for a file, the kernel drops every lock that
 * process holds on it, including the SHARED lock a live SQLite connection in
 * this same process (`akm improve` keeps one on state.db for the whole run)
 * holds. A peer using an older SQLite (< 3.51) read-write would then see no
 * reader, take EXCLUSIVE when it closes, and delete the `-wal`/`-shm` this
 * process is still using. The read therefore happens in a child `cp`, whose
 * descriptors and locks are its own. Windows locks belong to the handle, so
 * an in-process copy cannot release another handle's lock there (and there is
 * no `cp`).
 *
 * A source that vanished (a WAL checkpointed away mid-copy) throws an
 * `ENOENT` error, which {@link openSqliteReadSnapshot} retries.
 */
function copyFileOutsideThisProcess(source: string, destination: string): void {
  if (process.platform === "win32") {
    fs.copyFileSync(source, destination);
    return;
  }
  const result = spawnSync("cp", ["--", source, destination], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error) {
    throw new SqliteReadSnapshotUnavailableError(`cannot run cp to copy ${source}: ${result.error.message}`);
  }
  if (result.status === 0) return;
  // `cp` reports its errors as text, so the vanished-source case is recognised
  // by looking at the source itself.
  if (fileFingerprint(source) === undefined) {
    throw Object.assign(new Error(`${source} disappeared while it was being copied`), { code: "ENOENT" });
  }
  const reason =
    result.stderr.trim() || (result.signal ? `killed by ${result.signal}` : `exit status ${result.status}`);
  throw new Error(`cp could not copy ${source}: ${reason}`);
}

/**
 * Open an isolated copy of an existing SQLite database.
 *
 * Returns `undefined` only when the source is absent. Committed WAL frames are
 * copied beside the private main file; the source SHM is intentionally not
 * copied because SQLite can safely create one inside the disposable directory.
 * A live rollback-journal database fails closed because a file-level copy
 * cannot distinguish its committed and uncommitted pages without attaching to
 * the source.
 */
export function openSqliteReadSnapshot(dbPath: string): Database | undefined {
  if (!pathExists(dbPath)) return undefined;

  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-sqlite-read-"));
  const snapshotPath = path.join(snapshotDir, "snapshot.db");
  let db: Database | undefined;
  try {
    let copied = false;
    for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) sleepSync(SNAPSHOT_BACKOFF_MS * attempt);
      try {
        if (pathExists(`${dbPath}-journal`)) continue;
        const before = databaseFingerprint(dbPath);
        copyFileOutsideThisProcess(dbPath, snapshotPath);
        if (before.wal) copyFileOutsideThisProcess(`${dbPath}-wal`, `${snapshotPath}-wal`);
        else fs.rmSync(`${snapshotPath}-wal`, { force: true });
        const after = databaseFingerprint(dbPath);
        if (fingerprintsEqual(before, after) && !pathExists(`${dbPath}-journal`)) {
          copied = true;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    if (!copied) {
      throw new SqliteReadSnapshotUnavailableError(
        `SQLite main/WAL files did not settle after ${SNAPSHOT_MAX_ATTEMPTS} attempts with backoff — ` +
          "a writer may be continuously active, or a hot rollback journal never cleared",
      );
    }
    db = openDatabaseFinalizing(snapshotPath, { readonly: true, create: false });
    const closeSnapshot = db.close.bind(db);
    let closed = false;
    const cleanup = (bestEffort: boolean): void => {
      if (closed) return;
      closed = true;
      process.removeListener("exit", cleanupOnExit);
      if (bestEffort) {
        try {
          closeSnapshot();
        } catch {
          // Process teardown is already committed; keep removing the copy.
        }
        try {
          fs.rmSync(snapshotDir, { recursive: true, force: true });
        } catch {
          // Best-effort process-exit backstop. Normal close still surfaces IO errors.
        }
        return;
      }
      try {
        closeSnapshot();
      } finally {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      }
    };
    const cleanupOnExit = (): void => cleanup(true);
    process.once("exit", cleanupOnExit);
    db.close = () => cleanup(false);
    return db;
  } catch (error) {
    try {
      db?.close();
    } finally {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
    throw error;
  }
}
