// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.6b — rc-train FROM-state builder (chunk-0b, capture-only).
 *
 * Produces the "shipped rc-train layout" (anchors.md E.4, plan §3.4): the DB/
 * config shape of a real user who has been running an akm 0.9.0-rc.x build,
 * NOT a synthetic 0.8.0 tree. Concretely, under `dir`:
 *
 *   - `state.db`    — migrated through the FULL real migration chain (via
 *                      `src/core/state-db.ts#openStateDatabase`; never hand-
 *                      written DDL), seeded with a small amount of realistic
 *                      live state (asset_salience/asset_outcome/events rows
 *                      keyed to refs matching real assets in the WI-0b.2
 *                      `tests/fixtures/stashes/all-types/` fixture stash).
 *   - `workflow.db` — created the real way `src/workflows/db.ts` creates it
 *                      (`openWorkflowDatabase`), present per anchors.md E.4
 *                      ("workflow.db present" — `src/workflows/` still writes
 *                      it pre-cutover).
 *   - NO `vault` artifacts anywhere under `dir` (already true structurally:
 *      this builder never creates a stash tree, and `vault` was removed from
 *      `ASSET_SPECS_INTERNAL` pre-0.9.0 per anchors.md E.4).
 *
 * DB-only (no stash tree copied) per the WI-0b.6 brief's explicit escape
 * hatch ("reuse tests/fixtures/stashes/all-types or minimal if a stash tree
 * is required, else DB-only is fine") — the live-state refs below are chosen
 * to match all-types' real asset names for documentation value, but no files
 * are written to back them; a consumer that wants a literal on-disk twin can
 * pair this builder's output directory with a copy of that stash.
 *
 * This module is a deterministic BUILDER (code), not a committed binary .db
 * blob — Chunk 8 imports and runs its cutover against this builder's output.
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "../../../src/storage/database";
import { insertEvent } from "../../../src/storage/repositories/events-repository";
import { openWorkflowDatabase } from "../../../src/workflows/db";
import { FIXTURE_BASE_EPOCH_MS } from "./fixed-values";
import { insertAssetOutcomeRow, insertAssetSalienceRow, openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "./seed-rows";

/**
 * The migration id this fixture's state.db is captured at: the last state
 * migration BEFORE the WI-8.2 three-DB cutover (`020-three-db-cutover`) —
 * `019-proposal-fingerprints`. This is the true shipped rc-train "FROM-state"
 * pre-cutover ceiling (plan §3.4): a real rc-train install carried exactly this
 * ledger before running `migrate apply` into the cutover.
 *
 * WI-8.2: the fixture is now built EXPLICITLY at this ceiling (via
 * `openStateDbAtCeiling`), not through `openStateDatabase` — the latter always
 * applies the full live chain, which now includes migration 020, so it can no
 * longer produce a genuine pre-cutover snapshot. The migrate-apply flow under
 * test is what applies 020 + runs the cutover data step.
 *
 * The migration-fixtures smoke test cross-checks this literal against
 * `STATE_MIGRATIONS.at(-2)!.id` (the tip is now the cutover, 020): a later chunk
 * appending a NEW migration past the cutover shifts at(-2) forward and fails the
 * check loudly (a signal to re-capture this fixture under review) instead of
 * silently drifting.
 */
export const RC_TRAIN_MIGRATION_CEILING = PRE_CUTOVER_STATE_CEILING;

/**
 * Live-state refs seeded into rc-train's state.db, matching real asset names
 * in `tests/fixtures/stashes/all-types/` (bare refs — no origin — matching
 * how a primary-stash asset ref is actually minted, `makeAssetRef(type,
 * name)` with no registryId).
 */
export const RC_TRAIN_LIVE_REFS = {
  skill: "skill:all-types-skill",
  memory: "memory:all-types-memory",
} as const;

export interface RcTrainFromStatePaths {
  stateDbPath: string;
  workflowDbPath: string;
}

/** `<dir>/state.db` and `<dir>/workflow.db` — mirrors the real `<dataDir>/
 *  state.db` + `<dataDir>/workflow.db` layout (`src/core/paths.ts`
 *  `getStateDbPathInDataDir` / `getWorkflowDbPath`). */
export function rcTrainFromStatePaths(dir: string): RcTrainFromStatePaths {
  return { stateDbPath: path.join(dir, "state.db"), workflowDbPath: path.join(dir, "workflow.db") };
}

/**
 * Build the rc-train FROM-state fixture under `dir`. Every value written is
 * a fixed literal (no `Date.now()` / `Math.random()`) so the fixture is
 * byte/row-stable across builds.
 *
 * Requires the caller's environment to have `XDG_DATA_HOME` (or
 * `AKM_DATA_DIR`) set under `bun test` — `openWorkflowDatabase` (below) resolves
 * the canonical workflow.db path unconditionally even when an explicit path
 * overrides it (test-isolation guard in `src/core/paths.ts#getDataDir`).
 */
export function buildRcTrainFromState(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const { stateDbPath, workflowDbPath } = rcTrainFromStatePaths(dir);

  const stateDb = openStateDbAtCeiling(stateDbPath, RC_TRAIN_MIGRATION_CEILING);
  try {
    seedLiveState(stateDb);
  } finally {
    stateDb.close();
  }

  // Created the real way src/workflows/db.ts creates workflow.db: the base
  // schema + its own migration chain via openWorkflowDatabase. No rows are
  // seeded — "workflow.db present" (anchors.md E.4) only requires the file
  // and its schema to exist pre-cutover, not populated run history.
  const workflowDb = openWorkflowDatabase(workflowDbPath);
  workflowDb.close();
}

function seedLiveState(db: Database): void {
  const refs = Object.values(RC_TRAIN_LIVE_REFS);
  refs.forEach((assetRef, i) => {
    const updatedAt = FIXTURE_BASE_EPOCH_MS + i * 1000;
    insertAssetSalienceRow(db, {
      assetRef,
      encodingSalience: 0.6,
      outcomeSalience: 0.4,
      retrievalSalience: 0.5,
      rankScore: 0.55,
      consecutiveNoOps: 0,
      updatedAt,
      homeostaticDemotedAt: null,
      encodingSource: "content",
    });
    insertAssetOutcomeRow(db, {
      assetRef,
      lastRetrievedAt: updatedAt - 200,
      retrievalCount: 5 + i,
      expectedRetrievalRate: 0.9,
      negativeFeedbackCount: 0,
      acceptedChangeCount: 0,
      outcomeScore: 0.4,
      updatedAt,
    });
    insertEvent(db, {
      eventType: "show",
      ts: new Date(FIXTURE_BASE_EPOCH_MS + i * 1000).toISOString(),
      ref: assetRef,
      metadata: { type: assetRef.split(":")[0], name: assetRef.split(":")[1] },
    });
  });
}
