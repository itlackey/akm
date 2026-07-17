// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.7a -- seeded generator for the re-key merge property-test substrate
 * (chunk-0b, capture-only; Chunk 8 is the consumer -- anchors.md E.5).
 *
 * `generateRekeyState(seed, opts?)` builds a REAL state.db (via
 * `src/core/state-db.ts#openStateDatabase` -- the real migration runner,
 * never hand-written DDL, per the chunk-0b brief's hard constraint) and seeds
 * it with randomized rows across the 4 concrete key shapes (anchors.md E.2 /
 * D0b-2: `{bare, origin-qualified} x {plain, .derived-twin}`) for N logical
 * assets, across the tables enumerated below. Every value written --
 * timestamps, field values, row counts, which key shapes are present -- is a
 * pure deterministic function of `seed` (via the `mulberry32` PRNG in
 * `rekey-prng.ts`), so the same seed produces byte-identical rows on every
 * call (`Math.random()`/`Date.now()`/`new Date()` never appear here).
 *
 * ## Table coverage (enumerated from `src/core/state/migrations.ts` at this
 * capture HEAD -- see the WI-0b.7 report for the full table census):
 *
 *   - `asset_salience` (migration 009, migrations.ts:509-517, PK `asset_ref`)
 *     and `asset_outcome` (migration 010, migrations.ts:557-567, PK
 *     `asset_ref`) -- the two tables `rekeyStateDbForMove` itself re-keys
 *     (mv-cli.ts:927). SCALAR tables: exactly one row per ref; a collision
 *     (two spellings both present) must MERGE via most-recently-updated-wins
 *     (invariant 3), not just carry both rows forward.
 *   - `events` (migration 001, migrations.ts:45-51, nullable `ref`) and
 *     `proposals` (migration 001, migrations.ts:97-108, NOT NULL `ref`) --
 *     the "event/proposal tables keyed by asset_ref" the WI-0b.7 brief names
 *     explicitly. EVENT-SHAPED tables: MANY rows may share one ref; a
 *     collision must carry every row from every spelling forward under the
 *     canonical ref with NO row dropped or duplicated (invariant 2) -- no
 *     merge, since there is no PK collision to resolve.
 *
 * Other ref-keyed state.db tables exist (`task_history.target_ref`,
 * migrations.ts:158; `proposal_fingerprints.ref`, migrations.ts:832;
 * `canary_queries.anchor_ref`, migrations.ts:745) but are deliberately OUT of
 * this generator's covered set: `task_history`/`proposal_fingerprints` are
 * structurally identical event-shaped tables (the same `UPDATE ... SET ref =
 * ?` re-key op Chunk 8 would apply generalizes trivially once needed) and
 * `canary_queries.anchor_ref` backs a "minted once, never auto-refreshed"
 * canary set (migrations.ts:726-729) that is arguably NOT meant to track a
 * renamed asset at all -- re-keying it is a Chunk-8 design question, not a
 * generator gap. See the WI-0b.7 report for the full citation table.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import type { Database } from "../../../src/storage/database";
import { insertEvent } from "../../../src/storage/repositories/events-repository";
import { FIXTURE_BASE_EPOCH_MS } from "./fixed-values";
import {
  bareRef,
  type LogicalAssetKey,
  type LogicalAssetSpec,
  qualifiedRef,
  type RekeyModel,
  type SpellingPattern,
} from "./rekey-model";
import { chance, mulberry32, pick, type Rng } from "./rekey-prng";
import { insertAssetOutcomeRow, insertAssetSalienceRow } from "./seed-rows";

/** Fixed, deterministic candidate origins a generated db's logical assets are drawn from (cycled by index, never randomized in count/order). */
const ORIGIN_NAMES = ["stash", "registry-alpha", "local"] as const;

/** Fixed, deterministic candidate asset types a generated db's logical assets are drawn from. */
const ASSET_TYPES = ["skill", "memory", "task", "knowledge", "agent", "script"] as const;

const DEFAULT_ASSET_COUNT = 14;
const DEFAULT_ORIGIN_COUNT = 3;

export interface GenerateRekeyStateOptions {
  /** Path to write the generated state.db to. Defaults to a fresh temp dir (caller owns cleanup of a caller-supplied path; the default path's parent dir is NOT auto-cleaned -- pass an explicit path under a test's own managed temp dir when cleanup matters). */
  dbPath?: string;
  /** Number of base (non-derived) logical assets to seed. Default 14 -- enough to exercise every (pattern x origin x type) combination at least once while staying fast across 50-100 smoke seeds. */
  assetCount?: number;
  /** Number of distinct origins to cycle through (capped at `ORIGIN_NAMES.length`). Default 3. */
  originCount?: number;
}

export interface GeneratedRekeyState {
  readonly seed: number;
  readonly dbPath: string;
  readonly model: RekeyModel;
}

/**
 * Build a deterministic, randomized state.db for `seed` and return its path
 * plus the ground-truth model describing every logical asset seeded into it.
 * Applies the FULL real migration chain via `openStateDatabase` -- no
 * hand-written DDL.
 *
 * Requires the caller's environment to have `XDG_DATA_HOME`/`AKM_DATA_DIR`
 * set under `bun test` (same `openStateDatabase` test-isolation guard
 * WI-0b.6's builders document -- `src/core/paths.ts#getDataDir`).
 */
export function generateRekeyState(seed: number, opts: GenerateRekeyStateOptions = {}): GeneratedRekeyState {
  const dbPath = opts.dbPath ?? defaultDbPath(seed);
  const model = buildModel(seed, opts);

  const db = openStateDatabase(dbPath);
  try {
    seedModel(db, model);
  } finally {
    db.close();
  }

  return { seed, dbPath, model };
}

function defaultDbPath(seed: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-rekey-gen-${seed}-`));
  return path.join(dir, "state.db");
}

// ── Model construction (pure, deterministic) ────────────────────────────────

function buildModel(seed: number, opts: GenerateRekeyStateOptions): RekeyModel {
  const rng = mulberry32(seed);
  const assetCount = opts.assetCount ?? DEFAULT_ASSET_COUNT;
  const originCount = Math.min(opts.originCount ?? DEFAULT_ORIGIN_COUNT, ORIGIN_NAMES.length);
  const origins = ORIGIN_NAMES.slice(0, Math.max(1, originCount));

  const assets: LogicalAssetSpec[] = [];
  for (let i = 0; i < assetCount; i++) {
    const origin = origins[i % origins.length] as string;
    const type = ASSET_TYPES[i % ASSET_TYPES.length] as string;
    const name = `asset-${i}`;

    // i === 0 is a FORCED collision (qualified spelling wins) so the smoke
    // test's discrimination proof (naive clobber fails invariant 3) holds
    // deterministically on EVERY seed, not just probabilistically.
    const plainForced = i === 0 ? ({ pattern: "collision", winner: "qualified" } as const) : undefined;
    assets.push(buildAssetSpec(rng, i, { origin, type, name, derived: false }, plainForced));

    // Every 3rd base asset also gets an independent .derived-twin lineage
    // (a SEPARATE row, never merged with the plain asset -- anchors.md E.2).
    // The derived twin of i === 0 is ALSO a forced collision (bare wins this
    // time) so both collision directions are proven on every seed.
    if (i % 3 === 0) {
      const derivedForced = i === 0 ? ({ pattern: "collision", winner: "bare" } as const) : undefined;
      assets.push(buildAssetSpec(rng, i, { origin, type, name, derived: true }, derivedForced));
    }
  }

  return { seed, assets };
}

function buildAssetSpec(
  rng: Rng,
  i: number,
  key: LogicalAssetKey,
  forced?: { pattern: Extract<SpellingPattern, "collision">; winner: "bare" | "qualified" },
): LogicalAssetSpec {
  const pattern: SpellingPattern = forced?.pattern ?? pickPattern(rng);
  const collisionWinner =
    pattern === "collision" ? (forced?.winner ?? (chance(rng, 0.5) ? "bare" : "qualified")) : undefined;

  const base = FIXTURE_BASE_EPOCH_MS + i * 10_000 + (key.derived ? 5_000_000 : 0);
  let bareUpdatedAt = base + 1_000;
  let qualifiedUpdatedAt = base + 2_000;
  if (pattern === "collision") {
    if (collisionWinner === "bare") {
      bareUpdatedAt = base + 9_000;
      qualifiedUpdatedAt = base + 1_000;
    } else {
      bareUpdatedAt = base + 1_000;
      qualifiedUpdatedAt = base + 9_000;
    }
  }

  const bareEventRowCount = pattern === "qualifiedOnly" ? 0 : 1 + (i % 3);
  const qualifiedEventRowCount = pattern === "bareOnly" ? 0 : 1 + ((i + 2) % 3);

  return {
    key,
    pattern,
    collisionWinner,
    bareUpdatedAt,
    qualifiedUpdatedAt,
    bareEventRowCount,
    qualifiedEventRowCount,
  };
}

/** Weighted so collisions (the load-bearing case) are common without being universal -- bareOnly/qualifiedOnly assets exercise the plain-rename no-op paths. */
function pickPattern(rng: Rng): SpellingPattern {
  return pick(rng, ["bareOnly", "qualifiedOnly", "collision", "collision"] as const);
}

// ── Row seeding (writes to the real, already-migrated db) ──────────────────

function seedModel(db: Database, model: RekeyModel): void {
  model.assets.forEach((asset, i) => {
    seedScalarRows(db, asset, i);
    seedEventRows(db, asset, i);
    seedProposalRows(db, asset, i);
  });
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function seedScalarRows(db: Database, asset: LogicalAssetSpec, i: number): void {
  const d = asset.key.derived ? 1 : 0;
  if (asset.pattern !== "qualifiedOnly") {
    insertAssetSalienceRow(db, {
      assetRef: bareRef(asset.key),
      encodingSalience: round4(0.1 + 0.01 * i + 0.02 * d),
      outcomeSalience: round4(0.2 + 0.01 * i),
      retrievalSalience: round4(0.3 + 0.01 * i),
      rankScore: round4(0.05 * (i + 1)),
      consecutiveNoOps: i,
      updatedAt: asset.bareUpdatedAt,
      homeostaticDemotedAt: null,
      encodingSource: "type-stub",
    });
    insertAssetOutcomeRow(db, {
      assetRef: bareRef(asset.key),
      lastRetrievedAt: asset.bareUpdatedAt - 200,
      retrievalCount: i,
      expectedRetrievalRate: round4(0.3 * (i + 1)),
      negativeFeedbackCount: i,
      acceptedChangeCount: i,
      outcomeScore: round4(-0.05 * i),
      updatedAt: asset.bareUpdatedAt,
    });
  }
  if (asset.pattern !== "bareOnly") {
    insertAssetSalienceRow(db, {
      assetRef: qualifiedRef(asset.key),
      encodingSalience: round4(0.15 + 0.01 * i + 0.02 * d),
      outcomeSalience: round4(0.25 + 0.01 * i),
      retrievalSalience: round4(0.35 + 0.01 * i),
      rankScore: round4(0.05 * (i + 1) + 0.01),
      consecutiveNoOps: i + 1,
      updatedAt: asset.qualifiedUpdatedAt,
      homeostaticDemotedAt: asset.qualifiedUpdatedAt - 500,
      encodingSource: "content",
    });
    insertAssetOutcomeRow(db, {
      assetRef: qualifiedRef(asset.key),
      lastRetrievedAt: asset.qualifiedUpdatedAt - 200,
      retrievalCount: i + 1,
      expectedRetrievalRate: round4(0.3 * (i + 1) + 0.05),
      negativeFeedbackCount: i + 1,
      acceptedChangeCount: i + 1,
      outcomeScore: round4(0.05 * i),
      updatedAt: asset.qualifiedUpdatedAt,
    });
  }
}

/** Deterministic ISO timestamp offset from `updatedAt` -- never `new Date()`/`Date.now()`. */
function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function seedEventRows(db: Database, asset: LogicalAssetSpec, i: number): void {
  seedEventSpellingRows(db, bareRef(asset.key), asset.bareEventRowCount, asset, i, "bare");
  seedEventSpellingRows(db, qualifiedRef(asset.key), asset.qualifiedEventRowCount, asset, i, "qualified");
}

function seedEventSpellingRows(
  db: Database,
  ref: string,
  count: number,
  asset: LogicalAssetSpec,
  i: number,
  spelling: "bare" | "qualified",
): void {
  const baseTs = spelling === "bare" ? asset.bareUpdatedAt : asset.qualifiedUpdatedAt;
  for (let rowIdx = 0; rowIdx < count; rowIdx++) {
    const seedTag = `${i}-${asset.key.derived ? "d" : "p"}-${spelling}-${rowIdx}`;
    insertEvent(db, {
      eventType: "rekey-fixture-event",
      ts: isoAt(baseTs + rowIdx),
      ref,
      metadata: { seedTag },
    });
  }
}

/**
 * Insert one `proposals` row using the live column set (migration
 * `001-initial-schema`, migrations.ts:97-108). No repository helper exists
 * for a bare column-list insert (only `upsertProposal`, which requires a full
 * `Proposal` domain object) -- mirrors `seed-rows.ts`'s own documented raw-
 * INSERT pattern for tables without a convenient fixture-shaped helper.
 */
function insertProposalRow(
  db: Database,
  row: {
    id: string;
    ref: string;
    createdAt: string;
    updatedAt: string;
    seedTag: string;
  },
): void {
  db.prepare(
    `INSERT INTO proposals
       (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    "rekey-fixture-stash",
    row.ref,
    "pending",
    "rekey-fixture",
    row.createdAt,
    row.updatedAt,
    "",
    null,
    JSON.stringify({ seedTag: row.seedTag }),
  );
}

function seedProposalRows(db: Database, asset: LogicalAssetSpec, i: number): void {
  seedProposalSpellingRows(db, bareRef(asset.key), asset.bareEventRowCount, asset, i, "bare");
  seedProposalSpellingRows(db, qualifiedRef(asset.key), asset.qualifiedEventRowCount, asset, i, "qualified");
}

function seedProposalSpellingRows(
  db: Database,
  ref: string,
  count: number,
  asset: LogicalAssetSpec,
  i: number,
  spelling: "bare" | "qualified",
): void {
  const baseTs = spelling === "bare" ? asset.bareUpdatedAt : asset.qualifiedUpdatedAt;
  for (let rowIdx = 0; rowIdx < count; rowIdx++) {
    const seedTag = `${i}-${asset.key.derived ? "d" : "p"}-${spelling}-${rowIdx}`;
    insertProposalRow(db, {
      id: `prop-${seedTag}`,
      ref,
      createdAt: isoAt(baseTs + rowIdx),
      updatedAt: isoAt(baseTs + rowIdx),
      seedTag,
    });
  }
}
