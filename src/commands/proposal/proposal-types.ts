// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal domain types — dependency-free leaf.
 *
 * `Proposal` (+ its field types) and the validator-shared types
 * (`ProposalValidator`, `ProposalValidationContext`,
 * `ProposalValidationFinding`, `ProposalValidationReport`) used to live in
 * `./repository.ts` and `./validators/proposals.ts` / `./validators/proposal-validators.ts`
 * respectively. Both the storage repository (`storage/repositories/proposals-repository.ts`),
 * the legacy filesystem importer (`./legacy-import.ts`), and the validators
 * (`./validators/*.ts`) only need the *type*, not the txn engine or the
 * validator-combining logic — importing those heavier modules just for a
 * type created an import cycle (WI-9.8 KILL 1, plan §10.7 D.3: repository.ts
 * ↔ validators/proposals.ts / proposal-validators.ts / proposal-quality-validators.ts
 * ↔ storage/repositories/proposals-repository.ts ↔ legacy-import.ts).
 *
 * This module has NO imports back into `./repository.ts` or `./validators/*`
 * — every symbol here is moved verbatim, and the old homes re-export it so
 * existing import sites are unchanged.
 */

import type { AssetRef } from "../../core/asset/asset-ref";
import type { FileChange } from "../../core/file-change";

/**
 * Which eligibility lane selected an asset for an improve run (attribution
 * tagging). Recorded on `reflect_invoked` / `distill_invoked` / `promoted`
 * state.db events and persisted on the proposal record so downstream
 * accept / reject / revert / retrieval outcomes can be sliced by lane — i.e.
 * "does the PROACTIVE lane produce value vs the reactive lanes?".
 *
 *   - `"signal-delta"`   — asset had fresh feedback since its last proposal
 *                          (the reactive feedback-signal lane).
 *   - `"proactive"`      — Layer-2 proactiveMaintenance scheduled selector.
 *   - `"scope"`              — explicit `--scope <ref>` bypass (user intent wins).
 *   - `"forgetting-safety"` — WS-1 protective consolidation: asset fell from
 *                             top-200 to below position 500 in the stash-wide
 *                             salience ranking (scenario B rank-change report).
 *                             Force-included for one consolidation pass regardless
 *                             of cooldown / signal-delta status so it is not
 *                             silently dropped from the candidate pool.
 *   - `"replay"`             — #610 bounded replay budget: a top-salience ref
 *                              revisited even with zero reactive signal and
 *                              regardless of cooldown. The WEAKEST lane — it never
 *                              relabels a ref another lane already chose, and its
 *                              selection is strictly ADDITIVE on top of `--limit`
 *                              (never steals fresh work). Converged refs
 *                              (consecutive_no_ops >= dampener threshold) are skipped.
 *   - `"unknown"`            — origin lane could not be determined. NOT a silent
 *                              alias for `signal-delta`; only used when the lane
 *                              genuinely cannot be attributed.
 *
 * Precedence when a ref qualifies via multiple lanes (prefer the most specific
 * reactive signal): `scope` > `signal-delta` > `proactive` >
 * `high-salience` > `forgetting-safety` > `replay`. Replay is weakest so it never
 * relabels a ref another lane already chose.
 * A ref with real feedback is attributed to feedback even if it was also due
 * for proactive maintenance.
 *
 * Moved from `core/improve-types.ts` (WI-9.8 KILL 1): this is a
 * zero-dependency string union that `Proposal.eligibilitySource` also needs,
 * and core/improve-types.ts itself imports UP from commands/improve/* (the
 * §10.7 layering inversion KILL 2 fixes) — defining it there would drag this
 * dependency-free leaf (and everything that imports Proposal from it) back
 * into the still-cyclic improve-types SCC. core/improve-types.ts re-exports
 * this verbatim so `ImproveEligibleRef` and every improve/* consumer that
 * imports `EligibilitySource` from `core/improve-types` is unchanged.
 */
export type EligibilitySource =
  | "signal-delta"
  | "high-salience"
  | "proactive"
  | "scope"
  | "forgetting-safety"
  | "replay"
  | "unknown";

// ── Source allow-list (F-4 / #385) ──────────────────────────────────────────

/**
 * Curated allow-list of valid `source` values for proposals (F-4 / #385).
 *
 * Rationale (W3C PROV-DM 2013): Provenance records require typed, validated
 * sources for meaningful aggregation. Accept-rate-per-source is the core
 * self-measurement metric for recursive self-improvement: if reflect proposals
 * are accepted at 20% and distill proposals at 60%, that guides resource
 * allocation. Free-text typos (`"reflct"`) produce unaggregatable events.
 *
 * Automated sources (those in {@link AUTOMATED_PROPOSAL_SOURCES}) require a
 * `sourceRun` field for full PROV-DM traceability.
 */
export const PROPOSAL_SOURCES = [
  // Automated sources — require sourceRun for traceability.
  "reflect",
  "distill",
  "consolidate",
  "extract",
  "improve",
  // Semi-automated / tool-driven.
  "feedback",
  // Human-initiated / CLI-driven.
  "propose",
  "remember",
  "import",
  // Internal / system.
  "distill_quality_rejected",
  "schema-repair",
] as const;

/** Automated sources that SHOULD include a `sourceRun` for PROV-DM traceability. */
export const AUTOMATED_PROPOSAL_SOURCES = [
  "reflect",
  "distill",
  "consolidate",
  "extract",
  "improve",
  "schema-repair",
] as const satisfies ReadonlyArray<(typeof PROPOSAL_SOURCES)[number]>;

/** Union of all valid proposal source values. */
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

/**
 * Check whether a string is a valid {@link ProposalSource}.
 * Unknown source values are accepted with a runtime warning rather than a hard
 * error, to allow extensions without breaking existing callers.
 */
export function isValidProposalSource(source: string): source is ProposalSource {
  return (PROPOSAL_SOURCES as readonly string[]).includes(source);
}

/**
 * Check whether a source value is an automated source requiring `sourceRun`.
 */
export function isAutomatedProposalSource(source: string): source is (typeof AUTOMATED_PROPOSAL_SOURCES)[number] {
  return (AUTOMATED_PROPOSAL_SOURCES as readonly string[]).includes(source);
}

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a proposal.
 *
 *   - `pending`   — Live queue entry awaiting review.
 *   - `accepted`  — Promoted into the asset tree via {@link promoteProposal}.
 *   - `rejected`  — Reviewer (or automated guard / orphan purge / expiration)
 *                   declined the proposal.
 *   - `reverted`  — Previously `accepted` proposal that was rolled back via the
 *                   `akm proposal revert <id>` flow (D6c). The asset on disk is
 *                   restored from the backup captured at promotion time.
 *
 * Any non-`pending` status is "archived": the row stays in the table for the
 * audit trail but leaves the live queue.
 */
export type ProposalStatus = "pending" | "accepted" | "rejected" | "reverted";

export interface ProposalPayload {
  /**
   * Full file content the accepted proposal will write to disk. Since WI-6.2
   * this is, by construction, identical to `Proposal.changes[0].after` — the
   * payload is the single-content view of the envelope's primary change.
   */
  content: string;
  /** Convenience parsed frontmatter, if the content is markdown-with-frontmatter. */
  frontmatter?: Record<string, unknown>;
}

export interface ProposalReview {
  outcome: "accepted" | "rejected";
  reason?: string;
  decidedAt: string;
}

/**
 * The verdict the deterministic drain/triage engine reached for this proposal
 * (#577). Drain-owned audit machinery: the `akm improve` confidence gate that
 * also stamped these died in 0.9.0; historical rows it wrote still render.
 *
 *   - `auto-accepted` — the gate promoted the proposal without review.
 *   - `deferred`      — the gate left the proposal pending for human (or
 *                       later automated) review.
 *   - `auto-rejected` — the gate rejected the proposal without review.
 */
export type ProposalGateDecisionOutcome = "auto-accepted" | "deferred" | "auto-rejected";

/**
 * Per-proposal record of the automated gate decision (#577).
 *
 * Persisted onto the proposal row (in `metadata_json`) at gate time so tooling
 * can explain WHY each proposal is in its current state — e.g. `akm proposal
 * show` surfacing "deferred: below-threshold (72 < 90)" instead of forcing the
 * operator to reconstruct it from the run-level `triage_deferred` aggregate.
 *
 * Forward-only: proposals created before 0.9.0 (and any pending proposal that
 * predates this field) simply carry no `gateDecision`. Every renderer treats a
 * missing decision as "unknown" rather than erroring.
 */
export interface ProposalGateDecision {
  outcome: ProposalGateDecisionOutcome;
  /**
   * Short machine-stable reason token chosen by the gate that recorded the
   * decision. The vocabulary persisted today (drain/triage gate): `empty-diff`,
   * `max-diff-lines`, `min-content-lines`, `policy-accept`, `mid-band`,
   * `possible-dup`, `no-judge-configured`, `judgment-accept`,
   * `judgment-reject`.
   *
   * Historical rows written by the deleted (0.9.0) improve confidence gate may
   * carry `above-threshold`, `below-threshold`, `no-confidence`, or
   * `exploration-budget` — renderers still display them.
   */
  reason: string;
  /** Computed confidence score in `[0, 1]`, when the gate had one. */
  confidence?: number;
  /**
   * The value the gate actually measured and compared against the threshold
   * (drain gate). For the over-band defer this is the proposed content's line
   * count, for the body-floor defer the non-empty body-line count — so a full
   * comparison such as "210 > 200" stays reconstructable, not just the bound.
   * The improve gate uses {@link confidence} as its measured value instead.
   */
  measured?: number;
  /**
   * The thresholds in effect when the decision was made, so a comparison such
   * as "72 < 90" stays reconstructable later. Sparse — a gate records only the
   * knobs it actually consulted.
   */
  thresholds?: {
    /** Confidence threshold in `[0, 1]` (historical improve-gate rows only). */
    autoAccept?: number;
    /** Maximum diff-line bound that deferred the proposal (drain gate). */
    maxDiffLines?: number;
    /** Minimum body-line floor that deferred the proposal (drain gate). */
    minContentLines?: number;
  };
  /**
   * SHA-256 hash of the proposal content the gate evaluated, when the gate needs
   * to distinguish an unchanged retry from a reset/content edit.
   */
  contentHash?: string;
  /** Label of the gate that recorded the decision (e.g. `triage:personal-stash`, `improve:reflect`). */
  gate?: string;
  /** ISO timestamp the decision was recorded. */
  decidedAt: string;
}

export interface Proposal {
  /** Stable random id (crypto.randomUUID()). Primary key in the store. */
  id: string;
  /** Asset ref the proposal would create or update (`[origin//]type:name`). */
  ref: string;
  status: ProposalStatus;
  /**
   * Origin tag identifying the source subsystem (F-4 / #385).
   *
   * Should be one of {@link PROPOSAL_SOURCES}. Automated sources (reflect,
   * distill, consolidate, improve) additionally require `sourceRun` for
   * PROV-DM traceability and accept-rate-per-source aggregation.
   * Unknown values are accepted (warn at creation) to allow extensions.
   */
  source: ProposalSource | string;
  /**
   * Stable run identifier for the automated job that created this proposal.
   *
   * Required for automated sources ({@link AUTOMATED_PROPOSAL_SOURCES}) so
   * that accept-rate-per-source queries can be scoped to individual runs.
   * Optional for human-initiated sources (`propose`, `remember`, `import`).
   */
  sourceRun?: string;
  createdAt: string;
  updatedAt: string;
  payload: ProposalPayload;
  /**
   * The file mutations this proposal performs (plan §2.2). Multi-file capable;
   * proposals minted from a single-content payload carry exactly one entry
   * whose `after` IS `payload.content`. Derived at {@link createProposal} time;
   * legacy rows persisted before 0.9.0 synthesize a single `update` entry with
   * an empty `path` at read time.
   */
  changes: FileChange[];
  /**
   * SHA-256 hex of the content that existed at the primary change's target
   * path in the proposal's OWN stash when the proposal was minted. Absent when
   * the target did not exist (a `create`) or could not be resolved locally.
   * Consumed by the §23.6 input fingerprint (mint-time before-state term);
   * the unified transaction engine captures its own before-state at apply
   * time — this is NOT an apply-time guard.
   */
  beforeHash?: string;
  review?: ProposalReview;
  /**
   * Optional confidence score in `[0, 1]` (Advantage D6a / Phase 6A).
   *
   * When the proposal source can self-estimate quality (e.g. the reflect LLM
   * returning a calibrated score with its draft), the score is persisted for
   * reviewers and downstream tooling (`akm proposal show`, drain judgment
   * context). It no longer drives any automated accept path — the `akm
   * improve` confidence gate that promoted on threshold died in 0.9.0.
   *
   * Out-of-range or non-finite values are stripped at {@link createProposal}
   * time so downstream code can rely on the invariant `0 <= confidence <= 1`.
   */
  confidence?: number;
  /**
   * The drain/triage engine's verdict for this proposal (#577), recorded at
   * adjudication time (drain-owned audit machinery).
   *
   * Carries the decision (auto-accepted / deferred / auto-rejected), the reason
   * token, the confidence the gate computed, and the thresholds in effect, so
   * `akm proposal show` / `list` can explain why a proposal is pending without
   * the operator reconstructing it from run-level aggregates.
   *
   * Absent on proposals that never passed through a gate, and on every proposal
   * created before 0.9.0 (forward-only — no backfill). Historical rows written
   * by the deleted improve confidence gate still render. Renderers must treat
   * a missing decision as "unknown".
   */
  gateDecision?: ProposalGateDecision;
  /**
   * Full content of the asset that existed at the target ref BEFORE promotion
   * (Advantage D6c / Phase 6C). Captured exclusively by {@link promoteProposal}
   * when the target file existed; absent for genuinely-new assets. Consumed by
   * the `akm proposal revert <id>` flow to restore prior content.
   *
   * Never surfaced by the `akm proposal` output shapes — it is internal
   * revert state carried on the row.
   */
  backupContent?: string;
  /** SHA-256 of the exact bytes published when this proposal was accepted. */
  acceptedContentHash?: string;
  /** Exact write target owned by the accepted content; prevents cross-target revert. */
  acceptedTarget?: {
    source: string;
    root: string;
    path: string;
    contentHash: string;
  };
  /** Internal marker for a target binding reconstructed from pre-binding proposal state. */
  legacyAcceptedTargetDerived?: boolean;
  /** The accepted file was absent when legacy ownership was reconstructed. */
  legacyAcceptedAssetWasAbsent?: boolean;
  /**
   * Attribution tagging: which eligibility lane selected the source asset for the
   * improve run that produced this proposal (`signal-delta`, `high-salience`,
   * `proactive`, `scope`, or `unknown`). Persisted in `metadata_json` so the lane
   * survives to accept/reject/revert time even across runs, letting downstream
   * analysis measure whether the PROACTIVE lane produces value vs the reactive
   * lanes. Absent on proposals created before this field shipped (treat as
   * `"unknown"`) and on human-initiated sources that have no eligibility lane.
   */
  eligibilitySource?: EligibilitySource;
}

// ── Validator-shared types ───────────────────────────────────────────────────
//
// Moved from ./validators/proposals.ts (ProposalValidationFinding,
// ProposalValidationReport) and ./validators/proposal-validators.ts
// (ProposalValidationContext, ProposalValidator) — proposal-validators.ts and
// proposal-quality-validators.ts each needed the OTHER's types, and
// proposals.ts needed proposal-validators.ts's runProposalValidators while
// proposal-validators.ts needed proposals.ts's Finding/Report types. Hoisting
// the shared shapes here breaks both back-edges at once.

export interface ProposalValidationFinding {
  kind: string;
  message: string;
  /** "warn" findings are surfaced but do not block proposal acceptance. Defaults to error-level when absent. */
  severity?: "warn";
}

export interface ProposalValidationReport {
  ok: boolean;
  findings: ProposalValidationFinding[];
}

export interface ProposalValidationContext {
  parsedRef?: AssetRef;
  stop?: boolean;
  /**
   * Optional source-asset context for validators that need to compare the
   * proposed payload against the asset it was derived from (improve-stage
   * validators: reflect size guard, consolidate source-superseded guard).
   *
   * Populated by improve-stage call sites before invoking
   * {@link runProposalValidators}; the `proposal accept` path leaves this
   * absent and source-context-aware validators no-op.
   */
  source?: {
    content?: string;
    frontmatter?: Record<string, unknown>;
  };
}

export interface ProposalValidator {
  name: string;
  appliesTo(proposal: Proposal, ctx: ProposalValidationContext): boolean;
  validate(proposal: Proposal, ctx: ProposalValidationContext): ProposalValidationFinding[];
}
