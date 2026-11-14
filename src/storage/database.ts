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
 *   - On Node.js (CI-tested by the node-smoke job's smoke + compat suites) we
 *     use `better-sqlite3`, loaded via a runtime-gated dynamic `require` so the Bun path never
 *     imports it (it is an optionalDependency and may be uninstalled or
 *     uncompiled when running under Bun).
 *
 * Both driver handles are structurally compatible across the small surface AKM
 * uses (`prepare`, `exec`, `run`, `transaction`, `close` on the handle;
 * `get`, `all`, `iterate`, `run` on prepared statements). The Bun-specific `db.query()`
 * helper is normalised away — callers use `db.prepare(sql).all(...)` instead.
 *
 * This file is intentionally NOT an adapter/DI/ports-and-adapters layer. It is
 * a plain module: a structural type plus a factory function. The handle it
 * returns is the real underlying driver instance (so e.g. `sqlite-vec`'s
 * `load(db)`, used to drop the retired `entries_vec` table, receives the
 * genuine driver handle and works unchanged).
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
 * row shape returned by `get`/`all`/`iterate`. Both drivers accept positional bind
 * parameters via rest args.
 *
 * The return types are deliberately wide (`Row | null | undefined` for `get`,
 * and the `Row` element type stays unconstrained for `all`/`iterate`) so that a concrete
 * `bun:sqlite` statement — whose `get()` may return `null` and whose `all()`
 * elements are `Row | undefined` — remains structurally assignable to this
 * type. Every call site in AKM casts the result to its concrete row shape, so
 * the width is invisible to callers.
 */
export interface Statement<Row = unknown> {
  get(...params: SqlValue[]): Row | null | undefined;
  all(...params: SqlValue[]): Row[];
  iterate(...params: SqlValue[]): IterableIterator<Row>;
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
  /**
   * Whether a transaction is currently open on this connection. Both drivers
   * (`bun:sqlite`, `better-sqlite3`) expose this. Used to detect the phantom
   * state where `BEGIN IMMEDIATE` returns without actually opening a transaction
   * under writer contention (see `withImmediateTransaction`).
   */
  readonly inTransaction: boolean;
  /**
   * Load a SQLite extension. Both drivers expose this, and `sqlite-vec`'s
   * `load(db)` calls it directly — so the Node wrapper must forward it rather
   * than presenting a handle that silently lacks the method.
   */
  loadExtension(path: string, entryPoint?: string): void;
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
 * Open a SQLite database handle at `path` on the current runtime's driver
 * (`bun:sqlite` on Bun, `better-sqlite3` on Node). Returns a handle conforming
 * to the structural {@link Database} type.
 *
 * On Bun, `close()` means CLOSED. bun:sqlite's own `close()` is a
 * `sqlite3_close_v2`: while any `prepare()` statement is unfinalized the
 * connection survives as a zombie, holding the file, its WAL and its
 * shared memory, until GC finalizes the statements. When GC finally closes it,
 * the last-connection checkpoint writes that WAL into whatever file now sits at
 * the path, a restored or replaced copy included. It also kept a later
 * connection from leaving WAL mode (issue #720). So the handle finalizes every
 * statement it prepared that is still alive before the real close. Statements
 * are held weakly, so a per-row `prepare()` is not kept alive until close.
 * better-sqlite3's `close()` already closes the connection outright.
 */
export function openDatabase(path: string, opts?: OpenDatabaseOptions): Database {
  return isBun ? finalizeOnClose(openBunDatabase(path, opts)) : openNodeDatabase(path, opts);
}

type Finalizable = { finalize?: () => void };

function finalizeOnClose(db: Database): Database {
  const live = new Set<WeakRef<Finalizable>>();
  const forget = new FinalizationRegistry<WeakRef<Finalizable>>((ref) => live.delete(ref));
  const prepare = db.prepare.bind(db);
  const close = db.close.bind(db);
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const stmt = prepare(sql) as Finalizable;
    const ref = new WeakRef(stmt);
    live.add(ref);
    forget.register(stmt, ref);
    return stmt;
  }) as typeof db.prepare;
  (db as { close: typeof db.close }).close = () => {
    for (const ref of live) {
      try {
        ref.deref()?.finalize?.();
      } catch {
        // Already finalized by its owner.
      }
    }
    live.clear();
    close();
  };
  return db;
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

function bunOptions(opts: OpenDatabaseOptions): { readonly?: boolean; create?: boolean; readwrite?: boolean } {
  const out: { readonly?: boolean; create?: boolean; readwrite?: boolean } = {};
  if (opts.readonly !== undefined) out.readonly = opts.readonly;
  if (opts.create !== undefined) out.create = opts.create;
  // bun:sqlite reads a partial options object as the full set of open flags:
  // with neither `readonly` nor `readwrite` set the handle carries no access
  // mode and every statement fails with SQLITE_MISUSE ("bad parameter or
  // other API misuse"). Default to writable, matching the driver's no-options
  // open and better-sqlite3's semantics.
  if (!out.readonly) out.readwrite = true;
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
  new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): BetterSqliteDatabase;
}

interface BetterSqliteDatabase {
  prepare<Row = unknown>(sql: string): Statement<Row>;
  exec(sql: string): void;
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R;
  readonly inTransaction: boolean;
  loadExtension(path: string, entryPoint?: string): void;
  close(): void;
}

let betterSqlite3Ctor: BetterSqlite3Ctor | undefined;
/**
 * The package is missing, or it carries no binding for this platform. Its N-API
 * bindings ship prebuilt in the package (see package.json → pinNotes), so neither
 * a build toolchain nor the Node version decides whether it loads.
 */
function missingBindingRemedy(): string {
  return (
    "akm could not load 'better-sqlite3', the SQLite driver it needs on Node.js.\n" +
    "  • Its package carries prebuilt bindings for Linux and macOS on x64 and arm64 and for\n" +
    `    Windows on x64 and arm64; this machine is ${process.platform} ${process.arch}.\n` +
    "  • Reinstall akm (`npm install -g akm-cli`) if the package is missing (a global\n" +
    "    `npm i -g better-sqlite3` will NOT be resolved — Node loads it from akm's own node_modules).\n" +
    "  • Or run akm under Bun, which has a built-in SQLite driver and needs no native binding."
  );
}

function loadBetterSqlite3(): BetterSqlite3Ctor {
  if (!betterSqlite3Ctor) {
    // Runtime-gated dynamic require: only reached when NOT on Bun, so Bun never
    // resolves or loads the optional `better-sqlite3` native dependency.
    // `better-sqlite3` is an optionalDependency, so `npm i` can succeed without
    // it. Convert the raw MODULE_NOT_FOUND into an actionable message instead of
    // a cryptic onboarding crash.
    let mod: BetterSqlite3Ctor | { default: BetterSqlite3Ctor };
    try {
      mod = nodeRequire("better-sqlite3") as BetterSqlite3Ctor | { default: BetterSqlite3Ctor };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`${missingBindingRemedy()}\n  Underlying load error: ${raw}`);
    }
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
  let db: BetterSqliteDatabase;
  try {
    db = opts ? new BetterSqlite3(path, options) : new BetterSqlite3(path);
  } catch (err) {
    // The package loads its binding at the first construction, not at `require`, so a platform it carries no
    // binding for fails here.
    const raw = err instanceof Error ? err.message : String(err);
    if (!raw.includes("better_sqlite3.node")) throw err;
    throw new Error(`${missingBindingRemedy()}\n  Underlying error: ${raw}`);
  }
  return {
    prepare: db.prepare.bind(db),
    exec: db.exec.bind(db),
    // better-sqlite3 exposes mutations on prepared statements, while
    // bun:sqlite also provides db.run(). Normalize the latter at the provider
    // boundary so callers and maintenance wrappers can rely on one contract.
    run: (sql, ...params) => db.prepare(sql).run(...params),
    // sqlite-vec's load(db) calls db.loadExtension(); without forwarding it the
    // extension could never load on Node.
    loadExtension: db.loadExtension.bind(db),
    transaction: db.transaction.bind(db),
    get inTransaction() {
      return db.inTransaction;
    },
    close: db.close.bind(db),
  };
}
