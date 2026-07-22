// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.7 — shared vocabulary for the re-key merge property-test generator
 * (`rekey-generator.ts`), invariant harness (`rekey-invariants.ts`), and the
 * two reference implementations (`rekey-reference-impls.ts`) that prove the
 * harness discriminates correct from incorrect re-key behavior.
 *
 * The 4 concrete key shapes per logical asset are `{bare, origin-qualified} x
 * {plain, .derived-twin}` (anchors.md E.2 / D0b-2) -- NOT 3 flat categories.
 * `rekeyStateDbForMove` (src/commands/mv-cli.ts:898-967) demonstrates the
 * grammar these ref strings follow: bare = `type:name`, origin-qualified =
 * `origin//type:name`, and `.derived` is an orthogonal suffix applied to the
 * NAME portion of either spelling (mv-cli.ts:917-921; matches
 * `src/core/asset/asset-ref.ts#makeAssetRef` and
 * `src/commands/improve/memory/derived-ref.ts#DERIVED_SUFFIX`).
 *
 * A logical asset's CANONICAL key (D0b-2: "one canonical fully-qualified
 * key") is always its origin-qualified spelling: `origin//type:name[.derived]`
 * -- the bare spelling and the origin-qualified spelling are two names for
 * the SAME row and must merge; the `.derived` bit names a DIFFERENT row (a
 * separate lineage, e.g. `memory:foo` vs `memory:foo.derived` are different
 * conceptual assets) and is never merged across that bit.
 */

/** One logical asset's ref-key identity: the (origin, type, name, derived) tuple every ref spelling below is derived from. */
export interface LogicalAssetKey {
  readonly origin: string;
  readonly type: string;
  readonly name: string;
  /** Whether this is the `.derived`-twin lineage (a separate row from the plain asset of the same name). */
  readonly derived: boolean;
}

/** The bare `type:name[.derived]` spelling -- never fully qualified. */
export function bareRef(key: LogicalAssetKey): string {
  return key.derived ? `${key.type}:${key.name}.derived` : `${key.type}:${key.name}`;
}

/** The origin-qualified `origin//type:name[.derived]` spelling. */
export function qualifiedRef(key: LogicalAssetKey): string {
  return `${key.origin}//${bareRef(key)}`;
}

/** The canonical fully-qualified key a full-table re-key pass must collapse both spellings onto. Always equal to {@link qualifiedRef}. */
export function canonicalRef(key: LogicalAssetKey): string {
  return qualifiedRef(key);
}

/**
 * Which of the 2 spellings (bare / origin-qualified) have a seeded row for a
 * given logical asset:
 *   - "bareOnly"       -- only the bare spelling has a row (simple rename case).
 *   - "qualifiedOnly"  -- only the origin-qualified spelling has a row (already canonical; no-op case).
 *   - "collision"      -- BOTH spellings have a row, simultaneously, with DIFFERENT `updated_at` --
 *                          the case `rekeyStateDbForMove` was never asked to handle (anchors.md E.2/D0b-2).
 */
export type SpellingPattern = "bareOnly" | "qualifiedOnly" | "collision";

/** For a "collision" pattern: which spelling carries the LARGER `updated_at` and must therefore win the scalar-field merge (invariant 3). */
export type CollisionWinner = "bare" | "qualified";

/** One logical asset's full generation plan: which spellings exist, their timestamps, and how many event-table rows each spelling seeds. */
export interface LogicalAssetSpec {
  readonly key: LogicalAssetKey;
  readonly pattern: SpellingPattern;
  readonly collisionWinner: CollisionWinner | undefined;
  /** `updated_at` written to the bare-spelled scalar rows, when the bare spelling is present. */
  readonly bareUpdatedAt: number;
  /** `updated_at` written to the origin-qualified scalar rows, when that spelling is present. */
  readonly qualifiedUpdatedAt: number;
  /** Row count seeded into each event-shaped table (`events`, `proposals`) under the bare spelling. 0 when the bare spelling is absent. */
  readonly bareEventRowCount: number;
  /** Row count seeded into each event-shaped table under the origin-qualified spelling. 0 when that spelling is absent. */
  readonly qualifiedEventRowCount: number;
}

/** The full generated model for one seed: every logical asset a `generateRekeyState` call seeded into the produced state.db. */
export interface RekeyModel {
  readonly seed: number;
  readonly assets: readonly LogicalAssetSpec[];
}

/** A raw SQLite row read back via `SELECT *` -- opaque column bag, keyed by column name. */
// biome-ignore lint/suspicious/noExplicitAny: mirrors src/storage/database.ts's own Statement<Row = any> width -- SELECT * rows are genuinely heterogeneous across the 4 tables snapshotted.
export type RawRow = Record<string, any>;

/** Full row dump of every ref-keyed state.db table the WI-0b.7 harness covers, across the generated seed. */
export interface RekeySnapshot {
  readonly assetSalience: RawRow[];
  readonly assetOutcome: RawRow[];
  readonly events: RawRow[];
  readonly proposals: RawRow[];
}

/**
 * The shape a re-key implementation under test must have: mutate the real
 * state.db at `dbPath` IN PLACE, given the generator's ground-truth `model`
 * (the (origin, type, name, derived) identity of every logical asset it
 * seeded -- a real Chunk-8 implementation resolves this mapping from the live
 * stash/index; the generator supplies it directly so 0b's reference
 * implementations and the harness itself do not need that resolver to exist
 * yet). Deliberately NOT tied to any concrete Chunk-8 module path -- that
 * module does not exist yet (anchors.md E.5); Chunk 8 imports this type and
 * the harness, writes its own `RekeyFn`, and passes it in.
 */
export type RekeyFn = (dbPath: string, model: RekeyModel) => void;
