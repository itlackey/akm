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
 * Consumers: `tests/commands/improve/goldens-signal-delta-gate.test.ts` (WI-06).
 *
 * The self-consistency and P0-A high-retrieval fallback golden suites (and
 * their `SC_*`/`P0A_*` fixture-ref exports) were retired in Chunk 7 alongside
 * the lanes they baselined (R36) — see `tests/fixtures/goldens/DESIGNATIONS.json`.
 *
 * All names are memory-type; WI-8.5c flipped the durable/candidate ref
 * spelling to the SHORT conceptId, so this builds `memories/<name>` (D-R2).
 * Names double as sandboxed-stash filenames
 * (`<stashDir>/memories/<name>.md`), so they are filesystem-safe slugs.
 */

/** Build a `memories/<name>` conceptId ref string from a bare fixture name. */
export function memoryRef(name: string): string {
  return `memories/${name}`;
}

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
