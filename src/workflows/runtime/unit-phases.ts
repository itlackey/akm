// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit-row phase markers — a leaf module (imports nothing) so both the exec
 * drivers (step-work, brief, run-workflow) and the runtime (unit-checkin) can
 * key on the phase discriminator without an exec ↔ runtime import cycle.
 * Extracting {@link GATE_EVALUATION_PHASE} here broke the last workflows-
 * runtime knot (step-work → runs → unit-checkin → step-work; chunk-8 WI-8.6,
 * DoD 11).
 */

/**
 * `phase` marker stamped on gate-evaluation unit rows. Step ids cannot contain
 * dots (`PROGRAM_STEP_ID_PATTERN`), so a step can never be NAMED `x.gate` and
 * the synthetic `<stepId>.gate` node id is collision-free against user step
 * ids. The phase column is nonetheless the discriminator we key on — an
 * explicit marker, not a `node_id` suffix match, so recovery stays robust even
 * if the id scheme evolves. Dispatch rows always journal `phase: null`.
 */
export const GATE_EVALUATION_PHASE = "gate";
