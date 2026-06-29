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
  /**
   * Whether a transaction is currently open on this connection. Both drivers
   * (`bun:sqlite`, `better-sqlite3`) expose this. Used to detect the phantom
   * state where `BEGIN IMMEDIATE` returns without actually opening a transaction
   * under writer contention (see `withImmediateTransaction`).
   */
  readonly inTransaction: boolean;
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
 * A storage provider: one SQLite engine (and, later, a Postgres adapter) behind
 * the structural {@link Database} contract. This is the provider seam — adding a
 * backend means adding a provider to {@link PROVIDERS}, with NO call-site
 * changes. It is deliberately a tiny registry over the existing driver
 * factories, NOT a DI container or a ports-and-adapters hierarchy: the
 * {@link Database} type IS the port and `open` IS the adapter.
 */
interface StorageProvider {
  /** Stable identifier, for diagnostics and selection. */
  readonly name: string;
  /** Whether this provider can run in the current runtime. */
  supported(): boolean;
  /** Open a handle conforming to the structural {@link Database} type. */
  open(path: string, opts?: OpenDatabaseOptions): Database;
}

// bun:sqlite — Bun built-in, no native build. Cannot run on Node.
const bunSqliteProvider: StorageProvider = {
  name: "bun:sqlite",
  supported: () => isBun,
  open: openBunDatabase,
};

// better-sqlite3 — native Node driver. Cannot run on Bun (oven-sh/bun#4290).
const nodeSqliteProvider: StorageProvider = {
  name: "better-sqlite3",
  supported: () => !isBun,
  open: openNodeDatabase,
};

/**
 * Ordered provider registry. The factory selects the first supported provider.
 * A future Postgres provider is appended here — and only here. Both SQLite
 * engines are kept as distinct providers (not collapsed) because no single
 * SQLite driver runs on both Bun and Node today.
 */
const PROVIDERS: readonly StorageProvider[] = [bunSqliteProvider, nodeSqliteProvider];

/** Select the provider for the current runtime. */
function selectProvider(): StorageProvider {
  const provider = PROVIDERS.find((p) => p.supported());
  if (!provider) {
    throw new Error(`No storage provider supports the current runtime (${isBun ? "Bun" : "Node"}).`);
  }
  return provider;
}

/**
 * Open a SQLite database handle at `path` via the active {@link StorageProvider}.
 * Returns a handle conforming to the structural {@link Database} type.
 */
export function openDatabase(path: string, opts?: OpenDatabaseOptions): Database {
  return selectProvider().open(path, opts);
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
    // `better-sqlite3` is an optionalDependency, so `npm i` can succeed without
    // it (or with a native build that failed). Convert the raw MODULE_NOT_FOUND
    // into an actionable message instead of a cryptic onboarding crash.
    let mod: BetterSqlite3Ctor | { default: BetterSqlite3Ctor };
    try {
      mod = nodeRequire("better-sqlite3") as BetterSqlite3Ctor | { default: BetterSqlite3Ctor };
    } catch (err) {
      throw new Error(
        "akm could not load 'better-sqlite3', the SQLite driver it needs on Node.js.\n" +
          "  • Reinstall akm with a working C/C++ build toolchain so its optional\n" +
          "    'better-sqlite3' native binding rebuilds (a global `npm i -g better-sqlite3`\n" +
          "    will NOT be resolved — Node loads it from akm's own node_modules).\n" +
          "  • Or run akm under Bun, which has a built-in SQLite driver and needs no native build.\n" +
          `  Underlying load error: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  const db = opts ? new BetterSqlite3(path, options) : new BetterSqlite3(path);
  return db as unknown as Database;
}
