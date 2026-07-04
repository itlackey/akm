// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared SQLite PRAGMA application + journal-mode resolution (#628).
 *
 * Every AKM SQLite opener applies the same opening PRAGMAs: a journal mode, a
 * 30 s busy_timeout, and (for most) foreign_keys = ON. Historically each opener
 * hard-coded `PRAGMA journal_mode = WAL`. WAL is impossible on network
 * filesystems (NFS/SMB) because its `-shm` shared-memory wal-index cannot be
 * mmap'd over a network mount, so AKM could not run with its data dir on a
 * network share.
 *
 * This module centralises that PRAGMA block behind {@link applyStandardPragmas}
 * and makes the journal mode configurable via the `AKM_SQLITE_JOURNAL_MODE`
 * env var (WAL | DELETE | TRUNCATE; default WAL = unchanged behaviour). When the
 * mode is the WAL default and the data directory is detected to live on a
 * network filesystem, it auto-falls-back to DELETE with a one-line warning.
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

/** The journal modes AKM supports. WAL is the historical default. */
export type JournalMode = "WAL" | "DELETE" | "TRUNCATE";

const VALID_MODES: ReadonlySet<JournalMode> = new Set<JournalMode>(["WAL", "DELETE", "TRUNCATE"]);

// One-shot warning guards so a misconfigured env var or a network-FS fallback
// each emit AT MOST ONCE per process rather than on every db open.
let warnedInvalid = false;
let warnedNetworkFallback = false;

/**
 * Resolve a raw `AKM_SQLITE_JOURNAL_MODE` value to a canonical {@link JournalMode}.
 *
 * PURE and unit-testable: the raw string is passed in (not read from
 * `process.env` here). Trims + uppercases; an empty/undefined value yields the
 * WAL default; a recognised value yields its canonical form; any other
 * non-empty value warns once and falls back to WAL. Never throws.
 */
export function resolveJournalMode(raw: string | undefined): JournalMode {
  if (raw === undefined) return "WAL";
  const normalized = raw.trim().toUpperCase();
  if (normalized === "") return "WAL";
  if (VALID_MODES.has(normalized as JournalMode)) {
    return normalized as JournalMode;
  }
  warnInvalidJournalModeOnce(raw);
  return "WAL";
}

/**
 * The single env-reading seam: resolve the configured journal mode from
 * `process.env.AKM_SQLITE_JOURNAL_MODE`. Read at call time (per open) so tests
 * that set the env per-case see the right value and we avoid stale-env flakes.
 */
export function resolveConfiguredJournalMode(env: NodeJS.ProcessEnv = process.env): JournalMode {
  return resolveJournalMode(env.AKM_SQLITE_JOURNAL_MODE);
}

function warnInvalidJournalModeOnce(raw: string): void {
  if (warnedInvalid) return;
  warnedInvalid = true;
  warn(`[akm] invalid AKM_SQLITE_JOURNAL_MODE=${JSON.stringify(raw)} — using WAL (valid: WAL, DELETE, TRUNCATE)`);
}

// Known Linux f_type magic numbers for network filesystems. node's statfs
// normalises `type` to this numeric f_type magic on all platforms.
const FS_MAGIC_NFS = 0x6969; // 26985    — NFS
const FS_MAGIC_SMB = 0x517b; // 20859    — older SMB_SUPER_MAGIC
const FS_MAGIC_CIFS = 0xff534d42; // 4283649346 — SMB/CIFS
const FS_MAGIC_SMB2 = 0xfe534d42; // 4267272514 — SMB2
const FS_MAGIC_FUSE = 0x65735546; // 1702057286 — FUSE (sshfs + many network FUSE mounts)

const NETWORK_FS_MAGICS: ReadonlySet<number> = new Set([
  FS_MAGIC_NFS,
  FS_MAGIC_SMB,
  FS_MAGIC_CIFS,
  FS_MAGIC_SMB2,
  // FUSE is a judgment call: it backs BOTH network mounts (sshfs) and local
  // mounts (some encrypted/overlay FS). Treating it as network falls back to
  // DELETE — conservative-but-safe (DELETE works everywhere; the only cost is
  // losing WAL concurrency). An operator can always force WAL via the env var.
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

/** Options for {@link applyStandardPragmas}. */
export interface StandardPragmaOptions {
  /**
   * When `false`, `PRAGMA foreign_keys = ON` is NOT applied. Default `true`
   * (matching 4 of 5 openers). logs-db must pass `false` to stay byte-identical
   * (it never set foreign_keys).
   */
  foreignKeys?: boolean;
  /**
   * The resolved DB directory. When provided AND the resolved mode is the WAL
   * default, it is probed for a network filesystem to drive the WAL→DELETE
   * fallback. Omit to skip the probe entirely.
   */
  dataDir?: string;
  /**
   * Injectable filesystem-type probe (defaults to {@link statfsType} from the
   * runtime). Exists so the network-FS fallback path is unit-testable without
   * a real network mount.
   */
  fsTypeProbe?: (path: string) => number | undefined;
  /**
   * Injectable environment for resolving `AKM_SQLITE_JOURNAL_MODE`. Defaults to
   * `process.env`; supplied by tests (and `ManagedDbSpec.pragmas`) so the
   * journal-mode read is not an ambient global. Omit for the default.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Apply AKM's standard opening PRAGMAs to `db`, in order:
 *   1. `journal_mode` = the configured mode (with WAL→DELETE network-FS fallback)
 *   2. `busy_timeout = 30000`
 *   3. `foreign_keys = ON`  (unless `opts.foreignKeys === false`)
 *   4. `synchronous = FULL` (only in a rollback-journal mode — DELETE/TRUNCATE)
 *
 * Returns the effective {@link JournalMode} so callers/tests can assert it.
 *
 * `synchronous = FULL` is set explicitly only in DELETE/TRUNCATE so durability
 * intent is clear: rollback journals need FULL for crash-durability across
 * power loss, whereas WAL is durable at NORMAL. SQLite's default synchronous is
 * already FULL when unset, so this never changes WAL-default behaviour — the
 * WAL path emits no `synchronous` pragma, exactly as before.
 */
export function applyStandardPragmas(db: Database, opts: StandardPragmaOptions = {}): JournalMode {
  let mode = resolveConfiguredJournalMode(opts.env);

  // Network-FS fallback only fires for the WAL default and only when we have a
  // directory to probe. An explicitly-requested DELETE/TRUNCATE is never
  // overridden, and a failed/unsupported probe (undefined) keeps WAL.
  if (mode === "WAL" && opts.dataDir) {
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
  db.exec("PRAGMA busy_timeout = 30000");
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
