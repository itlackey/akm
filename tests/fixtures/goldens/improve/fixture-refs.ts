// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fixture-local asset names/refs for the `improve/` golden area (WI-02 —
 * brief §3.2 rule 3, R6). Every ref string that ends up embedded in a
 * committed golden fixture under `tests/fixtures/goldens/improve/*.json`
 * must be sourced from here, never a production ref literal, so Chunk 5's
 * §15.2 grammar codemod can mechanically re-key these fixtures.
 *
 * Consumers: `tests/commands/improve/goldens-self-consistency.test.ts`,
 * `tests/commands/improve/goldens-p0a-selection.test.ts`,
 * `tests/commands/improve/goldens-signal-delta-gate.test.ts` (WI-06).
 *
 * All names are memory-type (`memory:<name>`) — the only asset type these two
 * suites index. Names double as sandboxed-stash filenames
 * (`<stashDir>/memories/<name>.md`), so they are filesystem-safe slugs.
 */

/** Build a `memory:<name>` ref string from a bare fixture name. */
export function memoryRef(name: string): string {
  return `memory:${name}`;
}

// ── goldens-self-consistency.test.ts (R1) ───────────────────────────────────

/** Single hot ref (utility 0.9 >= SC_THRESHOLD) — expects 3x SC fan-out. */
export const SC_HOT_NAME = "sc-hot-utility";
/** Single cold ref (utility 0.3 < SC_THRESHOLD) — expects a single call. */
export const SC_COLD_NAME = "sc-cold-utility";
/** Boundary ref at utility exactly 0.7 (the `>=` comparison, loop-stages.ts:311). */
export const SC_BOUNDARY_NAME = "sc-boundary-utility";
/** Mixed-run case: two hot refs... */
export const SC_MIXED_HOT_A_NAME = "sc-mixed-hot-a";
export const SC_MIXED_HOT_B_NAME = "sc-mixed-hot-b";
/** ...and two cold refs, all reflect-eligible in the same improve run. */
export const SC_MIXED_COLD_A_NAME = "sc-mixed-cold-a";
export const SC_MIXED_COLD_B_NAME = "sc-mixed-cold-b";

// ── goldens-p0a-selection.test.ts (R2) ──────────────────────────────────────

/** Zero-feedback ref with retrievals at/above the P0-A threshold (5). */
export const P0A_ABOVE_THRESHOLD_NAME = "p0a-above-threshold";
/** Zero-feedback ref with retrievals below the P0-A threshold. */
export const P0A_BELOW_THRESHOLD_NAME = "p0a-below-threshold";
/** Once-per-asset scenario: selected on run 1, cursor-blocked on run 2. */
export const P0A_ONCE_PER_ASSET_NAME = "p0a-once-per-asset";
/** Lane-isolation scenario (`configWithoutPoolGuard`, proactive OFF): the P0-A-qualifying ref. */
export const P0A_ISOLATION_HIGH_RETRIEVAL_NAME = "p0a-isolation-high-retrieval";
/** Lane-isolation scenario: a plain zero-signal ref that must NOT be selected once proactive is off. */
export const P0A_ISOLATION_PLAIN_NAME = "p0a-isolation-plain";

/** Lane-attribution scenario (DEFAULT config, proactive ON) — one ref per lane. */
export const P0A_ATTRIBUTION_SIGNAL_DELTA_NAME = "p0a-attr-signal-delta";
export const P0A_ATTRIBUTION_HIGH_RETRIEVAL_NAME = "p0a-attr-high-retrieval";
/**
 * Named to sort lexically AFTER every `P0A_ATTRIBUTION_FILLER_PREFIX` name so
 * it is excluded from the proactive-maintenance lane's top-`maxPerRun` cut
 * (all candidates tie on priority — see the suite's lane-attribution test
 * comment) and instead falls through to the high-salience gate (Layer 3).
 */
export const P0A_ATTRIBUTION_HIGH_SALIENCE_NAME = "zzz-p0a-attr-high-salience";
/** Filler refs that saturate the default `proactiveMaintenance.maxPerRun` (15) cap. */
export const P0A_ATTRIBUTION_FILLER_PREFIX = "aaa-p0a-attr-filler-";
/** Must equal the default profile's `proactiveMaintenance.maxPerRun` (src/assets/improve-strategies/default.json). */
export const P0A_ATTRIBUTION_FILLER_COUNT = 15;

// ── goldens-signal-delta-gate.test.ts (R5, WI-06 — §6 preserve list) ───────

/** buildLatestFeedbackTsMap / buildLatestProposalTsMap direct unit fixtures. */
export const SDG_FEEDBACK_MAP_NAME = "sdg-feedback-map-ref";
export const SDG_PROPOSAL_MAP_NAME = "sdg-proposal-map-ref";

/**
 * Partition-count scenario, driven via a full `akmImprove` run with
 * `proactiveMaintenance` disabled and zero retrievals/salience seeded so
 * ONLY the signal-delta gate is exercised (P0-A/proactive/high-salience
 * never fire) — lanes are not asserted, only the resulting bucket counts.
 */
export const SDG_ELIGIBLE_A_NAME = "sdg-eligible-a";
export const SDG_ELIGIBLE_B_NAME = "sdg-eligible-b";
export const SDG_DISTILL_ONLY_NAME = "sdg-distill-only";
export const SDG_NO_FEEDBACK_A_NAME = "sdg-no-feedback-a";
export const SDG_NO_FEEDBACK_B_NAME = "sdg-no-feedback-b";
