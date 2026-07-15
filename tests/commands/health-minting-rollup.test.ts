// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Enrichment-vs-minting rollup pins (meta-review 05, DRIFT-5 refutation).
 *
 * The create-vs-update sensor already exists in proposals.metadata_json
 * (`backupContent` captured at apply time; `eligibilitySource` = lane) — the
 * rollup only derives the split so policy drift is visible in `akm health`
 * without a manual DB query. These tests pin the classification rules:
 * backupContent absent (or null) = minted; non-enrichment lanes appear in
 * byLane but not in the enrichment share; unattributed rows are excluded.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { computeEnrichmentMintingRollup } from "../../src/commands/health/metrics";
import { ENRICHMENT_LANES } from "../../src/commands/health/types";
import type { Database as AkmDatabase } from "../../src/storage/database";

const SINCE = "2026-01-01T00:00:00.000Z";
const UNTIL = "2026-12-31T00:00:00.000Z";
const IN_WINDOW = "2026-06-15T00:00:00.000Z";

let db: AkmDatabase;

beforeEach(() => {
  db = new Database(":memory:") as unknown as AkmDatabase;
  db.exec(`
    CREATE TABLE proposals (
      id               TEXT    PRIMARY KEY,
      stash_dir        TEXT    NOT NULL,
      ref              TEXT    NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'pending',
      source           TEXT    NOT NULL,
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      content          TEXT    NOT NULL DEFAULT '',
      frontmatter_json TEXT,
      metadata_json    TEXT    NOT NULL DEFAULT '{}'
    );
  `);
});

afterEach(() => {
  db.close();
});

let idCounter = 0;
function seedProposal(input: {
  status?: string;
  updatedAt?: string;
  lane?: string;
  backupContent?: string | null;
}): void {
  const metadata: Record<string, unknown> = {};
  if (input.lane !== undefined) metadata.eligibilitySource = input.lane;
  if (input.backupContent !== undefined) metadata.backupContent = input.backupContent;
  db.prepare(
    `INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at, metadata_json)
     VALUES (?, '/tmp/stash', ?, ?, 'reflect', ?, ?, ?)`,
  ).run(
    `p-${idCounter++}`,
    `knowledge:asset-${idCounter}`,
    input.status ?? "accepted",
    input.updatedAt ?? IN_WINDOW,
    input.updatedAt ?? IN_WINDOW,
    JSON.stringify(metadata),
  );
}

describe("computeEnrichmentMintingRollup", () => {
  test("splits minted (no backupContent) from updated per lane and computes the enrichment share", () => {
    seedProposal({ lane: "proactive", backupContent: "prior content" }); // updated
    seedProposal({ lane: "proactive", backupContent: "prior content" }); // updated
    seedProposal({ lane: "proactive" }); // minted — policy violation
    seedProposal({ lane: "extract" }); // minted, but extract is a minting lane

    const rollup = computeEnrichmentMintingRollup(db, SINCE, UNTIL);
    expect(rollup?.byLane.proactive).toEqual({ minted: 1, updated: 2 });
    expect(rollup?.byLane.extract).toEqual({ minted: 1, updated: 0 });
    // Share counts ONLY enrichment lanes: 1 minted / 3 decided.
    expect(rollup?.minted).toBe(1);
    expect(rollup?.updated).toBe(2);
    expect(rollup?.share).toBeCloseTo(1 / 3, 3); // roundRate rounds to 4 decimals
  });

  test("an explicit null backupContent classifies as minted (absence semantics)", () => {
    seedProposal({ lane: "high-salience", backupContent: null });
    const rollup = computeEnrichmentMintingRollup(db, SINCE, UNTIL);
    expect(rollup?.byLane["high-salience"]).toEqual({ minted: 1, updated: 0 });
  });

  test("a historical 'high-retrieval' lane (retired in Chunk 7) still rolls up in byLane but no longer counts toward the enrichment share", () => {
    // Chunk 7 (WI-7.2, R18/D13) deleted the P0-A high-retrieval fallback lane and
    // removed 'high-retrieval' from ENRICHMENT_LANES. Pre-existing proposal rows
    // persisted with that lane string still roll up per-lane (byLane covers every
    // lane seen in the data, unconditionally) but no longer contribute to the
    // top-level minted/updated/share aggregation, which sums ENRICHMENT_LANES only.
    seedProposal({ lane: "high-retrieval", backupContent: null });
    const rollup = computeEnrichmentMintingRollup(db, SINCE, UNTIL);
    expect(rollup?.byLane["high-retrieval"]).toEqual({ minted: 1, updated: 0 });
    expect(rollup?.minted).toBe(0);
    expect(rollup?.updated).toBe(0);
    expect(Number.isNaN(rollup?.share)).toBe(true);
  });

  test("excludes unattributed rows, non-accepted rows, and rows outside the window", () => {
    seedProposal({}); // no eligibilitySource (pre-Phase-6C) — excluded
    seedProposal({ lane: "proactive", status: "pending" }); // not accepted
    seedProposal({ lane: "proactive", updatedAt: "2025-01-01T00:00:00.000Z" }); // before window
    seedProposal({ lane: "proactive", updatedAt: "2027-01-01T00:00:00.000Z" }); // after window

    expect(computeEnrichmentMintingRollup(db, SINCE, UNTIL)).toBeUndefined();
  });

  test("share is NaN when only non-enrichment lanes decided", () => {
    seedProposal({ lane: "extract" });
    const rollup = computeEnrichmentMintingRollup(db, SINCE, UNTIL);
    expect(rollup).toBeDefined();
    expect(Number.isNaN(rollup?.share)).toBe(true);
  });

  test("fails open when the proposals table is absent", () => {
    const bare = new Database(":memory:") as unknown as AkmDatabase;
    try {
      expect(computeEnrichmentMintingRollup(bare, SINCE, UNTIL)).toBeUndefined();
    } finally {
      bare.close();
    }
  });

  test("the ratified enrichment lane set is pinned", () => {
    expect([...ENRICHMENT_LANES].sort()).toEqual(["high-salience", "proactive", "signal-delta"]);
  });
});
