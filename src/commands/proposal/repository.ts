// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The proposal queue (#225; storage in state.db since #578). Proposals are
 * queue state, not assets: rows in the `proposals` table partitioned by
 * `stash_dir`, where archival is a status flip that keeps the full audit trail
 * (review, reason, backup for revert). They never go through the asset writer
 * until accepted — {@link promoteProposal} is the bridge that writes the
 * accepted payload into the bundle.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ensureAkmMarkdownType } from "../../core/asset/akm-markdown";
import { assetPathForName, placementTypes, stashDirFor } from "../../core/asset/asset-placement";
import { isBundleSlug, parseBundleRef } from "../../core/asset/asset-ref";
import { assembleAsset, serializeFrontmatter } from "../../core/asset/asset-serialize";
import { carryForwardBookkeepingFrontmatter, parseFrontmatter } from "../../core/asset/frontmatter";
import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { type AkmConfig, loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { type FileChange, proposalContent } from "../../core/file-change";
import type { MemoryPruneCandidate } from "../../core/improve-types";
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
import { contentHash } from "../improve/content-hash";
import { writeSupersededEdge } from "../improve/memory/memory-belief";
import { archiveCleanupCandidate, derivedTwinPath } from "../improve/memory/memory-improve";
import { runBaseChecks } from "../lint/base-linter";
import type { LintIssue, LintIssueType } from "../lint/types";
import { formatNewAssetDiff, formatUnifiedDiff } from "./diff-format";
import {
  ASSET_MISSING_GATE_REASON,
  type EligibilitySource,
  EXPIRED_GATE_REASON,
  isAutomatedProposalSource,
  isRetireProposal,
  isValidProposalSource,
  PROPOSAL_SOURCES,
  type Proposal,
  type ProposalGateDecision,
  type ProposalPayload,
  type ProposalSource,
  type ProposalStatus,
  type RetireAcceptIntent,
  type RetirementMetadata,
  STALE_TARGET_GATE_REASON,
} from "./proposal-types";
import {
  canonicalOnlyProposalValidators,
  hasCanonicalProposalValidator,
  runProposalValidators,
} from "./validators/proposal-validators";
import { repairProposalContent, validateProposal } from "./validators/proposals";

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
export { proposalContent };

const PROMOTION_LINT_ISSUE_TYPES = new Set<LintIssueType>(["unquoted-colon", "missing-ref", "stale-path"]);
const MS_PER_DAY = 86_400_000;

type GateDecisionInput = Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string };

/** Why {@link createProposal} refused its input (the `proposal_creation_rejected` event's `reason`). */
type ProposalRejectionReason =
  | "invalid_ref"
  | "unknown_type"
  | "empty_content"
  | "missing_description"
  | "invalid_canonical_structure";

export interface OrphanPurgeResult {
  checked: number;
  rejected: number;
  durationMs: number;
  byType: Record<string, number>;
  orphans: Array<{ id: string; ref: string; reason: string }>;
}

export interface ExpireStaleResult {
  checked: number;
  expired: number;
  durationMs: number;
  retentionDays: number;
  expiredProposals: Array<{ id: string; ref: string; ageDays: number }>;
}

/** `p` with `content` as both the payload and the primary change's `after` (they must agree). */
function withProposalContent(p: Proposal, content: string): Proposal {
  return {
    ...p,
    payload: { ...p.payload, content },
    // A delete-op primary change carries no `after`.
    changes: p.changes.map((c, i) => (i === 0 && c.op !== "delete" ? { ...c, after: content } : c)),
  };
}

export interface ProposalsContext {
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
  /** Test seam — the state.db path. */
  dbPath?: string;
  /** The `<id>` of a `human:<id>` provenance actor; defaults to the OS username, else `local`. */
  actorId?: () => string;
}

export interface CreateProposalInput {
  ref: string;
  /** The queue's bundle name and materialized root; derived from the stash when omitted. */
  target?: { source: string; root: string };
  /** One of {@link PROPOSAL_SOURCES}; an unknown value warns. */
  source: ProposalSource | string;
  /** The automated run that made it (PROV-DM); an automated source without one warns. */
  sourceRun?: string;
  payload: ProposalPayload;
  /**
   * Ledger keys of the assets this proposal came from (distill's input memory,
   * consolidate's source memory); each gets a `proposed` ledger row in the mint
   * transaction. Defaults to the proposal's own ref.
   */
  attemptedRefs?: readonly string[];
  /** Confidence in [0, 1]; anything else is dropped. */
  confidence?: number;
  /** The eligibility lane that selected the source asset. */
  eligibilitySource?: EligibilitySource;
  /**
   * A consolidate PROMOTION proposal's source memory ref (alpha.9, O1): set
   * by `emitPromotionProposal`. On accept, the source (and its `.derived`
   * twin) is retired through the same archive path a `retire` proposal uses.
   */
  promotionSource?: string;
  /** Body content hash of `promotionSource` at mint time (alpha.9, B3) — see `Proposal.promotionSourceHash`. */
  promotionSourceHash?: string;
}

function nowIso(ctx?: ProposalsContext): string {
  return new Date((ctx?.now ?? Date.now)()).toISOString();
}

function withProposalsDb<T>(ctx: ProposalsContext | undefined, fn: (db: Database) => T): T {
  return withStateDb(fn, { path: ctx?.dbPath });
}

interface ProposalRefIdentity {
  conceptId: string;
  bundle?: string;
}

function isRetiredProposalConceptId(conceptId: string): boolean {
  const colon = conceptId.indexOf(":");
  return colon > 0 && stashDirFor(conceptId.slice(0, colon)) !== undefined;
}

function proposalRefIdentity(ref: string): ProposalRefIdentity | undefined {
  try {
    const parsed = parseBundleRef(ref);
    if (parsed.fragment !== undefined || isRetiredProposalConceptId(parsed.conceptId)) return undefined;
    return { conceptId: parsed.conceptId, ...(parsed.bundle !== undefined ? { bundle: parsed.bundle } : {}) };
  } catch {
    return undefined;
  }
}

/** A `--ref` filter: a short ref matches its concept in the queue, a qualified one also its bundle. */
function filterRefIdentity(ref: string): ProposalRefIdentity {
  const identity = proposalRefIdentity(ref);
  if (!identity) {
    throw new UsageError(
      `Invalid asset-ref filter "${ref}". Use the 0.9.0 grammar [bundle//]conceptId, e.g. knowledge/guide.md or lessons/deploy.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return identity;
}

function proposalMatchesRef(proposalRef: string, filter: ProposalRefIdentity): boolean {
  const proposal = proposalRefIdentity(proposalRef);
  return (
    proposal !== undefined &&
    proposal.conceptId === filter.conceptId &&
    (filter.bundle === undefined || proposal.bundle === filter.bundle)
  );
}

/**
 * The durable `proposals.ref`: `bundle//conceptId`, the conceptId built from
 * the type table (so a not-yet-existing asset keys onto its final spelling) and
 * the bundle the queue writes to — byte-identical to the item_ref the indexer
 * mints for the accepted asset.
 */
function proposalDurableRef(parsedRef: AssetRef, target: NonNullable<CreateProposalInput["target"]>): string {
  const conceptId = conceptIdFromTypeName(parsedRef.type, parsedRef.name);
  if (!isBundleSlug(target.source)) {
    throw new UsageError(`Proposal target source "${target.source}" is not a valid bundle name.`, "INVALID_FLAG_VALUE");
  }
  if (parsedRef.origin !== undefined && target.source !== parsedRef.origin) {
    throw new UsageError(
      `Proposal ref bundle "${parsedRef.origin}" conflicts with target source "${target.source}".`,
      "INVALID_FLAG_VALUE",
    );
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
  const target = resolveBundleWriteTarget(config, bundle);
  return { source: target.source.name, root: target.source.path };
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

/**
 * Create a pending proposal (a random UUID id). Obviously invalid input is
 * refused with a typed `proposal_creation_rejected` event. The mint and its
 * `proposed` ledger rows commit in one transaction; whether a ref may be
 * proposed again is decided earlier, by the stage's candidate selection.
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
  const rejectProposal = (reason: ProposalRejectionReason, message: string): never => {
    appendEvent({
      eventType: "proposal_creation_rejected",
      ref: input.ref,
      metadata: { source: input.source, reason },
    });
    throw new UsageError(message, "INVALID_PROPOSAL");
  };

  let parsedRef: AssetRef;
  try {
    parsedRef = parseRefInput(input.ref);
  } catch (err) {
    return rejectProposal(
      "invalid_ref",
      `Invalid proposal ref "${input.ref}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const typeDir = stashDirFor(parsedRef.type);
  if (!typeDir) {
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
  // Only consolidate — the pipeline that historically flooded the queue with
  // frontmatter-less proposals — must carry a description.
  if (input.source === "consolidate") {
    const desc = input.payload.frontmatter?.description;
    if (typeof desc !== "string" || desc.trim() === "") {
      return rejectProposal(
        "missing_description",
        `Proposal for "${input.ref}" (source=consolidate) has empty or missing frontmatter description.`,
      );
    }
  }

  // The FileChange envelope, and the target's before-hashes as of mint (the
  // freshness check at accept compares against them).
  const proposalTarget = resolveCreateProposalTarget(stashDir, input.target, parsedRef.origin);
  const normalizedRef = proposalDurableRef(parsedRef, proposalTarget);
  const targetRoot = path.resolve(proposalTarget.root);
  let targetRelPath: string;
  let beforeContent: string | undefined;
  try {
    const targetAbs = assetPathForName(parsedRef.type, path.join(targetRoot, typeDir), parsedRef.name);
    targetRelPath = path.relative(targetRoot, targetAbs);
    if (fs.existsSync(targetAbs)) beforeContent = fs.readFileSync(targetAbs, "utf8");
  } catch {
    targetRelPath = path.join(typeDir, parsedRef.name);
  }
  const content = targetRelPath.toLowerCase().endsWith(".md")
    ? ensureAkmMarkdownType(input.payload.content, parsedRef.type)
    : input.payload.content;
  const changes: FileChange[] = [
    { path: targetRelPath, after: content, op: beforeContent !== undefined ? "update" : "create" },
  ];
  const proposedTarget = { source: proposalTarget.source, root: targetRoot };

  if (hasCanonicalProposalValidator(parsedRef.type)) {
    // Mint checks structure only; the quality validators run at accept.
    const report = runProposalValidators(
      {
        id: "pending",
        ref: normalizedRef,
        status: "pending",
        source: input.source,
        createdAt: "",
        updatedAt: "",
        payload: { ...input.payload, content },
        changes,
        proposedTarget,
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

  const confidence =
    typeof input.confidence === "number" &&
    Number.isFinite(input.confidence) &&
    input.confidence >= 0 &&
    input.confidence <= 1
      ? input.confidence
      : undefined;
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const created = nowIso(ctx);
      const proposal: Proposal = {
        id: (ctx?.randomUUID ?? randomUUID)(),
        ref: normalizedRef,
        status: "pending",
        source: input.source,
        ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
        createdAt: created,
        updatedAt: created,
        payload: {
          content,
          ...(input.payload.frontmatter !== undefined ? { frontmatter: input.payload.frontmatter } : {}),
        },
        changes,
        proposedTarget,
        ...(beforeContent !== undefined
          ? { beforeHash: contentHash(beforeContent), beforeHashNormalized: contentHash(beforeContent, "normalized") }
          : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(input.eligibilitySource !== undefined ? { eligibilitySource: input.eligibilitySource } : {}),
        ...(input.promotionSource !== undefined ? { promotionSource: input.promotionSource } : {}),
        ...(input.promotionSourceHash !== undefined ? { promotionSourceHash: input.promotionSourceHash } : {}),
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
    }),
  );
}

export interface CreateRetireProposalInput {
  /** The ref of the asset being retired — becomes the proposal's own ref. */
  ref: string;
  /** One of {@link PROPOSAL_SOURCES}; the consolidate pair pass always uses `"consolidate-pair"` (S6) — kept apart from `"consolidate"`'s promotions. */
  source: ProposalSource | string;
  sourceRun?: string;
  target?: { source: string; root: string };
  /** The pair judge's confidence in [0, 1]; anything else is dropped. */
  confidence?: number;
  retirement: RetirementMetadata;
}

/**
 * Mint a `retire` proposal (0.9.17-alpha.9, the consolidate pair pass): its
 * primary `FileChange` deletes `ref`'s own file rather than writing new
 * content, so this does not reuse {@link createProposal} (which always
 * builds a create/update change and enforces content/description rules that
 * do not apply to a delete). `ref` must already exist on disk — retiring a
 * phantom is a caller bug, refused rather than silently accepted.
 *
 * Deliberately does NOT record an `improve_ledger` "proposed" row: the pair
 * pass keys its own ledger cadence per INITIATOR (source `consolidate-pair`,
 * `pair-pass.ts`'s own end-of-run write), which may differ from this
 * proposal's `ref` — the initiator and the retired side are not always the
 * same asset (see `runConsolidatePairPass`). Recording one here, keyed by
 * the retired ref instead, would be a second, competing row for whichever
 * asset happens to be both.
 */
export function createRetireProposal(
  stashDir: string,
  input: CreateRetireProposalInput,
  ctx?: ProposalsContext,
): Proposal {
  if (!isValidProposalSource(input.source)) {
    warn(
      `[proposal] Unknown source "${input.source}" for a retire proposal. Expected one of: ${PROPOSAL_SOURCES.join(", ")}.`,
    );
  }
  let parsedRef: AssetRef;
  try {
    parsedRef = parseRefInput(input.ref);
  } catch (err) {
    throw new UsageError(
      `Invalid retire proposal ref "${input.ref}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_PROPOSAL",
    );
  }
  const typeDir = stashDirFor(parsedRef.type);
  if (!typeDir) {
    throw new UsageError(
      `Unknown asset type "${parsedRef.type}" in retire proposal ref "${input.ref}". Known types: ${[...placementTypes()].sort().join(", ")}.`,
      "INVALID_PROPOSAL",
    );
  }
  const proposalTarget = resolveCreateProposalTarget(stashDir, input.target, parsedRef.origin);
  const normalizedRef = proposalDurableRef(parsedRef, proposalTarget);
  const targetRoot = path.resolve(proposalTarget.root);
  const targetAbs = assetPathForName(parsedRef.type, path.join(targetRoot, typeDir), parsedRef.name);
  if (!fs.existsSync(targetAbs)) {
    throw new UsageError(`Retire proposal target "${input.ref}" does not exist at ${targetAbs}.`, "INVALID_PROPOSAL");
  }
  const targetRelPath = path.relative(targetRoot, targetAbs);
  const beforeContent = fs.readFileSync(targetAbs, "utf8");
  const changes: FileChange[] = [{ path: targetRelPath, op: "delete" }];
  const proposedTarget = { source: proposalTarget.source, root: targetRoot };
  const confidence =
    typeof input.confidence === "number" &&
    Number.isFinite(input.confidence) &&
    input.confidence >= 0 &&
    input.confidence <= 1
      ? input.confidence
      : undefined;
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const created = nowIso(ctx);
      const proposal: Proposal = {
        id: (ctx?.randomUUID ?? randomUUID)(),
        ref: normalizedRef,
        status: "pending",
        source: input.source,
        ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
        createdAt: created,
        updatedAt: created,
        payload: { content: "" },
        changes,
        proposedTarget,
        beforeHash: contentHash(beforeContent),
        beforeHashNormalized: contentHash(beforeContent, "normalized"),
        ...(confidence !== undefined ? { confidence } : {}),
        retirement: input.retirement,
      };
      upsertProposal(db, proposal, stashDir);
      return proposal;
    }),
  );
}

type ListProposalsOptions = { includeArchive?: boolean; status?: ProposalStatus; ref?: string; type?: string };

function queryProposals(db: Database, stashDir: string, options: ListProposalsOptions): Proposal[] {
  // The live queue holds only pending proposals, so without the archive a
  // non-pending status matches nothing.
  if (!options.includeArchive && options.status !== undefined && options.status !== "pending") return [];
  const status = options.includeArchive ? options.status : "pending";
  const wantRef = options.ref !== undefined ? filterRefIdentity(options.ref) : undefined;
  return listStateProposals(db, { stashDir, ...(status !== undefined ? { status } : {}) }).filter((p) => {
    if (wantRef !== undefined && !proposalMatchesRef(p.ref, wantRef)) return false;
    if (!options.type) return true;
    try {
      return parseRefInput(p.ref).type === options.type;
    } catch {
      return false;
    }
  });
}

/** One stash's proposals: the pending queue, or with `includeArchive` the decided ones too. */
export function listProposals(
  stashDir: string,
  options: ListProposalsOptions = {},
  ctx?: ProposalsContext,
): Proposal[] {
  return withProposalsDb(ctx, (db) => queryProposals(db, stashDir, options));
}

/**
 * {@link listProposals} on a read snapshot that never creates or migrates
 * state.db: prompt building runs before the first dispatch has validated its
 * credentials, and a missing store is simply empty.
 */
export function listProposalsReadOnly(
  stashDir: string,
  options: ListProposalsOptions = {},
  ctx?: ProposalsContext,
): Proposal[] {
  const dbPath = ctx?.dbPath ?? getStateDbPath();
  if (!fs.existsSync(dbPath)) return [];
  const db = openSqliteReadSnapshot(dbPath);
  if (!db) return [];
  try {
    return queryProposals(db, stashDir, options);
  } finally {
    db.close();
  }
}

/** A proposal by id, live or archived. */
export function getProposal(stashDir: string, id: string, ctx?: ProposalsContext): Proposal {
  return withProposalsDb(ctx, (db) => requireProposal(db, stashDir, id));
}

function requireProposal(db: Database, stashDir: string, id: string): Proposal {
  const proposal = getStateProposal(db, id, stashDir);
  if (!proposal) throw new NotFoundError(`Proposal "${id}" not found.`, "PROPOSAL_NOT_FOUND");
  return proposal;
}

/**
 * A proposal by exact id; else, for an asset ref, its most recent pending
 * proposal (then most recent archived); else by a unique pending id prefix.
 */
export function resolveProposalId(stashDir: string, idOrRef: string, ctx?: ProposalsContext): Proposal {
  return withProposalsDb(ctx, (db) => {
    const exact = getStateProposal(db, idOrRef, stashDir);
    if (exact) return exact;
    if (idOrRef.includes(":") || idOrRef.includes("/")) {
      const wantRef = filterRefIdentity(idOrRef);
      // Should-fix 7: by-ref resolution never picks a retire proposal — the
      // newest pending proposal for a ref could be a `consolidate-pair`
      // retirement rather than the reflect/distill edit a person typed the
      // ref to accept, and accepting it archives the asset instead. A retire
      // is reached by its own proposal id, or by the explicit generator
      // `consolidate-pair` (bulk accept/reject).
      const newest = (status?: string): Proposal | undefined =>
        listStateProposals(db, { stashDir, ...(status !== undefined ? { status } : {}) })
          .filter((p) => proposalMatchesRef(p.ref, wantRef) && !isRetireProposal(p))
          .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
      const found = newest("pending") ?? newest();
      if (found) return found;
      throw new NotFoundError(`No proposal found for ref "${idOrRef}".`, "PROPOSAL_NOT_FOUND");
    }
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
 * The ledger outcome of a decision. A procedural refusal (retention expiry, a
 * stale target, a missing asset) judged nothing, so it never carries the
 * rejection window.
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

/** Archive a pending proposal as accepted/rejected, recording the decision in the ledger in the same transaction. */
export function archiveProposal(
  stashDir: string,
  id: string,
  status: "accepted" | "rejected",
  reason: string | undefined,
  ctx?: ProposalsContext,
  gateDecision?: GateDecisionInput,
): Proposal {
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
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
        review: { outcome: status, ...(reason !== undefined ? { reason } : {}), decidedAt },
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
    }),
  );
}

/**
 * Stamp a gate's decision (#577) on a pending proposal without changing its
 * status: the drain's verdict, or the generating stage's judge pass or review
 * deferral (`deferred` records `review_needed` in the ledger). A proposal no
 * longer pending is skipped (`undefined`), so a batch never aborts.
 */
export function recordGateDecision(
  stashDir: string,
  id: string,
  decision: GateDecisionInput,
  ctx?: ProposalsContext,
): Proposal | undefined {
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
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
    }),
  );
}

/**
 * Reject pending `reflect` proposals whose target no longer exists in any of
 * `sourceDirs` (a maintenance pass). Other sources — lessons above all — may
 * legitimately target assets that do not exist yet.
 */
export function purgeOrphanProposals(
  stashDir: string,
  sourceDirs: string[],
  ctx?: ProposalsContext,
): OrphanPurgeResult {
  const t0 = Date.now();
  const orphans: OrphanPurgeResult["orphans"] = [];
  const byType: Record<string, number> = {};
  const reflectPending = listProposals(stashDir, { status: "pending" }, ctx).filter((p) => p.source === "reflect");
  for (const p of reflectPending) {
    let parsed: AssetRef;
    try {
      parsed = parseRefInput(p.ref);
    } catch {
      continue;
    }
    const spec = stashDirFor(parsed.type);
    if (parsed.type === "lesson" || !spec) continue;
    const exists = sourceDirs.some((root) =>
      fs.existsSync(assetPathForName(parsed.type, path.join(root, spec), parsed.name)),
    );
    if (exists) continue;
    try {
      archiveProposal(stashDir, p.id, "rejected", "Asset no longer exists on disk", ctx, {
        outcome: "auto-rejected",
        reason: ASSET_MISSING_GATE_REASON,
        gate: "orphan-purge",
      });
      orphans.push({ id: p.id, ref: p.ref, reason: "asset_missing" });
      byType[parsed.type] = (byType[parsed.type] ?? 0) + 1;
    } catch (err) {
      warn(
        `[proposals] purgeOrphanProposals: failed to reject ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { checked: reflectPending.length, rejected: orphans.length, durationMs: Date.now() - t0, byType, orphans };
}

/**
 * Archive pending proposals older than `archiveRetentionDays` (default 90;
 * 0 disables) as rejected with an `expired` gate decision and a
 * `proposal_expired` event. The ledger records `expired` — a short grace, not
 * the rejection window, since nobody judged the content.
 */
export function expireStaleProposals(stashDir: string, config: AkmConfig, ctx?: ProposalsContext): ExpireStaleResult {
  const t0 = Date.now();
  const retentionDays = config.archiveRetentionDays ?? 90;
  const expiredProposals: ExpireStaleResult["expiredProposals"] = [];
  if (retentionDays <= 0)
    return { checked: 0, expired: 0, durationMs: Date.now() - t0, retentionDays, expiredProposals };
  const nowMs = (ctx?.now ?? Date.now)();
  const pending = listProposals(stashDir, { status: "pending" }, ctx);
  for (const p of pending) {
    // Should-fix 8: a retire proposal never expires by age. B2's accept-time
    // hash check already refuses it once it goes stale, and the
    // one-pending-retire-per-asset rule (pair-pass.ts's pendingRetireRefs)
    // bounds how many can queue up — retention expiry would instead
    // permanently drop a still-fresh pair nobody has reviewed yet, with no
    // way back short of the pair pass finding it again from scratch.
    if (isRetireProposal(p)) continue;
    const createdMs = new Date(p.createdAt).getTime();
    if (!Number.isFinite(createdMs) || nowMs - createdMs < retentionDays * MS_PER_DAY) continue;
    try {
      archiveProposal(stashDir, p.id, "rejected", "expired: no action within retention window", ctx, {
        outcome: "auto-rejected",
        reason: EXPIRED_GATE_REASON,
        gate: "retention",
      });
      const ageDays = Math.floor((nowMs - createdMs) / MS_PER_DAY);
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

/** The hash a `staged` gate decision records, so a reader can tell the judged bytes from an edit. */
export function proposalContentHash(proposal: Proposal): string {
  return contentHash(proposalContent(proposal));
}

/**
 * Record an accept or revert — the row, its ledger decision and its event in
 * one transaction — after the asset file is on disk. A proposal already in the
 * requested state is returned unchanged.
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
        existed: boolean;
        backupContent?: string;
        eventMetadata?: Record<string, unknown>;
        gateDecision?: GateDecisionInput;
        decidedAt: string;
      }
    | { operation: "revert"; assetPath: string; decidedAt: string },
  ctx?: ProposalsContext,
): Proposal {
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const current = requireProposal(db, stashDir, proposal.id);
      let next: Proposal;
      if (decision.operation === "accept") {
        const publishedHash = contentHash(decision.content);
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
                    op: decision.existed ? "update" : "create",
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
      const accept = decision.operation === "accept";
      upsertProposal(db, next, stashDir);
      recordImproveLedgerDecision(db, {
        proposalId: next.id,
        stashDir,
        ref: next.ref,
        source: next.source,
        outcome: ledgerOutcomeForDecision(accept ? "accepted" : "reverted"),
        at: decision.decidedAt,
        ...(accept ? {} : { detail: "reverted" }),
      });
      insertEventOnce(db, {
        eventType: accept ? "promoted" : "proposal_reverted",
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
        idempotencyKey: `${next.id}:${accept ? "promoted" : "reverted"}`,
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
  gateDecision?: GateDecisionInput,
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
  withProposalsDb(ctx, (db) =>
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

/** Write `content` atomically (temp file + rename), keeping an existing file's mode. */
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
  assetPath: string;
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
  const named = (target: ResolvedWriteTarget): ResolvedWriteTarget => ({
    ...target,
    source: { ...target.source, name: canonicalBundleIdForTarget(config, target) },
  });
  if (!proposal.proposedTarget) {
    const identity = proposalRefIdentity(proposal.ref);
    if (!identity) throw new UsageError(`Proposal ${proposal.id} has an invalid ref.`, "INVALID_PROPOSAL");
    if (identity.bundle !== undefined) {
      const target = named(resolveBundleWriteTarget(config, identity.bundle));
      if (
        explicitTarget !== undefined &&
        canonicalBundleIdForTarget(config, resolveWriteTarget(config, explicitTarget)) !== identity.bundle
      ) {
        throw new UsageError(
          `Proposal ${proposal.id} ref is bound to bundle "${identity.bundle}", which conflicts with --target "${explicitTarget}".`,
          "INVALID_FLAG_VALUE",
        );
      }
      if (queueTarget && canonicalBundleIdForTarget(config, queueTarget) !== identity.bundle) {
        throw new UsageError(`Proposal ${proposal.id} is bound to a different queue target.`, "INVALID_FLAG_VALUE");
      }
      return target;
    }
    const target = explicitTarget ? resolveWriteTarget(config, explicitTarget) : queueTarget;
    if (!target) {
      throw new UsageError(
        `Unbound short proposal ${proposal.id} requires an explicit --target or authenticated --queue context.`,
        "INVALID_PROPOSAL",
      );
    }
    return named(target);
  }
  if (
    queueTarget &&
    explicitTarget === undefined &&
    (canonicalBundleIdForTarget(config, queueTarget) !== proposal.proposedTarget.source ||
      path.resolve(queueTarget.source.path) !== path.resolve(proposal.proposedTarget.root))
  ) {
    throw new UsageError(`Proposal ${proposal.id} is bound to a different queue target.`, "INVALID_FLAG_VALUE");
  }
  return resolveRecordedProposalTarget(config, proposal.id, proposal.proposedTarget, explicitTarget);
}

// ── OKF v0.2 provenance on promotion (#730) ─────────────────────────────────
// `generated.by` names what produced the content (an automated source is
// `akm/<version>`, anything else `human:<actor>`); `verified[].by` names what
// accepted this promotion (a gate decision is `akm/<version>`, a direct
// `akm proposal accept` is `human:<actor>`). Only AKM-native targets get here.

function resolveActorId(ctx?: ProposalsContext): string {
  if (ctx?.actorId) return ctx.actorId();
  try {
    return os.userInfo().username?.trim() || "local";
  } catch {
    return "local";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stamp provenance onto a promoted asset's frontmatter: bare top-level
 * `generated` and `verified` (as OKF v0.2 spells them; `verified` accumulates),
 * and `sources` under `provenance:`, since a bare `sources:` is the wiki
 * citation-string convention. An existing frontmatter block keeps its raw body
 * bytes.
 */
function stampProposalProvenance(
  content: string,
  proposal: Proposal,
  gateDecision: GateDecisionInput | undefined,
  ctx: ProposalsContext | undefined,
  nowIsoStr: string,
): string {
  const parsed = parseFrontmatter(content);
  const fm: Record<string, unknown> = { ...parsed.data };
  const existingProvenance = isPlainRecord(fm.provenance) ? fm.provenance : {};
  const human = () => `human:${resolveActorId(ctx)}`;
  fm.generated = { by: isAutomatedProposalSource(proposal.source) ? `akm/${pkgVersion}` : human(), at: nowIsoStr };
  // The older nested `provenance.verified` spelling is absorbed too, so history is never lost.
  const priorVerified = Array.isArray(fm.verified)
    ? fm.verified
    : Array.isArray(existingProvenance.verified)
      ? existingProvenance.verified
      : [];
  fm.verified = [
    ...priorVerified,
    { by: gateDecision !== undefined ? `akm/${pkgVersion}` : human(), at: gateDecision?.decidedAt ?? nowIsoStr },
  ];
  const provenance: Record<string, unknown> = { ...existingProvenance };
  delete provenance.generatedBy;
  delete provenance.generatedAt;
  delete provenance.verified;
  if (Array.isArray(fm.evidenceSources)) {
    const sources = fm.evidenceSources
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
 * Validate, stamp and write an accepted proposal into its bound target, then
 * archive it as accepted. Overwriting an existing asset keeps its prior content
 * on the row (`backupContent`) for `akm proposal revert`.
 */
export async function promoteProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: {
    target?: string;
    queueTarget?: ResolvedWriteTarget;
    eventMetadata?: Record<string, unknown>;
    gateDecision?: GateDecisionInput;
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
      data = isPlainRecord(parsed) ? parsed : {};
    } catch {
      data = {};
    }
    body = raw;
    frontmatter = null;
  } else {
    ({ data, content: body, frontmatter } = parseFrontmatter(raw));
  }
  const resolvedRoot = path.resolve(targetRoot);
  return runBaseChecks({
    filePath: assetPath,
    relPath: path.relative(targetRoot, assetPath),
    raw,
    data,
    body,
    frontmatter,
    fix: false,
    stashRoot: targetRoot,
    extraStashRoots: resolveSourceEntries(targetRoot, config)
      .map((source) => source.path)
      .filter((sourcePath) => path.resolve(sourcePath) !== resolvedRoot),
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

/** The exact stamped bytes a promotion would publish, validated, without writing. */
export function preflightProposalPromotion(
  config: AkmConfig,
  proposal: Proposal,
  options: { target?: string; queueTarget?: ResolvedWriteTarget; gateDecision?: GateDecisionInput } = {},
  ctx?: ProposalsContext,
): ProposalPromotionPreflight {
  const repairedContent = repairProposalContent(proposalContent(proposal));
  const prepared =
    repairedContent === proposalContent(proposal) ? proposal : withProposalContent(proposal, repairedContent);
  const report = validateProposal(prepared);
  if (!report.ok) {
    throw new UsageError(
      `Proposal ${proposal.id} failed validation:\n${report.findings.map((f) => `[${f.kind}] ${f.message}`).join("\n")}`,
      "MISSING_REQUIRED_ARGUMENT",
      "Fix the proposal payload (frontmatter / content) and try again, or reject the proposal with a reason.",
    );
  }
  const ref = parseRefInput(prepared.ref);
  if (!stashDirFor(ref.type)) {
    throw new UsageError(`Proposal ${proposal.id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }
  const target = resolveProposalWriteTarget(config, prepared, options.target, options.queueTarget);
  const assetPath = resolveAssetFilePathSafe(target.source, ref);
  if (!assetPath) throw new UsageError(`Cannot resolve proposal target ${prepared.ref}.`, "INVALID_PROPOSAL");
  assertAkmAssetWrite(target.source);
  const markdown = assetPath.toLowerCase().endsWith(".md");
  let stampedContent = markdown
    ? stampProposalProvenance(repairedContent, prepared, options.gateDecision, ctx, nowIso(ctx))
    : repairedContent;
  if (markdown && fs.existsSync(assetPath)) {
    // Keep the live target's bookkeeping frontmatter the proposal doesn't set
    // (STALE, R20) — dropping `inferenceProcessed` would re-run inference.
    try {
      stampedContent = carryForwardBookkeepingFrontmatter(stampedContent, fs.readFileSync(assetPath, "utf8"));
    } catch {
      // best-effort; the freshness check is the real staleness gate
    }
  }
  const lintBlockers = promotionLintBlockers(stampedContent, assetPath, target.source.path, ref.type, config);
  if (lintBlockers.length > 0) {
    const summary = lintBlockers.map((finding) => `[${finding.issue}] ${finding.detail}`).join("; ");
    warn(`[proposal] promotion lint for ${proposal.id} found (non-blocking): ${summary}`);
  }
  return { proposal: prepared, repairedContent, ref, target, assetPath, stampedContent };
}

/**
 * The target's current bytes, provided it is still the one the proposal was
 * minted against (STALE, R20): compared bookkeeping-insensitively when the
 * proposal carries a normalized before-hash, exactly otherwise. A target that
 * already holds this proposal's content is a promotion that wrote but did not
 * record — finishing it is allowed. Never overwrites newer content.
 */
export function readFreshProposalTarget(
  proposal: Proposal,
  assetPath: string,
  stampedContent: string,
): Buffer | undefined {
  const current = fs.existsSync(assetPath) ? fs.readFileSync(assetPath) : undefined;
  if (proposal.beforeHash !== undefined) {
    const fresh =
      current !== undefined &&
      (proposal.beforeHashNormalized !== undefined
        ? contentHash(current, "normalized") === proposal.beforeHashNormalized
        : contentHash(current) === proposal.beforeHash);
    const alreadyPublished =
      current !== undefined && contentHash(current, "normalized") === contentHash(stampedContent, "normalized");
    if (!fresh && !alreadyPublished) {
      throw new UsageError(
        `Proposal target changed after proposal ${proposal.id} was created; refusing to overwrite newer content.`,
        "INVALID_FLAG_VALUE",
      );
    }
  } else if (current !== undefined && proposal.changes.some((change) => change.op === "create")) {
    throw new UsageError(
      `Proposal target was created after proposal ${proposal.id}; refusing to overwrite newer content.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return current;
}

/** The recorded asset path of an accepted/reverted proposal, provided `target` is the same binding. */
function acceptedAssetPath(proposal: Proposal, target: ResolvedWriteTarget, ref: AssetRef): string {
  const accepted = proposal.acceptedTarget;
  const assetPath = resolveAssetFilePathSafe(target.source, ref);
  if (
    !accepted ||
    !assetPath ||
    accepted.source !== target.source.name ||
    path.resolve(accepted.root) !== path.resolve(target.source.path) ||
    path.resolve(accepted.path) !== path.resolve(assetPath)
  ) {
    throw new UsageError(`proposal ${proposal.id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
  }
  return assetPath;
}

function requireAcceptedTarget(proposal: Proposal): NonNullable<Proposal["acceptedTarget"]> {
  if (!proposal.acceptedTarget) {
    const label = proposal.status === "reverted" ? "Reverted" : "Accepted";
    throw new UsageError(`${label} proposal ${proposal.id} has no recorded target.`, "INVALID_PROPOSAL");
  }
  return proposal.acceptedTarget;
}

/**
 * O1 (alpha.9): an accepted consolidate PROMOTION retires its source memory
 * (and its `.derived` twin), so promotion no longer leaves a memory/
 * knowledge duplicate behind. Runs whether a person accepted the promotion
 * or triage auto-promotion did — this is called from inside
 * `promoteProposalWithLease`'s ordinary accept path, below the drain/CLI
 * layer, so both routes hit it the same way. Best-effort: a failure here
 * only warns — the promotion itself already succeeded and is not undone —
 * and a source already gone (raced with something else, or never existed)
 * is silently skipped, not an error.
 *
 * B3: the promotion was queued against the source's content as it stood at
 * mint time (`accepted.promotionSourceHash`). If the source was edited since
 * — the freshest edit is exactly what a person would not want silently
 * discarded into the archive — this only warns and leaves the source alone;
 * the promotion itself still stands. A proposal minted before this field
 * existed carries no hash at all, so it is treated the same way: never
 * archived, not verified against a hash that was never recorded.
 */
function retirePromotionSource(mutationTarget: ResolvedWriteTarget, accepted: Proposal): void {
  if (!accepted.promotionSource) return;
  try {
    const sourceRef = parseRefInput(accepted.promotionSource);
    const typeDir = stashDirFor(sourceRef.type);
    if (!typeDir) return;
    const sourcePath = assetPathForName(sourceRef.type, path.join(mutationTarget.source.path, typeDir), sourceRef.name);
    if (!fs.existsSync(sourcePath)) return;
    if (!accepted.promotionSourceHash) {
      warn(
        `[proposal] O1: ${accepted.id} has no recorded source hash (minted by an older release) — leaving its source ${accepted.promotionSource} unarchived.`,
      );
      return;
    }
    const currentHash = contentHash(fs.readFileSync(sourcePath, "utf8"), "body");
    if (currentHash !== accepted.promotionSourceHash) {
      warn(
        `[proposal] O1: source ${accepted.promotionSource} for ${accepted.id} changed since the promotion was queued — leaving it unarchived.`,
      );
      return;
    }
    const candidate: MemoryPruneCandidate = {
      ref: accepted.promotionSource,
      reason: "promoted",
      proposalId: accepted.id,
      successorRefs: [accepted.ref],
    };
    const record = archiveCleanupCandidate(mutationTarget.source.path, candidate, sourcePath);
    const paths = [
      sourcePath,
      path.join(mutationTarget.source.path, record.archivedPath),
      path.join(mutationTarget.source.path, record.auditPath),
    ];
    const twin = derivedTwinPath(sourcePath, sourceRef.type);
    if (twin) {
      const twinRecord = archiveCleanupCandidate(mutationTarget.source.path, candidate, twin);
      paths.push(
        twin,
        path.join(mutationTarget.source.path, twinRecord.archivedPath),
        path.join(mutationTarget.source.path, twinRecord.auditPath),
      );
    }
    commitWriteTargetBoundary(mutationTarget, `Retire promoted source ${accepted.promotionSource}`, { paths });
  } catch (error) {
    warn(
      `[proposal] O1: failed to retire promotion source ${accepted.promotionSource} for ${accepted.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function promoteProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: {
    target?: string;
    queueTarget?: ResolvedWriteTarget;
    eventMetadata?: Record<string, unknown>;
    gateDecision?: GateDecisionInput;
  },
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const proposal = getProposal(stashDir, id, ctx);
  if (isRetireProposal(proposal)) return retireProposalWithLease(stashDir, config, proposal, options, ctx);
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  if (proposal.status === "accepted") {
    // Accepting again is a no-op, provided the published bytes are still there.
    const recorded = requireAcceptedTarget(proposal);
    const assetPath = acceptedAssetPath(proposal, target, parseRefInput(proposal.ref));
    if (!fs.existsSync(assetPath) || contentHash(fs.readFileSync(assetPath)) !== recorded.contentHash) {
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
  const assetPath = resolveAssetFilePathSafe(mutationTarget.source, preflight.ref);
  if (!assetPath) throw new UsageError(`Cannot resolve proposal target ${proposal.ref}.`, "INVALID_PROPOSAL");
  const backup = readFreshProposalTarget(proposal, assetPath, preflight.stampedContent);
  assertAkmAssetWrite(mutationTarget.source);
  const refIdentity = proposalRefIdentity(preflight.proposal.ref);
  const proposalForMutation: Proposal =
    refIdentity?.bundle === undefined
      ? { ...preflight.proposal, ref: `${target.source.name}//${refIdentity?.conceptId ?? ""}` }
      : preflight.proposal;
  const decidedAt = nowIso(ctx);
  const content = preflight.stampedContent.endsWith("\n") ? preflight.stampedContent : `${preflight.stampedContent}\n`;
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
      existed: backup !== undefined,
      ...(backup !== undefined ? { backupContent: backup.toString("utf8") } : {}),
      ...(options.eventMetadata ? { eventMetadata: options.eventMetadata } : {}),
      ...(options.gateDecision ? { gateDecision: options.gateDecision } : {}),
      decidedAt,
    },
    ctx,
  );
  await indexWrittenProposalAsset(mutationTarget, assetPath);
  if (accepted.status === "accepted" && accepted.source === "consolidate")
    retirePromotionSource(mutationTarget, accepted);
  return { proposal: accepted, assetPath, ref: accepted.ref };
}

/**
 * Every archive dir a tombstone under `.akm/memory-cleanup/archive/` claims
 * for `proposalId` — the primary asset's, and its `.derived` twin's if one
 * was archived alongside it. Used to detect what a resumed retire accept
 * (should-fix 5) has already moved.
 */
function findRetireArchiveDirsByProposalId(stashRoot: string, proposalId: string): string[] | undefined {
  const archiveRoot = path.join(stashRoot, ".akm", "memory-cleanup", "archive");
  let entries: string[];
  try {
    entries = fs.readdirSync(archiveRoot);
  } catch {
    return undefined;
  }
  const dirs: string[] = [];
  for (const name of entries) {
    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(fs.readFileSync(path.join(archiveRoot, name, "cleanup.md"), "utf8")).data;
    } catch {
      continue;
    }
    if (data.proposalId === proposalId) dirs.push(path.relative(stashRoot, path.join(archiveRoot, name)));
  }
  return dirs.length > 0 ? dirs : undefined;
}

/** The absolute original paths a set of archive dirs' own tombstones claim — for resume detection. */
function alreadyArchivedOriginalPaths(stashRoot: string, dirs: string[]): Set<string> {
  const paths = new Set<string>();
  for (const dirRel of dirs) {
    try {
      const data = parseFrontmatter(fs.readFileSync(path.join(stashRoot, dirRel, "cleanup.md"), "utf8")).data;
      if (typeof data.originalPath === "string") paths.add(path.resolve(stashRoot, data.originalPath));
    } catch {
      // An unreadable tombstone just is not counted "already done" — the move below re-attempts that file.
    }
  }
  return paths;
}

/**
 * Should-fix 5: record a retire accept's intent — `backupContent` and which
 * files (asset, `.derived` twin) are about to move — on the still-pending
 * proposal BEFORE any file is moved. A crash after this point resumes from
 * exactly this record instead of re-deriving `backupContent` from whatever
 * is on disk afterward, or from the archived copy, which for a `supersedes`
 * judgement already carries the edge the accept itself is about to write.
 */
function recordRetireAcceptIntent(
  stashDir: string,
  proposalId: string,
  intent: RetireAcceptIntent,
  ctx?: ProposalsContext,
): Proposal {
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const current = requireProposal(db, stashDir, proposalId);
      if (current.retireAcceptIntent) return current;
      const next: Proposal = { ...current, retireAcceptIntent: intent };
      upsertProposal(db, next, stashDir);
      return next;
    }),
  );
}

/**
 * Persist a retire's "accepted" decision — the row, its ledger decision and
 * its event — the one finalize step a fresh accept and one resumed after a
 * crash (should-fix 5) share: by the time either calls it, every file move
 * is already confirmed done. Mirrors the accept branch of
 * {@link persistProposalDecision}, kept separate since a retire's
 * accepted-shape fields (`retiredArchive`, no published `content`) do not
 * fit that function's create/update-shaped `decision` union.
 */
function persistRetireAcceptance(
  stashDir: string,
  proposal: Proposal,
  info: {
    targetName: string;
    targetRoot: string;
    assetPath: string;
    contentHash: string;
    archiveDirs: string[];
    backupContent: string;
    gateDecision?: GateDecisionInput;
    eventMetadata?: Record<string, unknown>;
  },
  ctx?: ProposalsContext,
): Proposal {
  const decidedAt = nowIso(ctx);
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const current = requireProposal(db, stashDir, proposal.id);
      if (current.status === "accepted") return current;
      if (current.status !== "pending") {
        throw new Error(`Proposal ${proposal.id} changed status during acceptance (${current.status}).`);
      }
      const next: Proposal = {
        ...proposal,
        retireAcceptIntent: undefined, // finalized — the intent only matters while still pending
        status: "accepted",
        updatedAt: decidedAt,
        review: { outcome: "accepted", decidedAt },
        acceptedTarget: {
          source: info.targetName,
          root: info.targetRoot,
          path: info.assetPath,
          contentHash: info.contentHash,
        },
        retiredArchive: { dirs: info.archiveDirs },
        backupContent: info.backupContent,
        ...(info.gateDecision
          ? { gateDecision: { ...info.gateDecision, decidedAt: info.gateDecision.decidedAt ?? decidedAt } }
          : {}),
      };
      upsertProposal(db, next, stashDir);
      recordImproveLedgerDecision(db, {
        proposalId: next.id,
        stashDir,
        ref: next.ref,
        source: next.source,
        outcome: "accepted",
        at: decidedAt,
      });
      insertEventOnce(db, {
        eventType: "promoted",
        ts: decidedAt,
        ref: next.ref,
        metadata: {
          proposalId: next.id,
          source: next.source,
          ...(next.sourceRun !== undefined ? { sourceRun: next.sourceRun } : {}),
          assetPath: info.assetPath,
          retired: true,
          ...(info.eventMetadata ? info.eventMetadata : {}),
        },
        idempotencyKey: `${next.id}:promoted`,
      });
      return next;
    }),
  );
}

/**
 * B2: throws a stale-retire `UsageError` unless the successor still exists
 * and both sides' recorded body hashes still match their current files — the
 * durable half of the chain guard. Used for a fresh accept, and (4b, third
 * review round) to re-check a resumed accept whose intent was recorded but
 * nothing has moved yet: a separate proposal accepted in between (e.g. this
 * one's successor itself retired by a B->C accept) can make the decision
 * stale even though nothing about the retired side's own file changed.
 */
function assertRetirementStillFresh(
  proposalId: string,
  proposalRef: string,
  retirement: RetirementMetadata,
  targetSource: WriteTargetSource,
  retiredCurrentBytes: Buffer,
): void {
  const successorPath = resolveAssetFilePathSafe(targetSource, parseRefInput(retirement.successorRef));
  const successorBytes = successorPath && fs.existsSync(successorPath) ? fs.readFileSync(successorPath) : undefined;
  const retiredFresh = contentHash(retiredCurrentBytes, "body") === retirement.retiredContentHash;
  const successorFresh =
    successorBytes !== undefined && contentHash(successorBytes, "body") === retirement.successorContentHash;
  if (!successorBytes || !retiredFresh || !successorFresh) {
    throw new UsageError(
      `Retire proposal ${proposalId} is stale — successor ${retirement.successorRef} ` +
        `${successorBytes === undefined ? "no longer exists" : !successorFresh ? "changed" : `and ${proposalRef} changed`} ` +
        "since judging; refusing to retire.",
      "INVALID_FLAG_VALUE",
    );
  }
}

/**
 * Accept a `retire` proposal (0.9.17-alpha.9, the consolidate pair pass): no
 * new content is written. Should-fix 5 (second review round) makes this a
 * three-phase, resume-safe sequence: (1) record intent — `backupContent`
 * and the exact files about to move — on the still-pending proposal; (2)
 * move each file into the recoverable cleanup archive
 * (`archiveCleanupCandidate`), skipping any the tombstone scan shows a prior,
 * crashed attempt already moved; (3) finalize via
 * {@link persistRetireAcceptance}. A `supersedes` judgement writes the
 * supersede edge on the retired (older) side AFTER intent is recorded (4a,
 * third review round — recording it first means a crash before the edge
 * write can never cause a resume to re-read the file and capture its own
 * edge into `backupContent`), so the archived copy still preserves it. A
 * target already gone with no recorded intent (raced with something else)
 * fails cleanly with a `UsageError`, the same clean-error idiom every other
 * staleness check in this file uses — never an unhandled throw.
 */
async function retireProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  proposal: Proposal,
  options: {
    target?: string;
    queueTarget?: ResolvedWriteTarget;
    eventMetadata?: Record<string, unknown>;
    gateDecision?: GateDecisionInput;
  },
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  const ref = parseRefInput(proposal.ref);
  if (proposal.status === "accepted") {
    // Accepting again is a no-op, provided the target is still gone (retired) and its archive is still there.
    const recorded = requireAcceptedTarget(proposal);
    const assetPath = acceptedAssetPath(proposal, target, ref);
    const archive = proposal.retiredArchive;
    const archivedStill = archive?.dirs.every((dir) => fs.existsSync(path.join(target.source.path, dir))) === true;
    if (fs.existsSync(assetPath) || !archivedStill) {
      throw new UsageError(
        `Accepted retire proposal ${proposal.id} no longer matches its archive.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { proposal, assetPath: recorded.path, ref: proposal.ref };
  }
  if (proposal.status !== "pending") {
    throw new UsageError(
      `Proposal ${proposal.id} is not pending (current status: ${proposal.status}). Only pending proposals can be accepted.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const assetPath = resolveAssetFilePathSafe(target.source, ref);
  if (!assetPath) throw new UsageError(`Cannot resolve proposal target ${proposal.ref}.`, "INVALID_PROPOSAL");

  let working = proposal;
  let intent = proposal.retireAcceptIntent;
  if (!intent) {
    // Fresh accept — no recorded intent yet, so the target must still be there.
    if (!fs.existsSync(assetPath)) {
      throw new UsageError(
        `Retire proposal ${proposal.id} target (${proposal.ref}) no longer exists — it may already have been retired, promoted away, or removed by another proposal.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const currentBytes = fs.readFileSync(assetPath);
    const retirement = proposal.retirement;
    if (!retirement) {
      // createRetireProposal always sets this — a row without one is corrupt, not merely stale.
      throw new Error(`Retire proposal ${proposal.id} has no retirement metadata.`);
    }
    // B2 (this is the durable half of the chain guard; the same-run half is
    // `retiredThisRun` in pair-pass.ts):
    assertRetirementStillFresh(proposal.id, proposal.ref, retirement, target.source, currentBytes);
    assertAkmAssetWrite(target.source);
    // Phase 1: record intent BEFORE any move, and BEFORE the supersede edge
    // (4a, third review round) — `backupContent` is `currentBytes`, read
    // above, before any mutation of this file. Recording first means a crash
    // between here and the edge write below can never cause a resume to
    // re-read the file and capture the edge INTO backupContent as if it were
    // the original.
    intent = { assetPath, backupContent: currentBytes.toString("utf8") };
    working = recordRetireAcceptIntent(stashDir, proposal.id, intent, ctx);
    if (retirement.judgeLabel === "supersedes") {
      try {
        writeSupersededEdge(assetPath, retirement.successorRef);
      } catch (error) {
        warn(
          `[proposal] failed to write the supersede edge for ${proposal.id} (continuing with the retire): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else {
    assertAkmAssetWrite(target.source);
    // 4b (third review round): intent was recorded but Phase 2 never moved
    // anything yet — re-run the B2 freshness check before resuming. A
    // separate proposal accepted in the meantime (this one's successor
    // itself retired by a B->C accept) can make the decision stale even
    // though nothing here changed. Once something has moved, it is too late
    // to cleanly refuse — Phase 2 below already tolerates a partial move.
    if (working.retirement && fs.existsSync(intent.assetPath)) {
      assertRetirementStillFresh(
        proposal.id,
        proposal.ref,
        working.retirement,
        target.source,
        fs.readFileSync(intent.assetPath),
      );
    }
  }

  // Phase 2: move, idempotently — a resumed call skips whichever file a
  // tombstone under this proposal's own id already claims.
  const mutationTarget = prepareWriteTargetForMutation(target);
  const already = findRetireArchiveDirsByProposalId(mutationTarget.source.path, proposal.id) ?? [];
  const alreadyDone = alreadyArchivedOriginalPaths(mutationTarget.source.path, already);
  const archiveDirs = [...already];
  const paths: string[] = [];
  const candidate: MemoryPruneCandidate = {
    ref: proposal.ref,
    reason: working.retirement?.reason ?? "duplicate",
    proposalId: proposal.id,
    ...(working.retirement?.successorRef ? { successorRefs: [working.retirement.successorRef] } : {}),
  };
  if (!alreadyDone.has(path.resolve(intent.assetPath)) && fs.existsSync(intent.assetPath)) {
    const record = archiveCleanupCandidate(mutationTarget.source.path, candidate, intent.assetPath);
    archiveDirs.push(path.dirname(record.auditPath));
    paths.push(
      intent.assetPath,
      path.join(mutationTarget.source.path, record.archivedPath),
      path.join(mutationTarget.source.path, record.auditPath),
    );
  }
  // 4d (third review round): the twin path is re-derived, not carried on the
  // intent — it is a pure function of assetPath and the ref's type, and the
  // tombstone scan above (`alreadyDone`) already finds one archived earlier,
  // so storing it was redundant persisted state.
  const twinPath = derivedTwinPath(intent.assetPath, ref.type);
  if (twinPath && !alreadyDone.has(path.resolve(twinPath)) && fs.existsSync(twinPath)) {
    const twinRecord = archiveCleanupCandidate(mutationTarget.source.path, candidate, twinPath);
    archiveDirs.push(path.dirname(twinRecord.auditPath));
    paths.push(
      twinPath,
      path.join(mutationTarget.source.path, twinRecord.archivedPath),
      path.join(mutationTarget.source.path, twinRecord.auditPath),
    );
  }
  if (paths.length > 0) commitWriteTargetBoundary(mutationTarget, `Retire ${proposal.ref}`, { paths });

  if (archiveDirs.length === 0) {
    // Recorded intent, but neither file is at its original location NOR
    // archived under this proposal's id: something else removed the target
    // between intent and move. Refuse cleanly rather than finalize on
    // nothing.
    throw new UsageError(
      `Retire proposal ${proposal.id} target (${proposal.ref}) no longer exists and was not archived by this proposal — refusing to accept.`,
      "INVALID_FLAG_VALUE",
    );
  }

  // Phase 3: finalize — always from the recorded intent's own backupContent,
  // never a hash guessed from the archived copy.
  const accepted = persistRetireAcceptance(
    stashDir,
    working,
    {
      targetName: mutationTarget.source.name,
      targetRoot: mutationTarget.source.path,
      assetPath: intent.assetPath,
      contentHash: contentHash(intent.backupContent),
      archiveDirs,
      backupContent: intent.backupContent,
      ...(options.gateDecision ? { gateDecision: options.gateDecision } : {}),
      ...(options.eventMetadata ? { eventMetadata: options.eventMetadata } : {}),
    },
    ctx,
  );
  return { proposal: accepted, assetPath: intent.assetPath, ref: accepted.ref };
}

export interface RevertResult {
  proposal: Proposal;
  assetPath: string;
  ref: string;
}

/**
 * Restore an accepted proposal's target from the backup taken at promotion.
 * New-asset proposals have no backup; a target edited since acceptance is
 * never clobbered. Reverting twice is a no-op.
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

/**
 * Revert an accepted `retire` proposal (0.9.17-alpha.9): move the archived
 * file(s) — the retired asset, and its `.derived` twin when one was archived
 * alongside it — back to where they lived, then overwrite the primary with
 * the exact pre-retire bytes `backupContent` recorded at accept (S4) —
 * byte-exact, so it also undoes any supersede edge accept wrote without
 * touching one a person had already written, and without appending a
 * trailing newline the original never had. Each archive dir is located from
 * `retiredArchive.dirs` (set at accept time) and its own `cleanup.md`
 * tombstone names the exact paths to restore — no re-scan of every
 * tombstone in the archive.
 *
 * Should-fix 5 (second review round): every archive dir is resolved and
 * validated before any of them are moved, AND that validation tells "not
 * yet moved" apart from "already moved by an earlier, crashed attempt of
 * our own" (original present, archived copy gone) rather than treating the
 * latter as a conflict — so a retry of a crashed revert resumes instead of
 * erroring on its own prior work. The archive dirs (tombstones) are removed
 * only after the "reverted" decision is durably recorded, not interleaved
 * with the moves — a crash between moving a file and recording the
 * decision used to delete that file's tombstone first, leaving an
 * "accepted" proposal a retry could neither finish nor re-validate.
 */
async function unretireProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  proposal: Proposal,
  options: { target?: string; queueTarget?: ResolvedWriteTarget },
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  const ref = parseRefInput(proposal.ref);
  if (!stashDirFor(ref.type)) {
    throw new UsageError(`Proposal ${proposal.id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }
  if (proposal.status !== "accepted" && proposal.status !== "reverted") {
    throw new UsageError(
      `only accepted proposals can be reverted (proposal ${proposal.id} status: ${proposal.status})`,
      "INVALID_FLAG_VALUE",
    );
  }
  const recorded = requireAcceptedTarget(proposal);
  const boundTarget = resolveRecordedProposalTarget(config, proposal.id, recorded, options.target);
  const assetPath = acceptedAssetPath(proposal, boundTarget, ref);
  if (proposal.status === "reverted") {
    return { proposal, assetPath, ref: proposal.ref };
  }
  const archive = proposal.retiredArchive;
  if (!archive || archive.dirs.length === 0) {
    throw new UsageError(
      `no archive recorded for this retire proposal (id: ${proposal.id})`,
      "MISSING_REQUIRED_ARGUMENT",
      "A retire proposal's archive is recorded at accept time; a proposal missing it cannot be reverted through this path.",
    );
  }
  const target = prepareWriteTargetForMutation(boundTarget);
  interface PendingRestore {
    dirAbs: string;
    auditPath: string;
    originalAbs: string;
    archivedAbs: string;
    /** Already moved back by an earlier, crashed attempt of our own — resume, do not re-move or error. */
    alreadyDone: boolean;
  }
  const pending: PendingRestore[] = [];
  for (const dirRel of archive.dirs) {
    const dirAbs = path.join(target.source.path, dirRel);
    const auditPath = path.join(dirAbs, "cleanup.md");
    let tombstoneData: Record<string, unknown>;
    try {
      tombstoneData = parseFrontmatter(fs.readFileSync(auditPath, "utf8")).data;
    } catch (error) {
      throw new UsageError(
        `Archive for proposal ${proposal.id} is missing its tombstone (${dirRel}); cannot revert: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_FLAG_VALUE",
      );
    }
    const originalRel = typeof tombstoneData.originalPath === "string" ? tombstoneData.originalPath : undefined;
    const archivedRel = typeof tombstoneData.archivedPath === "string" ? tombstoneData.archivedPath : undefined;
    if (!originalRel || !archivedRel) {
      throw new UsageError(
        `Archive tombstone for proposal ${proposal.id} (${dirRel}) is malformed.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const originalAbs = path.join(target.source.path, originalRel);
    const archivedAbs = path.join(target.source.path, archivedRel);
    const originalExists = fs.existsSync(originalAbs);
    const archivedExists = fs.existsSync(archivedAbs);
    if (originalExists && archivedExists) {
      throw new UsageError(
        `Cannot revert proposal ${proposal.id}: ${originalRel} already exists (created since retirement); refusing to overwrite it.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (!originalExists && !archivedExists) {
      throw new UsageError(
        `Cannot revert proposal ${proposal.id}: archived copy ${archivedRel} is missing.`,
        "INVALID_FLAG_VALUE",
      );
    }
    // Must-fix 2 (third review round): "original present, archived copy
    // missing" is not necessarily our own earlier, crashed revert — once a
    // purge can delete an archived copy on its own, a LATER, unrelated file
    // can occupy this same path (a new memory reusing a retired one's name),
    // and the write step below would overwrite it with the retired asset's
    // pre-retire bytes. Only the primary has a recorded pre-retire hash
    // (`retirement.retiredContentHash`) to tell the two apart; resume only
    // when it matches the file actually sitting there, otherwise refuse
    // exactly as the conflict case above does.
    if (originalExists && !archivedExists && path.resolve(originalAbs) === path.resolve(assetPath)) {
      const expectedHash = proposal.retirement?.retiredContentHash;
      let currentHash: string | undefined;
      try {
        currentHash = contentHash(fs.readFileSync(originalAbs, "utf8"), "body");
      } catch {
        currentHash = undefined;
      }
      if (!expectedHash || currentHash !== expectedHash) {
        throw new UsageError(
          `Cannot revert proposal ${proposal.id}: ${originalRel} exists but its content does not match what was retired (its path may have been reused since); refusing to overwrite it.`,
          "INVALID_FLAG_VALUE",
        );
      }
    }
    pending.push({ dirAbs, auditPath, originalAbs, archivedAbs, alreadyDone: originalExists });
  }
  const restoredPaths: string[] = [];
  let primaryOriginalAbs: string | undefined;
  for (const p of pending) {
    if (!p.alreadyDone) {
      fs.mkdirSync(path.dirname(p.originalAbs), { recursive: true });
      fs.renameSync(p.archivedAbs, p.originalAbs);
      recordWrittenPath(p.archivedAbs);
      recordWrittenPath(p.originalAbs);
    }
    restoredPaths.push(p.originalAbs, p.archivedAbs, p.auditPath);
    if (path.resolve(p.originalAbs) === path.resolve(assetPath)) primaryOriginalAbs = p.originalAbs;
  }
  // S4 / nit: overwrite the primary with the EXACT pre-retire bytes recorded
  // at accept (`backupContent`) — no appended trailing newline either, so
  // YAML comments, key order, a pre-existing human `supersededBy` edge, and
  // even the exact absence of a final newline all survive the round trip.
  // The archived copy just moved back may carry a `supersededBy` edge THIS
  // accept wrote (a `supersedes` judgement); restoring the recorded original
  // bytes already removes exactly that edge, so no separate
  // removeSupersededEdge mutation runs here — one that could not tell "the
  // edge accept wrote" from "an edge a person had already written" apart,
  // and would delete either.
  if (primaryOriginalAbs && proposal.backupContent !== undefined) {
    writeProposalAssetFile(primaryOriginalAbs, proposal.backupContent);
  }
  commitWriteTargetBoundary(target, `Revert ${proposal.ref}`, { paths: restoredPaths });
  const decidedAt = nowIso(ctx);
  const reverted = withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const current = requireProposal(db, stashDir, proposal.id);
      if (current.status === "reverted") return current;
      const next: Proposal = {
        ...current,
        status: "reverted",
        updatedAt: decidedAt,
        review: { outcome: "rejected", reason: "reverted: archived asset restored", decidedAt },
      };
      upsertProposal(db, next, stashDir);
      recordImproveLedgerDecision(db, {
        proposalId: next.id,
        stashDir,
        ref: next.ref,
        source: next.source,
        outcome: "rejected",
        at: decidedAt,
        detail: "reverted",
      });
      insertEventOnce(db, {
        eventType: "proposal_reverted",
        ts: decidedAt,
        ref: next.ref,
        metadata: { proposalId: next.id, source: next.source, assetPath },
        idempotencyKey: `${next.id}:reverted`,
      });
      return next;
    }),
  );
  // Only now — after the decision is durably recorded — remove the archive
  // dirs (tombstones). See the function doc comment for why this ordering
  // matters.
  for (const p of pending) {
    fs.rmSync(p.dirAbs, { recursive: true, force: true });
  }
  try {
    if (!(await indexWrittenAssets(target.source.path, restoredPaths, { bundleId: target.source.name }))) {
      warn(`[proposals] ${restoredPaths.join(", ")} were restored but not indexed; run \`akm index\`.`);
    }
  } catch (error) {
    warn(
      `[proposals] restored paths were not indexed (${error instanceof Error ? error.message : String(error)}); run \`akm index\`.`,
    );
  }
  return { proposal: reverted, assetPath, ref: proposal.ref };
}

async function revertProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string; queueTarget?: ResolvedWriteTarget },
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  const proposal = getProposal(stashDir, id, ctx);
  if (isRetireProposal(proposal)) return unretireProposalWithLease(stashDir, config, proposal, options, ctx);
  const ref = parseRefInput(proposal.ref);
  if (!stashDirFor(ref.type)) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }
  if (proposal.status !== "accepted" && proposal.status !== "reverted") {
    throw new UsageError(
      `only accepted proposals can be reverted (proposal ${id} status: ${proposal.status})`,
      "INVALID_FLAG_VALUE",
    );
  }
  const backupContent = proposal.backupContent;
  if (proposal.status === "accepted" && backupContent === undefined) {
    throw new UsageError(
      `no backup available for this proposal (id: ${id})`,
      "MISSING_REQUIRED_ARGUMENT",
      "Backups are only captured when a proposal overwrites an existing asset — new-asset proposals cannot be reverted via this path; delete the asset directly instead.",
    );
  }
  const recorded = requireAcceptedTarget(proposal);
  const boundTarget = resolveRecordedProposalTarget(config, id, recorded, options.target);
  const assetPath = acceptedAssetPath(proposal, boundTarget, ref);
  if (proposal.status === "reverted" || backupContent === undefined) {
    return { proposal, assetPath, ref: proposal.ref };
  }
  const target = prepareWriteTargetForMutation(boundTarget);
  if (!fs.existsSync(assetPath) || contentHash(fs.readFileSync(assetPath)) !== recorded.contentHash) {
    // Nit (third review round): by-ref resolution skips retire proposals
    // (should-fix 7), so reverting by ref when a SEPARATE retire proposal
    // for the same ref exists (pending or already accepted) lands here with
    // no clue that proposal is the real story — name it when one does.
    const siblingRetire = listProposalsReadOnly(stashDir, { ref: proposal.ref, includeArchive: true }, ctx).find(
      (p) => isRetireProposal(p) && (p.status === "pending" || p.status === "accepted"),
    );
    throw new UsageError(
      `asset content changed after proposal ${id} was accepted; refusing to clobber the newer content` +
        (siblingRetire ? ` (a retire proposal for this ref exists: ${siblingRetire.id})` : ""),
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

export interface ProposalDiff {
  /** The asset currently at the target, if any. */
  existing: string | null;
  proposed: string;
  /** Unified diff; empty when nothing changes. */
  unified: string;
  isNew: boolean;
  targetPath?: string;
}

/** The proposal against the asset its accept would overwrite (same target resolution as accept). */
export function diffProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string; queueTarget?: ResolvedWriteTarget } = {},
  ctx?: ProposalsContext,
): ProposalDiff {
  const proposal = getProposal(stashDir, id, ctx);
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  const targetPath = resolveAssetFilePathSafe(target.source, parseRefInput(proposal.ref));
  const existing = targetPath && fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
  // A retire proposal's primary change deletes its target rather than
  // writing content: "proposed" is empty and the diff shows the whole body
  // being removed, reusing the ordinary unified-diff formatter instead of
  // proposalContent() (which has nothing to read for a delete).
  const proposed = isRetireProposal(proposal) ? "" : proposalContent(proposal);
  return {
    existing,
    proposed,
    unified:
      existing === null
        ? formatNewAssetDiff(proposal.ref, proposed)
        : formatUnifiedDiff(existing, proposed, proposal.ref),
    isNew: existing === null,
    ...(targetPath ? { targetPath } : {}),
  };
}

function resolveAssetFilePathSafe(source: WriteTargetSource, ref: AssetRef): string | undefined {
  const typeDir = stashDirFor(ref.type);
  if (!typeDir) return undefined;
  try {
    return assetPathForName(ref.type, path.join(source.path, typeDir), ref.name);
  } catch {
    return undefined;
  }
}
