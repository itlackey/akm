// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b Step 0c — Hot-probation intake buffer (#604).
 *
 * New system-generated extractions enter `captureMode: hot-probation` and spend
 * ONE consolidation cycle in probation before promotion to the main stash;
 * dedup + quality second-pass runs against them. Stops noisy extractions from
 * polluting the stash at the source. Reuses shared dedupHash + body_embeddings.
 * Default OFF.
 *
 * @module hot-probation
 */

/**
 * captureMode value for system-generated extractions in probation.
 * Automatic counterpart to the user-explicit `captureMode: hot`.
 */
export const CAPTURE_MODE_HOT_PROBATION = "hot-probation" as const;

/**
 * Returns true when an asset is in hot-probation (system-generated, not yet
 * graduated from the intake dedup+quality pass).
 */
export function isHotProbation(captureModeValue: unknown): boolean {
  return captureModeValue === CAPTURE_MODE_HOT_PROBATION;
}

/**
 * Returns true when an asset should be skipped by the consolidation LLM
 * because it's still in hot-probation (hasn't completed the intake pass yet).
 *
 * Hot-probation assets are processed by the consolidation dedup pre-pass
 * (runDeterministicDedup) but excluded from the LLM merge clustering, so
 * noisy extractions can't pollute the LLM context.
 */
export function shouldSkipHotProbationInLlm(frontmatterData: Record<string, unknown>): boolean {
  return isHotProbation(frontmatterData.captureMode);
}

/**
 * Build frontmatter fields to inject when creating a hot-probation proposal.
 * The proposal will carry `captureMode: hot-probation` so downstream logic
 * knows to run the intake dedup pass before graduating it.
 */
export function buildHotProbationFrontmatter(): { captureMode: typeof CAPTURE_MODE_HOT_PROBATION } {
  return { captureMode: CAPTURE_MODE_HOT_PROBATION };
}
