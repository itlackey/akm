// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fixture-local asset names/refs for the `journal/` golden area (WI-03/WI-04
 * — brief §3.2 rule 3, R6). Every ref string that ends up embedded in a
 * committed golden fixture under `tests/fixtures/goldens/journal/*.json`
 * must be sourced from here, never a production ref literal, so Chunk 5's
 * §15.2 grammar codemod can mechanically re-key these fixtures.
 *
 * Consumers: `tests/commands/proposal/goldens-proposal-txn.test.ts`,
 * `tests/integration/goldens-proposal-recovery.test.ts` (WI-03); the WI-04
 * mv-engine suites reuse this module for their own scenario names.
 *
 * All WI-03 names are lesson-type (`lesson:<name>`) — `promoteProposal`'s
 * validation pipeline (`validators/proposals.ts`) requires well-formed
 * `description`/`when_to_use` frontmatter for the `lesson` type, so every
 * `*_CONTENT` constant below is a validator-passing payload. Names double as
 * sandboxed-stash filenames (`<stashDir>/lessons/<name>.md`).
 */

/** Build a `lesson:<name>` ref string from a bare fixture name. */
export function lessonRef(name: string): string {
  return `lesson:${name}`;
}

// ── goldens-proposal-txn.test.ts (R3 — accept/revert/reject engines) ───────

export const ACCEPT_NEW_ASSET_NAME = "jnl-accept-new-asset";
export const ACCEPT_OVERWRITE_NAME = "jnl-accept-overwrite";
export const ACCEPT_IDEMPOTENT_NAME = "jnl-accept-idempotent";
export const ACCEPT_TARGET_MUTATED_NAME = "jnl-accept-target-mutated";
export const REVERT_SUCCESS_NAME = "jnl-revert-success";
export const REVERT_REFUSE_CLOBBER_NAME = "jnl-revert-refuse-clobber";
export const REJECT_SUCCESS_NAME = "jnl-reject-success";
export const REJECT_NON_PENDING_NAME = "jnl-reject-non-pending";
export const REJECT_CONCURRENT_EDIT_NAME = "jnl-reject-concurrent-edit";
export const CREATE_DUPLICATE_PENDING_NAME = "jnl-create-duplicate-pending";
export const CREATE_HASH_MATCH_PENDING_NAME = "jnl-create-hash-match-pending";
export const CREATE_HASH_MATCH_REJECTED_NAME = "jnl-create-hash-match-rejected";
export const CREATE_COOLDOWN_NAME = "jnl-create-cooldown";
export const CREATE_FORCE_BYPASS_NAME = "jnl-create-force-bypass";

/**
 * Validator-passing lesson body. `description`/`when_to_use` are fixed,
 * generic prose (never embedding `label`, which is the fixture ref's name)
 * because `isValidDescription`/`isValidWhenToUse`
 * (`validators/proposal-quality-validators.ts:151-171`) reject a
 * description/when_to_use that is short AND contains the ref's tail as
 * "just naming the input ref". `label` and `body` still make each fixture's
 * *content* (and therefore its hash) distinct.
 */
export function lessonContent(label: string, body: string): string {
  return (
    "---\ndescription: Fixture-local golden capture content for the proposal journal round-trip suite.\n" +
    `when_to_use: Testing proposal accept, revert, and reject engine outcomes (${label}).\n---\n\n${body}\n`
  );
}

// ── tests/integration/goldens-proposal-recovery.test.ts (R3 — crash recovery) ─

export const RECOVERY_ACCEPT_PREFIX = "jnl-recovery-accept";
export const RECOVERY_REVERT_PREFIX = "jnl-recovery-revert";
export const RECOVERY_REJECT_PREFIX = "jnl-recovery-reject";
export const RECOVERY_REJECT_RECOVERS_ACCEPT_NAME = "jnl-recovery-reject-recovers-accept";
