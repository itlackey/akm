// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal substrate (#225, storage consolidated in #578).
 *
 * One durable proposal store for every future reflection / generation flow
 * (`akm reflect`, `akm propose`, `akm distill`, lesson distillation, …).
 * Proposals are *queue state*, not source-of-truth assets — they sit in the
 * queue waiting for human (or automated) review and only become assets after
 * `akm proposal accept` validates and promotes them via
 * {@link writeAssetToSource}.
 *
 * # Storage
 *
 * The canonical store is the `proposals` table in `state.db` (SQLite, WAL
 * mode — see `src/core/state-db.ts`). Rows are partitioned by `stash_dir` so
 * multi-stash installs keep independent queues, and the `status` column
 * distinguishes the live queue (`pending`) from the archive (`accepted` /
 * `rejected` / `reverted`). There is no separate archive location — archival
 * is a status flip, and the full audit trail (review outcome, reason, backup
 * content for revert) lives on the row.
 *
 * ## Legacy filesystem import
 *
 * Before 0.9.0 proposals lived as per-uuid JSON directories under
 * `<stashDir>/.akm/proposals/` (live) and `…/proposals/archive/` (archived).
 * The first proposal operation against a stash imports any legacy
 * `proposal.json` files into the table (INSERT OR IGNORE keyed on the UUID,
 * so re-runs never duplicate) and records the stash in `proposal_fs_imports`
 * so later invocations skip the directory walk. The legacy files are left in
 * place untouched — they are inert after import and may be removed by the
 * operator at leisure.
 *
 * # Why the queue bypasses `writeAssetToSource`
 *
 * The architectural rule "all writes go through `writeAssetToSource`" applies
 * to *assets*. Proposals are **not** assets — they live outside the asset
 * tree (in state.db, parallel to how events do). Routing them through
 * `writeAssetToSource` would force them into a `TYPE_DIRS` slot, would commit
 * them to git, and would leak unaccepted drafts through the normal indexer.
 * The {@link promoteProposal} step is the bridge: it routes the accepted
 * payload through `writeAssetToSource` so the actual asset write still
 * funnels through the single dispatch point in `src/core/write-source.ts`.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AssetRef } from "../../../core/asset/asset-ref";
import { makeAssetRef, parseAssetRef } from "../../../core/asset/asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "../../../core/asset/asset-spec";
import type { AkmConfig } from "../../../core/config/config";
import { NotFoundError, UsageError } from "../../../core/errors";
import { appendEvent } from "../../../core/events";
import type { EligibilitySource } from "../../../core/improve-types";
import {
  type Database,
  getStateProposal,
  hasImportedFsProposals,
  insertProposalIfAbsent,
  listStateProposalIdsByPrefix,
  listStateProposals,
  recordFsProposalsImport,
  upsertProposal,
  withImmediateTransaction,
  withStateDb,
} from "../../../core/state-db";
import { repairTruncatedDescription } from "../../../core/text-truncation";
import { warn } from "../../../core/warn";
import {
  commitWriteTargetBoundary,
  formatRefForMessage,
  resolveWriteTarget,
  type WriteTargetSource,
  writeAssetToSource,
} from "../../../core/write-source";
import { runProposalValidators } from "./proposal-validators";

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
  "recombine",
  "procedural",
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
  "recombine",
  "procedural",
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

/**
 * Typed reasons {@link createProposal} can reject input. Emitted in the
 * `proposal_creation_rejected` event so we can quantify *which* check fires
 * most across runs and tune upstream pipelines.
 */
export type ProposalRejectionReason = "invalid_ref" | "unknown_type" | "empty_content" | "missing_description";

/** Result of {@link purgeOrphanProposals}. */
export interface OrphanPurgeResult {
  /** Total pending proposals scanned. */
  checked: number;
  /** Number of proposals rejected as orphans. */
  rejected: number;
  /** Wall-clock duration of the purge in ms. */
  durationMs: number;
  /** Count of rejections by asset type prefix. */
  byType: Record<string, number>;
  /** Per-orphan details for the event metadata. */
  orphans: Array<{ id: string; ref: string; reason: string }>;
}

/** Result of {@link expireStaleProposals} (Advantage D6b / Phase 6B). */
export interface ExpireStaleResult {
  /** Number of pending proposals scanned for expiry. */
  checked: number;
  /** Number of proposals archived because they aged past the retention window. */
  expired: number;
  /** Wall-clock duration of the expiration pass in ms. */
  durationMs: number;
  /** Retention threshold (days) applied during this pass. */
  retentionDays: number;
  /** Per-expired details for the event metadata. */
  expiredProposals: Array<{ id: string; ref: string; ageDays: number }>;
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
  /** Full file content the accepted proposal will write to disk. */
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
 * The verdict an automated gate (the deterministic drain/triage engine or the
 * `akm improve` confidence gate) reached for this proposal (#577).
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
   * decision. The vocabulary actually persisted today:
   *
   *   - improve gate: `above-threshold`, `below-threshold`, `no-confidence`,
   *     `exploration-budget` (WS-4 — promoted regardless of confidence; excluded
   *     from auto-tune calibration).
   *   - drain/triage gate: `empty-diff`, `max-diff-lines`, `min-content-lines`,
   *     `policy-accept`, `mid-band`, `possible-dup`, `no-judge-configured`,
   *     `judgment-accept`, `judgment-reject`.
   *
   * The spec (#577) also names `type-filter` as an example token, but that is a
   * *ref-level* improve pre-filter (`shouldSkipRef`) that runs before any
   * proposal exists — there is no proposal to stamp at that point — so no gate
   * path persists it. It is documented here only as a spec example.
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
    /** Confidence auto-accept threshold in `[0, 1]` (improve gate). */
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
  review?: ProposalReview;
  /**
   * Optional confidence score in `[0, 1]` (Advantage D6a / Phase 6A).
   *
   * When the proposal source can self-estimate quality (e.g. the reflect LLM
   * returning a calibrated score with its draft), this value drives the
   * auto-accept policy in `akm improve`. Proposals with `confidence` at or
   * above the active confidence threshold are accepted without reviewer
   * intervention; everything else waits in the pending queue.
   *
   * Out-of-range or non-finite values are stripped at {@link createProposal}
   * time so downstream code can rely on the invariant `0 <= confidence <= 1`.
   */
  confidence?: number;
  /**
   * The automated gate's verdict for this proposal (#577), recorded at gate
   * time by the drain/triage engine or the `akm improve` confidence gate.
   *
   * Carries the decision (auto-accepted / deferred / auto-rejected), the reason
   * token, the confidence the gate computed, and the thresholds in effect, so
   * `akm proposal show` / `list` can explain why a proposal is pending without
   * the operator reconstructing it from run-level aggregates.
   *
   * Absent on proposals that never passed through a gate, and on every proposal
   * created before 0.9.0 (forward-only — no backfill). Renderers must treat a
   * missing decision as "unknown".
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
  /**
   * Attribution tagging: which eligibility lane selected the source asset for the
   * improve run that produced this proposal (`signal-delta`, `high-retrieval`,
   * `proactive`, `scope`, or `unknown`). Persisted in `metadata_json` so the lane
   * survives to accept/reject/revert time even across runs, letting downstream
   * analysis measure whether the PROACTIVE lane produces value vs the reactive
   * lanes. Absent on proposals created before this field shipped (treat as
   * `"unknown"`) and on human-initiated sources that have no eligibility lane.
   */
  eligibilitySource?: EligibilitySource;
}

export interface ProposalsContext {
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
  /** Test seam — override the state.db path (mirrors `EventsContext.dbPath`). */
  dbPath?: string;
}

export interface CreateProposalInput {
  ref: string;
  /**
   * Origin tag identifying the source subsystem (F-4 / #385).
   *
   * Should be one of {@link PROPOSAL_SOURCES}. Unknown values trigger a
   * runtime warning but are not rejected (backward compatibility).
   * Automated sources ({@link AUTOMATED_PROPOSAL_SOURCES}) should include
   * `sourceRun` for PROV-DM traceability.
   */
  source: ProposalSource | string;
  /**
   * Run identifier for the automated job creating this proposal.
   * Required (advisory) when `source` is an automated source. Logged as a
   * warning when omitted for automated sources so the gap is visible.
   */
  sourceRun?: string;
  payload: ProposalPayload;
  /**
   * When true, bypass dedup and cooldown guards. Use for human-initiated or
   * forced re-proposals that the operator has explicitly requested.
   */
  force?: boolean;
  /**
   * Optional confidence score in `[0, 1]` (Advantage D6a / Phase 6A).
   *
   * Values outside the closed interval `[0, 1]` and non-finite numbers
   * (NaN / ±Infinity) are silently dropped at create time so the persisted
   * proposal carries only well-formed scores. Callers that cannot estimate
   * confidence should omit the field.
   */
  confidence?: number;
  /**
   * Attribution tagging: the eligibility lane that selected the source asset for
   * the improve run creating this proposal. Forwarded verbatim onto the persisted
   * {@link Proposal} (`eligibilitySource`). Omitted by human-initiated sources
   * (`propose`, `remember`, `import`) that have no eligibility lane.
   */
  eligibilitySource?: EligibilitySource;
}

/**
 * Reason a `createProposal` call was skipped by the dedup/cooldown guard.
 *
 *   - `duplicate_pending`  — A pending proposal already exists for this
 *                            `ref+source` combination. Pass `force: true` to
 *                            bypass.
 *   - `content_hash_match` — An identical payload (same content hash) is
 *                            already pending or was recently rejected. Bypass
 *                            with `force: true`.
 *   - `cooldown`           — A proposal for this `ref+source` was rejected
 *                            within the source-specific cooldown window
 *                            (reflect: 14 d, distill: 30 d, others: 7 d).
 */
export type ProposalSkipReason = "duplicate_pending" | "content_hash_match" | "cooldown";

export interface CreateProposalSkipped {
  skipped: true;
  reason: ProposalSkipReason;
  /** Human-readable explanation for logs / telemetry. */
  message: string;
  /** The existing proposal that triggered the guard (when applicable). */
  existingProposalId?: string;
}

/** Result of {@link createProposal} — either a new `Proposal` or a skip record. */
export type CreateProposalResult = Proposal | CreateProposalSkipped;

/** Type guard: true when createProposal returned a skipped record. */
export function isProposalSkipped(result: CreateProposalResult): result is CreateProposalSkipped {
  return (result as CreateProposalSkipped).skipped === true;
}

// ── Dedup / cooldown constants ───────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Post-rejection cooldown windows by source. After a proposal is rejected,
 * `createProposal` silently skips new proposals for the same `ref+source`
 * until the window expires (unless `force: true` is passed).
 *
 * Rationale (Settles 2009 active-learning survey; Argilla/Label Studio HITL):
 * Reviewer fatigue is a blocker for the human-in-the-loop guarantee. Cooldowns
 * prevent nightly improve runs from re-flooding the queue with near-identical
 * proposals the reviewer just declined.
 *
 *   - reflect: 14 days (agent-based; slower feedback loops)
 *   - distill: 30 days (LLM-based; even more prone to regeneration loops)
 *   - default: 7 days  (conservative fallback for other sources)
 */
const COOLDOWN_MS: Record<string, number> = {
  reflect: 14 * MS_PER_DAY,
  distill: 30 * MS_PER_DAY,
};
const DEFAULT_COOLDOWN_MS = 7 * MS_PER_DAY;

function cooldownMsForSource(source: string): number {
  return COOLDOWN_MS[source] ?? DEFAULT_COOLDOWN_MS;
}

/** Compute a stable SHA-256 hex digest of a proposal's content string. */
function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Store access ─────────────────────────────────────────────────────────────

function nowIso(ctx?: ProposalsContext): string {
  const fn = ctx?.now ?? Date.now;
  return new Date(fn()).toISOString();
}

function newId(ctx?: ProposalsContext): string {
  const fn = ctx?.randomUUID ?? randomUUID;
  return fn();
}

/**
 * Open the state database (honouring the `ctx.dbPath` test seam), run the
 * legacy filesystem import for `stashDir` if it has not happened yet, hand the
 * connection to `fn`, and close it in a `finally`. Every public function in
 * this module funnels its store access through here so the legacy import is
 * guaranteed to have run before any read or write.
 */
function withProposalsDb<T>(stashDir: string, ctx: ProposalsContext | undefined, fn: (db: Database) => T): T {
  return withStateDb(
    (db) => {
      importLegacyProposalFiles(db, stashDir);
      return fn(db);
    },
    { path: ctx?.dbPath },
  );
}

// ── Legacy filesystem import (#578) ─────────────────────────────────────────

/** Legacy (pre-0.9.0) proposal directory: `<stashDir>/.akm/proposals[/archive]`. */
function legacyProposalsRoot(stashDir: string, archive: boolean): string {
  const root = path.join(stashDir, ".akm", "proposals");
  return archive ? path.join(root, "archive") : root;
}

/**
 * Shape of a legacy `proposal.json` file. Identical to {@link Proposal} except
 * that the pre-0.9.0 `backup` field held a path (relative to the proposal
 * directory) instead of the backup content itself.
 */
type LegacyProposalFile = Omit<Proposal, "backupContent"> & { backup?: string };

/**
 * One-shot import of legacy `proposal.json` files into the `proposals` table.
 *
 * Idempotent at two levels: the `proposal_fs_imports` ledger skips the
 * directory walk after the first successful import, and INSERT OR IGNORE
 * (keyed on the proposal UUID) protects against duplicates even if the walk
 * re-runs. Legacy `backup.<ext>` files are inlined into `backupContent` so
 * `akm proposal revert` keeps working for proposals accepted before 0.9.0.
 *
 * The legacy files are never modified or deleted — after import they are
 * inert artifacts the operator can remove at leisure.
 */
function importLegacyProposalFiles(db: Database, stashDir: string): void {
  if (hasImportedFsProposals(db, stashDir)) return;
  const liveRoot = legacyProposalsRoot(stashDir, false);
  if (!fs.existsSync(liveRoot)) return;

  let imported = 0;
  for (const archive of [false, true]) {
    const root = legacyProposalsRoot(stashDir, archive);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "archive") continue;
      const proposalDir = path.join(root, entry.name);
      const proposal = readLegacyProposalFile(proposalDir);
      if (!proposal) continue;
      if (insertProposalIfAbsent(db, proposal, stashDir)) imported += 1;
    }
  }

  recordFsProposalsImport(db, stashDir, imported);
  if (imported > 0) {
    warn(`[proposals] imported ${imported} legacy proposal file(s) from ${liveRoot} into state.db`);
  }
}

/**
 * Parse one legacy proposal directory into a {@link Proposal}, inlining the
 * backup file (when present) as `backupContent`. Returns undefined — with a
 * warning — when the `proposal.json` is missing, unreadable, or malformed, so
 * a single corrupt legacy entry never blocks the import of the rest.
 */
function readLegacyProposalFile(proposalDir: string): Proposal | undefined {
  const filePath = path.join(proposalDir, "proposal.json");
  let parsed: LegacyProposalFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyProposalFile;
  } catch (err) {
    warn(`[proposals] skipping legacy proposal at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.id !== "string" ||
    typeof parsed.ref !== "string"
  ) {
    warn(`[proposals] skipping legacy proposal at ${filePath}: not a proposal object`);
    return undefined;
  }

  const { backup, ...rest } = parsed;
  let backupContent: string | undefined;
  if (typeof backup === "string" && backup.length > 0) {
    try {
      backupContent = fs.readFileSync(path.join(proposalDir, backup), "utf8");
    } catch {
      // Backup file lost — import the proposal anyway; revert for it will
      // surface "no backup available", same as a new-asset proposal.
    }
  }

  return {
    ...rest,
    payload: {
      content: rest.payload?.content ?? "",
      ...(rest.payload?.frontmatter ? { frontmatter: rest.payload.frontmatter } : {}),
    },
    createdAt: rest.createdAt ?? "",
    updatedAt: rest.updatedAt ?? rest.createdAt ?? "",
    status: rest.status ?? "pending",
    source: rest.source ?? "import",
    ...(backupContent !== undefined ? { backupContent } : {}),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new pending proposal. The id is a stable random UUID, so two
 * proposals with the same `ref` never collide.
 *
 * **Dedup / cooldown guard** (F-2 / #363):
 *
 * Before writing, this function checks:
 *   1. `duplicate_pending` — a pending proposal already exists for the same
 *      `ref+source`. Pass `input.force = true` to bypass.
 *   2. `content_hash_match` — an identical content hash is already pending or
 *      was recently rejected for this `ref+source`. Bypass with `force: true`.
 *   3. `cooldown` — a proposal for this `ref+source` was rejected within the
 *      source-specific cooldown window (reflect: 14 d, distill: 30 d,
 *      others: 7 d). Bypass with `force: true`.
 *
 * When a guard fires the function returns a `CreateProposalSkipped` record
 * instead of writing. Use {@link isProposalSkipped} to detect it.
 */
export function createProposal(
  stashDir: string,
  input: CreateProposalInput,
  ctx?: ProposalsContext,
): CreateProposalResult {
  // F-4 / #385: Validate source against the allow-list. Unknown values are
  // warned (not rejected) for backward compatibility — extension callers
  // that pass custom source strings must not break.
  if (!isValidProposalSource(input.source)) {
    warn(
      `[proposal] Unknown source "${input.source}". ` +
        `Expected one of: ${PROPOSAL_SOURCES.join(", ")}. ` +
        "Typos in source values produce unaggregatable accept-rate-per-source metrics.",
    );
  } else if (isAutomatedProposalSource(input.source) && !input.sourceRun) {
    // Advisory warning: automated sources should include sourceRun for PROV-DM
    // traceability. This is not a hard error to avoid breaking existing callers.
    warn(
      `[proposal] Automated source "${input.source}" created a proposal without sourceRun. ` +
        "Add sourceRun to enable accept-rate-per-run aggregation (W3C PROV-DM).",
    );
  }

  // Deterministic input validation. Reject obviously-invalid proposals at
  // the source rather than letting them enter the queue and waste reviewer
  // time. Each rejection emits `proposal_creation_rejected` with a typed
  // reason so we can see *which* check is firing in the event stream.
  const rejectProposal = (reason: ProposalRejectionReason, message: string): never => {
    appendEvent({
      eventType: "proposal_creation_rejected",
      ref: input.ref,
      metadata: { source: input.source, reason },
    });
    throw new UsageError(message, "INVALID_PROPOSAL");
  };

  let parsedRef: ReturnType<typeof parseAssetRef>;
  try {
    parsedRef = parseAssetRef(input.ref);
  } catch (err) {
    return rejectProposal(
      "invalid_ref",
      `Invalid proposal ref "${input.ref}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!TYPE_DIRS[parsedRef.type]) {
    return rejectProposal(
      "unknown_type",
      `Unknown asset type "${parsedRef.type}" in proposal ref "${input.ref}". Known types: ${Object.keys(TYPE_DIRS).sort().join(", ")}.`,
    );
  }
  if (!input.payload.content.trim()) {
    return rejectProposal("empty_content", `Proposal for "${input.ref}" has empty content.`);
  }
  // Description check is only enforced for `consolidate` source — that's the
  // automated pipeline that historically produced proposals with missing or
  // malformed frontmatter, polluting the queue with hundreds of unusable
  // entries. Reflect / distill / propose proposals have varied legitimate
  // shapes and should not be rejected here for missing description.
  if (input.source === "consolidate") {
    const desc = input.payload.frontmatter?.description;
    if (typeof desc !== "string" || desc.trim() === "") {
      return rejectProposal(
        "missing_description",
        `Proposal for "${input.ref}" (source=consolidate) has empty or missing frontmatter description.`,
      );
    }
  }

  const normalizedRef = makeAssetRef(parsedRef.type, parsedRef.name, parsedRef.origin);

  return withProposalsDb(stashDir, ctx, (db) => {
    return withImmediateTransaction(db, () => {
      if (!input.force) {
        const skip = checkDedupAndCooldown(db, stashDir, normalizedRef, input, ctx);
        if (skip) return skip;
      }

      const created = nowIso(ctx);

      // Phase 6A: validate confidence is a finite number in [0, 1]. Anything else
      // is dropped silently — we never store NaN, Infinity, or out-of-range values.
      // Callers that mis-report confidence should not poison the auto-accept gate.
      const sanitizedConfidence =
        typeof input.confidence === "number" &&
        Number.isFinite(input.confidence) &&
        input.confidence >= 0 &&
        input.confidence <= 1
          ? input.confidence
          : undefined;

      const proposal: Proposal = {
        id: newId(ctx),
        ref: normalizedRef,
        status: "pending",
        source: input.source,
        ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
        createdAt: created,
        updatedAt: created,
        payload: {
          content: input.payload.content,
          ...(input.payload.frontmatter !== undefined ? { frontmatter: input.payload.frontmatter } : {}),
        },
        ...(sanitizedConfidence !== undefined ? { confidence: sanitizedConfidence } : {}),
        // Attribution tagging: persist the eligibility lane so it survives to
        // accept/reject/revert time. See EligibilitySource.
        ...(input.eligibilitySource !== undefined ? { eligibilitySource: input.eligibilitySource } : {}),
      };

      upsertProposal(db, proposal, stashDir);
      return proposal;
    });
  });
}

/**
 * Evaluate the F-2 dedup / cooldown guards against the store. Returns the
 * skip record when a guard fires, or undefined when the create may proceed.
 */
function checkDedupAndCooldown(
  db: Database,
  stashDir: string,
  normalizedRef: string,
  input: CreateProposalInput,
  ctx: ProposalsContext | undefined,
): CreateProposalSkipped | undefined {
  const newHash = contentHash(input.payload.content);
  const nowMs = (ctx?.now ?? Date.now)();
  const cooldownMs = cooldownMsForSource(input.source);

  // Scan pending proposals for ref+source matches.
  const pending = listStateProposals(db, { stashDir, ref: normalizedRef, status: "pending" }).filter(
    (p) => p.source === input.source,
  );

  if (pending.length > 0) {
    // Check for identical content hash first (silent skip).
    const hashMatch = pending.find((p) => contentHash(p.payload.content) === newHash);
    if (hashMatch) {
      return {
        skipped: true,
        reason: "content_hash_match",
        message: `Identical proposal for ${normalizedRef} already pending (id: ${hashMatch.id}).`,
        existingProposalId: hashMatch.id,
      };
    }
    // Duplicate pending for same ref+source (different content).
    const firstPending = pending[0];
    return {
      skipped: true,
      reason: "duplicate_pending",
      message: `A pending proposal for ${normalizedRef} from source "${input.source}" already exists (id: ${firstPending?.id ?? "unknown"}). Pass force:true to enqueue alongside it.`,
      existingProposalId: firstPending?.id,
    };
  }

  // Check cooldown against recently rejected proposals.
  const rejected = listStateProposals(db, { stashDir, ref: normalizedRef, status: "rejected" })
    .filter((p) => p.source === input.source)
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());

  const mostRecent = rejected[0];
  if (mostRecent !== undefined) {
    // Check content hash against recently rejected.
    if (contentHash(mostRecent.payload.content) === newHash) {
      return {
        skipped: true,
        reason: "content_hash_match",
        message: `Identical proposal for ${normalizedRef} was already rejected (id: ${mostRecent.id}).`,
        existingProposalId: mostRecent.id,
      };
    }
    // Check cooldown window.
    const rejectedAt = new Date(mostRecent.updatedAt ?? 0).getTime();
    if (nowMs - rejectedAt < cooldownMs) {
      const cooldownDays = cooldownMs / MS_PER_DAY;
      const remainingDays = Math.ceil((cooldownMs - (nowMs - rejectedAt)) / MS_PER_DAY);
      return {
        skipped: true,
        reason: "cooldown",
        message:
          `Proposal for ${normalizedRef} from source "${input.source}" is in cooldown ` +
          `(${cooldownDays}d window, ~${remainingDays}d remaining). Pass force:true to bypass.`,
        existingProposalId: mostRecent.id,
      };
    }
  }

  return undefined;
}

/**
 * List proposals for one stash. By default returns only the live (pending)
 * queue; pass `{ includeArchive: true }` to include accepted / rejected /
 * reverted entries as well.
 */
export function listProposals(
  stashDir: string,
  options: { includeArchive?: boolean; status?: ProposalStatus; ref?: string; type?: string } = {},
  ctx?: ProposalsContext,
): Proposal[] {
  return withProposalsDb(stashDir, ctx, (db) => {
    // Without includeArchive, only the live queue is visible — an explicit
    // non-pending status filter therefore matches nothing (mirrors the
    // historical live-directory scan).
    if (!options.includeArchive && options.status !== undefined && options.status !== "pending") {
      return [];
    }
    const status = options.includeArchive ? options.status : "pending";
    return listStateProposals(db, {
      stashDir,
      ...(status !== undefined ? { status } : {}),
      ...(options.ref !== undefined ? { ref: options.ref } : {}),
    }).filter((p) => {
      if (!options.type) return true;
      try {
        return parseAssetRef(p.ref).type === options.type;
      } catch {
        return false;
      }
    });
  });
}

/**
 * Look up a proposal by id (live or archived).
 * Throws `NotFoundError` when no match exists in this stash.
 */
export function getProposal(stashDir: string, id: string, ctx?: ProposalsContext): Proposal {
  return withProposalsDb(stashDir, ctx, (db) => requireProposal(db, stashDir, id));
}

function requireProposal(db: Database, stashDir: string, id: string): Proposal {
  const proposal = getStateProposal(db, id, stashDir);
  if (!proposal) {
    throw new NotFoundError(`Proposal "${id}" not found.`, "FILE_NOT_FOUND");
  }
  return proposal;
}

/**
 * Resolve a proposal by full UUID, UUID prefix, or asset ref.
 *
 * Resolution order:
 *   1. Exact UUID match (existing behaviour).
 *   2. Asset ref (contains `:`) — finds the most-recent pending proposal for
 *      that ref; falls back to archived if nothing is pending.
 *   3. UUID prefix — matches any PENDING proposal whose id starts with the
 *      given string; throws if ambiguous.
 */
export function resolveProposalId(stashDir: string, idOrRef: string, ctx?: ProposalsContext): Proposal {
  return withProposalsDb(stashDir, ctx, (db) => {
    // 1. Exact UUID.
    const exact = getStateProposal(db, idOrRef, stashDir);
    if (exact) return exact;

    // 2. Asset ref (e.g. "skill:akm-dream") — most recent pending, else most
    // recent archived.
    if (idOrRef.includes(":")) {
      const byRecency = (proposals: Proposal[]): Proposal | undefined =>
        proposals.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
      const pending = byRecency(listStateProposals(db, { stashDir, ref: idOrRef, status: "pending" }));
      if (pending) return pending;
      const archived = byRecency(listStateProposals(db, { stashDir, ref: idOrRef }));
      if (archived) return archived;
      throw new NotFoundError(`No proposal found for ref "${idOrRef}".`, "FILE_NOT_FOUND");
    }

    // 3. UUID prefix (pending queue only).
    const prefixMatches = listStateProposalIdsByPrefix(db, stashDir, idOrRef);
    if (prefixMatches.length === 1) return requireProposal(db, stashDir, prefixMatches[0]);
    if (prefixMatches.length > 1) {
      throw new UsageError(
        `Ambiguous prefix "${idOrRef}" — matches: ${prefixMatches.join(", ")}`,
        "INVALID_FLAG_VALUE",
      );
    }

    throw new NotFoundError(`Proposal "${idOrRef}" not found.`, "FILE_NOT_FOUND");
  });
}

/**
 * Archive a proposal: flip its status to `accepted` / `rejected`, bump
 * `updatedAt`, and record the review block. Used by both accept and reject
 * paths so the live queue only contains pending entries.
 */
export function archiveProposal(
  stashDir: string,
  id: string,
  status: "accepted" | "rejected",
  reason: string | undefined,
  ctx?: ProposalsContext,
): Proposal {
  return withProposalsDb(stashDir, ctx, (db) => {
    return withImmediateTransaction(db, () => {
      const existing = requireProposal(db, stashDir, id);
      if (existing.status !== "pending") {
        throw new UsageError(
          `Proposal ${id} is not pending (current status: ${existing.status}). Only pending proposals can be ${status}.`,
          "INVALID_FLAG_VALUE",
        );
      }
      const decidedAt = nowIso(ctx);
      const updated: Proposal = {
        ...existing,
        status,
        updatedAt: decidedAt,
        review: {
          outcome: status,
          ...(reason !== undefined ? { reason } : {}),
          decidedAt,
        },
      };
      upsertProposal(db, updated, stashDir);
      return updated;
    });
  });
}

/**
 * Record an automated gate's decision onto a proposal (#577).
 *
 * Stamps `gateDecision` (decision / reason / confidence / thresholds) onto the
 * row so `akm proposal show` and `list` can explain why a proposal landed where
 * it did. The decision is metadata about the adjudication, so this does NOT
 * change `status` or bump `updatedAt` — a `deferred` proposal stays `pending`,
 * and the accept / reject status flips are owned by {@link promoteProposal} /
 * {@link archiveProposal}. `decidedAt` defaults to now when the caller omits it.
 *
 * Best-effort: a proposal that no longer exists (e.g. concurrently archived) is
 * skipped silently rather than throwing, so a gate run never aborts mid-batch.
 * Returns the updated proposal, or undefined when no matching row exists.
 */
export function recordGateDecision(
  stashDir: string,
  id: string,
  decision: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string },
  ctx?: ProposalsContext,
): Proposal | undefined {
  return withProposalsDb(stashDir, ctx, (db) => {
    return withImmediateTransaction(db, () => {
      const existing = getStateProposal(db, id, stashDir);
      if (!existing || existing.status !== "pending") return undefined;
      const updated: Proposal = {
        ...existing,
        gateDecision: { ...decision, decidedAt: decision.decidedAt ?? nowIso(ctx) },
      };
      upsertProposal(db, updated, stashDir);
      return updated;
    });
  });
}

/**
 * Scan all pending proposals and reject those whose target asset no longer
 * exists on disk across any of `sourceDirs`. Intended to run as a periodic
 * maintenance pass (see `runImproveMaintenancePasses`) — it keeps the queue
 * from accumulating stale reviewer work after large refactors or deletes.
 *
 * Scope rule: only `source=reflect` proposals are subject to orphan rejection.
 * Lessons, propose, distill, and consolidate proposals legitimately target
 * assets that don't exist yet and must never be purged.
 */
export function purgeOrphanProposals(
  stashDir: string,
  sourceDirs: string[],
  ctx?: ProposalsContext,
): OrphanPurgeResult {
  const t0 = Date.now();
  const orphans: Array<{ id: string; ref: string; reason: string }> = [];
  const byType: Record<string, number> = {};
  const pending = listProposals(stashDir, { status: "pending" }, ctx);
  const reflectPending = pending.filter((p) => p.source === "reflect");

  for (const p of reflectPending) {
    let parsed: ReturnType<typeof parseAssetRef>;
    try {
      parsed = parseAssetRef(p.ref);
    } catch {
      continue;
    }
    // Lessons are new-asset proposals by definition — they cannot be orphaned.
    if (parsed.type === "lesson") continue;
    const spec = TYPE_DIRS[parsed.type];
    if (!spec) continue;

    const exists = sourceDirs.some((root) => {
      const typeRoot = path.join(root, spec);
      const candidate = resolveAssetPathFromName(parsed.type, typeRoot, parsed.name);
      return fs.existsSync(candidate);
    });

    if (!exists) {
      try {
        archiveProposal(stashDir, p.id, "rejected", "Asset no longer exists on disk", ctx);
        orphans.push({ id: p.id, ref: p.ref, reason: "asset_missing" });
        byType[parsed.type] = (byType[parsed.type] ?? 0) + 1;
      } catch (err) {
        // Best-effort — the purge is non-fatal. Log and continue.
        warn(
          `[proposals] purgeOrphanProposals: failed to reject ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    checked: reflectPending.length,
    rejected: orphans.length,
    durationMs: Date.now() - t0,
    byType,
    orphans,
  };
}

/**
 * Archive pending proposals older than `config.archiveRetentionDays` (Advantage
 * D6b / Phase 6B).
 *
 * Reviewer fatigue and queue rot are the dominant failure modes of any
 * human-in-the-loop pipeline (Settles 2009 active-learning survey). Pending
 * proposals that have aged past the retention window are very rarely accepted
 * — the reviewer either intentionally declined to act on them, or the asset
 * they target has drifted enough that the proposal is no longer relevant.
 * Auto-expiring them keeps the live queue focused on actionable work; the
 * archive preserves the full audit trail.
 *
 * Each expired proposal is archived with status `rejected` and reason
 * `"expired: no action within retention window"`. A `proposal_expired` event
 * is appended for each expired proposal so downstream observability (events
 * dashboards, source-acceptance-rate aggregations) can see expiry separately
 * from explicit rejections.
 *
 * Idempotent: a second call within the same retention window finds nothing
 * to expire (the archived entries are no longer in the pending queue).
 */
export function expireStaleProposals(stashDir: string, config: AkmConfig, ctx?: ProposalsContext): ExpireStaleResult {
  const t0 = Date.now();
  const retentionDays = config.archiveRetentionDays ?? 90;
  const expiredProposals: Array<{ id: string; ref: string; ageDays: number }> = [];

  // retentionDays === 0 disables TTL cleanup globally (mirrors how
  // consolidate.ts interprets the same config value).
  if (retentionDays <= 0) {
    return {
      checked: 0,
      expired: 0,
      durationMs: Date.now() - t0,
      retentionDays,
      expiredProposals,
    };
  }

  const retentionMs = retentionDays * MS_PER_DAY;
  const nowMs = (ctx?.now ?? Date.now)();
  const pending = listProposals(stashDir, { status: "pending" }, ctx);

  for (const p of pending) {
    const createdMs = new Date(p.createdAt).getTime();
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = nowMs - createdMs;
    if (ageMs < retentionMs) continue;

    try {
      archiveProposal(stashDir, p.id, "rejected", "expired: no action within retention window", ctx);
      const ageDays = Math.floor(ageMs / MS_PER_DAY);
      expiredProposals.push({ id: p.id, ref: p.ref, ageDays });
      appendEvent({
        eventType: "proposal_expired",
        ref: p.ref,
        metadata: {
          proposalId: p.id,
          source: p.source,
          ...(p.sourceRun !== undefined ? { sourceRun: p.sourceRun } : {}),
          ageDays,
          retentionDays,
        },
      });
    } catch (err) {
      // Best-effort — a single failure must not block the pass.
      warn(
        `[proposals] expireStaleProposals: failed to expire ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    checked: pending.length,
    expired: expiredProposals.length,
    durationMs: Date.now() - t0,
    retentionDays,
    expiredProposals,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

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

/**
 * Validate a proposal payload before promotion. Generic by default — any
 * proposal must parse cleanly and carry a non-empty body. Lessons get the
 * extra per-type lint from {@link lintLessonContent} so the contract documented
 * in v1 spec §13 is enforced at promotion time. Other asset types can hook
 * here in the future without changing call sites.
 */
export function validateProposal(proposal: Proposal): ProposalValidationReport {
  return runProposalValidators(proposal);
}

// ── Content repair ──────────────────────────────────────────────────────────

/**
 * Attempt bounded, deterministic repair of mechanically-fixable defects in a
 * proposal's markdown content. NEVER fabricates text — only strips known-bad
 * structure and applies {@link repairTruncatedDescription} to a truncated
 * description when one is detected.
 *
 * Repairs performed (in order):
 *   1. Strip body lines that restate frontmatter fields as pseudo-frontmatter
 *      (e.g. `**description**: …` or `when_to_use: …` in the body).
 *   2. Remove stray body `---` horizontal-rule lines (leaving exactly the two
 *      frontmatter fences when the content has a valid frontmatter block).
 *   3. Apply {@link repairTruncatedDescription} to a truncated/hanging
 *      `description` field in the frontmatter.
 *
 * Returns the repaired content string. When no repairs apply the input is
 * returned byte-identical so callers can use strict equality to detect
 * whether a repair actually happened.
 *
 * CRITICAL: This function is CONTENT-PRESERVING. Callers MUST re-validate the
 * repaired output via {@link validateProposal} / {@link runProposalValidators}
 * before promotion — a repair that makes things *worse* (or is simply
 * insufficient) must be caught by the existing gate.
 */
export function repairProposalContent(content: string): string {
  if (typeof content !== "string" || content.trim() === "") return content;

  // Determine whether the content has a frontmatter block so we know how
  // many `---` fence lines are expected.
  const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/.test(content);

  // Split into lines for structural repairs.
  const lines = content.split(/\r?\n/);

  // Track whether we are inside the opening frontmatter block so we can
  // leave it untouched and only repair the body.
  let inFrontmatter = false;

  // Frontmatter fence index tracking: first fence opens FM, second closes it.
  let fmOpenSeen = false;
  let fmCloseSeen = false;

  const repairedLines: string[] = [];

  for (const line of lines) {
    const isFence = /^---\s*$/.test(line);

    // Track frontmatter fences (first two `---` fences delimit the FM block).
    if (isFence && !fmCloseSeen) {
      if (!fmOpenSeen) {
        fmOpenSeen = true;
        inFrontmatter = true;
        repairedLines.push(line);
        continue;
      }
      if (inFrontmatter) {
        fmCloseSeen = true;
        inFrontmatter = false;
        repairedLines.push(line);
        continue;
      }
    }

    // We are now in the body (past the frontmatter or no frontmatter).
    if (inFrontmatter) {
      // Still inside the frontmatter — keep as-is.
      repairedLines.push(line);
      continue;
    }

    // Repair 1: Strip pseudo-frontmatter restatements in the body.
    // Matches lines like `**description**: …` or `when_to_use: …`.
    if (/^\s*(\*\*|__)?\s*(description|when_to_use)\s*(\*\*|__)?\s*:/i.test(line)) {
      // Drop the line — it is a structural defect, not user content.
      continue;
    }

    // Repair 2: Remove stray `---` horizontal-rule lines in the body.
    // We keep these only when the content has NO frontmatter (in that case
    // `---` is a legitimate thematic break in plain-body content).
    if (isFence && hasFrontmatter) {
      // Drop: these are extra `---` fences beyond the two frontmatter delimiters.
      continue;
    }

    repairedLines.push(line);
  }

  let repaired = repairedLines.join("\n");

  // Repair 3: Apply repairTruncatedDescription to the description field.
  // We operate on the raw text rather than re-parsing YAML to avoid
  // reformatting unrelated frontmatter keys.
  if (hasFrontmatter) {
    // Extract the body text (after the second `---`) so we can pass it to
    // repairTruncatedDescription as context for the swap-in heuristic.
    const bodyMatch = repaired.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const bodyText = bodyMatch?.[1] ?? "";

    repaired = repaired.replace(
      /^(description:\s*)(.*?)(\r?\n)/m,
      (_match, prefix: string, rawDesc: string, nl: string) => {
        const fixed = repairTruncatedDescription(rawDesc.trim(), bodyText);
        return `${prefix}${fixed}${nl}`;
      },
    );
  }

  return repaired;
}

// ── Promotion ──────────────────────────────────────────────────────────────

export interface PromoteResult {
  proposal: Proposal;
  /** Where the asset was written. */
  assetPath: string;
  /** Normalised asset ref. */
  ref: string;
}

/**
 * Validate a proposal, then promote it through the canonical
 * {@link writeAssetToSource} dispatch (the single place that branches on
 * `source.kind`). On success the proposal is archived with status `accepted`.
 * Validation failures throw a `UsageError` carrying every finding so the CLI
 * can render a single clear error envelope.
 *
 * Phase 6C: when the target asset already exists at the resolved write path,
 * its prior content is captured BEFORE the write and stored on the archived
 * proposal record (`backupContent`) so `akm proposal revert` can restore it.
 * Genuinely-new assets carry no backup.
 */
export async function promoteProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string } = {},
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const proposal = getProposal(stashDir, id, ctx);
  if (proposal.status !== "pending") {
    throw new UsageError(
      `Proposal ${id} is not pending (current status: ${proposal.status}). Only pending proposals can be accepted.`,
      "INVALID_FLAG_VALUE",
    );
  }

  // Attempt bounded auto-repair of mechanically-fixable structural defects
  // (pseudo-frontmatter-in-body, stray `---` fences, truncated description)
  // BEFORE running validation. If the repair produces valid content, we
  // promote the repaired version; if validation still fails, the original
  // error path throws as before. The repair is content-preserving and
  // deterministic — it never invents text.
  const repairedContent = repairProposalContent(proposal.payload.content);
  const proposalToValidate: Proposal =
    repairedContent !== proposal.payload.content
      ? { ...proposal, payload: { ...proposal.payload, content: repairedContent } }
      : proposal;

  const report = validateProposal(proposalToValidate);
  if (!report.ok) {
    const message = report.findings.map((f) => `[${f.kind}] ${f.message}`).join("\n");
    throw new UsageError(
      `Proposal ${id} failed validation:\n${message}`,
      "MISSING_REQUIRED_ARGUMENT",
      "Fix the proposal payload (frontmatter / content) and try again, or reject the proposal with a reason.",
    );
  }

  // Use the (possibly repaired) payload for the promotion write. Persist the
  // repaired content back onto the DB row so the audit trail reflects the
  // final promoted payload (not the defective original).
  if (repairedContent !== proposal.payload.content) {
    withProposalsDb(stashDir, ctx, (db) => {
      const updated: Proposal = { ...proposal, payload: { ...proposal.payload, content: repairedContent } };
      upsertProposal(db, updated, stashDir);
    });
  }

  const ref = parseAssetRef(proposalToValidate.ref);
  if (!TYPE_DIRS[ref.type]) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  const target = resolveWriteTarget(config, options.target);

  // Phase 6C: capture the prior content (if any) BEFORE writing the new
  // asset. We use the resolved write target to compute the exact path the
  // asset would land at — same resolver `writeAssetToSource` uses — so the
  // backup always mirrors what would be overwritten.
  let backupContent: string | undefined;
  try {
    const targetFilePath = resolveAssetFilePathSafe(target.source, ref);
    if (targetFilePath && fs.existsSync(targetFilePath)) {
      backupContent = fs.readFileSync(targetFilePath, "utf8");
    }
  } catch (err) {
    // Backup capture is best-effort. A failure here must not block promotion
    // (the user explicitly asked to accept); we surface a warning so the
    // missing-revert path is visible.
    warn(
      `[proposals] promoteProposal: failed to capture backup for ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const written = await writeAssetToSource(target.source, target.config, ref, repairedContent);
  // 0.9.0 (issue #507): single batch commit at the write boundary for git
  // targets. No-op for filesystem/primary-stash targets.
  commitWriteTargetBoundary(target, `Update ${formatRefForMessage(ref)}`);

  const archived = archiveProposal(stashDir, id, "accepted", undefined, ctx);

  // Persist the backup content on the archived proposal record so the revert
  // flow can restore the prior asset state.
  if (backupContent !== undefined) {
    const withBackup: Proposal = { ...archived, backupContent };
    withProposalsDb(stashDir, ctx, (db) => upsertProposal(db, withBackup, stashDir));
    return { proposal: withBackup, assetPath: written.path, ref: written.ref };
  }

  return { proposal: archived, assetPath: written.path, ref: written.ref };
}

// ── Reversion (Phase 6C) ────────────────────────────────────────────────────

/** Result of {@link revertProposal} (Advantage D6c / Phase 6C). */
export interface RevertResult {
  /** Updated proposal record with status === `"reverted"`. */
  proposal: Proposal;
  /** Path on disk that was restored from backup. */
  assetPath: string;
  /** Asset ref the revert acted on (re-serialized for the CLI envelope). */
  ref: string;
}

/**
 * Restore the prior content of an accepted proposal from the backup captured
 * at promotion time (Advantage D6c / Phase 6C).
 *
 * Pre-conditions:
 *   - `id` resolves to a proposal with `status === "accepted"`.
 *   - The proposal carries `backupContent` (captured by promoteProposal when
 *     the target asset existed before the write).
 *
 * On success:
 *   - The backup content is written back through {@link writeAssetToSource},
 *     so the canonical write-dispatch invariant is preserved.
 *   - The proposal record is updated to `status: "reverted"`.
 *   - Caller emits a `proposal_reverted` event in the CLI layer (mirrors how
 *     `promoted` / `rejected` are emitted by the CLI command, not the core).
 *
 * Errors are thrown as `UsageError` / `NotFoundError` so the CLI can map them
 * cleanly to exit codes — see `src/commands/proposal/proposal.ts` for the
 * wrapper.
 */
export async function revertProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string } = {},
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  const proposal = getProposal(stashDir, id, ctx);
  if (proposal.status !== "accepted") {
    throw new UsageError(
      `only accepted proposals can be reverted (proposal ${id} status: ${proposal.status})`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (proposal.backupContent === undefined) {
    throw new UsageError(
      `no backup available for this proposal (id: ${id})`,
      "MISSING_REQUIRED_ARGUMENT",
      "Backups are only captured when a proposal overwrites an existing asset — new-asset proposals cannot be reverted via this path; delete the asset directly instead.",
    );
  }

  const ref = parseAssetRef(proposal.ref);
  if (!TYPE_DIRS[ref.type]) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  const target = resolveWriteTarget(config, options.target);
  const written = await writeAssetToSource(target.source, target.config, ref, proposal.backupContent);
  // 0.9.0 (issue #507): single batch commit at the write boundary for git
  // targets. No-op for filesystem/primary-stash targets.
  commitWriteTargetBoundary(target, `Revert ${formatRefForMessage(ref)}`);

  // Update the proposal record to status: "reverted" and bump updatedAt +
  // review so the audit trail reflects the second decision.
  const now = nowIso(ctx);
  const reverted: Proposal = {
    ...proposal,
    status: "reverted",
    updatedAt: now,
    review: {
      outcome: "rejected",
      reason: "reverted: prior content restored from backup",
      decidedAt: now,
    },
  };
  withProposalsDb(stashDir, ctx, (db) => upsertProposal(db, reverted, stashDir));

  return { proposal: reverted, assetPath: written.path, ref: written.ref };
}

// ── Diff helpers ────────────────────────────────────────────────────────────

export interface ProposalDiff {
  /** Existing asset content if one is currently materialised. */
  existing: string | null;
  /** Proposed content (always present). */
  proposed: string;
  /** Unified diff text — empty when `existing === proposed`. */
  unified: string;
  /** When true, no asset exists yet at the target ref. */
  isNew: boolean;
  /** Path the diff would write to (if accepted). */
  targetPath?: string;
}

/**
 * Compute a diff between a proposal payload and the existing on-disk asset.
 * Uses {@link resolveWriteTarget} to find where the asset would land — so the
 * diff matches exactly what `accept` will write. Falls back to "new asset"
 * when no asset is currently materialised at the target ref.
 */
export function diffProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string } = {},
  ctx?: ProposalsContext,
): ProposalDiff {
  const proposal = getProposal(stashDir, id, ctx);
  const ref = parseAssetRef(proposal.ref);

  let targetPath: string | undefined;
  let existing: string | null = null;
  try {
    const target = resolveWriteTarget(config, options.target);
    targetPath = resolveAssetFilePathSafe(target.source, ref);
    if (targetPath && fs.existsSync(targetPath)) {
      existing = fs.readFileSync(targetPath, "utf8");
    }
  } catch {
    // No writable target configured — still return a "new asset" diff so
    // callers can see the proposed payload without erroring out.
  }

  const proposed = proposal.payload.content;
  if (existing === null) {
    return {
      existing: null,
      proposed,
      unified: formatNewAssetDiff(proposal.ref, proposed),
      isNew: true,
      ...(targetPath ? { targetPath } : {}),
    };
  }

  return {
    existing,
    proposed,
    unified: formatUnifiedDiff(existing, proposed, proposal.ref),
    isNew: false,
    ...(targetPath ? { targetPath } : {}),
  };
}

function resolveAssetFilePathSafe(source: WriteTargetSource, ref: AssetRef): string | undefined {
  const typeDir = TYPE_DIRS[ref.type];
  if (!typeDir) return undefined;
  const typeRoot = path.join(source.path, typeDir);
  try {
    return resolveAssetPathFromName(ref.type, typeRoot, ref.name);
  } catch {
    return undefined;
  }
}

/**
 * Minimal unified-diff renderer. We deliberately avoid pulling a runtime
 * dependency just for this — proposals diffs are usually small (a single
 * lesson / skill file), so the LCS-free greedy renderer below is plenty for
 * humans to review. The output mirrors `git diff --no-index` for the first
 * `@@ … @@` hunk: enough to be familiar, not so detailed that we re-implement
 * a full LCS table.
 */
export function formatUnifiedDiff(left: string, right: string, label: string): string {
  if (left === right) return "";
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const lines: string[] = [`--- ${label} (existing)`, `+++ ${label} (proposed)`];

  // Pad to the longer side so alignment is one-to-one. Real diff tools use
  // LCS to align matching runs; we don't need that fidelity for a review
  // surface — both halves are visible regardless.
  const max = Math.max(leftLines.length, rightLines.length);
  lines.push(`@@ 1,${leftLines.length} 1,${rightLines.length} @@`);
  for (let i = 0; i < max; i += 1) {
    const l = leftLines[i];
    const r = rightLines[i];
    if (l === r && l !== undefined) {
      lines.push(` ${l}`);
      continue;
    }
    if (l !== undefined) lines.push(`-${l}`);
    if (r !== undefined) lines.push(`+${r}`);
  }
  return lines.join("\n");
}

function formatNewAssetDiff(ref: string, content: string): string {
  const lines = [`--- /dev/null`, `+++ ${ref} (proposed, new asset)`];
  lines.push(`@@ 0,0 1,${content.split("\n").length} @@`);
  for (const line of content.split("\n")) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}
