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
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ensureAkmMarkdownType } from "../../core/asset/akm-markdown";
import { assetPathForName, placementTypes, stashDirFor } from "../../core/asset/asset-placement";
import { isBundleSlug, parseBundleRef } from "../../core/asset/asset-ref";
import { assembleAsset, serializeFrontmatter } from "../../core/asset/asset-serialize";
import {
  carryForwardBookkeepingFrontmatter,
  computeNormalizedContentHash,
  parseFrontmatter,
} from "../../core/asset/frontmatter";
import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { type AkmConfig, loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { type FileChange, proposalContent } from "../../core/file-change";
import { canonicalBundleIdForTarget, resolveBundleWriteTarget } from "../../core/mutation-target";
import { getStateDbPath, withImmediateTransaction, withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import { recordWrittenPath } from "../../core/write-provenance";
import {
  assertAkmAssetWrite,
  commitWriteTargetBoundary,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWriteTarget,
  type WriteTargetSource,
} from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import type { Database } from "../../storage/database";
import { insertEventOnce } from "../../storage/repositories/events-repository";
import {
  type ImproveLedgerOutcome,
  recordImproveLedger,
  recordImproveLedgerDecision,
} from "../../storage/repositories/improve-ledger-repository";
import {
  getStateProposal,
  listStateProposalIdsByPrefix,
  listStateProposals,
  upsertProposal,
} from "../../storage/repositories/proposals-repository";
import { openSqliteReadSnapshot } from "../../storage/sqlite-read-snapshot";
import { pkgVersion } from "../../version";
import { runBaseChecks } from "../lint/base-linter";
import type { LintIssue, LintIssueType } from "../lint/types";
import { formatNewAssetDiff, formatUnifiedDiff } from "./diff-format";
import {
  ASSET_MISSING_GATE_REASON,
  AUTOMATED_PROPOSAL_SOURCES,
  type EligibilitySource,
  EXPIRED_GATE_REASON,
  isAutomatedProposalSource,
  isValidProposalSource,
  PROPOSAL_SOURCES,
  type Proposal,
  type ProposalGateDecision,
  type ProposalPayload,
  type ProposalSource,
  type ProposalStatus,
  STALE_TARGET_GATE_REASON,
} from "./proposal-types";
import {
  canonicalOnlyProposalValidators,
  hasCanonicalProposalValidator,
  runProposalValidators,
} from "./validators/proposal-validators";
import { repairProposalContent, validateProposal } from "./validators/proposals";

const PROMOTION_LINT_ISSUE_TYPES = new Set<LintIssueType>(["unquoted-colon", "missing-ref", "stale-path"]);

// ── Proposal domain types (moved to ./proposal-types.ts, WI-9.8 KILL 1) ─────
//
// Proposal / ProposalStatus / ProposalPayload / ProposalReview /
// ProposalGateDecision(Outcome) / ProposalSource / PROPOSAL_SOURCES /
// AUTOMATED_PROPOSAL_SOURCES / isValidProposalSource / isAutomatedProposalSource
// moved to the dependency-free leaf so validators/proposals.ts,
// validators/proposal-validators.ts, storage/repositories/proposals-repository.ts,
// and storage repositories can import the `Proposal` type without importing
// this heavier transaction-engine module back. That back-edge was the
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
export type ProposalRejectionReason =
  | "invalid_ref"
  | "unknown_type"
  | "empty_content"
  | "missing_description"
  | "invalid_canonical_structure";

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
    changes: p.changes.map((c, i) =>
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
  /**
   * Test seam — defaults to the OS username (`os.userInfo().username`,
   * falling back to `"local"`). Used ONLY as the `<id>` in the v0.2
   * `human:<id>` actor convention when {@link promoteProposal} stamps
   * provenance onto a human-attributed promotion (#730 D2). AKM has no
   * multi-user identity system; the OS account is the least-surprising
   * stand-in for "the human at this keyboard."
   */
  actorId?: () => string;
}

export interface CreateProposalInput {
  ref: string;
  /**
   * Stable destination identity for the proposal. Callers creating proposals
   * in a named queue should pass the resolved source name and materialized root
   * rather than relying on path-derived bundle identity.
   */
  target?: {
    source: string;
    root: string;
  };
  /**
   * Origin tag identifying the source subsystem (F-4 / #385).
   *
   * Should be one of {@link PROPOSAL_SOURCES}. Unknown values trigger a
   * runtime warning but are not rejected.
   * Automated sources ({@link AUTOMATED_PROPOSAL_SOURCES}) should include
   * `sourceRun` for PROV-DM traceability.
   */
  source: ProposalSource | string;
  /**
   * Run identifier for the automated job creating this proposal.
   * Recommended when `source` is automated. Logged as a warning when omitted
   * so the attribution gap is visible.
   */
  sourceRun?: string;
  payload: ProposalPayload;
  /**
   * Improve-ledger keys of the assets this proposal was generated from — the
   * input memory for distill, the source memory for a consolidate promotion.
   * Each gets an `improve_ledger` row (outcome `proposed`) in the same
   * transaction as the mint. Defaults to the proposal's own ref.
   */
  attemptedRefs?: readonly string[];
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

const MS_PER_DAY = 86_400_000;

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
 * Open the state database (honouring the `ctx.dbPath` test seam), hand the
 * connection to `fn`, and close it in a `finally`. Every public function in
 * this module funnels its store access through here.
 *
 * `stashDir` is threaded through the public API for the store's per-stash
 * partition.
 */
function withProposalsDb<T>(_stashDir: string, ctx: ProposalsContext | undefined, fn: (db: Database) => T): T {
  return withStateDb(fn, { path: ctx?.dbPath });
}

/**
 * WI-8.5a — the durable `proposals.ref` key in the final `bundle//conceptId`
 * item_ref grammar (D-R3). The conceptId is BUILT from the D-R2 static table
 * ({@link conceptIdFromTypeName} = `<stash-subdir>/<name>`), never looked up, so a
 * proposal targeting a not-yet-existing asset (no index entry) still keys onto
 * its final spelling. The bundle is the configured write target's bundle id,
 * so a proposal's ref matches the item_ref the indexer mints for the accepted
 * asset byte-for-byte.
 *
 * Every explicit bundle qualifier remains part of the durable ref.
 */
/**
 * Parse a user-supplied `--ref` / `idOrRef` filter. Qualified filters retain
 * their bundle instead of collapsing to the concept id, while short filters
 * intentionally match that concept in the selected queue. Invalid filters fail
 * loudly with the current ref grammar.
 */
interface ProposalRefIdentity {
  conceptId: string;
  bundle?: string;
}

function proposalRefIdentity(ref: string): ProposalRefIdentity | undefined {
  try {
    const parsed = parseBundleRef(ref);
    if (parsed.fragment !== undefined || isRetiredProposalConceptId(parsed.conceptId)) return undefined;
    return {
      conceptId: parsed.conceptId,
      ...(parsed.bundle !== undefined ? { bundle: parsed.bundle } : {}),
    };
  } catch {
    return undefined;
  }
}

function filterRefIdentity(ref: string): ProposalRefIdentity {
  try {
    const p = parseBundleRef(ref);
    if (p.fragment !== undefined || isRetiredProposalConceptId(p.conceptId)) {
      throw new Error("not a current proposal identity");
    }
    return {
      conceptId: p.conceptId,
      ...(p.bundle !== undefined ? { bundle: p.bundle } : {}),
    };
  } catch {
    throw new UsageError(
      `Invalid asset-ref filter "${ref}". Use the 0.9.0 grammar [bundle//]conceptId, e.g. knowledge/guide.md or lessons/deploy.`,
      "INVALID_FLAG_VALUE",
    );
  }
}

function isRetiredProposalConceptId(conceptId: string): boolean {
  const colon = conceptId.indexOf(":");
  return colon > 0 && stashDirFor(conceptId.slice(0, colon)) !== undefined;
}

function proposalMatchesRef(proposalRef: string, filter: ProposalRefIdentity): boolean {
  const proposal = proposalRefIdentity(proposalRef);
  return (
    proposal !== undefined &&
    proposal.conceptId === filter.conceptId &&
    (filter.bundle === undefined || proposal.bundle === filter.bundle)
  );
}

function proposalDurableRef(parsedRef: AssetRef, target: NonNullable<CreateProposalInput["target"]>): string {
  const conceptId = conceptIdFromTypeName(parsedRef.type, parsedRef.name);
  const { origin } = parsedRef;
  if (!isBundleSlug(target.source)) {
    throw new UsageError(`Proposal target source "${target.source}" is not a valid bundle name.`, "INVALID_FLAG_VALUE");
  }
  if (origin !== undefined) {
    if (target.source !== origin) {
      throw new UsageError(
        `Proposal ref bundle "${origin}" conflicts with target source "${target.source}".`,
        "INVALID_FLAG_VALUE",
      );
    }
    return `${origin}//${conceptId}`;
  }
  return `${target.source}//${conceptId}`;
}

function resolveCreateProposalTarget(
  stashDir: string,
  explicit: CreateProposalInput["target"] | undefined,
  bundle: string | undefined,
): NonNullable<CreateProposalInput["target"]> {
  if (explicit) {
    if (!isBundleSlug(explicit.source) || !explicit.root.trim()) {
      throw new UsageError(
        "Proposal targets require a current bundle name and materialized root.",
        "INVALID_FLAG_VALUE",
      );
    }
    return { source: explicit.source, root: path.resolve(explicit.root) };
  }
  const config = loadConfig();
  const local = resolveProposalQueueTarget(stashDir, config);
  if (!bundle || bundle === local.source) return local;
  if (bundle) {
    const target = resolveBundleWriteTarget(config, bundle);
    return { source: target.source.name, root: target.source.path };
  }
  return local;
}

export function resolveProposalQueueTarget(
  stashDir: string,
  config: AkmConfig = loadConfig(),
): NonNullable<CreateProposalInput["target"]> {
  const root = path.resolve(stashDir);
  const sources = resolveSourceEntries(root, config);
  const sourceIndex = sources.findIndex((source) => path.resolve(source.path) === root);
  const source = sources[sourceIndex];
  const bundleId = sourceIndex >= 0 ? deriveInstallations(sources)[sourceIndex]?.id : undefined;
  if (!source || !bundleId) {
    throw new ConfigError(`No bundle owns proposal queue ${root}.`, "INVALID_CONFIG_FILE");
  }
  if (!source.registryId && Object.keys(config.bundles ?? {}).length > 0) {
    throw new ConfigError(`No configured bundle owns proposal queue ${root}.`, "INVALID_CONFIG_FILE");
  }
  if (source.writable !== true) {
    throw new UsageError(`Proposal bundle "${bundleId}" is not writable.`, "INVALID_FLAG_VALUE");
  }
  return { source: bundleId, root };
}

/** Mint-time target resolution for {@link createProposal}. */
interface ProposalTargetInfo {
  proposalTarget: NonNullable<CreateProposalInput["target"]>;
  normalizedRef: string;
  targetRoot: string;
  targetRelPath: string;
  beforeHash?: string;
  /** Bookkeeping-insensitive counterpart of {@link beforeHash} (STALE, R20). */
  beforeHashNormalized?: string;
}

/**
 * Resolve the durable target ref, target root/rel-path, and current
 * before-hash for a parsed proposal ref (WI-6.2).
 */
function resolveProposalTargetInfo(
  stashDir: string,
  parsedRef: ReturnType<typeof parseRefInput>,
  explicitTarget: CreateProposalInput["target"] | undefined,
): ProposalTargetInfo {
  const proposalTarget = resolveCreateProposalTarget(stashDir, explicitTarget, parsedRef.origin);
  const normalizedRef = proposalDurableRef(parsedRef, proposalTarget);
  const targetRoot = path.resolve(proposalTarget.root);
  let targetRelPath: string;
  let mintBeforeContent: string | undefined;
  try {
    const typeRoot = path.join(targetRoot, stashDirFor(parsedRef.type) as string);
    const targetAbs = assetPathForName(parsedRef.type, typeRoot, parsedRef.name);
    targetRelPath = path.relative(targetRoot, targetAbs);
    if (fs.existsSync(targetAbs)) mintBeforeContent = fs.readFileSync(targetAbs, "utf8");
  } catch {
    // Resolution failure degrades to a best-effort create — never blocks the mint.
    targetRelPath = path.join(stashDirFor(parsedRef.type) as string, parsedRef.name);
  }
  return {
    proposalTarget,
    normalizedRef,
    targetRoot,
    targetRelPath,
    beforeHash: mintBeforeContent !== undefined ? proposalHash(mintBeforeContent) : undefined,
    beforeHashNormalized: mintBeforeContent !== undefined ? computeNormalizedContentHash(mintBeforeContent) : undefined,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new pending proposal. The id is a stable random UUID, so two
 * proposals with the same `ref` never collide.
 *
 * The mint and its `improve_ledger` rows (outcome `proposed`, one per
 * {@link CreateProposalInput.attemptedRefs} entry) commit in one transaction.
 * Whether a ref may be proposed again is decided before generation, by the
 * stage's candidate selection reading that ledger — not here.
 */
export function createProposal(stashDir: string, input: CreateProposalInput, ctx?: ProposalsContext): Proposal {
  if (!isValidProposalSource(input.source)) {
    warn(
      `[proposal] Unknown source "${input.source}". ` +
        `Expected one of: ${PROPOSAL_SOURCES.join(", ")}. ` +
        "Typos in source values produce unaggregatable accept-rate-per-source metrics.",
    );
  } else if (isAutomatedProposalSource(input.source) && !input.sourceRun) {
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
  if (input.target && parsedRef.origin && input.target.source !== parsedRef.origin) {
    return rejectProposal(
      "invalid_ref",
      `Qualified proposal ref bundle "${parsedRef.origin}" conflicts with queue target "${input.target.source}".`,
    );
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

  // WI-6.2: derive the FileChange[] envelope + mint-time beforeHash. The
  // target is resolved against the proposal's OWN stash (a local snapshot —
  // accept re-resolves the write target from config at apply time), and only
  // the before-state's HASH is kept: the change's `before` body is a
  // transaction-time capture that does not exist at mint time.
  const {
    proposalTarget,
    normalizedRef,
    targetRoot,
    targetRelPath,
    beforeHash: mintedBeforeHash,
    beforeHashNormalized: mintedBeforeHashNormalized,
  } = resolveProposalTargetInfo(stashDir, parsedRef, input.target);
  const proposalContent = targetRelPath.toLowerCase().endsWith(".md")
    ? ensureAkmMarkdownType(input.payload.content, parsedRef.type)
    : input.payload.content;
  const mintedChanges: FileChange[] = [
    {
      path: targetRelPath,
      after: proposalContent,
      op: mintedBeforeHash !== undefined ? "update" : "create",
    },
  ];

  if (hasCanonicalProposalValidator(parsedRef.type)) {
    // Mint-time gate: structural shape only (generic + canonical-per-type),
    // NOT the full quality-validator list — see canonicalOnlyProposalValidators'
    // doc comment (#952 review round 2). Quality validators (including the
    // blocking reflect-truncation-marker guard) run at `proposal accept` /
    // drain-promotion time via validateProposal instead.
    const report = runProposalValidators(
      {
        id: "pending",
        ref: normalizedRef,
        status: "pending",
        source: input.source,
        createdAt: "",
        updatedAt: "",
        payload: { ...input.payload, content: proposalContent },
        changes: mintedChanges,
        proposedTarget: { source: proposalTarget.source, root: targetRoot },
      },
      canonicalOnlyProposalValidators,
    );
    if (!report.ok) {
      return rejectProposal(
        "invalid_canonical_structure",
        `Proposal for "${input.ref}" has invalid ${parsedRef.type} structure:\n${report.findings
          .map((finding) => `[${finding.kind}] ${finding.message}`)
          .join("\n")}`,
      );
    }
  }

  return withProposalsDb(stashDir, ctx, (db) => {
    return withImmediateTransaction(db, () => {
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
          content: proposalContent,
          ...(input.payload.frontmatter !== undefined ? { frontmatter: input.payload.frontmatter } : {}),
        },
        changes: mintedChanges,
        proposedTarget: { source: proposalTarget.source, root: targetRoot },
        ...(mintedBeforeHash !== undefined ? { beforeHash: mintedBeforeHash } : {}),
        ...(mintedBeforeHashNormalized !== undefined ? { beforeHashNormalized: mintedBeforeHashNormalized } : {}),
        ...(sanitizedConfidence !== undefined ? { confidence: sanitizedConfidence } : {}),
        // Attribution tagging: persist the eligibility lane so it survives to
        // accept/reject/revert time. See EligibilitySource.
        ...(input.eligibilitySource !== undefined ? { eligibilitySource: input.eligibilitySource } : {}),
      };

      upsertProposal(db, proposal, stashDir);
      for (const ref of input.attemptedRefs ?? [normalizedRef]) {
        recordImproveLedger(db, {
          stashDir,
          ref,
          source: input.source,
          outcome: "proposed",
          at: created,
          proposalId: proposal.id,
        });
      }
      return proposal;
    });
  });
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
    // Short filters match by conceptId; qualified filters additionally retain
    // bundle identity. Applied in JS because a short query does not equal the
    // fully-qualified stored ref.
    const wantRef = options.ref !== undefined ? filterRefIdentity(options.ref) : undefined;
    return listStateProposals(db, {
      stashDir,
      ...(status !== undefined ? { status } : {}),
    }).filter((p) => {
      if (wantRef !== undefined && !proposalMatchesRef(p.ref, wantRef)) {
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
 * Read proposal context without creating or migrating state.db.
 *
 * Prompt-building consumers call this before their first model dispatch. A
 * missing proposal store is therefore an empty snapshot, not a reason to
 * create durable state before a required symbolic credential is validated at
 * the dispatch boundary.
 */
export function listProposalsReadOnly(
  stashDir: string,
  options: { includeArchive?: boolean; status?: ProposalStatus; ref?: string; type?: string } = {},
  ctx?: ProposalsContext,
): Proposal[] {
  const dbPath = ctx?.dbPath ?? getStateDbPath();
  if (!fs.existsSync(dbPath)) return [];

  let db: Database | undefined;
  try {
    db = openSqliteReadSnapshot(dbPath);
    if (!db) return [];
    if (!options.includeArchive && options.status !== undefined && options.status !== "pending") return [];
    const status = options.includeArchive ? options.status : "pending";
    const wantRef = options.ref !== undefined ? filterRefIdentity(options.ref) : undefined;
    return listStateProposals(db, {
      stashDir,
      ...(status !== undefined ? { status } : {}),
    }).filter((proposal) => {
      if (wantRef !== undefined && !proposalMatchesRef(proposal.ref, wantRef)) return false;
      if (!options.type) return true;
      try {
        return parseRefInput(proposal.ref).type === options.type;
      } catch {
        return false;
      }
    });
  } finally {
    db?.close();
  }
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
    throw new NotFoundError(`Proposal "${id}" not found.`, "PROPOSAL_NOT_FOUND");
  }
  return proposal;
}

/**
 * Resolve a proposal by full UUID, UUID prefix, or asset ref.
 *
 * Resolution order:
 *   1. Exact UUID match (existing behaviour).
 *   2. Asset ref (contains `/`) — finds the most-recent pending proposal for
 *      that ref; falls back to archived if nothing is pending.
 *   3. UUID prefix — matches any PENDING proposal whose id starts with the
 *      given string; throws if ambiguous.
 */
export function resolveProposalId(stashDir: string, idOrRef: string, ctx?: ProposalsContext): Proposal {
  return withProposalsDb(stashDir, ctx, (db) => {
    // 1. Exact UUID.
    const exact = getStateProposal(db, idOrRef, stashDir);
    if (exact) return exact;

    // 2. Asset ref — most recent pending, else most recent archived. Qualified
    // refs retain bundle identity; short refs match by conceptId in this queue.
    const wantRef = idOrRef.includes(":") || idOrRef.includes("/") ? filterRefIdentity(idOrRef) : undefined;
    if (wantRef !== undefined) {
      const byRecency = (proposals: Proposal[]): Proposal | undefined =>
        proposals.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
      const forConcept = (status?: string): Proposal[] =>
        listStateProposals(db, { stashDir, ...(status !== undefined ? { status } : {}) }).filter((p) =>
          proposalMatchesRef(p.ref, wantRef),
        );
      const pending = byRecency(forConcept("pending"));
      if (pending) return pending;
      const archived = byRecency(forConcept());
      if (archived) return archived;
      throw new NotFoundError(`No proposal found for ref "${idOrRef}".`, "PROPOSAL_NOT_FOUND");
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

    throw new NotFoundError(`Proposal "${idOrRef}" not found.`, "PROPOSAL_NOT_FOUND");
  });
}

/**
 * The improve-ledger outcome a proposal decision records. A procedural
 * refusal — the retention expiry, the drain's stale-target auto-reject, an
 * orphan whose asset is gone — is not a judgement on the content, so it never
 * carries the rejection window.
 */
function ledgerOutcomeForDecision(
  status: "accepted" | "rejected" | "reverted",
  gateDecision?: Pick<ProposalGateDecision, "outcome" | "reason">,
): ImproveLedgerOutcome {
  if (status === "accepted") return "accepted";
  if (gateDecision?.outcome === "auto-rejected") {
    if (gateDecision.reason === EXPIRED_GATE_REASON) return "expired";
    if (gateDecision.reason === STALE_TARGET_GATE_REASON || gateDecision.reason === ASSET_MISSING_GATE_REASON) {
      return "failed";
    }
  }
  return "rejected";
}

/**
 * Archive a proposal: flip its status to `accepted` / `rejected`, bump
 * `updatedAt`, and record the review block. Used by both accept and reject
 * paths so the live queue only contains pending entries. The decision lands
 * in the improve ledger in the same transaction.
 */
export function archiveProposal(
  stashDir: string,
  id: string,
  status: "accepted" | "rejected",
  reason: string | undefined,
  ctx?: ProposalsContext,
  gateDecision?: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string },
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
        ...(gateDecision ? { gateDecision: { ...gateDecision, decidedAt: gateDecision.decidedAt ?? decidedAt } } : {}),
      };
      upsertProposal(db, updated, stashDir);
      recordImproveLedgerDecision(db, {
        proposalId: updated.id,
        stashDir,
        ref: updated.ref,
        source: updated.source,
        outcome: ledgerOutcomeForDecision(status, gateDecision),
        at: decidedAt,
        ...(reason !== undefined ? { detail: reason } : {}),
      });
      return updated;
    });
  });
}

/**
 * Record a gate's decision onto a proposal (#577): the triage drain's verdict,
 * or the generating stage's quality-judge pass / review deferral.
 *
 * Stamps `gateDecision` (decision / reason / measurement / thresholds) onto the
 * row so `akm proposal show` and `list` can explain why a proposal landed where
 * it did. The decision is metadata about the adjudication, so this does NOT
 * change `status` or bump `updatedAt` — a `deferred` proposal stays `pending`,
 * and the accept / reject status flips are owned by {@link promoteProposal} /
 * {@link archiveProposal}. `decidedAt` defaults to now when the caller omits it.
 *
 * A `deferred` decision (left for human review) records `review_needed` in the
 * improve ledger.
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
      const decidedAt = decision.decidedAt ?? nowIso(ctx);
      const updated: Proposal = { ...existing, gateDecision: { ...decision, decidedAt } };
      upsertProposal(db, updated, stashDir);
      if (decision.outcome === "deferred") {
        recordImproveLedgerDecision(db, {
          proposalId: updated.id,
          stashDir,
          ref: updated.ref,
          source: updated.source,
          outcome: "review_needed",
          at: decidedAt,
          detail: decision.reason,
        });
      }
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
        archiveProposal(stashDir, p.id, "rejected", "Asset no longer exists on disk", ctx, {
          outcome: "auto-rejected",
          reason: ASSET_MISSING_GATE_REASON,
          gate: "orphan-purge",
        });
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
 * Each expired proposal is archived with status `rejected`, reason
 * `"expired: no action within retention window"` and an `expired` gate
 * decision, and records `expired` in the improve ledger — a short grace, never
 * the rejection window: nobody judged the content. A `proposal_expired` event
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
      archiveProposal(stashDir, p.id, "rejected", "expired: no action within retention window", ctx, {
        outcome: "auto-rejected",
        reason: EXPIRED_GATE_REASON,
        gate: "retention",
      });
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

/** SHA-256 hex digest of proposal/asset bytes. */
export function proposalHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Hash of a proposal's primary content — what a `staged` gate decision
 * records, so a later reader can tell the judged bytes from an edited retry.
 */
export function proposalContentHash(proposal: Proposal): string {
  return proposalHash(proposalContent(proposal));
}

function proposalFileHash(filePath: string): string {
  return proposalHash(fs.readFileSync(filePath));
}

/**
 * Record an accept or revert: the proposal row and its event in one state.db
 * transaction, after the asset file is already on disk. Idempotent — a
 * proposal already in the requested state is returned unchanged.
 */
function persistProposalDecision(
  stashDir: string,
  proposal: Proposal,
  decision:
    | {
        operation: "accept";
        target: ResolvedWriteTarget;
        assetPath: string;
        content: string;
        originalHash: string | null;
        backupContent?: string;
        eventMetadata?: Record<string, unknown>;
        gateDecision?: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string };
        decidedAt: string;
      }
    | { operation: "revert"; assetPath: string; decidedAt: string },
  ctx?: ProposalsContext,
): Proposal {
  return withProposalsDb(stashDir, ctx, (db) =>
    withImmediateTransaction(db, () => {
      const current = requireProposal(db, stashDir, proposal.id);
      let next: Proposal;
      if (decision.operation === "accept") {
        const publishedHash = proposalHash(decision.content);
        if (current.status === "accepted") {
          if (current.acceptedTarget?.contentHash !== publishedHash) {
            throw new Error(`Accepted proposal ${proposal.id} does not match the published content.`);
          }
          return current;
        }
        if (current.status !== "pending") {
          throw new Error(`Proposal ${proposal.id} changed status during acceptance (${current.status}).`);
        }
        const root = decision.target.source.path;
        const persisted: Proposal =
          proposal.changes.length > 0 && proposal.changes.every((change) => change.path.length > 0)
            ? withProposalContent(proposal, decision.content)
            : {
                ...proposal,
                payload: { ...proposal.payload, content: decision.content },
                changes: [
                  {
                    path: path.relative(root, decision.assetPath),
                    op: decision.originalHash === null ? "create" : "update",
                    after: decision.content,
                  },
                ],
                proposedTarget: { source: decision.target.source.name, root },
              };
        next = {
          ...persisted,
          status: "accepted",
          updatedAt: decision.decidedAt,
          review: { outcome: "accepted", decidedAt: decision.decidedAt },
          acceptedTarget: {
            source: decision.target.source.name,
            root,
            path: decision.assetPath,
            contentHash: publishedHash,
          },
          ...(decision.gateDecision
            ? {
                gateDecision: {
                  ...decision.gateDecision,
                  decidedAt: decision.gateDecision.decidedAt ?? decision.decidedAt,
                },
              }
            : {}),
          ...(decision.backupContent !== undefined ? { backupContent: decision.backupContent } : {}),
        };
      } else {
        if (current.status === "reverted") return current;
        if (current.status !== "accepted") {
          throw new Error(`Proposal ${proposal.id} changed status during reversion (${current.status}).`);
        }
        next = {
          ...current,
          status: "reverted",
          updatedAt: decision.decidedAt,
          review: {
            outcome: "rejected",
            reason: "reverted: prior content restored from backup",
            decidedAt: decision.decidedAt,
          },
        };
      }
      upsertProposal(db, next, stashDir);
      recordImproveLedgerDecision(db, {
        proposalId: next.id,
        stashDir,
        ref: next.ref,
        source: next.source,
        outcome: ledgerOutcomeForDecision(decision.operation === "accept" ? "accepted" : "reverted"),
        at: decision.decidedAt,
        ...(decision.operation === "revert" ? { detail: "reverted" } : {}),
      });
      insertEventOnce(db, {
        eventType: decision.operation === "accept" ? "promoted" : "proposal_reverted",
        ts: decision.decidedAt,
        ref: next.ref,
        metadata: {
          proposalId: next.id,
          source: next.source,
          ...(next.sourceRun !== undefined ? { sourceRun: next.sourceRun } : {}),
          assetPath: decision.assetPath,
          ...(next.eligibilitySource !== undefined ? { eligibilitySource: next.eligibilitySource } : {}),
          ...(decision.operation === "accept" && decision.eventMetadata ? decision.eventMetadata : {}),
        },
        idempotencyKey: `${next.id}:${decision.operation === "accept" ? "promoted" : "reverted"}`,
      });
      return next;
    }),
  );
}

export function rejectProposalDurably(
  stashDir: string,
  proposalId: string,
  reason?: string,
  ctx?: ProposalsContext,
  gateDecision?: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string },
): Proposal {
  const decidedAt = nowIso(ctx);
  const rejected = archiveProposal(
    stashDir,
    proposalId,
    "rejected",
    reason,
    { ...ctx, now: () => Date.parse(decidedAt) },
    gateDecision,
  );
  withProposalsDb(stashDir, ctx, (db) =>
    withImmediateTransaction(db, () => {
      insertEventOnce(db, {
        eventType: "rejected",
        ts: decidedAt,
        ref: rejected.ref,
        metadata: {
          proposalId: rejected.id,
          source: rejected.source,
          ...(rejected.sourceRun !== undefined ? { sourceRun: rejected.sourceRun } : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
        idempotencyKey: `${rejected.id}:rejected`,
      });
    }),
  );
  return rejected;
}

/** Write `content` to `assetPath` atomically (temp file + rename), keeping an existing file's mode. */
function writeProposalAssetFile(assetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  const mode = fs.existsSync(assetPath) ? fs.statSync(assetPath).mode & 0o777 : 0o644;
  const tempPath = path.join(path.dirname(assetPath), `.akm-proposal-${process.pid}-${randomUUID()}.tmp`);
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode });
  try {
    fs.renameSync(tempPath, assetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  recordWrittenPath(assetPath);
}

/** Index the file just written; the next `akm index` catches up when this cannot. */
async function indexWrittenProposalAsset(target: ResolvedWriteTarget, assetPath: string): Promise<void> {
  try {
    if (!(await indexWrittenAssets(target.source.path, [assetPath], { bundleId: target.source.name }))) {
      warn(`[proposals] ${assetPath} was written but not indexed; run \`akm index\`.`);
    }
  } catch (error) {
    warn(
      `[proposals] ${assetPath} was written but not indexed (${error instanceof Error ? error.message : String(error)}); run \`akm index\`.`,
    );
  }
}

export interface PromoteResult {
  proposal: Proposal;
  /** Where the asset was written. */
  assetPath: string;
  /** Normalised asset ref. */
  ref: string;
}

function resolveRecordedProposalTarget(
  config: AkmConfig,
  proposalId: string,
  binding: { source: string; root: string },
  explicitTarget?: string,
): ResolvedWriteTarget {
  let target: ResolvedWriteTarget;
  try {
    target = explicitTarget
      ? resolveWriteTarget(config, explicitTarget)
      : resolveBundleWriteTarget(config, binding.source);
  } catch {
    throw new UsageError(
      `Proposal ${proposalId} is bound to target "${binding.source}" at ${binding.root}, but that writable target is no longer configured.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const targetBundleId = canonicalBundleIdForTarget(config, target);
  if (targetBundleId !== binding.source || path.resolve(target.source.path) !== path.resolve(binding.root)) {
    throw new UsageError(
      `Proposal ${proposalId} is bound to target "${binding.source}" at ${binding.root}; ` +
        `--target "${explicitTarget}" resolves to "${targetBundleId}" at ${target.source.path}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return { ...target, source: { ...target.source, name: targetBundleId } };
}

function resolveProposalWriteTarget(
  config: AkmConfig,
  proposal: Proposal,
  explicitTarget?: string,
  queueTarget?: ResolvedWriteTarget,
): ResolvedWriteTarget {
  if (!proposal.proposedTarget) {
    const identity = proposalRefIdentity(proposal.ref);
    if (!identity) throw new UsageError(`Proposal ${proposal.id} has an invalid ref.`, "INVALID_PROPOSAL");
    if (identity.bundle !== undefined) {
      const target = resolveBundleWriteTarget(config, identity.bundle);
      const targetBundleId = canonicalBundleIdForTarget(config, target);
      if (explicitTarget !== undefined) {
        const explicit = resolveWriteTarget(config, explicitTarget);
        if (canonicalBundleIdForTarget(config, explicit) !== identity.bundle) {
          throw new UsageError(
            `Proposal ${proposal.id} ref is bound to bundle "${identity.bundle}", which conflicts with --target "${explicitTarget}".`,
            "INVALID_FLAG_VALUE",
          );
        }
      }
      if (queueTarget && canonicalBundleIdForTarget(config, queueTarget) !== identity.bundle) {
        throw new UsageError(`Proposal ${proposal.id} is bound to a different queue target.`, "INVALID_FLAG_VALUE");
      }
      return { ...target, source: { ...target.source, name: targetBundleId } };
    }
    const target = explicitTarget ? resolveWriteTarget(config, explicitTarget) : queueTarget;
    if (!target) {
      throw new UsageError(
        `Unbound short proposal ${proposal.id} requires an explicit --target or authenticated --queue context.`,
        "INVALID_PROPOSAL",
      );
    }
    const targetBundleId = canonicalBundleIdForTarget(config, target);
    return { ...target, source: { ...target.source, name: targetBundleId } };
  }
  if (queueTarget && explicitTarget === undefined) {
    const queueBundleId = canonicalBundleIdForTarget(config, queueTarget);
    if (
      queueBundleId !== proposal.proposedTarget.source ||
      path.resolve(queueTarget.source.path) !== path.resolve(proposal.proposedTarget.root)
    ) {
      throw new UsageError(`Proposal ${proposal.id} is bound to a different queue target.`, "INVALID_FLAG_VALUE");
    }
  }
  return resolveRecordedProposalTarget(config, proposal.id, proposal.proposedTarget, explicitTarget);
}

// ── D2 (#730) — OKF v0.2 provenance stamping on promotion ───────────────────
//
// The proposals system already tracks exactly what OKF v0.2 wants on disk —
// `source`/`sourceRun` (PROV-DM modeled, `proposal-types.ts` §80-120),
// `gateDecision` (`:200-237`), `review` (`:170-174`) — but none of it leaves
// state.db. This section projects it onto the written asset's frontmatter at
// promotion time, AKM-native assets only (an OKF-adapter target never reaches
// this function — `assertAkmAssetWrite` rejects it earlier in
// `promoteProposalWithLease`, before any of this runs).
//
// Two DISTINCT actors, deliberately not conflated (documented judgment call —
// see the PR body for the alternative considered and rejected):
//   - `generated.by` answers "what produced the CONTENT" — keyed on
//     `isAutomatedProposalSource(proposal.source)`: an automated pipeline
//     (reflect/distill/consolidate/extract/improve/schema-repair) stamps
//     `akm/<pkgVersion>`; a human-initiated source (propose/remember/import)
//     or the semi-automated `feedback` source stamps `human:<actorId>`.
//   - `verified[0].by` answers "what accepted/reviewed THIS promotion" —
//     keyed on whether a `gateDecision` was supplied to THIS call: present
//     (the automated drain/triage path decided) stamps `akm/<pkgVersion>`;
//     absent (a human explicitly ran `akm proposal accept`) stamps
//     `human:<actorId>`. Every promotion reaches this function via exactly
//     one of those two paths, so `verified` is always stamped — there is no
//     third, unreviewed path to disk.

/** Resolve the `human:<id>` actor id — the OS account, the least-surprising stand-in for "the human at this keyboard" in a system with no multi-user identity. */
function resolveActorId(ctx?: ProposalsContext): string {
  if (ctx?.actorId) return ctx.actorId();
  try {
    const username = os.userInfo().username?.trim();
    return username ? username : "local";
  } catch {
    return "local";
  }
}

/** `generated.by` — keyed on the SOURCE that produced the content (see file-header note above). */
function generatedByActor(proposal: Proposal, ctx?: ProposalsContext): string {
  return isAutomatedProposalSource(proposal.source) ? `akm/${pkgVersion}` : `human:${resolveActorId(ctx)}`;
}

/** `verified[0].by` — keyed on whether THIS promotion was gated (automated) or a direct human accept (see file-header note above). */
function verifiedByActor(
  gateDecision: (Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string }) | undefined,
  ctx?: ProposalsContext,
): string {
  return gateDecision !== undefined ? `akm/${pkgVersion}` : `human:${resolveActorId(ctx)}`;
}

/** True for a plain (non-null, non-array) object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stamp OKF v0.2 provenance onto ONE promoted asset's frontmatter (D2.1/D2.2/
 * D2.3), in the **hybrid** on-disk shape settled by the #730 review:
 *
 * - `generated: {by, at}` and `verified: [{by, at}]` are written **bare at the
 *   top level**, exactly as OKF v0.2 spells them (SPEC §5.2/§5.3). Neither key
 *   has any pre-existing AKM consumer, so spelling them the spec's way costs
 *   nothing and makes `okf-support.md`'s "AKM Markdown is an OKF-compatible
 *   superset" positioning actually true for trust metadata: a third-party OKF
 *   v0.2 reader pointed at an AKM stash sees conformant provenance.
 * - `sources` stays namespaced under `provenance:`, because a bare top-level
 *   `sources:` genuinely collides with the pre-existing AKM-native wiki
 *   citation-**string** convention
 *   (`indexer/passes/metadata.ts#applyWikiFrontmatter`, which silently drops
 *   non-strings) on a promoted wiki page.
 *
 * The read side back into `IndexDocument.provenance` is
 * `metadata.ts#applyProvenanceFrontmatter` (which accepts both this shape and
 * the older fully-nested one), carried through `akm-adapter.ts`'s
 * `DOCUMENT_JSON_CARRIED_FIELDS` (D2.4).
 *
 * A no-op frontmatter mutation preserves the existing frontmatter block's raw
 * body bytes (mirrors `frontmatter.ts#mutateFrontmatter`'s documented
 * contract) rather than reshaping via `assembleAsset`, which would strip
 * leading body blank lines / force a trailing newline. A file with no
 * frontmatter block at all (non-conformant input) gains one via
 * `assembleAsset`, exactly as any other first-frontmatter write would.
 */
function stampProposalProvenance(
  content: string,
  proposal: Proposal,
  gateDecision: (Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string }) | undefined,
  ctx: ProposalsContext | undefined,
  nowIsoStr: string,
): string {
  const parsed = parseFrontmatter(content);
  const fm: Record<string, unknown> = { ...parsed.data };
  const existingProvenance = isPlainRecord(fm.provenance) ? fm.provenance : {};

  // Bare `generated:` — OKF v0.2's replacement for `timestamp` (SPEC §13).
  fm.generated = { by: generatedByActor(proposal, ctx), at: nowIsoStr };

  // Bare `verified:` — append, so independent confirmations accumulate rather
  // than the newest overwriting the record. Both the bare list and the older
  // nested spelling are absorbed, so a re-promotion never loses history.
  const priorVerified = Array.isArray(fm.verified)
    ? fm.verified
    : Array.isArray(existingProvenance.verified)
      ? existingProvenance.verified
      : [];
  fm.verified = [
    ...priorVerified,
    { by: verifiedByActor(gateDecision, ctx), at: gateDecision?.decidedAt ?? nowIsoStr },
  ];

  // `sources` alone stays namespaced — bare `sources:` is the wiki
  // citation-string convention. Drop the nested provenance block entirely when
  // it would otherwise be empty, so unrelated assets gain no dead key.
  const provenance: Record<string, unknown> = { ...existingProvenance };
  delete provenance.generatedBy;
  delete provenance.generatedAt;
  delete provenance.verified;

  const evidenceSources = fm.evidenceSources;
  if (Array.isArray(evidenceSources)) {
    const sources = evidenceSources
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((resource) => ({ resource: resource.trim() }));
    if (sources.length > 0) provenance.sources = sources;
  }

  if (Object.keys(provenance).length > 0) fm.provenance = provenance;
  else delete fm.provenance;

  return parsed.frontmatter !== null
    ? `---\n${serializeFrontmatter(fm)}\n---\n${parsed.content}`
    : assembleAsset(fm, parsed.content);
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
  options: {
    target?: string;
    queueTarget?: ResolvedWriteTarget;
    eventMetadata?: Record<string, unknown>;
    gateDecision?: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string };
  } = {},
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  return withAssetMutationLease("proposal-accept", () => promoteProposalWithLease(stashDir, config, id, options, ctx));
}

function promotionLintBlockers(
  raw: string,
  assetPath: string,
  targetRoot: string,
  refType: string,
  config: AkmConfig,
): LintIssue[] {
  let data: Record<string, unknown>;
  let body: string;
  let frontmatter: string | null;
  if (refType === "task") {
    try {
      const parsed = parseYaml(raw);
      data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    body = raw;
    frontmatter = null;
  } else {
    ({ data, content: body, frontmatter } = parseFrontmatter(raw));
  }

  const resolvedRoot = path.resolve(targetRoot);
  const extraStashRoots = resolveSourceEntries(targetRoot, config)
    .map((source) => source.path)
    .filter((sourcePath) => path.resolve(sourcePath) !== resolvedRoot);
  return runBaseChecks({
    filePath: assetPath,
    relPath: path.relative(targetRoot, assetPath),
    raw,
    data,
    body,
    frontmatter,
    fix: false,
    stashRoot: targetRoot,
    extraStashRoots,
  }).filter((finding) => PROMOTION_LINT_ISSUE_TYPES.has(finding.issue));
}

export interface ProposalPromotionPreflight {
  proposal: Proposal;
  repairedContent: string;
  ref: AssetRef;
  target: ResolvedWriteTarget;
  assetPath: string;
  stampedContent: string;
}

/** Build and validate the exact stamped bytes promotion would publish, without writing. */
export function preflightProposalPromotion(
  config: AkmConfig,
  proposal: Proposal,
  options: {
    target?: string;
    queueTarget?: ResolvedWriteTarget;
    gateDecision?: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string };
  } = {},
  ctx?: ProposalsContext,
): ProposalPromotionPreflight {
  const repairedContent = repairProposalContent(proposalContent(proposal));
  const preparedProposal =
    repairedContent === proposalContent(proposal) ? proposal : withProposalContent(proposal, repairedContent);
  const report = validateProposal(preparedProposal);
  if (!report.ok) {
    const message = report.findings.map((finding) => `[${finding.kind}] ${finding.message}`).join("\n");
    throw new UsageError(
      `Proposal ${proposal.id} failed validation:\n${message}`,
      "MISSING_REQUIRED_ARGUMENT",
      "Fix the proposal payload (frontmatter / content) and try again, or reject the proposal with a reason.",
    );
  }

  const ref = parseRefInput(preparedProposal.ref);
  if (!stashDirFor(ref.type)) {
    throw new UsageError(`Proposal ${proposal.id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }
  const target = resolveProposalWriteTarget(config, preparedProposal, options.target, options.queueTarget);
  const assetPath = resolveAssetFilePathSafe(target.source, ref);
  if (!assetPath) throw new UsageError(`Cannot resolve proposal target ${preparedProposal.ref}.`, "INVALID_PROPOSAL");
  assertAkmAssetWrite(target.source);

  let stampedContent = assetPath.toLowerCase().endsWith(".md")
    ? stampProposalProvenance(repairedContent, preparedProposal, options.gateDecision, ctx, nowIso(ctx))
    : repairedContent;
  if (assetPath.toLowerCase().endsWith(".md") && fs.existsSync(assetPath)) {
    // STALE (R20): carry the live target's akm bookkeeping frontmatter
    // forward when the proposal's own frontmatter doesn't set it, so
    // promoting never drops e.g. `inferenceProcessed` and makes memory
    // inference reprocess the memory. Best-effort — an unreadable live file
    // here doesn't block promotion; the freshness guard below is the real
    // gate on staleness.
    try {
      const liveRaw = fs.readFileSync(assetPath, "utf8");
      stampedContent = carryForwardBookkeepingFrontmatter(stampedContent, liveRaw);
    } catch {
      // Best-effort — see comment above.
    }
  }
  const lintBlockers = promotionLintBlockers(stampedContent, assetPath, target.source.path, ref.type, config);
  if (lintBlockers.length > 0) {
    const summary = lintBlockers.map((finding) => `[${finding.issue}] ${finding.detail}`).join("; ");
    warn(`[proposal] promotion lint for ${proposal.id} found (non-blocking): ${summary}`);
  }

  return { proposal: preparedProposal, repairedContent, ref, target, assetPath, stampedContent };
}

async function promoteProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: {
    target?: string;
    queueTarget?: ResolvedWriteTarget;
    eventMetadata?: Record<string, unknown>;
    gateDecision?: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string };
  },
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  let proposal = getProposal(stashDir, id, ctx);
  const repairedContent = repairProposalContent(proposalContent(proposal));
  const proposalToValidate =
    repairedContent === proposalContent(proposal) ? proposal : withProposalContent(proposal, repairedContent);
  const report = validateProposal(proposalToValidate);
  if (!report.ok) {
    const message = report.findings.map((finding) => `[${finding.kind}] ${finding.message}`).join("\n");
    throw new UsageError(
      `Proposal ${id} failed validation:\n${message}`,
      "MISSING_REQUIRED_ARGUMENT",
      "Fix the proposal payload (frontmatter / content) and try again, or reject the proposal with a reason.",
    );
  }
  const ref = parseRefInput(proposalToValidate.ref);
  if (!stashDirFor(ref.type)) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  // Use the (possibly repaired) payload for the promotion write. Persist the
  // repaired content back onto the DB row so the audit trail reflects the
  // final promoted payload (not the defective original).
  if (repairedContent !== proposalContent(proposal)) {
    withProposalsDb(stashDir, ctx, (db) => {
      upsertProposal(db, proposalToValidate, stashDir);
    });
  }

  proposal = getProposal(stashDir, id, ctx);
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  if (proposal.status === "accepted") {
    if (!proposal.acceptedTarget) {
      throw new UsageError(`Accepted proposal ${id} has no recorded target.`, "INVALID_PROPOSAL");
    }
    const assetPath = resolveAssetFilePathSafe(target.source, ref);
    if (
      proposal.acceptedTarget.source !== target.source.name ||
      path.resolve(proposal.acceptedTarget.root) !== path.resolve(target.source.path) ||
      !assetPath ||
      path.resolve(proposal.acceptedTarget.path) !== path.resolve(assetPath)
    ) {
      throw new UsageError(`proposal ${id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
    }
    if (
      !assetPath ||
      !fs.existsSync(assetPath) ||
      proposalFileHash(assetPath) !== proposal.acceptedTarget.contentHash
    ) {
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
  const preflight = preflightProposalPromotion(config, proposal, { ...options, queueTarget: target }, ctx);

  const mutationTarget = prepareWriteTargetForMutation(target);
  const assetPath = resolveAssetFilePathSafe(mutationTarget.source, ref);
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
  if (proposal.beforeHash !== undefined) {
    // STALE (R20): a proposal minted with a normalized before-hash is fresh
    // when the CURRENT target's bookkeeping-stripped content still matches —
    // insensitive to a same-run bookkeeping rewrite (salience scoring,
    // inference dedup marking) of the target after mint. A legacy proposal
    // without one keeps the exact raw-hash check it always had.
    const fresh =
      proposal.beforeHashNormalized !== undefined
        ? backup !== undefined &&
          computeNormalizedContentHash(backup.toString("utf8")) === proposal.beforeHashNormalized
        : backup !== undefined && proposalHash(backup) === proposal.beforeHash;
    // A file that already holds this proposal's content is a promotion that
    // wrote the asset but did not get to record the decision: finish it.
    const alreadyPublished =
      backup !== undefined &&
      computeNormalizedContentHash(backup.toString("utf8")) === computeNormalizedContentHash(preflight.stampedContent);
    if (!fresh && !alreadyPublished) {
      throw new UsageError(
        `Proposal target changed after proposal ${id} was created; refusing to overwrite newer content.`,
        "INVALID_FLAG_VALUE",
      );
    }
  }
  if (
    proposal.beforeHash === undefined &&
    backup !== undefined &&
    proposal.changes.some((change) => change.op === "create")
  ) {
    throw new UsageError(
      `Proposal target was created after proposal ${id}; refusing to overwrite newer content.`,
      "INVALID_FLAG_VALUE",
    );
  }
  assertAkmAssetWrite(mutationTarget.source);
  // D2 (#730): stamp OKF v0.2 provenance onto the promoted content BEFORE
  // lint/write — reaching this point already proves the target is AKM-native
  // (assertAkmAssetWrite above rejects an OKF-adapter target first), so the
  // OKF write-rejection contract (runbook §10) is untouched: this code never
  // runs for it. Markdown-only: a task/env/script/other non-markdown target
  // has no frontmatter block to stamp into.
  //
  // workflow-format-unification removed the re-validation fallback that used
  // to live here: every AKM-native markdown type (workflow included) now
  // validates its frontmatter against a schema whose closed key set is
  // `envelope ∪ type-keys` (`schemas/akm-workflow.json` $ref's
  // `schemas/akm-asset-envelope.json`, which already admits `generated`/
  // `verified`/`provenance`/`status`/`stale_after`). A validator rejecting the
  // machine-stamped keys it is contractually required to admit is structurally
  // impossible now, so falling back to unstamped content on rejection would
  // only silently hide a real regression instead of promoting stamped content.
  const stampedContent = preflight.stampedContent;
  const proposalForPreflight = preflight.proposal;
  const refIdentity = proposalRefIdentity(proposalForPreflight.ref);
  const proposalForMutation: Proposal =
    refIdentity?.bundle === undefined
      ? { ...proposalForPreflight, ref: `${target.source.name}//${refIdentity?.conceptId ?? ""}` }
      : proposalForPreflight;
  const decidedAt = nowIso(ctx);
  const content = stampedContent.endsWith("\n") ? stampedContent : `${stampedContent}\n`;
  writeProposalAssetFile(assetPath, content);
  commitWriteTargetBoundary(mutationTarget, `Update ${proposalForMutation.ref}`, { paths: [assetPath] });
  const accepted = persistProposalDecision(
    stashDir,
    proposalForMutation,
    {
      operation: "accept",
      target: mutationTarget,
      assetPath,
      content,
      originalHash: backup ? proposalHash(backup) : null,
      ...(backup !== undefined ? { backupContent: backup.toString("utf8") } : {}),
      ...(options.eventMetadata ? { eventMetadata: options.eventMetadata } : {}),
      ...(options.gateDecision ? { gateDecision: options.gateDecision } : {}),
      decidedAt,
    },
    ctx,
  );
  await indexWrittenProposalAsset(mutationTarget, assetPath);
  return { proposal: accepted, assetPath, ref: accepted.ref };
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
  options: { target?: string; queueTarget?: ResolvedWriteTarget } = {},
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  return withAssetMutationLease("proposal-revert", () => revertProposalWithLease(stashDir, config, id, options, ctx));
}

async function revertProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string; queueTarget?: ResolvedWriteTarget },
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  let proposal = getProposal(stashDir, id, ctx);
  const ref = parseRefInput(proposal.ref);
  if (!stashDirFor(ref.type)) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  proposal = getProposal(stashDir, id, ctx);
  if (proposal.status === "reverted") {
    if (!proposal.acceptedTarget) {
      throw new UsageError(`Reverted proposal ${id} has no recorded target.`, "INVALID_PROPOSAL");
    }
    const target = resolveRecordedProposalTarget(config, id, proposal.acceptedTarget, options.target);
    const requestedAssetPath = resolveAssetFilePathSafe(target.source, ref);
    if (
      !requestedAssetPath ||
      proposal.acceptedTarget.source !== target.source.name ||
      path.resolve(proposal.acceptedTarget.root) !== path.resolve(target.source.path) ||
      path.resolve(proposal.acceptedTarget.path) !== path.resolve(requestedAssetPath)
    ) {
      throw new UsageError(`proposal ${id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
    }
    return {
      proposal,
      assetPath: requestedAssetPath,
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
  if (!proposal.acceptedTarget) {
    throw new UsageError(`Accepted proposal ${id} has no recorded target.`, "INVALID_PROPOSAL");
  }
  let target = resolveRecordedProposalTarget(config, id, proposal.acceptedTarget, options.target);
  const requestedAssetPath = resolveAssetFilePathSafe(target.source, ref);
  if (
    proposal.acceptedTarget.source !== target.source.name ||
    path.resolve(proposal.acceptedTarget.root) !== path.resolve(target.source.path) ||
    !requestedAssetPath ||
    path.resolve(proposal.acceptedTarget.path) !== path.resolve(requestedAssetPath)
  ) {
    throw new UsageError(`proposal ${id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
  }
  const assetPath = requestedAssetPath;
  const acceptedHash = proposal.acceptedTarget.contentHash;
  target = prepareWriteTargetForMutation(target);
  if (!fs.existsSync(assetPath) || proposalFileHash(assetPath) !== acceptedHash) {
    throw new UsageError(
      `asset content changed after proposal ${id} was accepted; refusing to clobber the newer content`,
      "INVALID_FLAG_VALUE",
    );
  }
  const decidedAt = nowIso(ctx);
  writeProposalAssetFile(assetPath, backupContent.endsWith("\n") ? backupContent : `${backupContent}\n`);
  commitWriteTargetBoundary(target, `Revert ${proposal.ref}`, { paths: [assetPath] });
  const reverted = persistProposalDecision(stashDir, proposal, { operation: "revert", assetPath, decidedAt }, ctx);
  await indexWrittenProposalAsset(target, assetPath);
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
  options: { target?: string; queueTarget?: ResolvedWriteTarget } = {},
  ctx?: ProposalsContext,
): ProposalDiff {
  const proposal = getProposal(stashDir, id, ctx);
  const ref = parseRefInput(proposal.ref);

  let targetPath: string | undefined;
  let existing: string | null = null;
  const readTarget = (target: ResolvedWriteTarget): void => {
    targetPath = resolveAssetFilePathSafe(target.source, ref);
    if (targetPath && fs.existsSync(targetPath)) {
      existing = fs.readFileSync(targetPath, "utf8");
    }
  };
  readTarget(resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget));

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
