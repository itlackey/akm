// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal domain types — a dependency-free leaf, so the storage repository
 * and the validators can share `Proposal` without importing each other.
 */

import type { AssetRef } from "../../core/asset/resolve-ref";
import type { FileChange } from "../../core/file-change";

/**
 * The eligibility lane that selected an asset for an improve run, carried on
 * the invoked/promoted events and the proposal so outcomes can be sliced by
 * lane. When several lanes qualify, the most specific reactive one wins:
 * `scope` > `signal-delta` > `proactive` > `high-salience` >
 * `forgetting-safety` > `replay`. `unknown` is only for a lane that genuinely
 * cannot be attributed; `replay` appears on rows older releases wrote.
 */
export type EligibilitySource =
  | "signal-delta"
  | "high-salience"
  | "proactive"
  | "scope"
  | "forgetting-safety"
  | "replay"
  | "unknown";

/**
 * Valid proposal `source` values (#385): typed sources keep accept-rate per
 * source aggregatable (PROV-DM). An unknown value is accepted with a warning.
 */
export const PROPOSAL_SOURCES = [
  "reflect",
  "distill",
  "consolidate",
  "extract",
  "improve",
  "feedback",
  "propose",
  "remember",
  "import",
  "distill_quality_rejected",
  "schema-repair",
] as const;

/** Automated sources, which should carry a `sourceRun`. */
export const AUTOMATED_PROPOSAL_SOURCES = [
  "reflect",
  "distill",
  "consolidate",
  "extract",
  "improve",
  "schema-repair",
] as const satisfies ReadonlyArray<(typeof PROPOSAL_SOURCES)[number]>;

export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

export function isValidProposalSource(source: string): source is ProposalSource {
  return (PROPOSAL_SOURCES as readonly string[]).includes(source);
}

export function isAutomatedProposalSource(source: string): source is (typeof AUTOMATED_PROPOSAL_SOURCES)[number] {
  return (AUTOMATED_PROPOSAL_SOURCES as readonly string[]).includes(source);
}

/** `pending` is the live queue; the rest are archived rows kept for the audit trail. */
export type ProposalStatus = "pending" | "accepted" | "rejected" | "reverted";

export interface ProposalPayload {
  /** The content accept writes — always equal to `changes[0].after`. */
  content: string;
  frontmatter?: Record<string, unknown>;
}

export interface ProposalReview {
  outcome: "accepted" | "rejected";
  reason?: string;
  decidedAt: string;
}

/**
 * A gate's verdict (#577): `staged` means a judge passed this exact content
 * (a promote run may accept it without judging again); `deferred` leaves it
 * for review.
 */
export type ProposalGateDecisionOutcome = "auto-accepted" | "deferred" | "staged" | "auto-rejected";

/** Why a proposal is where it is, stamped by the gate that put it there (`akm proposal show`). */
export interface ProposalGateDecision {
  outcome: ProposalGateDecisionOutcome;
  /**
   * Stable reason token. The drain (`triage` gate): `empty-diff`,
   * `judge-passed`, `judgment-accept`, `judgment-reject`,
   * `no-judge-configured`, `judgment-deferred`, `stale-target`. The stage
   * quality judge (`quality-gate`): `quality-judge` on a staged pass,
   * `quality-review` for a human. Also `expired` and `asset-missing`; older
   * releases wrote `max-diff-lines`, `min-content-lines`, `policy-accept`,
   * `mid-band` and `possible-dup`.
   */
  reason: string;
  /** What an older threshold gate measured (e.g. the line count in "210 > 200"). */
  measured?: number;
  thresholds?: { maxDiffLines?: number; minContentLines?: number };
  /** SHA-256 of the content the gate evaluated, to tell an unchanged retry from an edit. */
  contentHash?: string;
  gate?: string;
  decidedAt: string;
}

export interface Proposal {
  id: string;
  /** `[bundle//]conceptId` of the asset it creates or updates. */
  ref: string;
  status: ProposalStatus;
  source: ProposalSource | string;
  /** The automated run that made it. */
  sourceRun?: string;
  createdAt: string;
  updatedAt: string;
  payload: ProposalPayload;
  /** The file mutations; a single-content proposal has one whose `after` is `payload.content`. */
  changes: FileChange[];
  /**
   * The bundle and root bound at mint, so a later accept cannot follow a
   * changed default write target. Absent on rows from before it existed; those
   * re-resolve from `ref`.
   */
  proposedTarget?: { source: string; root: string };
  /** SHA-256 of the target as of mint (absent for a create). */
  beforeHash?: string;
  /**
   * The same, with akm's bookkeeping frontmatter removed (STALE, R20): the
   * freshness check prefers it, so a same-run bookkeeping rewrite of the target
   * does not stale out the proposal while a real edit still does.
   */
  beforeHashNormalized?: string;
  review?: ProposalReview;
  /** Self-estimated confidence in [0, 1], for reviewers. */
  confidence?: number;
  gateDecision?: ProposalGateDecision;
  /** The target's content before promotion (absent for new assets), for revert. Never shown. */
  backupContent?: string;
  /** Exactly where the accepted content went; prevents cross-target revert. */
  acceptedTarget?: { source: string; root: string; path: string; contentHash: string };
  eligibilitySource?: EligibilitySource;
}

/** A promote refused because the target changed after mint (STALE, R20) — not a merit judgement. */
export const STALE_TARGET_GATE_REASON = "stale-target";
export const EXPIRED_GATE_REASON = "expired";
export const ASSET_MISSING_GATE_REASON = "asset-missing";

const PROCEDURAL_GATE_REASONS: ReadonlySet<string> = new Set([
  STALE_TARGET_GATE_REASON,
  EXPIRED_GATE_REASON,
  ASSET_MISSING_GATE_REASON,
]);

/**
 * A rejection nobody judged on its content (stale target, expiry, orphan
 * purge). The "previously rejected" prompt context and the accept-rate metric
 * leave these out. Expiries archived before the gate reason existed are known
 * by their review reason.
 */
export function isProceduralRejection(proposal: Pick<Proposal, "gateDecision" | "review">): boolean {
  if (proposal.gateDecision?.outcome === "auto-rejected" && PROCEDURAL_GATE_REASONS.has(proposal.gateDecision.reason)) {
    return true;
  }
  return proposal.review?.reason?.startsWith("expired:") === true;
}

export interface ProposalValidationFinding {
  kind: string;
  message: string;
  /** `warn` is shown but does not block acceptance. */
  severity?: "warn";
}

export interface ProposalValidationReport {
  ok: boolean;
  findings: ProposalValidationFinding[];
}

export interface ProposalValidationContext {
  parsedRef?: AssetRef;
  stop?: boolean;
  /** The source asset, for the improve-stage guards; absent at accept, where they no-op. */
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
