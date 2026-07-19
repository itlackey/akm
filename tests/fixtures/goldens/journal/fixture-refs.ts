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
  return `lessons/${name}`;
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
export const CREATE_MODEL_ID_TERM_NAME = "jnl-create-model-id-term";

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

// ── goldens-mv-txn.test.ts / goldens-mv-recovery.test.ts (R3 — mv move engine,
//    WI-04) ───────────────────────────────────────────────────────────────
//
// `akm mv` operates on `memory:`/`knowledge:` (and other flat-markdown) refs,
// not `lesson:` proposal payloads, and does not validate frontmatter shape
// the way `promoteProposal`'s validators do -- so these constants are plain
// name strings plus small content builders for the source asset and its
// citers (body prose, frontmatter `xrefs:` list, `tasks/*.yml`).

/** Build a `memory:<name>` ref string from a bare fixture name. */
export function memoryRef(name: string): string {
  return `memories/${name}`;
}

/**
 * The fully-qualified `stash//memories/<name>` item_ref a memory asset carries
 * post-flip. `akm mv`'s in-place re-key rewrites a usage-event ref to the new
 * NAME (still legacy-spelled), then a full index's §11.4 re-key migrates it onto
 * the entry's fully-qualified `item_ref` — so the durable `usage_events.entry_ref`
 * an mv-recovered row ends up carrying is this spelling, not `memory:<name>`
 * (identical to the green expectation pinned at
 * `tests/integration/mv-durable-recovery.test.ts:249`). Used only for the
 * usage-event re-key assertions; the golden fixture serializes only the boolean
 * OUTCOME of that comparison, never this literal.
 */
export function memoryItemRef(name: string): string {
  return `stash//memories/${name}`;
}

/** Plain body content for a memory/knowledge asset moved by the mv-engine goldens. */
export function mvSourceBody(label: string): string {
  return `Fixture-local mv source body (${label}).\n`;
}

/** Body-prose citer content: one inline occurrence of `ref`. */
export function mvBodyCiterContent(ref: string): string {
  return `---\ndescription: Fixture-local mv body citer.\n---\n\nSee ${ref} for details.\n`;
}

/** Frontmatter `xrefs:` list citer content: one list-entry occurrence of `ref`. */
export function mvFrontmatterCiterContent(ref: string): string {
  return `---\ndescription: Fixture-local mv frontmatter citer.\nxrefs:\n  - ${ref}\n---\n\nDerived note body (no inline ref).\n`;
}

/** `tasks/*.yml` citer content: one `prompt:` occurrence of `ref` (mv-cli.ts scans tasks/*.yml|*.yaml). */
export function mvTaskYamlContent(ref: string): string {
  return `schedule: "0 9 * * *"\nprompt: ${ref}\n`;
}

// -- scenario 1: body + frontmatter + task-yaml citers + .derived.md twin --
export const MV_MOVE_BASE_NAME = "mv-move-base";
export const MV_MOVE_TARGET_REL = "projectA/mv-move-renamed";
export const MV_MOVE_BODY_CITER_NAME = "mv-move-body-citer";
export const MV_MOVE_FRONTMATTER_CITER_NAME = "mv-move-frontmatter-citer";
export const MV_MOVE_TASK_YAML_NAME = "mv-move-nightly";
export const MV_MOVE_READONLY_CITER_NAME = "mv-move-readonly-citer";

// -- scenario 2a: divergent citer at the STAGE window (mv-cli.ts:576) --
export const MV_STAGE_DIVERGENCE_NAME = "mv-stage-divergence";
export const MV_STAGE_DIVERGENCE_TARGET_REL = "mv-stage-divergence-new";
export const MV_STAGE_DIVERGENCE_CITER_NAME = "mv-stage-divergence-citer";

// -- scenario 2b: divergent citer at the REPLACE window (mv-cli.ts:632) --
export const MV_REPLACE_DIVERGENCE_NAME = "mv-replace-divergence";
export const MV_REPLACE_DIVERGENCE_TARGET_REL = "mv-replace-divergence-new";
export const MV_REPLACE_DIVERGENCE_CITER_NAME = "mv-replace-divergence-citer";

// -- scenario 3: divergent-committed-target recovery refusal (validateCommittedMove) --
export const MV_COMMITTED_DIVERGENCE_NAME = "mv-committed-divergence";
export const MV_COMMITTED_DIVERGENCE_TARGET_REL = "mv-committed-divergence-new";
export const MV_COMMITTED_DIVERGENCE_TRIGGER_NAME = "mv-committed-divergence-trigger";

// -- scenario 4: transient re-key failure retains the journal, next mutation
//    completes forward (behavior of tests/commands/mv.test.ts:353) --
export const MV_TRANSIENT_REKEY_NAME = "mv-transient-rekey";
export const MV_TRANSIENT_REKEY_TARGET_REL = "mv-transient-rekey-new";
export const MV_TRANSIENT_REKEY_TRIGGER_NAME = "mv-transient-rekey-trigger";
export const MV_TRANSIENT_REKEY_TRIGGER_TARGET_REL = "mv-transient-rekey-trigger-new";

// ── tests/integration/goldens-mv-recovery.test.ts (R3 — SIGKILL crash recovery,
//    WI-04) ───────────────────────────────────────────────────────────────

/** SIGKILL at "applying" (before any citer/source rename) -> full rollback. */
export const MV_RECOVERY_ROLLBACK_NAME = "mv-recovery-rollback";
export const MV_RECOVERY_ROLLBACK_TARGET_REL = "mv-recovery-rollback-new";

/** SIGKILL roll-forward phases: filesystem-committed / index-finalized / state-finalized / event-finalized. */
export const MV_RECOVERY_FORWARD_PHASES = [
  "filesystem-committed",
  "index-finalized",
  "state-finalized",
  "event-finalized",
] as const;
export const MV_RECOVERY_FORWARD_PREFIX = "mv-recovery-forward";
export const MV_RECOVERY_FORWARD_TRIGGER_PREFIX = "mv-recovery-forward-trigger";

/** The four independent recovery entry points (brief §2.2 / WI-04 step 2). */
export const MV_RECOVERY_ENTRY_MVRUN_NAME = "mv-recovery-entry-mvrun";
export const MV_RECOVERY_ENTRY_MVRUN_TRIGGER_NAME = "mv-recovery-entry-mvrun-trigger";
export const MV_RECOVERY_ENTRY_PROMOTE_NAME = "mv-recovery-entry-promote";
export const MV_RECOVERY_ENTRY_INDEXER_FULL_NAME = "mv-recovery-entry-indexfull";
export const MV_RECOVERY_ENTRY_INDEXER_TARGETED_NAME = "mv-recovery-entry-indextargeted";
