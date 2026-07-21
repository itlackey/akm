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
 * `<stashDir>/.akm/proposals/`. The first proposal operation against a stash
 * imports any legacy `proposal.json` files into the table — see
 * `./legacy-import.ts` (`importLegacyProposalFiles`), funnelled through
 * {@link withProposalsDb}.
 *
 * # Why the queue bypasses `writeAssetToSource`
 *
 * The architectural rule "all writes go through `writeAssetToSource`" applies
 * to *assets*. Proposals are **not** assets — they live outside the asset
 * tree (in state.db, parallel to how events do). Routing them through
 * `writeAssetToSource` would force them into a placement stash-subdir slot, would commit
 * them to git, and would leak unaccepted drafts through the normal indexer.
 * The {@link promoteProposal} step is the bridge: it routes the accepted
 * payload through `writeAssetToSource` so the actual asset write still
 * funnels through the single dispatch point in `src/core/write-source.ts`.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assetPathForName, placementTypes, stashDirFor } from "../../core/asset/asset-placement";
import { isBundleSlug } from "../../core/asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { isWithin } from "../../core/common";
import { type AkmConfig, loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { type FileChange, proposalContent } from "../../core/file-change";
import {
  _setTxnMutationHookForTests,
  advanceTxn,
  beginTxn,
  canonicalTxnRoot,
  cleanupTxn,
  fsyncTxnDir,
  fsyncTxnFile,
  listTxnJournals,
  mintTxnId,
  recoverTxnsForRoot,
  registerTxnKind,
  sweepJournallessTxnDir,
  type Txn,
  type TxnJournal,
  txnDirFor,
  txnMutationHook,
  txnNamespaceDir,
} from "../../core/fs-txn";
import { withImmediateTransaction, withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import {
  commitWriteTargetBoundary,
  type ResolvedWriteTarget,
  resolveWritableTargets,
  resolveWriteTarget,
  type WriteTargetSource,
} from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { deriveInstallations, slugForPath } from "../../indexer/installations";
import type { Database } from "../../storage/database";
import { insertEventOnce } from "../../storage/repositories/events-repository";
import {
  getStateProposal,
  listStateProposalIdsByPrefix,
  listStateProposals,
  upsertProposal,
} from "../../storage/repositories/proposals-repository";
import { formatNewAssetDiff, formatUnifiedDiff } from "./diff-format";
import { importLegacyProposalFiles } from "./legacy-import";
import {
  AUTOMATED_PROPOSAL_SOURCES,
  type EligibilitySource,
  isAutomatedProposalSource,
  isValidProposalSource,
  PROPOSAL_SOURCES,
  type Proposal,
  type ProposalGateDecision,
  type ProposalPayload,
  type ProposalSource,
  type ProposalStatus,
} from "./proposal-types";
import { repairProposalContent, validateProposal } from "./validators/proposals";

// ── Proposal domain types (moved to ./proposal-types.ts, WI-9.8 KILL 1) ─────
//
// Proposal / ProposalStatus / ProposalPayload / ProposalReview /
// ProposalGateDecision(Outcome) / ProposalSource / PROPOSAL_SOURCES /
// AUTOMATED_PROPOSAL_SOURCES / isValidProposalSource / isAutomatedProposalSource
// moved to the dependency-free leaf so validators/proposals.ts,
// validators/proposal-validators.ts, storage/repositories/proposals-repository.ts,
// and legacy-import.ts can import the `Proposal` type without importing this
// (much heavier) txn-engine module back — that back-edge was the
// repository↔validators import cycle (plan §10.7 D.3). Every symbol this
// module used to export directly is re-exported here verbatim so existing
// import sites (`from "../proposal/repository"`) are unchanged.
export {
  AUTOMATED_PROPOSAL_SOURCES,
  isAutomatedProposalSource,
  isValidProposalSource,
  PROPOSAL_SOURCES,
  type Proposal,
  type ProposalGateDecision,
  type ProposalGateDecisionOutcome,
  type ProposalPayload,
  type ProposalReview,
  type ProposalSource,
  type ProposalStatus,
} from "./proposal-types";

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

// The envelope's primary-content accessor lives in the dependency-free
// core/file-change module; re-exported here so proposal consumers get it
// alongside the repository API.
export { proposalContent };

/**
 * Copy of `p` with `content` replacing BOTH the payload's content and the
 * primary change's `after` — every in-memory content mutation must keep the
 * WI-6.2 invariant (`changes[0].after === payload.content`) intact.
 */
function withProposalContent(p: Proposal, content: string): Proposal {
  return {
    ...p,
    payload: { ...p.payload, content },
    changes: (p.changes ?? [{ path: "", op: "update" as const }]).map((c, i) =>
      // A delete-op primary change carries no `after` (file-change.ts contract).
      i === 0 && c.op !== "delete" ? { ...c, after: content } : c,
    ),
  };
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
  /**
   * Engine/model identifier that generated this proposal's content — the
   * plan §4.5 model-id term of the §23.6 input fingerprint. The same inputs
   * processed by a DIFFERENT model are a new fingerprint (not a dup). Omitted
   * by human-initiated sources; automated producers pass their resolved
   * runner's model where available.
   */
  modelId?: string;
}

/**
 * Reason a `createProposal` call was skipped by the fingerprint/backoff guard
 * (WI-6.4, plan §4.5 — the §23.6 input-fingerprint scheme replaced the
 * dedup/cooldown content-hash machinery).
 *
 *   - `fingerprint_match`  — These exact inputs (scheme version + source +
 *                            target ref + target before-hash + engine/model-id;
 *                            evidence/guidance/evaluator terms reserved) were
 *                            already processed into a proposal. Pass
 *                            `force: true` to enqueue anyway.
 *   - `rejection_backoff`  — A proposal for this `ref+source` was rejected
 *                            within the source-specific backoff window
 *                            (reflect: 14 d, distill: 30 d, others: 7 d) —
 *                            the RETAINED cooldown semantics.
 */
export type ProposalSkipReason = "fingerprint_match" | "rejection_backoff";

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

// ── Fingerprint / rejection-backoff constants ────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Post-rejection backoff windows by source (the RETAINED cooldown semantics,
 * plan §4.5). After a proposal is rejected, `createProposal` silently skips
 * new proposals for the same `ref+source` until the window expires (unless
 * `force: true` is passed).
 *
 * Rationale (Settles 2009 active-learning survey; Argilla/Label Studio HITL):
 * Reviewer fatigue is a blocker for the human-in-the-loop guarantee. Backoff
 * prevents nightly improve runs from re-flooding the queue with near-identical
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

/**
 * WI-8.5a — the durable `proposals.ref` key in the final `bundle//conceptId`
 * item_ref grammar (D-R3). The conceptId is BUILT from the D-R2 static table
 * ({@link conceptIdFromTypeName} = `<stash-subdir>/<name>`), never looked up, so a
 * proposal targeting a not-yet-existing asset (no index entry) still keys onto
 * its final spelling. The bundle is the write-target stash's installation id —
 * the SAME `deriveInstallations` derivation the index write path uses
 * (`index-written-assets.ts`), so a proposal's ref matches the item_ref the
 * indexer would mint for the accepted asset byte-for-byte.
 *
 * A proposal carrying a slug-clean registry origin re-keys onto that bundle; a
 * non-slug registry origin (`github:owner/repo`, `npm:@scope/pkg`) cannot be
 * re-keyed without inventing a slug (D-R5) and keeps its legacy
 * `origin//type:name` spelling until the config `bundles` key lands. The
 * `local`/`stash` primary-stash sentinels resolve to the write-target bundle.
 */
/**
 * The conceptId (`<stash-subdir>/<name>`) a STORED proposal ref maps to
 * (`undefined` when unparseable). TOLERANT by design: a single malformed durable
 * row must never crash a listing, so a parse failure here degrades to "no match"
 * rather than throwing. WI-8.5a stores `proposals.ref` as the item_ref, so a
 * user query ref (`lessons/x` / `bundle//lessons/x`) can no longer exact-match
 * the stored `bundle//lessons/x`; matching on the shared conceptId is the durable
 * read for the user-facing filter paths (`proposal list --ref`,
 * `resolveProposalId`). The internal fingerprint/backoff paths keep exact
 * `ref`-column matching (they compare the already-final `normalizedRef`), so old
 * legacy rejected rows aging out is the documented dedup-window reset, not a
 * lookup regression.
 *
 * USER-SUPPLIED filter refs go through {@link filterConceptId} instead — an
 * unparseable filter is a loud usage error, never a silent empty result.
 */
function proposalConceptId(ref: string): string | undefined {
  try {
    const p = parseRefInput(ref);
    return conceptIdFromTypeName(p.type, p.name);
  } catch {
    return undefined;
  }
}

/**
 * The conceptId a USER-SUPPLIED `--ref` / `idOrRef` filter maps to. Unlike the
 * tolerant {@link proposalConceptId} (which reads STORED rows), an unparseable
 * filter throws a typed {@link UsageError} rather than resolving to `undefined`
 * and silently matching nothing — an invalid filter should fail loudly, naming
 * the 0.9.0 grammar (D-R3: the legacy `type:name` grammar is gone). Delegates the
 * grammar to `parseRefInput`, so a legacy `skill:x` input surfaces the same loud
 * error as any other unparseable filter.
 */
function filterConceptId(ref: string): string {
  try {
    const p = parseRefInput(ref);
    return conceptIdFromTypeName(p.type, p.name);
  } catch {
    throw new UsageError(
      `Invalid asset-ref filter "${ref}". Use the 0.9.0 grammar [bundle//]conceptId, e.g. knowledge/guide.md or lessons/deploy.`,
      "INVALID_FLAG_VALUE",
    );
  }
}

function proposalDurableRef(parsedRef: AssetRef, stashDir: string): string {
  const conceptId = conceptIdFromTypeName(parsedRef.type, parsedRef.name);
  const { origin } = parsedRef;
  if (origin !== undefined && origin !== "local" && origin !== "stash") {
    return isBundleSlug(origin) ? `${origin}//${conceptId}` : `${origin}//${parsedRef.type}:${parsedRef.name}`; // WI-8.5b: collapse (non-slug registry origin)
  }
  const bundleId = deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
  return `${bundleId}//${conceptId}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new pending proposal. The id is a stable random UUID, so two
 * proposals with the same `ref` never collide.
 *
 * **Input-fingerprint / rejection-backoff guard** (§23.6, WI-6.4):
 *
 * Before writing, this function checks:
 *   1. `fingerprint_match` — the §23.6 input fingerprint (scheme version,
 *      source, ref, target before-hash, model id) was already processed.
 *      The row survives the proposal's lifecycle, so identical inputs stay
 *      deduplicated until the target, model, or scheme changes. Pass
 *      `input.force = true` to bypass.
 *   2. `rejection_backoff` — a proposal for this `ref+source` was rejected
 *      within the source-specific backoff window (reflect: 14 d, distill:
 *      30 d, others: 7 d). Bypass with `force: true`.
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

  let parsedRef: ReturnType<typeof parseRefInput>;
  try {
    parsedRef = parseRefInput(input.ref);
  } catch (err) {
    return rejectProposal(
      "invalid_ref",
      `Invalid proposal ref "${input.ref}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!stashDirFor(parsedRef.type)) {
    return rejectProposal(
      "unknown_type",
      `Unknown asset type "${parsedRef.type}" in proposal ref "${input.ref}". Known types: ${[...placementTypes()].sort().join(", ")}.`,
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

  const normalizedRef = proposalDurableRef(parsedRef, stashDir); // durable proposal.ref (WI-8.5a item_ref flip)

  // WI-6.2: derive the FileChange[] envelope + mint-time beforeHash. The
  // target is resolved against the proposal's OWN stash (a local snapshot —
  // accept re-resolves the write target from config at apply time), and only
  // the before-state's HASH is kept: the change's `before` body is a
  // transaction-time capture that does not exist at mint time.
  let targetRelPath: string;
  let mintBeforeContent: string | undefined;
  try {
    const typeRoot = path.join(stashDir, stashDirFor(parsedRef.type) as string);
    const targetAbs = assetPathForName(parsedRef.type, typeRoot, parsedRef.name);
    targetRelPath = path.relative(stashDir, targetAbs);
    if (fs.existsSync(targetAbs)) mintBeforeContent = fs.readFileSync(targetAbs, "utf8");
  } catch {
    // Resolution failure degrades to a best-effort create — never blocks the mint.
    targetRelPath = path.join(stashDirFor(parsedRef.type) as string, parsedRef.name);
  }
  const mintedChanges: FileChange[] = [
    {
      path: targetRelPath,
      after: input.payload.content,
      op: mintBeforeContent !== undefined ? "update" : "create",
    },
  ];
  const mintedBeforeHash = mintBeforeContent !== undefined ? contentHash(mintBeforeContent) : undefined;

  const fingerprint = computeProposalFingerprint({
    ref: normalizedRef,
    source: input.source,
    ...(mintedBeforeHash !== undefined ? { beforeHash: mintedBeforeHash } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
  });

  return withProposalsDb(stashDir, ctx, (db) => {
    return withImmediateTransaction(db, () => {
      if (!input.force) {
        const skip = checkFingerprintAndBackoff(db, stashDir, normalizedRef, input, fingerprint, ctx);
        if (skip) return skip;
      }

      const created = nowIso(ctx);

      // Phase 6A: validate confidence is a finite number in [0, 1]. Anything else
      // is dropped silently — we never store NaN, Infinity, or out-of-range values.
      // Callers that mis-report confidence should not poison downstream readers.
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
        changes: mintedChanges,
        ...(mintedBeforeHash !== undefined ? { beforeHash: mintedBeforeHash } : {}),
        ...(sanitizedConfidence !== undefined ? { confidence: sanitizedConfidence } : {}),
        // Attribution tagging: persist the eligibility lane so it survives to
        // accept/reject/revert time. See EligibilitySource.
        ...(input.eligibilitySource !== undefined ? { eligibilitySource: input.eligibilitySource } : {}),
      };

      upsertProposal(db, proposal, stashDir);
      // Record the processed fingerprint (also on force — a forced enqueue is
      // still "these inputs were processed"; future unforced identical inputs
      // dedup against it).
      recordProposalFingerprint(db, stashDir, fingerprint, normalizedRef, input, proposal.id, created);
      return proposal;
    });
  });
}

/** Version stamp of the input-fingerprint scheme; bump when terms change. */
const PROPOSAL_FINGERPRINT_VERSION = 1;

/**
 * Compute the §23.6 input fingerprint for a proposal mint (+ the plan §4.5
 * engine/model-id term). Terms, in order: scheme version, source (the recipe
 * stand-in until Wave-2 recipes exist), target ref, target before-hash
 * (empty for a create), evidence IDs/hashes (reserved — not yet modeled),
 * guidance hashes (reserved), evaluator version (reserved), model id.
 * Deliberately an INPUT fingerprint: the generated content is not a term —
 * already-processed inputs skip re-processing regardless of what the model
 * produced this time.
 */
function computeProposalFingerprint(args: {
  ref: string;
  source: string;
  beforeHash?: string;
  modelId?: string;
}): string {
  return contentHash(
    [
      `v${PROPOSAL_FINGERPRINT_VERSION}`,
      args.source,
      args.ref,
      args.beforeHash ?? "",
      "", // evidence IDs/hashes — reserved (Wave-2 recipes)
      "", // guidance hashes — reserved
      "", // evaluator version — reserved
      args.modelId ?? "",
    ].join("\0"),
  );
}

/**
 * Durably record a processed fingerprint (INSERT OR REPLACE — idempotent).
 * `ref` must be the NORMALIZED ref — the same value the fingerprint was
 * computed over — so future ref-keyed readers of the table never mismatch.
 */
function recordProposalFingerprint(
  db: Database,
  stashDir: string,
  fingerprint: string,
  ref: string,
  input: CreateProposalInput,
  proposalId: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO proposal_fingerprints
       (stash_dir, fingerprint, ref, source, model_id, proposal_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(stashDir, fingerprint, ref, input.source, input.modelId ?? "", proposalId, createdAt);
}

/**
 * Evaluate the fingerprint + rejection-backoff guards. Returns the skip
 * record when a guard fires, or undefined when the create may proceed.
 */
function checkFingerprintAndBackoff(
  db: Database,
  stashDir: string,
  normalizedRef: string,
  input: CreateProposalInput,
  fingerprint: string,
  ctx: ProposalsContext | undefined,
): CreateProposalSkipped | undefined {
  const nowMs = (ctx?.now ?? Date.now)();
  const backoffMs = cooldownMsForSource(input.source);

  // §23.6: an already-processed fingerprint skips another model call's output
  // unless explicitly forced. The row survives the proposal's lifecycle —
  // identical inputs stay deduplicated until the target (before-hash), the
  // model, or the scheme changes.
  const existing = db
    .prepare("SELECT proposal_id FROM proposal_fingerprints WHERE stash_dir = ? AND fingerprint = ?")
    .get(stashDir, fingerprint) as { proposal_id: string | null } | undefined;
  if (existing) {
    return {
      skipped: true,
      reason: "fingerprint_match",
      message: `These inputs were already processed into a proposal for ${normalizedRef} (fingerprint match). Pass force:true to enqueue anyway.`,
      ...(existing.proposal_id ? { existingProposalId: existing.proposal_id } : {}),
    };
  }

  // Rejection backoff (RETAINED cooldown semantics): a recent rejection for
  // this ref+source suppresses new proposals until the window expires.
  const rejected = listStateProposals(db, { stashDir, ref: normalizedRef, status: "rejected" })
    .filter((p) => p.source === input.source)
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());

  const mostRecent = rejected[0];
  if (mostRecent !== undefined) {
    const rejectedAt = new Date(mostRecent.updatedAt ?? 0).getTime();
    if (nowMs - rejectedAt < backoffMs) {
      const backoffDays = backoffMs / MS_PER_DAY;
      const remainingDays = Math.ceil((backoffMs - (nowMs - rejectedAt)) / MS_PER_DAY);
      return {
        skipped: true,
        reason: "rejection_backoff",
        message:
          `Proposal for ${normalizedRef} from source "${input.source}" is in rejection backoff ` +
          `(${backoffDays}d window, ~${remainingDays}d remaining). Pass force:true to bypass.`,
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
    // WI-8.5a: the `ref` filter matches by conceptId (grammar-independent) so a
    // display/legacy query ref finds the item_ref-spelled row. Applied in JS, not
    // as a SQL `ref = ?`, since the stored spelling no longer equals the query ref.
    const wantConceptId = options.ref !== undefined ? filterConceptId(options.ref) : undefined;
    return listStateProposals(db, {
      stashDir,
      ...(status !== undefined ? { status } : {}),
    }).filter((p) => {
      if (options.ref !== undefined && (wantConceptId === undefined || proposalConceptId(p.ref) !== wantConceptId)) {
        return false;
      }
      if (!options.type) return true;
      try {
        return parseRefInput(p.ref).type === options.type;
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

    // 2. Asset ref in EITHER grammar — most recent pending, else most recent
    // archived. WI-8.5a: match by conceptId (a UUID carries neither `:` nor `/`,
    // so both grammars — legacy `skill:x` and new `skills/x` / `bundle//skills/x`
    // — route here and match the item_ref-spelled stored row).
    const wantConceptId = idOrRef.includes(":") || idOrRef.includes("/") ? filterConceptId(idOrRef) : undefined;
    if (wantConceptId !== undefined) {
      const byRecency = (proposals: Proposal[]): Proposal | undefined =>
        proposals.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
      const forConcept = (status?: string): Proposal[] =>
        listStateProposals(db, { stashDir, ...(status !== undefined ? { status } : {}) }).filter(
          (p) => proposalConceptId(p.ref) === wantConceptId,
        );
      const pending = byRecency(forConcept("pending"));
      if (pending) return pending;
      const archived = byRecency(forConcept());
      if (archived) return archived;
      throw new NotFoundError(`No proposal found for ref "${idOrRef}".`, "FILE_NOT_FOUND");
    }

    // 3. UUID prefix (pending queue only).
    const prefixMatches = listStateProposalIdsByPrefix(db, stashDir, idOrRef);
    if (prefixMatches.length === 1) return requireProposal(db, stashDir, prefixMatches[0]!);
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
 * Record the drain/triage engine's decision onto a proposal (#577).
 * Drain-owned audit machinery — the deterministic drain engine is the only
 * live writer since the 0.9.0 confidence-gate deletion.
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
    let parsed: ReturnType<typeof parseRefInput>;
    try {
      parsed = parseRefInput(p.ref);
    } catch {
      continue;
    }
    // Lessons are new-asset proposals by definition — they cannot be orphaned.
    if (parsed.type === "lesson") continue;
    const spec = stashDirFor(parsed.type);
    if (!spec) continue;

    const exists = sourceDirs.some((root) => {
      const typeRoot = path.join(root, spec);
      const candidate = assetPathForName(parsed.type, typeRoot, parsed.name);
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

  // Prune fingerprint rows past the same retention window (best-effort):
  // ISO created_at strings compare lexicographically.
  try {
    const cutoffIso = new Date(nowMs - retentionMs).toISOString();
    withProposalsDb(stashDir, ctx, (db) =>
      db.prepare("DELETE FROM proposal_fingerprints WHERE stash_dir = ? AND created_at < ?").run(stashDir, cutoffIso),
    );
  } catch (err) {
    warn(
      `[proposals] expireStaleProposals: fingerprint prune failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    checked: pending.length,
    expired: expiredProposals.length,
    durationMs: Date.now() - t0,
    retentionDays,
    expiredProposals,
  };
}

/**
 * Kind-owned payload of a `proposal` transaction (accept/revert), riding the
 * unified fs-txn engine (WI-6.3). The envelope carries
 * kind/phase/transactionId/root(= target root)/changes/decidedAt.
 */
interface ProposalTxnPayload {
  operation: "accept" | "revert";
  proposalId: string;
  stashDir: string;
  targetSource: string;
  assetPath: string;
  ref: string;
  contentPath: string;
  publishPath: string;
  displacedPath: string;
  backupPath: string | null;
  originalHash: string | null;
  publishedHash: string;
  eventMetadata?: Record<string, unknown>;
}

type ProposalTxn = Txn<ProposalTxnPayload>;

const PROPOSAL_TXN_KIND = "proposal";
const PROPOSAL_TXN_PHASES = [
  "prepared",
  "asset-published",
  "proposal-persisted",
  "index-finalized",
  "event-finalized",
  "committed",
] as const;

/** TEST-ONLY crash-window hook used by subprocess recovery tests. */
export function _setProposalMutationHookForTests(hook?: (point: string) => void): void {
  _setTxnMutationHookForTests(hook);
}

function proposalHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function proposalFileHash(filePath: string): string {
  return proposalHash(fs.readFileSync(filePath));
}

function sameProposalFile(left: string, right: string): boolean {
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function cleanupProposalPublication(p: ProposalTxnPayload): void {
  for (const filePath of [p.publishPath, p.displacedPath]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      warn(
        `[proposals] transaction publication cleanup failed at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  fsyncTxnDir(path.dirname(p.assetPath));
}

function rollbackPreparedProposalTransaction(txn: ProposalTxn): void {
  const p = txn.journal.payload;
  const currentHash = fs.existsSync(p.assetPath) ? proposalFileHash(p.assetPath) : null;
  if (!fs.existsSync(p.displacedPath)) {
    if (p.originalHash === null) {
      if (currentHash === p.publishedHash && sameProposalFile(p.assetPath, p.publishPath)) {
        fs.unlinkSync(p.assetPath);
      } else if (currentHash !== null) {
        throw new Error(`Cannot roll back proposal transaction: target was created externally.`);
      }
    } else if (currentHash !== p.originalHash) {
      throw new Error(`Cannot roll back proposal transaction: ${p.assetPath} diverged.`);
    }
    cleanupProposalPublication(p);
    return;
  }
  if (currentHash === p.publishedHash) fs.unlinkSync(p.assetPath);
  else if (currentHash !== null && currentHash !== p.originalHash) {
    throw new Error(`Cannot roll back proposal transaction: ${p.assetPath} diverged.`);
  }
  if (fs.existsSync(p.displacedPath)) {
    if (fs.existsSync(p.assetPath)) {
      throw new Error(`Cannot restore proposal backup: ${p.assetPath} is occupied.`);
    }
    fs.linkSync(p.displacedPath, p.assetPath);
  }
  cleanupProposalPublication(p);
}

function validatePublishedProposal(p: ProposalTxnPayload): void {
  if (!fs.existsSync(p.assetPath) || proposalFileHash(p.assetPath) !== p.publishedHash) {
    throw new Error(`Cannot recover proposal ${p.proposalId}: published asset diverged.`);
  }
}

function persistProposalTransactionState(txn: ProposalTxn, proposal: Proposal, ctx?: ProposalsContext): Proposal {
  const p = txn.journal.payload;
  const decidedAt = txn.journal.decidedAt;
  const backupContent = p.backupPath ? fs.readFileSync(p.backupPath, "utf8") : undefined;
  const publishedContent = fs.readFileSync(p.contentPath, "utf8");
  return withProposalsDb(p.stashDir, ctx, (db) =>
    withImmediateTransaction(db, () => {
      const current = requireProposal(db, p.stashDir, p.proposalId);
      if (p.operation === "accept") {
        if (current.status === "accepted") {
          if (current.acceptedContentHash !== p.publishedHash) {
            throw new Error(`Accepted proposal ${p.proposalId} does not match its recovery journal.`);
          }
          return current;
        }
        if (current.status !== "pending") {
          throw new Error(`Proposal ${p.proposalId} changed status during acceptance (${current.status}).`);
        }
        const accepted: Proposal = {
          ...withProposalContent(proposal, publishedContent),
          status: "accepted",
          updatedAt: decidedAt,
          review: { outcome: "accepted", decidedAt },
          acceptedContentHash: p.publishedHash,
          acceptedTarget: {
            source: p.targetSource,
            root: txn.journal.root,
            path: p.assetPath,
            contentHash: p.publishedHash,
          },
          ...(backupContent !== undefined ? { backupContent } : {}),
        };
        upsertProposal(db, accepted, p.stashDir);
        return accepted;
      }

      if (current.status === "reverted") return current;
      if (current.status !== "accepted") {
        throw new Error(`Proposal ${p.proposalId} changed status during reversion (${current.status}).`);
      }
      const reverted: Proposal = {
        ...current,
        status: "reverted",
        updatedAt: decidedAt,
        review: {
          outcome: "rejected",
          reason: "reverted: prior content restored from backup",
          decidedAt,
        },
      };
      upsertProposal(db, reverted, p.stashDir);
      return reverted;
    }),
  );
}

function persistProposalEvent(txn: ProposalTxn, proposal: Proposal, ctx?: ProposalsContext): void {
  const p = txn.journal.payload;
  withProposalsDb(p.stashDir, ctx, (db) =>
    withImmediateTransaction(db, () => {
      const metadata = {
        proposalId: proposal.id,
        source: proposal.source,
        ...(proposal.sourceRun !== undefined ? { sourceRun: proposal.sourceRun } : {}),
        assetPath: p.assetPath,
        ...(proposal.eligibilitySource !== undefined ? { eligibilitySource: proposal.eligibilitySource } : {}),
        ...(p.eventMetadata ?? {}),
        proposalTransactionId: txn.journal.transactionId,
      };
      insertEventOnce(db, {
        eventType: p.operation === "accept" ? "promoted" : "proposal_reverted",
        ts: txn.journal.decidedAt,
        ref: p.ref,
        metadata,
        idempotencyKey: txn.journal.transactionId,
      });
    }),
  );
}

async function finalizeProposalTransaction(
  txn: ProposalTxn,
  target: ResolvedWriteTarget,
  proposal: Proposal,
  ctx?: ProposalsContext,
): Promise<Proposal> {
  const p = txn.journal.payload;
  validatePublishedProposal(p);
  cleanupProposalPublication(p);
  if (txn.journal.phase === "asset-published") {
    const commitRoot = target.source.repoPath ?? target.source.path;
    const commitPath = path.relative(commitRoot, p.assetPath).replaceAll(path.sep, "/");
    commitWriteTargetBoundary(target, `${p.operation === "accept" ? "Update" : "Revert"} ${p.ref}`, {
      paths: [commitPath],
    });
    persistProposalTransactionState(txn, proposal, ctx);
    advanceTxn(txn, "proposal-persisted");
  }
  let accepted = getProposal(p.stashDir, p.proposalId, ctx);
  if (txn.journal.phase === "proposal-persisted") {
    if (!(await indexWrittenAssets(txn.journal.root, [p.assetPath]))) {
      throw new Error(`Proposal ${p.proposalId} index finalization failed.`);
    }
    advanceTxn(txn, "index-finalized");
  }
  if (txn.journal.phase === "index-finalized") {
    accepted = getProposal(p.stashDir, p.proposalId, ctx);
    persistProposalEvent(txn, accepted, ctx);
    txnMutationHook("event-persisted");
    advanceTxn(txn, "event-finalized");
  }
  if (txn.journal.phase === "event-finalized") advanceTxn(txn, "committed");
  return accepted;
}

/**
 * Kind-level safety fence for a `proposal` journal, run before any recovery
 * action (mirrors the legacy per-engine fence; the engine fences root binding
 * and the uniform changes[] separately).
 */
function fenceProposalTxnJournal(journal: TxnJournal<ProposalTxnPayload>, txnDir: string, root: string): void {
  const p = journal.payload;
  if (
    !["accept", "revert"].includes(p.operation) ||
    !isWithin(p.assetPath, root) ||
    ![p.contentPath, p.backupPath]
      .filter((candidate): candidate is string => candidate !== null)
      .every((candidate) => isWithin(candidate, txnDir)) ||
    ![p.publishPath, p.displacedPath].every(
      (candidate) => isWithin(candidate, root) && path.dirname(candidate) === path.dirname(p.assetPath),
    )
  ) {
    throw new Error(`Refusing unsafe proposal transaction journal at ${path.join(txnDir, "journal.json")}.`);
  }
}

async function recoverProposalTransactions(
  target: ResolvedWriteTarget,
  stashDir: string,
  ctx?: ProposalsContext,
): Promise<Map<string, Proposal>> {
  const completed = new Map<string, Proposal>();
  const nsDir = txnNamespaceDir(target.source.path);
  if (!fs.existsSync(nsDir)) return completed;
  for (const entry of fs.readdirSync(nsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionDir = path.join(nsDir, entry.name);
    const journalPath = path.join(transactionDir, "journal.json");
    if (!fs.existsSync(journalPath)) {
      // Journal-less dirs may be a SIBLING kind's beginTxn window (shared
      // per-root namespace) — sweep only when demonstrably stale.
      sweepJournallessTxnDir(transactionDir);
      continue;
    }
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as TxnJournal<ProposalTxnPayload>;
    if (journal.kind !== PROPOSAL_TXN_KIND) continue;
    if (path.resolve(journal.payload.stashDir) !== path.resolve(stashDir)) continue;
    if (journal.version !== 1 || canonicalTxnRoot(journal.root) !== canonicalTxnRoot(target.source.path)) {
      throw new Error(`Refusing unsafe proposal transaction journal at ${journalPath}.`);
    }
    fenceProposalTxnJournal(journal, transactionDir, target.source.path);
    const txn: ProposalTxn = { journal, journalPath, dir: transactionDir };
    if (journal.phase === "prepared") rollbackPreparedProposalTransaction(txn);
    else if (journal.phase !== "committed") {
      const proposal = getProposal(stashDir, journal.payload.proposalId, ctx);
      completed.set(journal.payload.proposalId, await finalizeProposalTransaction(txn, target, proposal, ctx));
    } else {
      completed.set(journal.payload.proposalId, getProposal(stashDir, journal.payload.proposalId, ctx));
    }
    cleanupProposalPublication(journal.payload);
    cleanupTxn(transactionDir);
  }
  return completed;
}

export async function recoverProposalTransactionsForStash(
  stashDir: string,
  config: AkmConfig,
  ctx?: ProposalsContext,
  proposalId?: string,
): Promise<Map<string, Proposal>> {
  const completed = new Map<string, Proposal>();
  const matches = listTxnJournals(
    (j) =>
      j.kind === PROPOSAL_TXN_KIND &&
      path.resolve((j as TxnJournal<ProposalTxnPayload>).payload.stashDir) === path.resolve(stashDir) &&
      (proposalId === undefined || (j as TxnJournal<ProposalTxnPayload>).payload.proposalId === proposalId),
  ) as TxnJournal<ProposalTxnPayload>[];
  const irreversible = matches.filter((journal) => journal.phase !== "prepared" && journal.phase !== "committed");
  if (proposalId !== undefined && irreversible.length > 1) {
    throw new Error(`Conflicting durable proposal transactions exist for ${proposalId}; refusing recovery.`);
  }
  const recoveredRoots = new Set<string>();
  for (const journal of matches) {
    let target: ResolvedWriteTarget;
    try {
      target = resolveWriteTarget(config, journal.payload.targetSource);
    } catch {
      target = resolveWriteTarget(config);
    }
    if (canonicalTxnRoot(target.source.path) !== canonicalTxnRoot(journal.root)) {
      throw new Error(`Proposal transaction ${journal.transactionId} is bound to a different target root.`);
    }
    const key = path.resolve(target.source.path);
    if (recoveredRoots.has(key)) continue;
    await recoverTxnsForRoot(target.source.path, (journal) => journal.kind === "mv");
    const recovered = await recoverProposalTransactions(target, stashDir, ctx);
    for (const [id, proposal] of recovered) completed.set(id, proposal);
    recoveredRoots.add(key);
  }
  return completed;
}

/**
 * Kind-owned payload of a `proposal-reject` transaction (DB-only — no file
 * changes, deliberately NO before-hash; the envelope root is the stash).
 */
interface RejectTxnPayload {
  proposalId: string;
  stashDir: string;
  reason?: string;
}

type RejectTxn = Txn<RejectTxnPayload>;

const REJECT_TXN_KIND = "proposal-reject";
const REJECT_TXN_PHASES = ["prepared", "state-persisted", "event-finalized", "committed"] as const;

function finalizeRejectTransaction(txn: RejectTxn, ctx?: ProposalsContext): Proposal {
  const p = txn.journal.payload;
  const decidedAt = txn.journal.decidedAt;
  let proposal = getProposal(p.stashDir, p.proposalId, ctx);
  if (txn.journal.phase === "prepared") {
    if (proposal.status === "pending") {
      proposal = archiveProposal(p.stashDir, p.proposalId, "rejected", p.reason, {
        ...ctx,
        now: () => Date.parse(decidedAt),
      });
    } else if (proposal.status !== "rejected") {
      throw new Error(`Proposal ${p.proposalId} changed status during rejection (${proposal.status}).`);
    }
    advanceTxn(txn, "state-persisted");
    txnMutationHook("reject-state-persisted");
  }
  if (txn.journal.phase === "state-persisted") {
    proposal = getProposal(p.stashDir, p.proposalId, ctx);
    const eventRef = proposal.ref;
    const eventMeta = {
      proposalId: proposal.id,
      source: proposal.source,
      ...(proposal.sourceRun !== undefined ? { sourceRun: proposal.sourceRun } : {}),
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
      proposalTransactionId: txn.journal.transactionId,
    };
    withProposalsDb(p.stashDir, ctx, (db) =>
      withImmediateTransaction(db, () => {
        insertEventOnce(db, {
          eventType: "rejected",
          ts: decidedAt,
          ref: eventRef,
          metadata: eventMeta,
          idempotencyKey: txn.journal.transactionId,
        });
      }),
    );
    txnMutationHook("reject-event-persisted");
    advanceTxn(txn, "event-finalized");
  }
  if (txn.journal.phase === "event-finalized") advanceTxn(txn, "committed");
  return proposal;
}

function recoverRejectTransaction(stashDir: string, proposalId: string, ctx?: ProposalsContext): Proposal | undefined {
  const nsDir = txnNamespaceDir(stashDir);
  if (!fs.existsSync(nsDir)) return undefined;
  for (const entry of fs.readdirSync(nsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionDir = path.join(nsDir, entry.name);
    const journalPath = path.join(transactionDir, "journal.json");
    if (!fs.existsSync(journalPath)) continue;
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as TxnJournal<RejectTxnPayload>;
    if (journal.kind !== REJECT_TXN_KIND) continue;
    if (journal.payload.proposalId !== proposalId) continue;
    if (journal.version !== 1 || path.resolve(journal.payload.stashDir) !== path.resolve(stashDir)) {
      throw new Error(`Refusing unsafe proposal rejection journal at ${journalPath}.`);
    }
    const proposal = finalizeRejectTransaction({ journal, journalPath, dir: transactionDir }, ctx);
    cleanupTxn(transactionDir);
    return proposal;
  }
  return undefined;
}

export function rejectProposalDurably(
  stashDir: string,
  proposalId: string,
  reason?: string,
  ctx?: ProposalsContext,
): Proposal {
  const recovered = recoverRejectTransaction(stashDir, proposalId, ctx);
  if (recovered) return recovered;
  const proposal = getProposal(stashDir, proposalId, ctx);
  if (proposal.status !== "pending") {
    throw new UsageError(
      `Proposal ${proposalId} is not pending (current status: ${proposal.status}). Only pending proposals can be rejected.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const txn = beginTxn<RejectTxnPayload>({
    kind: REJECT_TXN_KIND,
    root: stashDir,
    changes: [],
    payload: { proposalId, stashDir, ...(reason !== undefined ? { reason } : {}) },
    decidedAt: nowIso(ctx),
  });
  const rejected = finalizeRejectTransaction(txn, ctx);
  cleanupTxn(txn.dir);
  return rejected;
}

function prepareProposalTransaction(
  stashDir: string,
  target: ResolvedWriteTarget,
  proposal: Proposal,
  ref: AssetRef,
  content: string,
  options: {
    operation: "accept" | "revert";
    originalHash: string | null;
    backup?: Buffer;
    eventMetadata?: Record<string, unknown>;
  },
  ctx?: ProposalsContext,
): ProposalTxn {
  const assetPath = resolveAssetFilePathSafe(target.source, ref);
  if (!assetPath) throw new Error(`Cannot resolve proposal target ${proposal.ref}.`);
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  const publishedHash = proposalHash(normalized);
  // Mint the id first: the payload embeds paths under the transaction dir,
  // and the initial `prepared` journal must be written exactly ONCE with its
  // final contents (crash runners intercept the first rename per phase).
  const transactionId = mintTxnId();
  const transactionDir = txnDirFor(target.source.path, transactionId);
  fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  const contentPath = path.join(transactionDir, "published-content");
  const publishPath = path.join(path.dirname(assetPath), `.akm-proposal-${transactionId}.publish`);
  const displacedPath = path.join(path.dirname(assetPath), `.akm-proposal-${transactionId}.displaced`);
  fs.writeFileSync(contentPath, normalized, { encoding: "utf8", mode: 0o600 });
  fsyncTxnFile(contentPath);
  let persistedBackupPath: string | null = null;
  if (options.backup) {
    const backupPath = path.join(transactionDir, "backup-content");
    fs.writeFileSync(backupPath, options.backup, { mode: 0o600 });
    fsyncTxnFile(backupPath);
    persistedBackupPath = backupPath;
  }
  const txn = beginTxn<ProposalTxnPayload>({
    kind: PROPOSAL_TXN_KIND,
    root: target.source.path,
    transactionId,
    changes: [
      {
        path: assetPath,
        op: options.originalHash === null ? "create" : "update",
        beforeHash: options.originalHash,
        afterHash: publishedHash,
      },
    ],
    payload: {
      operation: options.operation,
      proposalId: proposal.id,
      stashDir,
      targetSource: target.source.name,
      assetPath,
      ref: proposal.ref,
      contentPath,
      publishPath,
      displacedPath,
      backupPath: persistedBackupPath,
      originalHash: options.originalHash,
      publishedHash,
      ...(options.eventMetadata ? { eventMetadata: options.eventMetadata } : {}),
    },
    decidedAt: nowIso(ctx),
  });
  try {
    const mode = fs.existsSync(assetPath) ? fs.statSync(assetPath).mode & 0o777 : 0o644;
    fs.writeFileSync(publishPath, normalized, { encoding: "utf8", flag: "wx", mode });
    fsyncTxnFile(publishPath);
    fsyncTxnDir(path.dirname(assetPath));
  } catch (error) {
    rollbackPreparedProposalTransaction(txn);
    cleanupTxn(txn.dir);
    throw error;
  }
  return txn;
}

function publishProposalAsset(txn: ProposalTxn): void {
  const p = txn.journal.payload;
  try {
    if (p.originalHash !== null) {
      fs.renameSync(p.assetPath, p.displacedPath);
      if (proposalFileHash(p.displacedPath) !== p.originalHash) {
        fs.renameSync(p.displacedPath, p.assetPath);
        throw new Error(`Proposal target changed while its backup was being acquired.`);
      }
    }
    fs.linkSync(p.publishPath, p.assetPath);
    fsyncTxnDir(path.dirname(p.assetPath));
    advanceTxn(txn, "asset-published");
  } catch (error) {
    rollbackPreparedProposalTransaction(txn);
    cleanupTxn(txn.dir);
    throw error;
  }
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
  options: { target?: string; eventMetadata?: Record<string, unknown> } = {},
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  return withAssetMutationLease("proposal-accept", () => promoteProposalWithLease(stashDir, config, id, options, ctx));
}

async function promoteProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string; eventMetadata?: Record<string, unknown> },
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  let proposal = getProposal(stashDir, id, ctx);

  // Attempt bounded auto-repair of mechanically-fixable structural defects
  // (pseudo-frontmatter-in-body, stray `---` fences, truncated description)
  // BEFORE running validation. If the repair produces valid content, we
  // promote the repaired version; if validation still fails, the original
  // error path throws as before. The repair is content-preserving and
  // deterministic — it never invents text.
  const repairedContent = repairProposalContent(proposalContent(proposal));
  const proposalToValidate: Proposal =
    repairedContent !== proposalContent(proposal) ? withProposalContent(proposal, repairedContent) : proposal;

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
  if (repairedContent !== proposalContent(proposal)) {
    withProposalsDb(stashDir, ctx, (db) => {
      upsertProposal(db, withProposalContent(proposal, repairedContent), stashDir);
    });
  }

  const ref = parseRefInput(proposalToValidate.ref);
  if (!stashDirFor(ref.type)) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  await recoverProposalTransactionsForStash(stashDir, config, ctx, id);
  proposal = getProposal(stashDir, id, ctx);
  const target = resolveWriteTarget(config, options.target);
  await recoverTxnsForRoot(target.source.path, (journal) => journal.kind === "mv");
  if (proposal.status === "accepted" && proposal.acceptedContentHash) {
    const assetPath = resolveAssetFilePathSafe(target.source, ref);
    if (
      proposal.acceptedTarget &&
      (proposal.acceptedTarget.source !== target.source.name ||
        path.resolve(proposal.acceptedTarget.root) !== path.resolve(target.source.path) ||
        !assetPath ||
        path.resolve(proposal.acceptedTarget.path) !== path.resolve(assetPath))
    ) {
      throw new UsageError(`proposal ${id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
    }
    if (!assetPath || !fs.existsSync(assetPath) || proposalFileHash(assetPath) !== proposal.acceptedContentHash) {
      throw new UsageError(`Accepted proposal ${id} does not match the current asset content.`, "INVALID_FLAG_VALUE");
    }
    return { proposal, assetPath, ref: proposal.ref };
  }
  if (proposal.status !== "pending") {
    throw new UsageError(
      `Proposal ${id} is not pending (current status: ${proposal.status}). Only pending proposals can be accepted.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const assetPath = resolveAssetFilePathSafe(target.source, ref);
  if (!assetPath) throw new UsageError(`Cannot resolve proposal target ${proposal.ref}.`, "INVALID_PROPOSAL");
  let backup: Buffer | undefined;
  if (fs.existsSync(assetPath)) {
    try {
      backup = fs.readFileSync(assetPath);
    } catch (error) {
      throw new Error(
        `Proposal backup read failed for ${assetPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const transaction = prepareProposalTransaction(
    stashDir,
    target,
    proposalToValidate,
    ref,
    repairedContent,
    {
      operation: "accept",
      originalHash: backup ? proposalHash(backup) : null,
      backup,
      eventMetadata: options.eventMetadata,
    },
    ctx,
  );
  publishProposalAsset(transaction);
  const accepted = await finalizeProposalTransaction(transaction, target, proposalToValidate, ctx);
  cleanupTxn(transaction.dir);
  return { proposal: accepted, assetPath: transaction.journal.payload.assetPath, ref: proposal.ref };
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
  return withAssetMutationLease("proposal-revert", () => revertProposalWithLease(stashDir, config, id, options, ctx));
}

async function revertProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string },
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  let proposal = getProposal(stashDir, id, ctx);
  const ref = parseRefInput(proposal.ref);
  if (!stashDirFor(ref.type)) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  await recoverProposalTransactionsForStash(stashDir, config, ctx, id);
  proposal = getProposal(stashDir, id, ctx);
  if (proposal.status === "reverted") {
    if (options.target) resolveWriteTarget(config, options.target);
    const target = proposal.legacyAcceptedTargetDerived
      ? resolveWritableTargets(config).find(
          (candidate) =>
            candidate.source.name === proposal.acceptedTarget?.source &&
            path.resolve(candidate.source.path) === path.resolve(proposal.acceptedTarget?.root ?? ""),
        )
      : resolveWriteTarget(config, options.target);
    const requestedAssetPath = target ? resolveAssetFilePathSafe(target.source, ref) : undefined;
    if (
      !target ||
      !requestedAssetPath ||
      (proposal.acceptedTarget &&
        (proposal.acceptedTarget.source !== target.source.name ||
          path.resolve(proposal.acceptedTarget.root) !== path.resolve(target.source.path) ||
          path.resolve(proposal.acceptedTarget.path) !== path.resolve(requestedAssetPath)))
    ) {
      throw new UsageError(`proposal ${id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
    }
    return {
      proposal,
      assetPath: requestedAssetPath as string,
      ref: proposal.ref,
    };
  }
  if (proposal.status !== "accepted") {
    throw new UsageError(
      `only accepted proposals can be reverted (proposal ${id} status: ${proposal.status})`,
      "INVALID_FLAG_VALUE",
    );
  }
  const backupContent = proposal.backupContent;
  if (backupContent === undefined) {
    throw new UsageError(
      `no backup available for this proposal (id: ${id})`,
      "MISSING_REQUIRED_ARGUMENT",
      "Backups are only captured when a proposal overwrites an existing asset — new-asset proposals cannot be reverted via this path; delete the asset directly instead.",
    );
  }
  const proposalBody = proposalContent(proposal);
  const legacyAccepted = proposalBody.endsWith("\n") ? proposalBody : `${proposalBody}\n`;
  let acceptedHash =
    proposal.acceptedTarget?.contentHash ?? proposal.acceptedContentHash ?? proposalHash(legacyAccepted);
  const writableTargets = resolveWritableTargets(config);
  let target: ResolvedWriteTarget;
  let assetPath: string;

  if (!proposal.acceptedTarget) {
    if (options.target) resolveWriteTarget(config, options.target);
    const candidates = writableTargets.flatMap((candidate) => {
      const candidatePath = resolveAssetFilePathSafe(candidate.source, ref);
      return candidatePath ? [{ target: candidate, assetPath: candidatePath }] : [];
    });
    const matching = candidates.filter(
      (candidate) => fs.existsSync(candidate.assetPath) && proposalFileHash(candidate.assetPath) === acceptedHash,
    );
    if (matching.length > 1) {
      throw new UsageError(
        `legacy proposal ${id} has ambiguous accepted content in multiple writable targets; refusing revert`,
        "INVALID_FLAG_VALUE",
      );
    }
    const existing = candidates.filter((candidate) => fs.existsSync(candidate.assetPath));
    if (matching.length === 0 && existing.length > 0) {
      throw new UsageError(
        `asset content changed after proposal ${id} was accepted; refusing to clobber the newer content`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (matching.length === 0 && candidates.length !== 1) {
      throw new UsageError(
        `legacy proposal ${id} has no accepted asset and ${candidates.length} writable targets can own the ref; ownership is ambiguous`,
        "INVALID_FLAG_VALUE",
      );
    }
    const owner = matching[0] ?? candidates[0];
    if (!owner) {
      throw new UsageError(
        `legacy proposal ${id} has no writable target that can own ${proposal.ref}`,
        "INVALID_FLAG_VALUE",
      );
    }
    const acceptedAssetWasAbsent = matching.length === 0;
    proposal = withProposalsDb(stashDir, ctx, (db) =>
      withImmediateTransaction(db, () => {
        const current = requireProposal(db, stashDir, id);
        if (current.status !== "accepted" || current.acceptedTarget) {
          throw new Error(`Proposal ${id} changed while deriving its legacy revert target.`);
        }
        const bound: Proposal = {
          ...current,
          acceptedContentHash: acceptedHash,
          acceptedTarget: {
            source: owner.target.source.name,
            root: owner.target.source.path,
            path: owner.assetPath,
            contentHash: acceptedHash,
          },
          legacyAcceptedTargetDerived: true,
          ...(acceptedAssetWasAbsent ? { legacyAcceptedAssetWasAbsent: true } : {}),
        };
        upsertProposal(db, bound, stashDir);
        return bound;
      }),
    );
    txnMutationHook("legacy-target-derived");
    target = owner.target;
    assetPath = owner.assetPath;
  } else if (proposal.legacyAcceptedTargetDerived) {
    const acceptedTarget = proposal.acceptedTarget;
    if (!acceptedTarget) throw new Error(`Legacy proposal ${id} lost its derived accepted target.`);
    const bound = writableTargets.find((candidate) => {
      const candidatePath = resolveAssetFilePathSafe(candidate.source, ref);
      return (
        candidate.source.name === acceptedTarget.source &&
        path.resolve(candidate.source.path) === path.resolve(acceptedTarget.root) &&
        candidatePath !== undefined &&
        path.resolve(candidatePath) === path.resolve(acceptedTarget.path)
      );
    });
    if (!bound) {
      throw new UsageError(
        `legacy proposal ${id} is bound to a writable target that is no longer configured`,
        "INVALID_FLAG_VALUE",
      );
    }
    target = bound;
    assetPath = acceptedTarget.path;
  } else {
    target = resolveWriteTarget(config, options.target);
    const requestedAssetPath = resolveAssetFilePathSafe(target.source, ref);
    if (
      proposal.acceptedTarget.source !== target.source.name ||
      path.resolve(proposal.acceptedTarget.root) !== path.resolve(target.source.path) ||
      !requestedAssetPath ||
      path.resolve(proposal.acceptedTarget.path) !== path.resolve(requestedAssetPath)
    ) {
      throw new UsageError(`proposal ${id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
    }
    assetPath = requestedAssetPath;
  }

  await recoverTxnsForRoot(target.source.path, (journal) => journal.kind === "mv");
  acceptedHash = proposal.acceptedTarget?.contentHash ?? proposal.acceptedContentHash ?? acceptedHash;
  const acceptedAssetExists = fs.existsSync(assetPath);
  if (
    (fs.existsSync(assetPath) && proposalFileHash(assetPath) !== acceptedHash) ||
    (!fs.existsSync(assetPath) && !proposal.legacyAcceptedAssetWasAbsent)
  ) {
    throw new UsageError(
      `asset content changed after proposal ${id} was accepted; refusing to clobber the newer content`,
      "INVALID_FLAG_VALUE",
    );
  }
  const transaction = prepareProposalTransaction(
    stashDir,
    target,
    proposal,
    ref,
    backupContent,
    { operation: "revert", originalHash: acceptedAssetExists ? acceptedHash : null },
    ctx,
  );
  publishProposalAsset(transaction);
  const reverted = await finalizeProposalTransaction(transaction, target, proposal, ctx);
  cleanupTxn(transaction.dir);
  return { proposal: reverted, assetPath, ref: proposal.ref };
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
  const ref = parseRefInput(proposal.ref);

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

  const proposed = proposalContent(proposal);
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
  const typeDir = stashDirFor(ref.type);
  if (!typeDir) return undefined;
  const typeRoot = path.join(source.path, typeDir);
  try {
    return assetPathForName(ref.type, typeRoot, ref.name);
  } catch {
    return undefined;
  }
}

// Register the proposal transaction kinds with the unified engine so ANY
// recovery entry point (mv pre-flight, indexer, write-path indexer) can
// finish or roll back an interrupted proposal mutation for a root it
// touches. The proposal-owned entry points below keep their richer,
// ctx-threaded recovery paths over the same journals.
registerTxnKind<ProposalTxnPayload>(PROPOSAL_TXN_KIND, {
  phases: PROPOSAL_TXN_PHASES,
  commitPhase: "asset-published",
  validate: (journal, txnDir, root) => fenceProposalTxnJournal(journal, txnDir, root),
  rollback: (txn) => {
    rollbackPreparedProposalTransaction(txn);
  },
  finalize: async (txn) => {
    const p = txn.journal.payload;
    const config = loadConfig();
    let target: ResolvedWriteTarget;
    try {
      target = resolveWriteTarget(config, p.targetSource);
    } catch {
      target = resolveWriteTarget(config);
    }
    if (canonicalTxnRoot(target.source.path) !== canonicalTxnRoot(txn.journal.root)) {
      throw new Error(`Proposal transaction ${txn.journal.transactionId} is bound to a different target root.`);
    }
    const proposal = getProposal(p.stashDir, p.proposalId);
    await finalizeProposalTransaction(txn, target, proposal);
    cleanupProposalPublication(p);
  },
});

registerTxnKind<RejectTxnPayload>(REJECT_TXN_KIND, {
  phases: REJECT_TXN_PHASES,
  // A reject is roll-forward from its very first phase (DB-only; the archive
  // decision is durable the moment the journal exists).
  commitPhase: "prepared",
  rollback: () => {},
  finalize: (txn) => {
    finalizeRejectTransaction(txn as RejectTxn);
  },
});
