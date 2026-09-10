// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for two enrichment fixes (round 2 — `enrich.ts`):
 *
 *  - N1: `applyEnrichmentToEntry` re-verifies the live `entries` row (by id,
 *    against the queued `blobHash`/`itemRef`) before writing, so a concurrent
 *    reconcile that renames or deletes the row while the LLM round trip
 *    (`enrichReconciledEntries`) is in flight cannot resurrect a ghost row or
 *    clobber a renamed row's `entry_units` — and a genuine write failure is
 *    counted/surfaced rather than silently swallowed by `concurrentMap`
 *    (`core/concurrent.ts`: a thrown callback's slot just stays `undefined`).
 *  - N2: `reconcileRoots({ insideBorrowedTransaction: true })` skips the
 *    enrichment pass entirely — mirroring how the embedding drain is already
 *    skipped inside `akm bundle update`'s borrowed `BEGIN IMMEDIATE`
 *    (`indexer.ts`'s `deferredUpdateTransaction`) — so no LLM call is made
 *    and the transaction is never elongated across a provider round trip.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { enrichReconciledEntries, type MetadataEnrichmentCandidate } from "../../../src/indexer/enrich";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { reconcileRoots } from "../../../src/indexer/reconcile";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { replaceEntryUnits } from "../../../src/storage/repositories/units-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let db: Database;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  db = openIndexDatabase(getDbPath());
});

afterEach(() => {
  closeDatabase(db);
  storage.cleanup();
});

function configureLlm(): void {
  saveConfig({
    semanticSearchMode: "off",
    engines: {
      index: { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "test-model" },
    },
    index: { defaults: { engine: "index" }, metadataEnhance: { enabled: true } },
  });
}

function llmSuccessResponse(): Response {
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            description: "Enriched thing",
            tags: ["enriched"],
            searchHints: ["find the enriched thing"],
          }),
        },
      },
    ],
  });
}

function writeThing(name: string): string {
  const filePath = path.join(storage.stashDir, "knowledge", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `# ${name}\n\nBody prose about ${name}.\n`, "utf8");
  return filePath;
}

/** Seed a live `entries` row (+ a stand-in `entry_units` row) and the matching candidate `enrichReconciledEntries` would have queued for it. */
function seedCandidate(name: string, filePath: string, blobHash: string): MetadataEnrichmentCandidate {
  const entry: IndexDocument = { type: "knowledge", name, quality: "generated" };
  const provenance = deriveEntryProvenance(
    { bundleId: "stash", componentId: "stash", adapterId: "akm" },
    "knowledge",
    name,
  );
  const entryId = upsertEntry(db, filePath, entry, "", provenance, blobHash);
  replaceEntryUnits(db, entryId, [{ ordinal: 0, fragmentId: null, hash: "original-unit-hash" }]);
  return { entryId, blobHash, entry, filePath, provenance };
}

function cacheRowCount(blobHash: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache WHERE asset_ref = ?").get(blobHash) as {
      cnt: number;
    }
  ).cnt;
}

// ── N1: stale-identity guard ────────────────────────────────────────────────

test("a rename in flight during enrichment is not clobbered: no ghost row, no reverted entry_units", async () => {
  configureLlm();
  const filePath = writeThing("thing");
  const candidate = seedCandidate("thing", filePath, "blob-thing");

  const newFilePath = writeThing("thing-renamed");
  const newItemRef = "stash//knowledge/thing-renamed";
  const newContentHash = "blob-thing-renamed";

  const result = await withMockedFetch(
    () => enrichReconciledEntries(db, loadConfig(), [candidate], 4000),
    () => {
      // Simulate the concurrent reconcile landing WHILE the LLM call above is
      // "in flight": a same-id rename (`repointEntry`'s own UPDATE shape) to
      // a new item_ref/path/content_hash, plus fresh entry_units for the new
      // identity — exactly what a real rename commits mid-flight.
      db.prepare(
        "UPDATE entries SET item_ref = ?, file_path = ?, content_hash = ?, document_json = ? WHERE id = ?",
      ).run(
        newItemRef,
        newFilePath,
        newContentHash,
        JSON.stringify({ type: "knowledge", name: "thing-renamed", quality: "generated" }),
        candidate.entryId,
      );
      replaceEntryUnits(db, candidate.entryId, [{ ordinal: 0, fragmentId: null, hash: "renamed-unit-hash" }]);
      return llmSuccessResponse();
    },
  );

  // The outcome is reported, not silently lost: counted as skipped, not enriched.
  expect(result.enriched).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.failed).toBe(0);

  // No ghost row under the stale item_ref this candidate was queued with.
  const ghostCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM entries WHERE item_ref = ?").get(candidate.provenance.itemRef) as {
      cnt: number;
    }
  ).cnt;
  expect(ghostCount).toBe(0);
  const totalEntries = (db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as { cnt: number }).cnt;
  expect(totalEntries).toBe(1);

  // The live renamed row is untouched by the enrichment write.
  const live = db
    .prepare("SELECT item_ref AS itemRef, file_path AS filePath, content_hash AS contentHash FROM entries WHERE id = ?")
    .get(candidate.entryId) as { itemRef: string; filePath: string; contentHash: string };
  expect(live.itemRef).toBe(newItemRef);
  expect(live.filePath).toBe(newFilePath);
  expect(live.contentHash).toBe(newContentHash);

  // entry_units were NOT reverted to the old identity's unit hash.
  const units = db
    .prepare("SELECT unit_hash AS hash FROM entry_units WHERE entry_id = ? ORDER BY ordinal")
    .all(candidate.entryId) as { hash: string }[];
  expect(units.map((u) => u.hash)).toEqual(["renamed-unit-hash"]);

  // The provider result is still cached under the queued content hash — a
  // later run over the SAME content applies it with no new provider call.
  expect(cacheRowCount(candidate.blobHash)).toBe(1);
});

test("a delete in flight during enrichment is not resurrected and raises no error", async () => {
  configureLlm();
  const filePath = writeThing("thing");
  const candidate = seedCandidate("thing", filePath, "blob-thing");

  const result = await withMockedFetch(
    () => enrichReconciledEntries(db, loadConfig(), [candidate], 4000),
    () => {
      // Simulate a concurrent reconcile deleting the file's row entirely
      // (e.g. the delete-instead-of-rename variant) while the LLM call is
      // "in flight". `entry_units` cascades with it (ON DELETE CASCADE).
      db.prepare("DELETE FROM entries WHERE id = ?").run(candidate.entryId);
      return llmSuccessResponse();
    },
  );

  // No resurrection, and the outcome is reported rather than lost.
  expect(result.enriched).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.failed).toBe(0);

  const totalEntries = (db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as { cnt: number }).cnt;
  expect(totalEntries).toBe(0);
  const ghostCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM entries WHERE item_ref = ?").get(candidate.provenance.itemRef) as {
      cnt: number;
    }
  ).cnt;
  expect(ghostCount).toBe(0);

  // The provider result is still cached under the queued content hash.
  expect(cacheRowCount(candidate.blobHash)).toBe(1);
});

test("a genuine write failure after a successful provider call is counted, not silently swallowed", async () => {
  configureLlm();
  const filePath = writeThing("thing");
  const candidate = seedCandidate("thing", filePath, "blob-thing");

  // maxChars <= 0 makes `deriveUnits` throw a RangeError once the live-row
  // identity check passes (no rename/delete race here) — a real write
  // failure distinct from the stale-identity no-op above. `concurrentMap`
  // would otherwise swallow this into an undefined slot with no record.
  const result = await withMockedFetch(
    () => enrichReconciledEntries(db, loadConfig(), [candidate], 0),
    () => llmSuccessResponse(),
  );

  expect(result.enriched).toBe(0);
  expect(result.skipped).toBe(0);
  expect(result.failed).toBe(1);

  // The write transaction rolled back: the entry is untouched (still
  // "generated", not "enriched").
  const row = db.prepare("SELECT document_json AS json FROM entries WHERE id = ?").get(candidate.entryId) as {
    json: string;
  };
  expect((JSON.parse(row.json) as IndexDocument).quality).toBe("generated");

  // The provider result is still cached — only the DB write failed.
  expect(cacheRowCount(candidate.blobHash)).toBe(1);
});

// ── N2: skip inside a borrowed update transaction ───────────────────────────

test("reconcileRoots skips enrichment entirely when insideBorrowedTransaction is set", async () => {
  configureLlm();
  writeThing("thing");

  let providerCalls = 0;
  const counts = await withMockedFetch(
    () =>
      reconcileRoots(db, [{ path: storage.stashDir, bundleId: "stash" }], {
        insideBorrowedTransaction: true,
      }),
    () => {
      providerCalls++;
      throw new Error("enrichment must not run inside a borrowed update transaction");
    },
  );

  // No LLM call at all — never awaited across the (simulated) borrowed
  // transaction, so it can never elongate it.
  expect(providerCalls).toBe(0);
  expect(counts.added).toBe(1);

  const row = db
    .prepare("SELECT document_json AS json FROM entries WHERE file_path = ?")
    .get(path.join(storage.stashDir, "knowledge", "thing.md")) as { json: string };
  expect((JSON.parse(row.json) as IndexDocument).quality).toBe("generated");

  const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
  expect(cacheCount).toBe(0);
});

test("an ordinary (non-borrowed) reconcileRoots run still enriches normally", async () => {
  configureLlm();
  writeThing("thing");

  const counts = await withMockedFetch(
    () => reconcileRoots(db, [{ path: storage.stashDir, bundleId: "stash" }]),
    () => llmSuccessResponse(),
  );
  expect(counts.added).toBe(1);

  const row = db
    .prepare("SELECT document_json AS json FROM entries WHERE file_path = ?")
    .get(path.join(storage.stashDir, "knowledge", "thing.md")) as { json: string };
  const entry = JSON.parse(row.json) as IndexDocument;
  expect(entry.quality).toBe("enriched");
  expect(entry.description).toBe("Enriched thing");

  const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
  expect(cacheCount).toBe(1);
});
