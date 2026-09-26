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
 */
export function openDatabase(path: string, opts?: OpenDatabaseOptions): Database {
  return isBun ? openBunDatabase(path, opts) : openNodeDatabase(path, opts);
}

/**
 * {@link openDatabase} with a finalize-on-close guard (issue #720).
 *
 * bun:sqlite's `Database.close()` is a `sqlite3_close_v2`: with any UNFINALIZED
 * `prepare()` statement outstanding, the underlying connection — and its WAL
 * shared-memory mapping — survives as a zombie until GC finalizes the
 * statements. A later connection in the same process then cannot leave WAL
 * mode (`PRAGMA journal_mode = DELETE` → "database is locked"), which is
 * exactly what silently defeated the migrate-apply single-file conversion.
 * (`db.query()` statements are Database-cached and immune; `prepare()` is the
 * dominant idiom in the migration helpers.)
 *
 * This variant tracks `prepare()` results and finalizes them (idempotently)
 * before the real `close()`, so close always means CLOSED. It is deliberately
 * OPT-IN for the migrate-apply flow's short-lived helper connections and the
 * migration test fixtures — NOT the global default: long-lived/hot paths cache
 * prepared statements per connection (e.g. the entries upsert WeakMap) and
 * worker flows may still be stepping a statement when a sibling close lands;
 * force-finalizing under them changes behavior they were built on.
 */
export function openDatabaseFinalizing(path: string, opts?: OpenDatabaseOptions): Database {
  const db = openDatabase(path, opts);
  const tracked = new Set<{ finalize?: () => void }>();
  const origPrepare = db.prepare.bind(db);
  const origClose = db.close.bind(db);
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string, ...rest: unknown[]) => {
    const stmt = (origPrepare as (...a: unknown[]) => { finalize?: () => void })(sql, ...rest);
    tracked.add(stmt);
    return stmt;
  }) as typeof db.prepare;
  (db as { close: typeof db.close }).close = ((...args: unknown[]) => {
    for (const stmt of tracked) {
      try {
        stmt.finalize?.();
      } catch {
        // Already finalized (double-finalize is the idempotent no-op case).
      }
    }
    tracked.clear();
    return (origClose as (...a: unknown[]) => unknown)(...args);
  }) as typeof db.close;
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
 * The binding is absent or unbuildable — a toolchain/install problem.
 */
const MISSING_BINDING_REMEDY =
  "akm could not load 'better-sqlite3', the SQLite driver it needs on Node.js.\n" +
  "  • Reinstall akm with a working C/C++ build toolchain so its optional\n" +
  "    'better-sqlite3' native binding builds (a global `npm i -g better-sqlite3`\n" +
  "    will NOT be resolved — Node loads it from akm's own node_modules).\n" +
  "  • Or run akm under Bun, which has a built-in SQLite driver and needs no native build.";

/**
 * Recognize a binding built for a DIFFERENT Node ABI than the one now running,
 * and answer with the one command that fixes it.
 *
 * This is the most likely failure a real user hits, and it is not a broken
 * install: a native addon is compiled (or a prebuilt binary is selected) for
 * the Node major present at `npm install` time. Upgrade Node afterwards and the
 * same file no longer loads.
 *
 * It is matched rather than described because the symptom text varies and the
 * previous wording only named ONE of them. The prebuilt-binary path — which is
 * now the normal path, since better-sqlite3 is pinned to a version publishing a
 * prebuild for every supported Node (see package.json → pinNotes) — reports
 * `Module did not self-register`, saying nothing about versions at all. A
 * from-source build reports the explicit `NODE_MODULE_VERSION` mismatch. Asking
 * the user to decide which bullet applies is the step worth deleting.
 */
export function abiMismatchRemedy(message: string): string | undefined {
  const ABI_MISMATCH_SHAPES = [
    "did not self-register", // prebuilt binary for another ABI
    "NODE_MODULE_VERSION", // explicit mismatch, from-source build
    "was compiled against a different", // same, older phrasing
    "invalid ELF header", // binary for another platform/arch entirely
  ];
  if (!ABI_MISMATCH_SHAPES.some((shape) => message.includes(shape))) return undefined;
  return (
    "akm could not load 'better-sqlite3': its native binding was built for a different\n" +
    `Node.js version than the one now running (this Node is ABI ${process.versions.modules}).\n` +
    "This is what happens when Node is upgraded after akm is installed. It is NOT a\n" +
    "broken install, and reinstalling akm is not required.\n" +
    "  Fix: npm rebuild better-sqlite3        # in akm's install directory\n" +
    "  Or:  npm install -g akm-cli            # reinstall, rebuilding against this Node\n" +
    "  Or:  run akm under Bun, whose built-in SQLite driver needs no native binding."
  );
}

function loadBetterSqlite3(): BetterSqlite3Ctor {
  if (!betterSqlite3Ctor) {
    // Runtime-gated dynamic require: only reached when NOT on Bun, so Bun never
    // resolves or loads the optional `better-sqlite3` native dependency.
    // `better-sqlite3` is an optionalDependency, so `npm i` can succeed without
    // it (or with a native build that failed). Convert the raw MODULE_NOT_FOUND
    // into an actionable message instead of a cryptic onboarding crash.
    let mod: BetterSqlite3Ctor | { default: BetterSqlite3Ctor };
    try {
      mod = nodeRequire("better-sqlite3") as BetterSqlite3Ctor | { default: BetterSqlite3Ctor };
    } catch (err) {
      // An ABI mismatch does NOT arrive here — `require` succeeds and the
      // failure lands at construction (see openNodeDatabase). This path is a
      // genuinely absent or unresolvable module. `abiMismatchRemedy` is still
      // consulted because a from-source build CAN fail at load with the
      // explicit NODE_MODULE_VERSION message.
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`${abiMismatchRemedy(raw) ?? MISSING_BINDING_REMEDY}\n  Underlying load error: ${raw}`);
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
  // Construction, not `require`, is where an ABI mismatch surfaces.
  // `require("better-sqlite3")` SUCCEEDS against a binding built for another
  // Node ABI — the package resolves its `.node` file lazily — so the loader's
  // catch never sees this error and cannot explain it. Verified against a real
  // ABI-127 binding under Node 24 (ABI 137): `require()` returned a function
  // and `new Database(...)` threw. Wrapping the require alone left the most
  // likely real-world failure reported as a bare Node internals message.
  let db: BetterSqliteDatabase;
  try {
    db = opts ? new BetterSqlite3(path, options) : new BetterSqlite3(path);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const remedy = abiMismatchRemedy(raw);
    if (!remedy) throw err;
    throw new Error(`${remedy}\n  Underlying error: ${raw}`);
  }
  return {
    prepare: db.prepare.bind(db),
    exec: db.exec.bind(db),
    // better-sqlite3 exposes mutations on prepared statements, while
    // bun:sqlite also provides db.run(). Normalize the latter at the provider
    // boundary so callers and maintenance wrappers can rely on one contract.
    run: (sql, ...params) => db.prepare(sql).run(...params),
    // sqlite-vec's load(db) calls db.loadExtension(). Without forwarding it the
    // extension could never load on Node, so the vector fast path was dead
    // across the entire npm distribution even when sqlite-vec was installed.
    loadExtension: db.loadExtension.bind(db),
    transaction: db.transaction.bind(db),
    get inTransaction() {
      return db.inTransaction;
    },
    close: db.close.bind(db),
  };
}
