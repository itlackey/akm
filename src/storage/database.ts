// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * SQLite runtime boundary.
 *
 * Single source of truth for opening SQLite database handles. The rest of the
 * codebase imports the {@link Database} type and {@link openDatabase} factory
 * from here and NEVER imports `bun:sqlite` or `better-sqlite3` directly.
 *
 * Runtime selection:
 *   - On Bun (the primary/test runtime) we use the built-in `bun:sqlite`.
 *   - On Node.js (additive, not CI-tested this pass) we use `better-sqlite3`,
 *     loaded via a runtime-gated dynamic `require` so the Bun path never
 *     imports it (it is an optionalDependency and may be uninstalled or
 *     uncompiled when running under Bun).
 *
 * Both driver handles are structurally compatible across the small surface AKM
 * uses (`prepare`, `exec`, `run`, `transaction`, `close` on the handle;
 * `get`, `all`, `run` on prepared statements). The Bun-specific `db.query()`
 * helper is normalised away — callers use `db.prepare(sql).all(...)` instead.
 *
 * This file is intentionally NOT an adapter/DI/ports-and-adapters layer. It is
 * a plain module: a structural type plus a factory function. The handle it
 * returns is the real underlying driver instance (so e.g. `sqlite-vec`'s
 * `load(db)` receives the genuine driver handle and works unchanged).
 *
 * @module storage/database
 */

import { createRequire } from "node:module";

// Detect the runtime exactly once at module load.
const isBun = !!process.versions?.bun;

// A CommonJS-style require usable from this ESM module on both runtimes. Used
// to load the runtime-specific driver lazily so that neither `bun:sqlite` (a
// Bun built-in, unresolvable on Node) nor `better-sqlite3` (an optional native
// dep, possibly absent under Bun) is statically imported.
const nodeRequire = createRequire(import.meta.url);

/**
 * A bound parameter value accepted by a prepared statement. This is the common
 * subset of what both `bun:sqlite` and `better-sqlite3` accept positionally.
 */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/** Result of a mutating statement/exec (`run()`), common to both drivers. */
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * A prepared statement, narrowed to the methods AKM calls. Generic over the
 * row shape returned by `get`/`all`. Both drivers accept positional bind
 * parameters via rest args.
 *
 * The return types are deliberately wide (`Row | null | undefined` for `get`,
 * and the `Row` element type stays unconstrained for `all`) so that a concrete
 * `bun:sqlite` statement — whose `get()` may return `null` and whose `all()`
 * elements are `Row | undefined` — remains structurally assignable to this
 * type. Every call site in AKM casts the result to its concrete row shape, so
 * the width is invisible to callers.
 */
export interface Statement<Row = unknown> {
  get(...params: SqlValue[]): Row | null | undefined;
  all(...params: SqlValue[]): Row[];
  run(...params: SqlValue[]): RunResult;
}

/**
 * The structural database handle type. Covers exactly the methods AKM invokes
 * on a SQLite handle. Deliberately a small hand-written structural type rather
 * than an alias of `@types/better-sqlite3` so it stays valid on Bun (where
 * better-sqlite3 is not installed) and documents the actual contract.
 *
 * NOTE: `db.query()` (Bun-only) is intentionally absent — it is normalised to
 * `db.prepare().all()` at the call sites that previously used it.
 */
export interface Database {
  /**
   * Prepare a SQL statement for repeated execution. The row generic defaults
   * to `any` (rather than `unknown`) purely so a concrete `bun:sqlite` /
   * `better-sqlite3` handle stays structurally assignable to this type;
   * call sites cast `get`/`all` results to their concrete row shapes.
   */
  // biome-ignore lint/suspicious/noExplicitAny: see doc comment — width is needed for cross-driver structural assignability
  prepare<Row = any>(sql: string): Statement<Row>;
  /** Execute one or more SQL statements with no bound parameters / results. */
  exec(sql: string): void;
  /** Execute a single mutating statement with optional positional params. */
  run(sql: string, ...params: SqlValue[]): RunResult;
  /**
   * Wrap a function in a transaction. Both drivers return a callable that runs
   * the wrapped function (and commits/rolls back) when invoked.
   */
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
  /** Close the underlying database handle. */
  close(): void;
}

/** Options accepted by {@link openDatabase}. Common subset across drivers. */
export interface OpenDatabaseOptions {
  /** Open the database in read-only mode. */
  readonly?: boolean;
  /** Create the file if it does not exist (drivers default to true). */
  create?: boolean;
}

/**
 * A guard consulted on every {@link openDatabase} call before the driver opens
 * the handle. It receives the FINAL path string handed to the driver (already
 * resolved past any `?? getDbPath()` default at the higher-level openers), so it
 * sees `:memory:` verbatim and sees a no-arg default-to-real open as the real
 * file path. Throwing from it aborts the open. Used by the unit-tier purity
 * guard (`tests/_helpers/purity-guard.ts`) to fail any real on-disk SQLite open.
 */
export type OpenDatabaseGuard = (path: string) => void;

let activeOpenGuard: OpenDatabaseGuard | undefined;

/**
 * Install a {@link OpenDatabaseGuard}. TEST-ONLY: throws unless
 * `AKM_TEST_HARNESS === "1"`, so production code can never install one — the
 * default (no guard) is the production path. Returns the previously-installed
 * guard so a caller can restore it (`afterAll`).
 */
export function setOpenDatabaseGuard(guard: OpenDatabaseGuard | null): OpenDatabaseGuard | undefined {
  if (process.env.AKM_TEST_HARNESS !== "1") {
    throw new Error("setOpenDatabaseGuard is test-only (requires AKM_TEST_HARNESS=1)");
  }
  const prev = activeOpenGuard;
  activeOpenGuard = guard ?? undefined;
  return prev;
}

/** Remove any installed open-database guard (restore the production no-guard path). */
export function resetOpenDatabaseGuard(): void {
  activeOpenGuard = undefined;
}

// ── In-memory DB redirect: the unit-tier test pool (#664) ────────────────────
//
// ONE structural redirect instead of migrating ~900 tests by hand: under the
// unit test tier, every real-file `openDatabase(path)` is mapped to a
// process-pooled `:memory:` database keyed by that path. Same path within (or
// across) tests shares one in-memory DB (close() is keep-alive, so a reopen
// still sees the data — file-like persistence); unique sandbox paths give
// isolation exactly as real files do. This eliminates the real fd + `-wal`/
// `-shm` churn the #664 thesis ties to the Bun `--isolate` epoll race under
// `--parallel>1` (empirically: 2/20 race-or-hang at `--parallel=4` WITHOUT it),
// and is faster than disk. Production and the integration tier never enable it.
//
// `databaseExists()` makes the redirect transparent to the ~11 call sites that
// gate a DB open on `fs.existsSync(dbPath)`: under the redirect "the file
// exists" == "the pool has it" (i.e. it was built), so those guards keep working.

let inMemoryRedirect = false;
const inMemoryPool = new Map<string, { db: Database; realClose: () => void }>();
// Generous LRU cap: test fixture DBs are tiny; eviction only frees paths no
// recent test has touched (a later reopen just gets a fresh DB — harmless).
const IN_MEMORY_POOL_CAP = 2048;

/**
 * Enable/disable the unit-tier in-memory DB redirect. TEST-ONLY (requires
 * `AKM_TEST_HARNESS=1`). Disabling drains the pool.
 */
export function setInMemoryDbRedirect(on: boolean): void {
  if (process.env.AKM_TEST_HARNESS !== "1") {
    throw new Error("setInMemoryDbRedirect is test-only (requires AKM_TEST_HARNESS=1)");
  }
  inMemoryRedirect = on;
  if (!on) clearInMemoryDbPool();
}

/** Whether the in-memory redirect is currently active (for `databaseExists`). */
export function isInMemoryDbRedirectActive(): boolean {
  return inMemoryRedirect;
}

/** Truly close every pooled in-memory DB and empty the pool. */
export function clearInMemoryDbPool(): void {
  for (const { realClose } of inMemoryPool.values()) {
    try {
      realClose();
    } catch {
      /* already closed */
    }
  }
  inMemoryPool.clear();
}

/**
 * Pool-aware DB existence check. Replaces the `fs.existsSync(dbPath)` guards
 * that decide whether an index/state/workflow DB has been built: under the
 * unit-tier redirect a built DB lives in the pool (never on disk), so existence
 * == the pool has it. In production / integration this is plain `fs.existsSync`.
 */
export function databaseExists(dbPath: string): boolean {
  if (inMemoryRedirect && dbPath !== ":memory:") return inMemoryPool.has(dbPath);
  return nodeRequire("node:fs").existsSync(dbPath);
}

function evictOldestInMemoryDbs(): void {
  while (inMemoryPool.size > IN_MEMORY_POOL_CAP) {
    const oldest = inMemoryPool.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const entry = inMemoryPool.get(oldest);
    inMemoryPool.delete(oldest);
    try {
      entry?.realClose();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Open a SQLite database handle at `path`, selecting the driver for the current
 * runtime. Returns a handle conforming to the structural {@link Database} type.
 *
 * The Node driver (`better-sqlite3`) is required lazily and ONLY when not on
 * Bun, so importing this module under Bun never touches `better-sqlite3`.
 */
export function openDatabase(path: string, opts?: OpenDatabaseOptions): Database {
  // Unit-tier redirect: a real-file open becomes a process-pooled :memory: DB
  // keyed by the path. Same path → same handle; close() is keep-alive. A bare
  // `:memory:` open is passed straight through (never pooled by path).
  if (inMemoryRedirect && path !== ":memory:") {
    const existing = inMemoryPool.get(path);
    if (existing) {
      inMemoryPool.delete(path); // LRU touch
      inMemoryPool.set(path, existing);
      return existing.db;
    }
    const db = isBun ? openBunDatabase(":memory:", opts) : openNodeDatabase(":memory:", opts);
    const realClose = (db.close as () => void).bind(db);
    (db as { close: () => void }).close = () => {}; // keep-alive until evicted/cleared
    inMemoryPool.set(path, { db, realClose });
    evictOldestInMemoryDbs();
    return db;
  }
  // The guard slot is undefined in production (zero overhead beyond this load);
  // only the unit-tier purity harness installs one. It sees the final driver
  // path, so the §8.3 `p === ":memory:"` discrimination runs on exactly what the
  // driver receives.
  activeOpenGuard?.(path);
  if (isBun) {
    return openBunDatabase(path, opts);
  }
  return openNodeDatabase(path, opts);
}

function openBunDatabase(path: string, opts?: OpenDatabaseOptions): Database {
  const { Database: BunDatabase } = loadBunSqlite();
  // Only pass an options object when an option is actually set. bun:sqlite
  // raises SQLITE_MISUSE if handed an options bag with all-undefined fields,
  // and every current caller opens with just a path — so the no-opts path must
  // remain byte-identical to the original `new Database(path)`.
  const db = opts ? new BunDatabase(path, bunOptions(opts)) : new BunDatabase(path);
  return db as unknown as Database;
}

function bunOptions(opts: OpenDatabaseOptions): { readonly?: boolean; create?: boolean } {
  const out: { readonly?: boolean; create?: boolean } = {};
  if (opts.readonly !== undefined) out.readonly = opts.readonly;
  if (opts.create !== undefined) out.create = opts.create;
  return out;
}

let bunSqliteModule: typeof import("bun:sqlite") | undefined;
function loadBunSqlite(): typeof import("bun:sqlite") {
  // `bun:sqlite` is a Bun built-in. This function is only ever called when
  // `isBun` is true, so Node never resolves the `bun:` specifier. Loaded via
  // require (not a static import) to keep Node's ESM resolver from choking on
  // the `bun:` specifier when this module is merely imported under Node.
  if (!bunSqliteModule) {
    bunSqliteModule = nodeRequire("bun:sqlite") as typeof import("bun:sqlite");
  }
  return bunSqliteModule;
}

interface BetterSqlite3Ctor {
  new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): Database;
}

let betterSqlite3Ctor: BetterSqlite3Ctor | undefined;
function loadBetterSqlite3(): BetterSqlite3Ctor {
  if (!betterSqlite3Ctor) {
    // Runtime-gated dynamic require: only reached when NOT on Bun, so Bun never
    // resolves or loads the optional `better-sqlite3` native dependency.
    const mod = nodeRequire("better-sqlite3") as BetterSqlite3Ctor | { default: BetterSqlite3Ctor };
    betterSqlite3Ctor = (mod as { default?: BetterSqlite3Ctor }).default ?? (mod as BetterSqlite3Ctor);
  }
  return betterSqlite3Ctor;
}

function openNodeDatabase(path: string, opts?: OpenDatabaseOptions): Database {
  const BetterSqlite3 = loadBetterSqlite3();
  // better-sqlite3 validates option *values* strictly and throws
  // `Expected the "readonly" option to be a boolean` if the key is present with
  // an `undefined` value — so only include each option when it is actually set,
  // matching the no-opts byte-identical path on the Bun side.
  const options: { readonly?: boolean; fileMustExist?: boolean } = {};
  if (opts?.readonly !== undefined) options.readonly = opts.readonly;
  if (opts?.create === false) options.fileMustExist = true;
  const db = opts ? new BetterSqlite3(path, options) : new BetterSqlite3(path);
  return db as unknown as Database;
}
