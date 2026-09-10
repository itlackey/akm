// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954: `generateEmbeddingsForDb` must refuse to run against a
 * connection that already has an ambient transaction open. Before this guard,
 * `akm bundle update`'s coordinator ran the whole embedding phase inside its
 * own outer `BEGIN IMMEDIATE`, so every per-batch `db.transaction()` the
 * materializer opened nested as an unobservable SAVEPOINT — nothing durable,
 * nothing visible to a reader, and a SIGKILL mid-run lost every embedding of
 * the run instead of just the batch in flight (field report, #954 follow-up).
 *
 * This is a pure contract check on `db.inTransaction` — no real database is
 * opened, so this stays a unit test (AGENTS.md ORG-03..06 classification).
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config/config";
import { generateEmbeddingsForDb } from "../src/indexer/materialize-embeddings";
import type { Database } from "../src/storage/database";

describe("generateEmbeddingsForDb: ambient-transaction drift guard (#954)", () => {
  test("throws immediately when db.inTransaction is already true", async () => {
    const fakeDb = { inTransaction: true } as unknown as Database;
    const config: AkmConfig = { semanticSearchMode: "auto" };

    await expect(generateEmbeddingsForDb(fakeDb, config, () => {})).rejects.toThrow(/ambient transaction/i);
  });

  test("the guard fires before any config/db branching (even semanticSearchMode: off)", async () => {
    const fakeDb = { inTransaction: true } as unknown as Database;
    const config: AkmConfig = { semanticSearchMode: "off" };

    await expect(generateEmbeddingsForDb(fakeDb, config, () => {})).rejects.toThrow(/ambient transaction/i);
  });
});
