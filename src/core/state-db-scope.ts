// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Ambient, run-scoped state.db connection reuse.
 *
 * `openStateDatabase` is NOT cheap: every call registers a `state-db`
 * maintenance activity (a lockfile create under the maintenance barrier), opens
 * a throwaway read-only preflight handle to assert the migration ledger, then
 * opens the real handle and applies pragmas. Paying that per repository call
 * — twice per dispatched workflow unit (insert + finish), plus once per
 * `appendEvent` (two events per unit) — is the dominant cost of a wide `map`
 * fan-out.
 *
 * This module adds the ONE thing the codebase was missing: a way to say "for
 * the duration of this async operation, everything that talks to state.db
 * shares a single handle". It deliberately does NOT introduce a pool, a cache
 * with an eviction policy, or a background keep-alive timer — those all leak
 * handles across the test harness's per-test data-dir swaps. The scope owns
 * exactly one connection and closes it in a `finally`.
 *
 * ## Why this is safe
 *
 * SQLite connections must not be shared across THREADS. This is a single
 * process running a single-threaded JS event loop: `bun:sqlite` statement
 * execution and `withImmediateTransaction`'s `BEGIN IMMEDIATE … COMMIT` bodies
 * are fully synchronous, so two logically concurrent units can never interleave
 * statements on the shared handle — the runtime cannot preempt a synchronous
 * transaction body. Sharing one handle therefore REMOVES in-process writer
 * contention (`SQLITE_BUSY` against ourselves) rather than creating it.
 * Cross-process behaviour is untouched: WAL mode, the 30 s `busy_timeout` and
 * the run-lease protocol all still arbitrate between processes exactly as
 * before.
 *
 * The one hazard of an {@link AsyncLocalStorage}-carried handle is async work
 * that ESCAPES the scope: the context propagates into a promise that settles
 * after the scope's `finally` closed the handle. {@link borrowScopedStateDb}
 * guards that with a `closed` flag — once a scope is torn down it stops
 * lending, and escapee callers transparently fall back to opening their own
 * connection (the pre-existing behaviour). A use-after-close is structurally
 * impossible.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { Database } from "../storage/database";
import { getStateDbPath, openStateDatabase } from "./state-db";

interface StateDbScope {
  /** Resolved absolute path this scope's handle is (or will be) bound to. */
  readonly dbPath: string;
  /** Opened lazily on first borrow — a scope that never touches the DB opens nothing. */
  db: Database | undefined;
  /** Set by the scope's `finally`; a closed scope never lends again. */
  closed: boolean;
}

const scopeStorage = new AsyncLocalStorage<StateDbScope>();

/** Every scope with a live handle, so the exit backstop can close them all. */
const liveScopes = new Set<StateDbScope>();
let exitHookInstalled = false;

function installExitBackstop(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Idempotent, synchronous backstop: a process that exits mid-scope (a
  // `process.exit()` from a command, an uncaught fatal) still releases the
  // handle and its maintenance-activity lockfile. Normal teardown happens in
  // the scope's own `finally`, which removes the scope from `liveScopes`
  // first, so this never double-closes.
  process.on("exit", closeAllStateDbScopes);
}

/**
 * Close every scope-owned handle. Idempotent and safe to call at any time: a
 * closed scope stops lending, so in-flight borrowers fall back to their own
 * connections instead of using a dead handle.
 *
 * This is the disposal hook the engine can wire next to
 * `disposeDispatchResources` if it ever wants deterministic teardown at the end
 * of a run; until then the per-scope `finally` plus the process-exit backstop
 * above are what guarantee no handle leak.
 */
export function closeAllStateDbScopes(): void {
  for (const scope of [...liveScopes]) closeScope(scope);
}

function closeScope(scope: StateDbScope): void {
  scope.closed = true;
  liveScopes.delete(scope);
  const db = scope.db;
  scope.db = undefined;
  if (!db) return;
  try {
    db.close();
  } catch {
    // A close failure must never mask the caller's own error (or wedge exit).
  }
}

/**
 * The ambient scoped handle for `dbPath` (default: the canonical state.db), or
 * `undefined` when there is no live scope for that exact path.
 *
 * The path comparison matters: the test harness repoints `AKM_DATA_DIR` between
 * tests, and a scope entered against one data dir must never lend its handle to
 * a caller resolving a different one.
 */
export function borrowScopedStateDb(dbPath?: string): Database | undefined {
  const scope = scopeStorage.getStore();
  if (!scope || scope.closed) return undefined;
  if (path.resolve(dbPath ?? getStateDbPath()) !== scope.dbPath) return undefined;
  scope.db ??= openStateDatabase(scope.dbPath);
  liveScopes.add(scope);
  return scope.db;
}

/**
 * Run `fn` with one shared state.db connection ambient for its whole async
 * extent. The handle is opened on FIRST borrow (never eagerly) and closed once
 * `fn` settles.
 *
 * Nesting is a no-op join: an inner scope for the same path reuses the outer
 * scope's handle and does not close it, so a caller can enter a scope without
 * knowing whether an outer frame already did.
 */
export async function withStateDbScope<T>(fn: () => Promise<T>, opts?: { path?: string }): Promise<T> {
  const dbPath = path.resolve(opts?.path ?? getStateDbPath());
  const outer = scopeStorage.getStore();
  if (outer && !outer.closed && outer.dbPath === dbPath) return fn();
  const scope: StateDbScope = { dbPath, db: undefined, closed: false };
  installExitBackstop();
  try {
    return await scopeStorage.run(scope, fn);
  } finally {
    closeScope(scope);
  }
}

/** Test seam: how many scope-owned handles are currently open. Must return to 0. */
export function openScopedStateDbCount(): number {
  let count = 0;
  for (const scope of liveScopes) if (scope.db) count++;
  return count;
}
