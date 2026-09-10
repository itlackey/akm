// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `reclassifyIndexDbContention` (field follow-up to #956, F1) — the
 * `akmIndex` boundary's reclassification of a contention-shaped raw SQLite
 * error into `TransientError("INDEX_DB_CONTENDED")`, mirroring
 * `STATE_DB_CONTENDED`'s precedent
 * (tests/integration/state-db/with-immediate-transaction.test.ts's
 * exhaustion/passthrough pair). Pure unit test: synthetic errors only, no
 * real database opened here — the genuine two-connection contention case is
 * covered by
 * tests/integration/commands/sources/index-db-contention.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { ConfigError, TransientError } from "../../src/core/errors";
import { reclassifyIndexDbContention } from "../../src/indexer/indexer";

describe("reclassifyIndexDbContention", () => {
  test("a contention-shaped raw driver error reclassifies to INDEX_DB_CONTENDED with the original as cause", () => {
    const raw = new Error("database is locked");
    (raw as Error & { code?: string }).code = "SQLITE_BUSY";

    const result = reclassifyIndexDbContention(raw);

    expect(result).toBeInstanceOf(TransientError);
    expect((result as TransientError).code).toBe("INDEX_DB_CONTENDED");
    expect((result as Error).message).toContain("akm's index database is busy");
    expect((result as Error).message).toContain("retry shortly");
    expect((result as Error).cause).toBe(raw);
    // Falls back to the code-derived TRANSIENT_HINTS entry (no rebuild lock
    // held in this synthetic case, so the message carries no holder pid).
    expect((result as TransientError).hint()).toContain("--skip-if-locked");
  });

  test("a non-contention error is rethrown exactly as raised, never reclassified", () => {
    const raw = new Error("disk full");
    expect(reclassifyIndexDbContention(raw)).toBe(raw);
  });

  test("an already-classified akm error is never re-wrapped, even if its text happens to mention locking", () => {
    const already = new ConfigError("some unrelated config problem mentioning database is locked, coincidentally");
    expect(reclassifyIndexDbContention(already)).toBe(already);
  });

  test("a message-only contention shape (no .code, 'database table is locked') also reclassifies", () => {
    const raw = new Error("database table is locked");
    const result = reclassifyIndexDbContention(raw);
    expect(result).toBeInstanceOf(TransientError);
    expect((result as TransientError).code).toBe("INDEX_DB_CONTENDED");
  });
});
