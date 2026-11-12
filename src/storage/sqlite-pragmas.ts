// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared SQLite PRAGMA application + journal-mode resolution (#628).
 *
 * Every AKM SQLite opener applies the same opening PRAGMAs: a journal mode, a
 * 30 s busy_timeout, and (for most) foreign_keys = ON. WAL is impossible on
 * network filesystems (NFS/SMB) because its `-shm` shared-memory wal-index
 * cannot be mmap'd over a network mount.
 *
 * This module centralises that PRAGMA block behind {@link applyStandardPragmas}.
 * The journal mode is WAL; when the data directory is detected to live on a
 * network filesystem, it falls back to DELETE with a one-line warning.
 *
 * Boundary note: this is a PLAIN module, not a runtime-boundary file. It only
 * does pure string work plus `db.exec()` (allowed everywhere). The single
 * runtime primitive it needs — a filesystem-type probe (statfs) — lives in
 * src/runtime.ts and is injected here, keeping the network-FS classifier a
 * pure, unit-testable function.
 *
 * @module storage/sqlite-pragmas
 */

import { warn } from "../core/warn";
import { statfsType } from "../runtime";
import type { Database } from "./database";

/** The journal modes AKM uses: WAL, or DELETE on a network filesystem. */
export type JournalMode = "WAL" | "DELETE";

// One-shot warning guard so a network-FS fallback emits AT MOST ONCE per process.
let warnedNetworkFallback = false;

// Known Linux f_type magic numbers for network filesystems. These match only
// on Linux: other platforms report different statfs `type` values, so detection
// never fires there. virtiofs reports FUSE_SUPER_MAGIC, so the FUSE entry covers it.
// Values are from the kernel's include/uapi/linux/magic.h.
const FS_MAGIC_NFS = 0x6969; // 26985    — NFS
const FS_MAGIC_SMB = 0x517b; // 20859    — older SMB_SUPER_MAGIC
const FS_MAGIC_CIFS = 0xff534d42; // 4283649346 — SMB/CIFS
const FS_MAGIC_SMB2 = 0xfe534d42; // 4267272514 — SMB2
const FS_MAGIC_FUSE = 0x65735546; // 1702057286 — FUSE (sshfs, virtiofs + many network FUSE mounts)
const FS_MAGIC_9P = 0x01021997; // 16914839   — V9FS_MAGIC (9p, WSL2 /mnt/c)
const FS_MAGIC_CEPH = 0x00c36400; // 12805120   — CEPH_SUPER_MAGIC (CephFS)

const NETWORK_FS_MAGICS: ReadonlySet<number> = new Set([
  FS_MAGIC_NFS,
  FS_MAGIC_SMB,
  FS_MAGIC_CIFS,
  FS_MAGIC_SMB2,
  FS_MAGIC_9P,
  FS_MAGIC_CEPH,
  // FUSE is a judgment call: it backs BOTH network mounts (sshfs) and local
  // mounts (some encrypted/overlay FS). Treating it as network falls back to
  // DELETE — conservative-but-safe (DELETE works everywhere; the only cost is
  // losing WAL concurrency).
  FS_MAGIC_FUSE,
]);

/**
 * PURE classifier: is `fsType` a known network-filesystem magic number?
 * Returns false for `undefined` (probe failed/unsupported) and for local
 * magics (ext4 0xEF53, btrfs, xfs, tmpfs, apfs, …). Unit-testable with
 * injected magic numbers — no real mount required.
 */
export function isNetworkFilesystem(fsType: number | undefined): boolean {
  if (fsType === undefined) return false;
  return NETWORK_FS_MAGICS.has(fsType);
}

/** How long a statement waits for a lock before failing with SQLITE_BUSY. */
export const SQLITE_BUSY_TIMEOUT_MS = 30_000;

/**
 * The standard set for a READ-ONLY handle: just `busy_timeout`. A read-only
 * connection cannot run the rest (journal_mode and foreign_keys are write
 * operations), but SQLite's default timeout of 0 makes reads fail INSTANTLY
 * under writer contention — which matters in the DELETE journal mode
 * the network-filesystem fallback selects, where readers do block.
 */
export function applyReadonlyPragmas(db: Database): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}

/** Options for {@link applyStandardPragmas}. */
export interface StandardPragmaOptions {
  /**
   * When `false`, `PRAGMA foreign_keys = ON` is NOT applied. Default `true`
   * (matching 4 of 5 openers). logs-db must pass `false` to stay byte-identical
   * (it never set foreign_keys).
   */
  foreignKeys?: boolean;
  /**
   * The resolved DB directory. When provided it is probed for a network
   * filesystem to drive the WAL→DELETE fallback. Omit to skip the probe entirely.
   */
  dataDir?: string;
  /**
   * Injectable filesystem-type probe (defaults to {@link statfsType} from the
   * runtime). Exists so the network-FS fallback path is unit-testable without
   * a real network mount.
   */
  fsTypeProbe?: (path: string) => number | undefined;
}

/**
 * Apply AKM's standard opening PRAGMAs to `db`, in order:
 *   1. `journal_mode` = WAL (DELETE on a network filesystem)
 *   2. `busy_timeout = 30000`
 *   3. `foreign_keys = ON`  (unless `opts.foreignKeys === false`)
 *   4. `synchronous = FULL` (only in the rollback-journal mode — DELETE)
 *
 * Returns the effective {@link JournalMode} so callers/tests can assert it.
 *
 * `synchronous = FULL` is set explicitly only in DELETE so durability
 * intent is clear: rollback journals need FULL for crash-durability across
 * power loss, whereas WAL is durable at NORMAL. SQLite's default synchronous is
 * already FULL when unset, so this never changes WAL-default behaviour — the
 * WAL path emits no `synchronous` pragma, exactly as before.
 */
export function applyStandardPragmas(db: Database, opts: StandardPragmaOptions = {}): JournalMode {
  let mode: JournalMode = "WAL";

  // Network-FS fallback only fires for the WAL default and only when we have a
  // directory to probe. A failed/unsupported probe (undefined) keeps WAL.
  if (opts.dataDir) {
    const probe = opts.fsTypeProbe ?? statfsType;
    if (isNetworkFilesystem(probe(opts.dataDir))) {
      mode = "DELETE";
      warnNetworkFallbackOnce(opts.dataDir);
    }
  }

  // PRAGMAs must run before any DDL or DML. busy_timeout is applied FIRST so a
  // journal-mode change that must reclaim a leftover `-wal` file (WAL→DELETE on
  // reopen of an unclean WAL db, e.g. after a crash) can wait out a transient
  // lock instead of failing immediately with SQLITE_BUSY. For the WAL default
  // this is a no-op (WAL→WAL changes nothing), so byte-identical behaviour is
  // preserved.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA journal_mode = ${mode}`);
  if (opts.foreignKeys !== false) {
    db.exec("PRAGMA foreign_keys = ON");
  }
  if (mode !== "WAL") {
    db.exec("PRAGMA synchronous = FULL");
  }

  return mode;
}

function warnNetworkFallbackOnce(dataDir: string): void {
  if (warnedNetworkFallback) return;
  warnedNetworkFallback = true;
  warn(`[akm] network filesystem detected at ${dataDir} — WAL unsupported, using DELETE journal mode`);
}
