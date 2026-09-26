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
import { runBaseChecks } from "../lint/base-linter";
import type { LintIssue, LintIssueType } from "../lint/types";
import { formatNewAssetDiff, formatUnifiedDiff } from "./diff-format";
import {
  ASSET_MISSING_GATE_REASON,
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
      const newest = (status?: string): Proposal | undefined =>
        listStateProposals(db, { stashDir, ...(status !== undefined ? { status } : {}) })
          .filter((p) => proposalMatchesRef(p.ref, wantRef))
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
  return { proposal: accepted, assetPath, ref: accepted.ref };
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

async function revertProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string; queueTarget?: ResolvedWriteTarget },
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  const proposal = getProposal(stashDir, id, ctx);
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
  const proposed = proposalContent(proposal);
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
