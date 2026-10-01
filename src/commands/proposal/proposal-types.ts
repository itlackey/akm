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
 * `scope` > `signal-delta` > `proactive` > `high-salience`. `unknown` is only
 * for a lane that genuinely cannot be attributed; `forgetting-safety` and
 * `replay` are retired (0.9.17-alpha.9, R5, and earlier respectively) —
 * neither is assigned by anything any more, both appear on rows older
 * releases wrote.
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
  /** The consolidate pair pass's own retire proposals (alpha.9, S6) — kept apart from `consolidate`'s promotions so a bulk `accept --generator consolidate` never sweeps a retirement, and the reverse. */
  "consolidate-pair",
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
  "consolidate-pair",
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
 * A rejection `akm proposal reopen` undid, kept on the proposal so reopening
 * it never erases what happened. The rejection's `gateDecision` is recorded
 * here too, and cleared from the proposal unless it is a `deferred` one: a
 * reopened proposal is adjudicated afresh, whereas a stale `staged` verdict
 * would let the drain accept it unseen and another gate's `auto-rejected`
 * would have the drain skip it. A `deferred` verdict (the quality gate's
 * hand-off to a person) stays, so the drain keeps leaving it alone.
 */
export interface ProposalReviewHistoryEntry {
  /** The rejection that was undone, as recorded when it was made. */
  review?: ProposalReview;
  gateDecision?: ProposalGateDecision;
  reopenedAt: string;
  /** The `--reason` given to `akm proposal reopen`. */
  reopenReason?: string;
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
  /** The quality judge's per-criterion scores, on a `quality-gate` pass. */
  scores?: Record<string, number>;
  /** The quality judge's one-sentence reason, on a `quality-gate` pass. */
  judgeReason?: string;
  gate?: string;
  decidedAt: string;
}

/**
 * A consolidate pair-pass retire proposal's metadata (plan §5.2, alpha.9
 * brief §A "Proposal"). `ref` is the retired asset (same as `Proposal.ref`);
 * `reason` is the tombstone vocabulary `archiveCleanupCandidate` writes,
 * derived from `judgeLabel` (`supersedes` → `superseded`, the other two
 * labels unchanged).
 */
export type RetireReason = "duplicate" | "subsumed" | "superseded" | "promoted";

export interface RetirementMetadata {
  /** The ref being retired — redundant with `Proposal.ref`, kept explicit for metadata-only readers. */
  retiredRef: string;
  /** The ref that survives this pair. */
  successorRef: string;
  /** Cosine similarity between the judged pair. */
  cosine: number;
  /** The pair judge's raw classification. */
  judgeLabel: "duplicate" | "subsumed" | "supersedes";
  /** The judge's own explanation (<=25 words, its `reason` field). */
  judgeReason: string;
  /** Body-content hash (`contentHash(_, "body")`) of the retired asset at judge time. */
  retiredContentHash: string;
  /** Body-content hash of the successor asset at judge time. */
  successorContentHash: string;
  /** Tombstone-vocabulary reason (`judgeLabel` translated: supersedes -> superseded). */
  reason: Exclude<RetireReason, "promoted">;
  /**
   * Set at mint by the retirement continuity check (alpha.9 plan §5.4, rule
   * R3) when the retired asset ranked top 10 for one of its own past queries
   * but the successor did not. The proposal still mints — a person can still
   * accept it by id — but it is excluded from every bulk accept path.
   */
  continuityRisk?: RetirementContinuityRisk;
}

/** One query where the retired asset ranked top 10 but the successor did not. */
export interface ContinuityRiskRank {
  query: string;
  retiredRank: number;
  /** `null`: the successor did not rank in the top 10 at all for this query. */
  successorRank: number | null;
}

/** The retirement continuity check's failure report (see {@link RetirementMetadata.continuityRisk}). */
export interface RetirementContinuityRisk {
  /** Of the replayed queries, how many the successor failed to also rank top 10 for. */
  failingQueries: number;
  ranks: ContinuityRiskRank[];
  /**
   * Of the replayed queries, how many could not be verified (S2): the
   * search call threw, or fell back to keyword-only ranking instead of the
   * real one. Omitted when every query was verified. A proposal carrying
   * this is excluded from bulk accept the same as a `failingQueries` one —
   * an unverified query must never read as "no risk found".
   */
  unverifiedQueries?: number;
}

/**
 * Where an archived retire proposal's files ended up (accept-time only, so
 * `akm proposal revert` can find them without re-scanning every tombstone).
 * Stash-relative paths, one per archived file (the retired asset, plus its
 * `.derived` twin when one was archived alongside it).
 */
export interface RetiredArchiveRecord {
  dirs: string[];
}

/**
 * A retire accept's durable intent (should-fix 5), recorded on the still-
 * "pending" proposal BEFORE any file is moved: the exact bytes to preserve
 * as `backupContent`. A crashed accept resumes from this record instead of
 * re-deriving it from whatever the archive happens to contain. No `twinPath`
 * (4d, third review round, dropped as redundant): the twin, if any, is a
 * pure function of `assetPath` and the ref's type (`derivedTwinPath`), and
 * whether it was already archived by an earlier, crashed attempt is exactly
 * what the tombstone scan (`alreadyArchivedOriginalPaths`) independently
 * finds — nothing a stored path adds to either.
 */
export interface RetireAcceptIntent {
  assetPath: string;
  backupContent: string;
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
  /** Rejections undone by `akm proposal reopen`, oldest first; absent on a proposal never reopened. */
  reviewHistory?: ProposalReviewHistoryEntry[];
  /** Self-estimated confidence in [0, 1], for reviewers. */
  confidence?: number;
  gateDecision?: ProposalGateDecision;
  /** The target's content before promotion (absent for new assets), for revert. Never shown. */
  backupContent?: string;
  /** Exactly where the accepted content went; prevents cross-target revert. */
  acceptedTarget?: { source: string; root: string; path: string; contentHash: string };
  eligibilitySource?: EligibilitySource;
  /** Consolidate pair-pass retire proposals only (alpha.9): set at mint. */
  retirement?: RetirementMetadata;
  /** Set at accept time for a retire proposal; read back by `akm proposal revert`. */
  retiredArchive?: RetiredArchiveRecord;
  /**
   * A consolidate PROMOTION proposal's source memory ref (alpha.9, O1): set
   * at mint by `emitPromotionProposal`. On accept, `promoteProposal` retires
   * this memory (and its `.derived` twin) through the same archive path, so
   * an accepted promotion no longer leaves a memory/knowledge duplicate
   * behind — whether a person accepts it or triage auto-promotion does.
   */
  promotionSource?: string;
  /**
   * Body content hash (`contentHash(_, "body")`) of `promotionSource` at
   * mint time (alpha.9, B3). Accept re-reads the source and only archives it
   * when the hash still matches — an edit made after the promotion was
   * queued survives, not silently discarded into the archive. Absent on a
   * proposal minted before this field existed; those never archive their
   * source (no hash to verify freshness against).
   */
  promotionSourceHash?: string;
  /**
   * A pending retire proposal's recorded accept intent (should-fix 5), set
   * right before the first file move and cleared once accept finishes.
   * Still present means a prior accept attempt crashed after recording it
   * but before finishing — the next accept resumes from it idempotently
   * rather than re-deriving `backupContent` from whatever is on disk now.
   */
  retireAcceptIntent?: RetireAcceptIntent;
}

/**
 * When a pending proposal's wait for review began: its last reopen (#997), else
 * its creation. Every age-based sweep — retention expiry, and `--older-than` on
 * bulk accept/reject and on `drain` — counts from here, so a proposal just put
 * back in the queue is not swept as if it had been waiting since it was first
 * created (a scheduled `drain --older-than 7 --promote` would otherwise take
 * it at once).
 */
export function proposalWaitingSince(proposal: Pick<Proposal, "createdAt" | "reviewHistory">): string {
  return proposal.reviewHistory?.at(-1)?.reopenedAt ?? proposal.createdAt;
}

/** A pending or accepted proposal whose primary change deletes its target (a consolidate retire proposal, alpha.9). */
export function isRetireProposal(proposal: Pick<Proposal, "changes">): boolean {
  return proposal.changes[0]?.op === "delete";
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
