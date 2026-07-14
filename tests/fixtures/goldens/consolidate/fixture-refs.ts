// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fixture-local asset names/refs for the `consolidate/` golden area (WI-05 —
 * brief §3.2 rule 3, R6). Every ref string that ends up embedded in a
 * committed golden fixture under `tests/fixtures/goldens/consolidate/*.json`
 * must be sourced from here, never a production ref literal, so Chunk 5's
 * §15.2 grammar codemod can mechanically re-key these fixtures.
 *
 * Consumers: `tests/commands/consolidate/goldens-consolidate-ops.test.ts`,
 * `tests/commands/consolidate/goldens-merge-plans.test.ts`,
 * `tests/commands/consolidate/goldens-consolidate-journal.test.ts` (WI-06).
 *
 * All names are memory-type (`memory:<name>`) or knowledge-type
 * (`knowledge:<name>`) — the two asset types the consolidate op-handlers
 * touch. Names double as sandboxed-stash filenames
 * (`<stashDir>/memories/<name>.md` / `<stashDir>/knowledge/<name>.md`), so
 * they are filesystem-safe slugs.
 */

/** Build a `memory:<name>` ref string from a bare fixture name. */
export function memoryRef(name: string): string {
  return `memory:${name}`;
}

/** Build a `knowledge:<name>` ref string from a bare fixture name. */
export function knowledgeRef(name: string): string {
  return `knowledge:${name}`;
}

// ── goldens-consolidate-ops.test.ts — merge (R5) ────────────────────────────

/** merge 1 primary + 1 secondary — primary output pinned byte-for-byte. */
export const MERGE11_PRIMARY_NAME = "cop-merge11-primary";
export const MERGE11_SECONDARY_NAME = "cop-merge11-secondary";

/** merge 1 primary + 2 secondaries — one-LLM-call/all-archived asymmetry. */
export const MERGE12_PRIMARY_NAME = "cop-merge12-primary";
export const MERGE12_SECONDARY_A_NAME = "cop-merge12-secondary-a";
export const MERGE12_SECONDARY_B_NAME = "cop-merge12-secondary-b";

/** merge refusal: a hot-captured participant blocks the merge pre-flight. */
export const MERGE_REFUSAL_HOT_PRIMARY_NAME = "cop-merge-refusal-hot-primary";
export const MERGE_REFUSAL_HOT_SECONDARY_NAME = "cop-merge-refusal-hot-secondary";

/** merge refusal: an unparseable participant blocks the merge pre-flight. */
export const MERGE_REFUSAL_UNPARSEABLE_PRIMARY_NAME = "cop-merge-refusal-unparseable-primary";
export const MERGE_REFUSAL_UNPARSEABLE_SECONDARY_NAME = "cop-merge-refusal-unparseable-secondary";

/** merge refusal: generated content is missing a description. */
export const MERGE_REFUSAL_MISSING_DESC_PRIMARY_NAME = "cop-merge-refusal-missing-desc-primary";
export const MERGE_REFUSAL_MISSING_DESC_SECONDARY_NAME = "cop-merge-refusal-missing-desc-secondary";

/** merge refusal: generated content has a truncated description. */
export const MERGE_REFUSAL_TRUNCATED_DESC_PRIMARY_NAME = "cop-merge-refusal-truncated-desc-primary";
export const MERGE_REFUSAL_TRUNCATED_DESC_SECONDARY_NAME = "cop-merge-refusal-truncated-desc-secondary";

/** merge refusal: anti-collapse generation guard (both participants over maxGeneration). */
export const MERGE_REFUSAL_GENERATION_PRIMARY_NAME = "cop-merge-refusal-generation-primary";
export const MERGE_REFUSAL_GENERATION_SECONDARY_NAME = "cop-merge-refusal-generation-secondary";

// ── goldens-consolidate-ops.test.ts — delete (R5) ───────────────────────────

export const DELETE_NORMAL_NAME = "cop-delete-normal";
export const DELETE_HOT_REFUSED_NAME = "cop-delete-hot-refused";
export const DELETE_ALREADY_GONE_NAME = "cop-delete-already-gone";

// ── goldens-consolidate-ops.test.ts — promote (R5) ──────────────────────────

export const PROMOTE_HAPPY_NAME = "cop-promote-happy";
export const PROMOTE_HAPPY_KNOWLEDGE_NAME = "cop-promote-happy-target";

export const PROMOTE_GATE_WITHIN_RUN_DEDUP_NAME = "cop-promote-gate-within-run-dedup";
export const PROMOTE_GATE_ALREADY_EXISTS_NAME = "cop-promote-gate-already-exists";
export const PROMOTE_GATE_ALREADY_EXISTS_KNOWLEDGE_NAME = "cop-promote-gate-already-exists-target";
export const PROMOTE_GATE_SUPERSEDED_NAME = "cop-promote-gate-superseded";
export const PROMOTE_GATE_TOO_SMALL_NAME = "cop-promote-gate-too-small";
export const PROMOTE_GATE_BODY_DEDUP_NAME = "cop-promote-gate-body-dedup";
export const PROMOTE_GATE_BODY_DEDUP_EXISTING_KNOWLEDGE_NAME = "cop-promote-gate-body-dedup-existing-target";
export const PROMOTE_GATE_SLUG_DEDUP_NAME = "cop-promote-gate-slug-dedup";
export const PROMOTE_GATE_SLUG_DEDUP_KNOWLEDGE_NAME = "cop-promote-gate-slug-dedup-2026-05-03";
export const PROMOTE_GATE_SLUG_DEDUP_EXISTING_KNOWLEDGE_NAME = "cop-promote-gate-slug-dedup-9";

// ── goldens-consolidate-ops.test.ts — contradict (R5) ───────────────────────

export const CONTRADICT_HIGH_CONF_NAME = "cop-contradict-high-conf";
export const CONTRADICT_HIGH_CONF_BY_NAME = "cop-contradict-high-conf-by";
export const CONTRADICT_LOW_CONF_NAME = "cop-contradict-low-conf";
export const CONTRADICT_LOW_CONF_BY_NAME = "cop-contradict-low-conf-by";
export const CONTRADICT_MISSING_CONF_NAME = "cop-contradict-missing-conf";
export const CONTRADICT_MISSING_CONF_BY_NAME = "cop-contradict-missing-conf-by";
export const CONTRADICT_ARCHIVED_NAME = "cop-contradict-archived";
export const CONTRADICT_ARCHIVED_BY_NAME = "cop-contradict-archived-by";

// ── goldens-merge-plans.test.ts (pure-function mergePlans goldens) ─────────

export const MP_HALLUCINATED_PRIMARY = "memory:mp-hallucinated-primary";
export const MP_REAL_PRIMARY = "memory:mp-real-primary";
export const MP_REAL_SECONDARY = "memory:mp-real-secondary";
export const MP_HALLUCINATED_SECONDARY = "memory:mp-hallucinated-secondary";

export const MP_MERGE_DELETE_TARGET = "memory:mp-merge-delete-target";
export const MP_MERGE_DELETE_SECONDARY = "memory:mp-merge-delete-secondary";

export const MP_PROMOTE_MERGE_TARGET = "memory:mp-promote-merge-target";
export const MP_PROMOTE_MERGE_KNOWLEDGE = "knowledge:mp-promote-merge-knowledge";

export const MP_CONTRADICT_A = "memory:mp-contradict-a";
export const MP_CONTRADICT_B = "memory:mp-contradict-b";

// ── goldens-consolidate-journal.test.ts (R5, WI-06) ─────────────────────────

/** Full-run journal lifecycle: one real (non-hot) memory the LLM stub deletes. */
export const JOURNAL_LIFECYCLE_NAME = "cj-lifecycle-delete";

/** All-hot chunk: both memories carry captureMode:hot so the LLM is never called. */
export const JOURNAL_ALLHOT_A_NAME = "cj-allhot-a";
export const JOURNAL_ALLHOT_B_NAME = "cj-allhot-b";

/**
 * `completed >= operations` silent-cleanup scenario: one real memory the
 * fresh run deletes, alongside a hand-crafted STALE "completed" journal (see
 * `JOURNAL_STALE_OP_REF_NAME`) whose own backup dir is never removed by
 * `checkForIncompleteJournal` (characterization surprise — see suite notes).
 */
export const JOURNAL_SILENT_LEAK_NAME = "cj-silent-leak-delete";

/**
 * Referenced only INSIDE hand-crafted journal fixture files written directly
 * to disk by the recovery-mode scenarios (abort/clean/silent-leak) — never
 * backed by a real memory file on disk. Fixture-local so the crafted journal
 * JSON never embeds a production ref.
 */
export const JOURNAL_STALE_OP_REF_NAME = "cj-stale-op-ref";

/** consolidateGuardStatus verdict matrix (consolidate/eligibility.ts:60). */
export const GUARD_HOT_NAME = "cj-guard-hot";
export const GUARD_SAFE_NAME = "cj-guard-safe";
export const GUARD_UNPARSEABLE_NAME = "cj-guard-unparseable";
export const GUARD_MISSING_NAME = "cj-guard-missing";
