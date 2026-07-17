// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.6a — orphan-bearing state.db builder (chunk-0b, capture-only).
 *
 * Produces a `state.db` migrated through the FULL real migration chain (via
 * `src/core/state-db.ts#openStateDatabase` — never hand-written DDL) and then
 * seeds `asset_salience` / `asset_outcome` rows whose `asset_ref` names a
 * logical asset with NO on-disk file anywhere (an "orphan", anchors.md E.3:
 * "an old ref -> no live item ... an acknowledged steady state"), in all 4
 * concrete ref-spelling key shapes documented in anchors.md E.2:
 *
 *   {bare, origin-qualified} x {plain, .derived-twin}
 *
 * Also seeds a couple of NON-orphan (live) contrast rows keyed to refs that
 * match real assets shipped in the WI-0b.2 `tests/fixtures/stashes/all-types/`
 * fixture stash, so Chunk 8's quarantine logic (the `legacy_state` table it
 * builds) has both a positive (orphan -> quarantine) and negative (live ->
 * stays) case in one fixture.
 *
 * Deliberately does NOT create a `legacy_state` table (Chunk 8's to build,
 * anchors.md E.3) and does NOT resurrect `recombine_hypotheses` or
 * `asset_outcome.review_pressure` (both dropped by migration
 * `018-drop-dead-lane-schema` — brief trap list #6).
 *
 * This module is a deterministic BUILDER (code), not a committed binary .db
 * blob — Chunk 8 imports and runs it directly against the (then-current) real
 * migration chain.
 */

import { openStateDatabase } from "../../../src/core/state-db";
import type { Database } from "../../../src/storage/database";
import { FIXTURE_BASE_EPOCH_MS } from "./fixed-values";
import { insertAssetOutcomeRow, insertAssetSalienceRow } from "./seed-rows";

/** Origin qualifier used for the origin-qualified ref shapes below. Matches
 *  the real `sourceName` value `rekeyStateDbForMove` (mv-cli.ts:898-967) uses
 *  for primary-stash-sourced moves (anchors.md E.2). */
const ORPHAN_ORIGIN = "stash";
const ORPHAN_TASK_NAME = "ghost-task-orphan";
const ORPHAN_MEMORY_NAME = "ghost-memory-orphan";

/**
 * The 4 concrete orphan ref key shapes (anchors.md E.2, D0b-2): `.derived` is
 * an orthogonal modifier bit applied to either a bare or an origin-qualified
 * spelling, not a 3rd flat category. None of these names resolve to any file
 * under any fixture stash in this repo — that absence is what makes them
 * orphans.
 */
export const ORPHAN_REFS = {
  bare: `task:${ORPHAN_TASK_NAME}`,
  originQualified: `${ORPHAN_ORIGIN}//task:${ORPHAN_TASK_NAME}`,
  bareDerived: `memory:${ORPHAN_MEMORY_NAME}.derived`,
  originQualifiedDerived: `${ORPHAN_ORIGIN}//memory:${ORPHAN_MEMORY_NAME}.derived`,
} as const;

/**
 * Non-orphan contrast refs: bare refs matching real assets shipped in
 * `tests/fixtures/stashes/all-types/` (skills/all-types-skill/SKILL.md,
 * memories/all-types-memory.md). This builder only produces a state.db (no
 * stash tree) — a consumer that pairs this state.db with the all-types stash
 * gets genuinely live rows here; used bare (no origin) to match how a
 * primary-stash asset's ref is actually minted (`makeAssetRef(type, name)`
 * with no registryId — src/indexer/search/db-search.ts:95/97).
 */
export const LIVE_CONTRAST_REFS = {
  skill: "skill:all-types-skill",
  memory: "memory:all-types-memory",
} as const;

/**
 * Build the orphan-bearing state.db fixture at `dbPath`. Applies the full
 * real migration chain via `openStateDatabase`, then seeds the 4-shape
 * orphan rows plus 2 live-contrast rows into both `asset_salience` and
 * `asset_outcome`. Every value is a fixed literal (no `Date.now()` /
 * `Math.random()`) so the fixture is byte/row-stable across builds.
 *
 * Requires the caller's environment to have `XDG_DATA_HOME` (or
 * `AKM_DATA_DIR`) set under `bun test` — `openStateDatabase` resolves the
 * canonical path unconditionally even when `dbPath` overrides it (test-
 * isolation guard in `src/core/paths.ts#getDataDir`).
 */
export function buildOrphanBearingStateDb(dbPath: string): void {
  const db = openStateDatabase(dbPath);
  try {
    seedOrphanRows(db);
    seedLiveContrastRows(db);
  } finally {
    db.close();
  }
}

function seedOrphanRows(db: Database): void {
  const refs = Object.values(ORPHAN_REFS);
  refs.forEach((assetRef, i) => {
    const updatedAt = FIXTURE_BASE_EPOCH_MS + i * 1000;
    insertAssetSalienceRow(db, {
      assetRef,
      encodingSalience: 0.5,
      outcomeSalience: 0.1 * (i + 1),
      retrievalSalience: 0.2 * (i + 1),
      rankScore: 0.05 * (i + 1),
      consecutiveNoOps: i,
      updatedAt,
      homeostaticDemotedAt: i % 2 === 0 ? updatedAt - 500 : null,
      encodingSource: i % 2 === 0 ? "type-stub" : "content",
    });
    insertAssetOutcomeRow(db, {
      assetRef,
      lastRetrievedAt: updatedAt - 200,
      retrievalCount: i + 1,
      expectedRetrievalRate: 0.3 * (i + 1),
      negativeFeedbackCount: i,
      acceptedChangeCount: i,
      outcomeScore: -0.1 * (i + 1),
      updatedAt,
    });
  });
}

function seedLiveContrastRows(db: Database): void {
  const refs = Object.values(LIVE_CONTRAST_REFS);
  refs.forEach((assetRef, i) => {
    const updatedAt = FIXTURE_BASE_EPOCH_MS + 100_000 + i * 1000;
    insertAssetSalienceRow(db, {
      assetRef,
      encodingSalience: 0.8,
      outcomeSalience: 0.6,
      retrievalSalience: 0.7,
      rankScore: 0.75,
      consecutiveNoOps: 0,
      updatedAt,
      homeostaticDemotedAt: null,
      encodingSource: "content",
    });
    insertAssetOutcomeRow(db, {
      assetRef,
      lastRetrievedAt: updatedAt - 200,
      retrievalCount: 10 + i,
      expectedRetrievalRate: 1.2,
      negativeFeedbackCount: 0,
      acceptedChangeCount: 1,
      outcomeScore: 0.9,
      updatedAt,
    });
  });
}
