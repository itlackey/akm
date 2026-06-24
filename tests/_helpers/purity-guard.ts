// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Runtime purity guard (#664 Step 2 / C2.2) — OPT-IN.
 *
 * The static unit-purity lint (`scripts/lint-tests-unit-purity.ts`) catches a
 * `Bun.serve` / subprocess spawn by regex, but it CANNOT see real I/O that hides
 * behind a facade: a test that calls `embed()` (real fetch via the embedder
 * facade), an un-seamed `searchLocal()` (real `ensureIndex` + on-disk open), or
 * an `improve` planner step that defaults to `openExistingDatabase()` still opens
 * a real socket / on-disk SQLite handle that no grep sees (Reviewer 2 finding 10).
 *
 * This guard closes that hole at runtime. Installed in a `beforeAll` and removed
 * in an `afterAll`, it makes the unit tier fail LOUDLY when real I/O is acquired:
 *
 *   - Every `openDatabase(path)` at the storage boundary (`src/storage/database.ts`)
 *     is intercepted. A real on-disk path THROWS `UNIT_IMPURE_DB_OPEN`. The ONLY
 *     honored in-memory form is the bare token `":memory:"` — per §8.3 correction
 *     1, `file:`/`mode=memory`/`file::memory:` URIs are NOT honored, because
 *     bun:sqlite's default constructor (no URI flags) opens those as REAL on-disk
 *     files literally named that string. A no-arg `openDatabase()` /
 *     `openExistingDatabase()` / `openStateDatabase()` resolves to the real
 *     data-dir path before reaching the boundary, so it is seen as a real path
 *     and throws — exactly the un-seamed default-to-real call the ratchet must
 *     surface.
 *   - `globalThis.fetch` THROWS `UNIT_IMPURE_FETCH` unconditionally — an
 *     un-seamed network call is always impure; HTTP purity is Seam 1's injected
 *     `HttpClient`, never a real socket.
 *
 * Per §8.1 / §8.5 the harness also sets `AKM_NO_AUTO_MIGRATE=1` (so any stray
 * config read on a `:memory:` open can never rewrite the operator's real
 * `config.json` or print a banner) and asks the DB layer to apply
 * `PRAGMA temp_store = MEMORY` (so FTS5/vec sorts on a seeded corpus never spill
 * to a file-backed temp btree the path-level guard cannot see).
 *
 * This is the OPT-IN form. It is NOT installed globally yet — the global flip is
 * Phase 6 (C6.2). Until then a test that wants the guarantee installs it itself:
 *
 *   import { installPurityGuard } from "../_helpers/purity-guard";
 *   describe("...", () => {
 *     installPurityGuard();   // beforeAll install + afterAll restore
 *     test("...", () => { ... });
 *   });
 */

import { afterAll, beforeAll } from "bun:test";
import { resetOpenDatabaseGuard, setOpenDatabaseGuard } from "../../src/storage/database";

/** The canonical anonymous in-memory SQLite DB — the ONLY honored in-memory form. */
export const IN_MEMORY_DB_PATH = ":memory:";

/**
 * §8.3 correction 1: ONLY the bare `:memory:` token is in-memory under the
 * driver the storage boundary uses (`new BunDatabase(path)`, no URI flags). The
 * `file:`/`mode=memory`/`file::memory:` branches are deliberately absent — they
 * open REAL on-disk files under bun:sqlite's default constructor and would let
 * the guard certify a real-file open as pure.
 */
export function isInMemorySqlitePath(p: string | undefined): boolean {
  return p === IN_MEMORY_DB_PATH;
}

/** Error thrown when an un-seamed real on-disk SQLite open is attempted. */
export class UnitImpureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitImpureError";
  }
}

const realOpenGuard = (path: string): void => {
  if (isInMemorySqlitePath(path)) return;
  throw new UnitImpureError(
    `UNIT_IMPURE_DB_OPEN: a unit test opened a real SQLite database at "${path}". ` +
      `The unit tier must do zero real I/O — seed an in-memory DB via ` +
      `openDatabase(":memory:") / seedEntries(...) instead, or move this test to ` +
      `tests/integration/. (A no-arg openDatabase()/openExistingDatabase()/` +
      `openStateDatabase() resolves to the real data-dir path and trips this guard ` +
      `— add a db?/getAllEntries? seam at that call site.)`,
  );
};

/**
 * Install the runtime purity guard for the enclosing `describe`. Registers a
 * `beforeAll` that installs the open-database guard, throwing `globalThis.fetch`,
 * `AKM_NO_AUTO_MIGRATE=1`, and the `temp_store=MEMORY` request flag; and an
 * `afterAll` that restores all four. Idempotent and self-restoring, so it is safe
 * to install in multiple sibling describes within one file.
 */
export function installPurityGuard(): void {
  let prevGuard: ReturnType<typeof setOpenDatabaseGuard>;
  let prevFetch: typeof globalThis.fetch;
  let prevNoAutoMigrate: string | undefined;
  let prevTempStore: string | undefined;

  beforeAll(() => {
    // §8.1: keep any stray config read on a :memory: open from rewriting the
    // operator's real config.json or emitting a banner into captured output.
    prevNoAutoMigrate = process.env.AKM_NO_AUTO_MIGRATE;
    process.env.AKM_NO_AUTO_MIGRATE = "1";

    // §8.1 / §8.5: force SQLite temp btrees in-memory so large FTS5/vec sorts on
    // a seeded :memory: corpus never spill to a file-backed temp the path-level
    // guard cannot see. The DB layer reads this flag in applyStandardPragmas.
    prevTempStore = process.env.AKM_TEST_TEMP_STORE_MEMORY;
    process.env.AKM_TEST_TEMP_STORE_MEMORY = "1";

    // Intercept every real on-disk SQLite open at the storage boundary.
    prevGuard = setOpenDatabaseGuard(realOpenGuard);

    // Un-seamed network = always impure. Throw rather than touch a real socket.
    prevFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new UnitImpureError(
        "UNIT_IMPURE_FETCH: a unit test called globalThis.fetch. Inject an " +
          "HttpClient (#664 Seam 1) so the code under test never opens a real " +
          "socket, or move this test to tests/integration/.",
      );
    }) as unknown as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = prevFetch;
    if (prevGuard) setOpenDatabaseGuard(prevGuard);
    else resetOpenDatabaseGuard();
    if (prevNoAutoMigrate === undefined) delete process.env.AKM_NO_AUTO_MIGRATE;
    else process.env.AKM_NO_AUTO_MIGRATE = prevNoAutoMigrate;
    if (prevTempStore === undefined) delete process.env.AKM_TEST_TEMP_STORE_MEMORY;
    else process.env.AKM_TEST_TEMP_STORE_MEMORY = prevTempStore;
  });
}
