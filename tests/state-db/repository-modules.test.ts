// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Direct-isolation coverage for the pure helpers that moved out of the old
 * core/state-db god-module into per-domain repositories under
 * src/storage/repositories. These exercise the relocated functions from their
 * NEW module paths with ZERO database — the whole point of the split was making
 * these unit-testable without an open connection.
 */

import { describe, expect, test } from "bun:test";
import { blobToEmbedding, embeddingToBlob } from "../../src/storage/repositories/embeddings-repository";
import { type EventRow, eventRowToEnvelope } from "../../src/storage/repositories/events-repository";
import type { ExtractedSessionRow } from "../../src/storage/repositories/extract-sessions-repository";
import { shouldSkipAlreadyExtractedSession } from "../../src/storage/repositories/extract-sessions-repository";

describe("events-repository.eventRowToEnvelope (pure, no DB)", () => {
  test("maps columns and omits empty metadata + null ref", () => {
    const row: EventRow = {
      id: 7,
      event_type: "improve_completed",
      ts: "2026-07-03T00:00:00Z",
      ref: null,
      metadata_json: "{}",
    };
    expect(eventRowToEnvelope(row)).toEqual({
      schemaVersion: 1,
      id: 7,
      ts: "2026-07-03T00:00:00Z",
      eventType: "improve_completed",
    });
  });

  test("attaches non-empty metadata and ref; tolerates corrupt JSON", () => {
    const withMeta: EventRow = { id: 1, event_type: "x", ts: "t", ref: "memories/a", metadata_json: '{"k":1}' };
    expect(eventRowToEnvelope(withMeta)).toEqual({
      schemaVersion: 1,
      id: 1,
      ts: "t",
      eventType: "x",
      ref: "memories/a",
      metadata: { k: 1 },
    });
    const corrupt: EventRow = { id: 2, event_type: "x", ts: "t", ref: null, metadata_json: "{not json" };
    expect(eventRowToEnvelope(corrupt).metadata).toBeUndefined();
  });
});

describe("embeddings-repository blob codec (pure, no DB)", () => {
  test("embeddingToBlob → blobToEmbedding round-trips as Float32", () => {
    const vec = [0, 1, -1, 0.5, 1234.5];
    const roundTripped = blobToEmbedding(embeddingToBlob(vec));
    expect(roundTripped).toHaveLength(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(roundTripped[i]).toBeCloseTo(vec[i]!, 3);
    }
  });
});

describe("extract-sessions-repository.shouldSkipAlreadyExtractedSession (pure, no DB)", () => {
  const base: ExtractedSessionRow = {
    harness: "opencode",
    session_id: "s1",
    processed_at: "2026-07-03T00:00:00Z",
    session_ended_at: null,
    outcome: "candidates_queued",
    candidate_count: 0,
    proposal_count: 0,
    rationale: null,
    source_run: null,
    metadata_json: "{}",
    content_hash: "H",
  };

  test("no prior row → process (false)", () => {
    expect(shouldSkipAlreadyExtractedSession(undefined, "H")).toBe(false);
  });
  test("null prior hash → backfill once (false)", () => {
    expect(shouldSkipAlreadyExtractedSession({ ...base, content_hash: null }, "H")).toBe(false);
  });
  test("equal hash → skip (true); differing hash → reprocess (false)", () => {
    expect(shouldSkipAlreadyExtractedSession(base, "H")).toBe(true);
    expect(shouldSkipAlreadyExtractedSession(base, "H2")).toBe(false);
  });
});
