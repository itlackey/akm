// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic fixed values shared by the chunk-0b migration DB fixture
 * builders (`orphan-state.ts`, `rc-train-state.ts`).
 *
 * Every timestamp/score/count these builders write is a literal constant
 * derived from {@link FIXTURE_BASE_EPOCH_MS} — never `Date.now()` or
 * `Math.random()` — so the fixtures are byte/row-stable across every build.
 * Chunk 8's property/regression tests import these builders directly and
 * re-run them; a non-deterministic seed would make those tests flaky.
 */

/**
 * Fixed base epoch (Unix ms) every fixture timestamp in this tree is offset
 * from. Arbitrary but stable: `2023-11-14T22:13:20.000Z`. Individual rows add
 * a small fixed offset (see each builder) so rows are distinguishable by
 * `updated_at` without ever reading the clock.
 */
export const FIXTURE_BASE_EPOCH_MS = 1_700_000_000_000;
