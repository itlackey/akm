// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The proposal queue (#225; storage in state.db since #578). Proposals are
 * queue state, not assets: rows in the `proposals` table partitioned by
 * `bundle_id` (the bundle whose queue it is), where archival is a status flip that keeps the full audit trail
 * (review, reason, backup for revert). They never go through the asset writer
 * until accepted — {@link promoteProposal} is the bridge that writes the
 * accepted payload into the bundle.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { ensureAkmMarkdownType } from "../../core/asset/akm-markdown";
import { placementTypes, stashDirFor } from "../../core/asset/asset-placement";
import { isBundleSlug, makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { assembleAsset, serializeFrontmatter } from "../../core/asset/asset-serialize";
import {
  carryForwardBookkeepingFrontmatter,
  parseFrontmatter,
  replaceFrontmatterBlocks,
} from "../../core/asset/frontmatter";
import { type AssetRef, parsePlacementRef } from "../../core/asset/resolve-ref";
import { stalePathRoots } from "../../core/asset/stale-path";
import { indexFiles } from "../../core/assets/files";
import { assertAdapterWrites } from "../../core/assets/gate";
import { type Asset, currentConceptId, qualifyRef, readAsset } from "../../core/assets/read";
import { type AssetAddress, addressOf, writeAssets } from "../../core/assets/write";
import { materialiseBundleDir, stateBundleId } from "../../core/bundle-at-dir";
import { bundleIdForDir } from "../../core/bundle-id";
import { type AkmConfig, loadConfig } from "../../core/config/config";
import { bundleAtDir } from "../../core/config/config-sources";
import { ConfigError, NotFoundError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import type { MemoryPruneCandidate } from "../../core/improve-types";
import { canonicalBundleIdForTarget, resolveBundleWriteTarget } from "../../core/mutation-target";
import { getStateDbPath, openStateReadSnapshot, withImmediateTransaction, withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import { beginWriteProvenance } from "../../core/write-provenance";
import {
  type CommitOutcome,
  commitAcceptedPaths,
  commitWriteTargetBoundary,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWriteTarget,
  type WriteTargetSource,
} from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { deriveInstallations } from "../../indexer/installations";
import { sameScope, scopeFromFrontmatter } from "../../indexer/passes/metadata";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { sha256Hex } from "../../runtime";
import type { Database } from "../../storage/database";
import { insertEventOnce } from "../../storage/repositories/events-repository";
import {
  CONSOLIDATE_LEDGER_SOURCE,
  forgetImproveLedgerDecision,
  type ImproveLedgerOutcome,
  PAIR_PASS_LEDGER_SOURCE,
  recordImproveLedger,
  recordImproveLedgerDecision,
  reopenImproveLedgerDecision,
} from "../../storage/repositories/improve-ledger-repository";
import {
  getStateProposal,
  isLegacyProposalRef,
  listStateProposalIdsByPrefix,
  listStateProposals,
  upsertProposal,
} from "../../storage/repositories/proposals-repository";
import { schedulerEnabledRefs, setSchedulerRefEnabled } from "../../tasks/activation-config";
import { withSchedulerLock } from "../../tasks/scheduler-lock";
import { pkgVersion } from "../../version";
import { contentHash } from "../improve/content-hash";
import { writeSupersededEdge } from "../improve/memory/memory-belief";
import { derivedTwinOf, retireCleanupCandidate } from "../improve/memory/memory-improve";
import { runBaseChecks } from "../lint/base-linter";
import type { LintIssue, LintIssueType } from "../lint/types";
import { akmTasksDisable, akmTasksEnable, inspectTaskSchedulerBindings } from "../tasks/tasks";
import { formatNewAssetDiff, formatRetireDiff, formatUnifiedDiff } from "./diff-format";
import {
  ASSET_MISSING_GATE_REASON,
  type EligibilitySource,
  EXPIRED_GATE_REASON,
  isAutomatedProposalSource,
  isRetireProposal,
  isValidProposalSource,
  PROPOSAL_SOURCES,
  type Proposal,
  type ProposalChange,
  type ProposalDecider,
  type ProposalFeedbackFix,
  type ProposalGateDecision,
  type ProposalPayload,
  type ProposalSource,
  type ProposalStatus,
  proposalContent,
  proposalWaitingSince,
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
  | "invalid_canonical_structure"
  | "cross_bundle";

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

/** `p` with `content` as both the payload and the primary change's `content` (they must agree). */
function withProposalContent(p: Proposal, content: string): Proposal {
  return {
    ...p,
    payload: { ...p.payload, content },
    // A delete-op primary change carries no `content`.
    changes: p.changes.map((c, i) => (i === 0 && c.op !== "delete" ? { ...c, content } : c)),
  };
}

export interface ProposalsContext {
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
  /** Test seam — the state.db path. */
  dbPath?: string;
  /**
   * A live state.db connection the caller already holds (the improve run's).
   * {@link listProposalsReadOnly} reads through it instead of copying the
   * database; every other operation still opens its own.
   */
  db?: Database;
  /** The `<id>` of a `human:<id>` provenance actor; defaults to the OS username, else `local`. */
  actorId?: () => string;
}

export interface CreateProposalInput {
  ref: string;
  /** The queue's bundle name and materialized root; derived from the stash when omitted. */
  target?: { source: string; root: string };
  /**
   * The durable `bundle//conceptId` of the existing asset this proposal rewrites,
   * when the caller read it from a specific bundle. The proposal must be filed in
   * that bundle: another queue would fork the asset (a `create`) or overwrite its
   * own copy with content derived from the other bundle's (#1000).
   */
  itemRef?: string;
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
   * A consolidate PROMOTION proposal's source memory ref: set
   * by `emitPromotionProposal`. On accept, the source (and its `.derived`
   * twin) is retired through the same archive path a `retire` proposal uses.
   */
  promotionSource?: string;
  /** Body content hash of `promotionSource` at mint time — see `Proposal.promotionSourceHash`. */
  promotionSourceHash?: string;
  /** A feedback fix's reason and cited source — see `Proposal.feedback`. */
  feedback?: ProposalFeedbackFix;
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

function proposalRefIdentity(ref: string): ProposalRefIdentity | undefined {
  try {
    const parsed = parseBundleRef(ref);
    if (parsed.fragment !== undefined || isLegacyProposalRef(ref)) return undefined;
    return { conceptId: parsed.conceptId, ...(parsed.bundle !== undefined ? { bundle: parsed.bundle } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * A `--ref` filter: a short ref matches its concept in the queue, a qualified one also its bundle. Both the filter and
 * a stored ref are read as the asset they name now, so a proposal stored under a file spelling
 * (`main//knowledge/guide.md`) is found by `knowledge/guide` and the other way round.
 */
function refFilter(stashDir: string, ref: string): (proposalRef: string) => boolean {
  const filter = proposalRefIdentity(ref);
  if (!filter) {
    throw new UsageError(
      `Invalid asset-ref filter "${ref}". Use the ref grammar [bundle//]conceptId, e.g. knowledge/guide.md or lessons/deploy.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const sources = resolveSourceEntries(stashDir, loadConfig());
  // The filter's own outdated spelling is the caller's to fix (one warning); a stored ref is not, so it resolves silently.
  const wanted = parseBundleRef(
    qualifyRef(makeBundleRef(filter.bundle, filter.conceptId), { bundle: materialiseBundleDir(stashDir) }),
  ).conceptId;
  const asked = new Map<string, string>();
  const current = (identity: ProposalRefIdentity): string => {
    const key = `${identity.bundle ?? ""}//${identity.conceptId}`;
    const known = asked.get(key);
    if (known !== undefined) return known;
    // A stored ref whose bundle is not configured names its asset by concept id alone: whichever bundle holds it now.
    const held = identity.bundle === undefined || resolveSourcesForOrigin(identity.bundle, sources).length > 0;
    const conceptId = currentConceptId(makeBundleRef(held ? identity.bundle : undefined, identity.conceptId));
    asked.set(key, conceptId);
    return conceptId;
  };
  return (proposalRef) => {
    const proposal = proposalRefIdentity(proposalRef);
    if (proposal === undefined) return false;
    if (filter.bundle !== undefined && proposal.bundle !== filter.bundle) return false;
    // As written (what a filter always found), or the same asset under another spelling.
    return proposal.conceptId === filter.conceptId || proposal.conceptId === wanted || current(proposal) === wanted;
  };
}

/**
 * The durable `proposals.ref`: `bundle//conceptId`, the asset's ref (its path)
 * and the bundle the queue writes to — byte-identical to the item_ref the
 * indexer mints for the accepted asset.
 */
function proposalDurableRef(
  { conceptId }: Pick<AssetAddress, "conceptId">,
  origin: string | undefined,
  target: NonNullable<CreateProposalInput["target"]>,
): string {
  if (!isBundleSlug(target.source)) {
    throw new UsageError(`Proposal target source "${target.source}" is not a valid bundle name.`, "INVALID_FLAG_VALUE");
  }
  if (origin !== undefined && target.source !== origin) {
    throw new UsageError(
      `Proposal ref bundle "${origin}" conflicts with target source "${target.source}".`,
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
  const bundleId =
    sourceIndex >= 0
      ? (bundleAtDir(config, root) ?? bundleIdForDir(root, new Set(Object.keys(config.bundles ?? {}))))
      : undefined;
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
 * The configured bundle that owns the asset `itemRef` names when it is not the
 * bundle rooted at `target`; otherwise `undefined`. A differing name is
 * confirmed by the owner's root, so one bundle known by two spellings is never
 * taken for two, and an owner that cannot be resolved is never refused on.
 */
function otherOwningBundle(itemRef: string, target: { source: string; root: string }): string | undefined {
  try {
    const owner = parseBundleRef(itemRef).bundle;
    if (owner === undefined || owner === target.source) return undefined;
    const sources = resolveSourceEntries(target.root, loadConfig());
    const ownerSource = sources[deriveInstallations(sources).findIndex((installation) => installation.id === owner)];
    return ownerSource !== undefined && path.resolve(ownerSource.path) !== path.resolve(target.root)
      ? owner
      : undefined;
  } catch (err) {
    rethrowIfTestIsolationError(err);
    return undefined;
  }
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

  let origin: string | undefined;
  try {
    origin = parseBundleRef(input.ref).bundle;
  } catch (err) {
    return rejectProposal(
      "invalid_ref",
      `Invalid proposal ref "${input.ref}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!input.payload.content.trim()) {
    return rejectProposal("empty_content", `Proposal for "${input.ref}" has empty content.`);
  }
  if (input.target && origin && input.target.source !== origin) {
    return rejectProposal(
      "invalid_ref",
      `Qualified proposal ref bundle "${origin}" conflicts with queue target "${input.target.source}".`,
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

  const proposalTarget = resolveCreateProposalTarget(stashDir, input.target, origin);
  const targetSource = materialiseBundleDir(proposalTarget.root, loadConfig(), { name: proposalTarget.source });
  let parsedRef: AssetAddress;
  try {
    parsedRef = addressOf(targetSource, input.ref);
  } catch (err) {
    return rejectProposal(
      "invalid_ref",
      `Invalid proposal ref "${input.ref}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsedRef.exists && parsedRef.file === undefined && stashDirFor(parsedRef.type) === undefined) {
    return rejectProposal(
      "unknown_type",
      `Unknown asset type "${parsedRef.type}" in proposal ref "${input.ref}". Known types: ${[...placementTypes()].sort().join(", ")}.`,
    );
  }
  const owner = input.itemRef ? otherOwningBundle(input.itemRef, proposalTarget) : undefined;
  if (owner) {
    return rejectProposal(
      "cross_bundle",
      `Proposal for "${input.ref}" rewrites ${input.itemRef}, which bundle "${owner}" owns, but its queue target is bundle "${proposalTarget.source}". Filing it there would fork the asset out of "${owner}" or overwrite this bundle's copy with content taken from the other. Improve it in its own bundle instead (\`akm improve --bundle ${owner}\`).`,
    );
  }

  // The change envelope, and the target's before-hashes as of mint (the freshness check at accept compares against
  // them).
  const normalizedRef = proposalDurableRef(parsedRef, origin, proposalTarget);
  let beforeContent: string | undefined;
  try {
    if (parsedRef.exists) beforeContent = readAsset(targetSource, parsedRef.conceptId)?.entry.content();
  } catch {
    // An unreadable target is minted as a create, as before.
  }
  const content = parsedRef.file?.toLowerCase().endsWith(".md")
    ? ensureAkmMarkdownType(input.payload.content, parsedRef.type)
    : input.payload.content;
  const changes: ProposalChange[] = [
    { ref: normalizedRef, content, op: beforeContent !== undefined ? "update" : "create" },
  ];
  const proposedTarget = { source: proposalTarget.source };

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
        ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
      };
      upsertProposal(db, proposal, stateBundleId(stashDir));
      for (const ref of input.attemptedRefs ?? [normalizedRef]) {
        recordImproveLedger(db, {
          bundleId: stateBundleId(stashDir),
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
  /** One of {@link PROPOSAL_SOURCES}; the consolidate pair pass always uses `"consolidate-pair"` — kept apart from `"consolidate"`'s promotions. */
  source: ProposalSource | string;
  sourceRun?: string;
  target?: { source: string; root: string };
  /** The pair judge's confidence in [0, 1]; anything else is dropped. */
  confidence?: number;
  /** Absent for a human retirement; the judged pair pass always sets it. */
  retirement?: RetirementMetadata;
  /** Raw-bytes sha256 the caller last saw; the proposal is minted only from exactly those bytes. */
  expectedRevision?: string;
}

/**
 * Mint a `retire` proposal: its
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
  const invalid = (err: unknown) =>
    new UsageError(
      `Invalid retire proposal ref "${input.ref}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_PROPOSAL",
    );
  let origin: string | undefined;
  try {
    origin = parseBundleRef(input.ref).bundle;
  } catch (err) {
    throw invalid(err);
  }
  const proposalTarget = resolveCreateProposalTarget(stashDir, input.target, origin);
  const targetSource = materialiseBundleDir(proposalTarget.root, loadConfig(), { name: proposalTarget.source });
  let parsedRef: AssetAddress;
  try {
    parsedRef = addressOf(targetSource, input.ref);
  } catch (err) {
    throw invalid(err);
  }
  if (!parsedRef.exists && parsedRef.file === undefined && stashDirFor(parsedRef.type) === undefined) {
    throw new UsageError(
      `Unknown asset type "${parsedRef.type}" in retire proposal ref "${input.ref}". Known types: ${[...placementTypes()].sort().join(", ")}.`,
      "INVALID_PROPOSAL",
    );
  }
  const normalizedRef = proposalDurableRef(parsedRef, origin, proposalTarget);
  const target = parsedRef.exists ? readAsset(targetSource, parsedRef.conceptId) : undefined;
  if (!target) {
    throw new UsageError(
      `Retire proposal target "${input.ref}" does not exist at ${parsedRef.file ?? normalizedRef}.`,
      "INVALID_PROPOSAL",
    );
  }
  const beforeBytes = target.entry.bytes();
  if (input.expectedRevision !== undefined && sha256Hex(beforeBytes) !== input.expectedRevision)
    throw new UsageError("The asset changed. Reload before retiring it.", "ASSET_CONTENT_CHANGED");
  const beforeContent = beforeBytes.toString("utf8");
  const changes: ProposalChange[] = [{ ref: normalizedRef, op: "delete" }];
  const proposedTarget = { source: proposalTarget.source };
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
        beforeHash: contentHash(beforeBytes),
        beforeHashNormalized: contentHash(beforeContent, "normalized"),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(input.retirement ? { retirement: input.retirement } : {}),
      };
      upsertProposal(db, proposal, stateBundleId(stashDir));
      return proposal;
    }),
  );
}

/** The bundle a proposal is bound to, to address its ref in: the bundle `proposedTarget` names, else the queue's own directory. */
function proposalBundleId(stashDir: string, proposal: Proposal, config: AkmConfig): string {
  const bound = proposal.proposedTarget?.source;
  if (bound === undefined) return materialiseBundleDir(stashDir, config);
  try {
    resolveBundleWriteTarget(config, bound);
    return bound;
  } catch {
    return materialiseBundleDir(stashDir, config, { name: bound });
  }
}

type ListProposalsOptions = { includeArchive?: boolean; status?: ProposalStatus; ref?: string; type?: string };

function queryProposals(db: Database, stashDir: string, options: ListProposalsOptions): Proposal[] {
  // The live queue holds only pending proposals, so without the archive a
  // non-pending status matches nothing.
  if (!options.includeArchive && options.status !== undefined && options.status !== "pending") return [];
  const status = options.includeArchive ? options.status : "pending";
  const matchesRef = options.ref !== undefined ? refFilter(stashDir, options.ref) : undefined;
  const config = options.type ? loadConfig() : undefined;
  return listStateProposals(db, {
    bundleId: stateBundleId(stashDir),
    ...(status !== undefined ? { status } : {}),
  }).filter((p) => {
    if (matchesRef !== undefined && !matchesRef(p.ref)) return false;
    if (!options.type || !config) return true;
    try {
      return addressOf(proposalBundleId(stashDir, p, config), p.ref).type === options.type;
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
 * credentials, and a missing store is simply empty. A caller that already
 * holds a live connection (`ctx.db`) reads through it: a snapshot would copy
 * the whole database for nothing.
 */
export function listProposalsReadOnly(
  stashDir: string,
  options: ListProposalsOptions = {},
  ctx?: ProposalsContext,
): Proposal[] {
  if (ctx?.db) return queryProposals(ctx.db, stashDir, options);
  const dbPath = ctx?.dbPath ?? getStateDbPath();
  // asset-io: state proposal database
  if (!fs.existsSync(dbPath)) return [];
  const db = openStateReadSnapshot(dbPath);
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
  const proposal = getStateProposal(db, id, stateBundleId(stashDir));
  if (!proposal) throw new NotFoundError(`Proposal "${id}" not found.`, "PROPOSAL_NOT_FOUND");
  return proposal;
}

/**
 * A proposal by exact id; else, for an asset ref, its most recent pending
 * proposal (then most recent archived); else by a unique pending id prefix.
 */
export function resolveProposalId(stashDir: string, idOrRef: string, ctx?: ProposalsContext): Proposal {
  return withProposalsDb(ctx, (db) => resolveProposalIdIn(db, stashDir, idOrRef));
}

/** {@link resolveProposalId} over a connection the caller holds (the workspace reads state.db read-only). */
export function resolveProposalIdIn(db: Database, stashDir: string, idOrRef: string): Proposal {
  const exact = getStateProposal(db, idOrRef, stateBundleId(stashDir));
  if (exact) return exact;
  if (idOrRef.includes(":") || idOrRef.includes("/")) {
    const matchesRef = refFilter(stashDir, idOrRef);
    // By-ref resolution never picks a retire proposal — the
    // newest pending proposal for a ref could be a `consolidate-pair`
    // retirement rather than the reflect/distill edit a person typed the
    // ref to accept, and accepting it archives the asset instead. A retire
    // is reached by its own proposal id, or by the explicit generator
    // `consolidate-pair` (bulk accept/reject).
    const newest = (status?: string): Proposal | undefined =>
      listStateProposals(db, { bundleId: stateBundleId(stashDir), ...(status !== undefined ? { status } : {}) })
        .filter((p) => matchesRef(p.ref) && !isRetireProposal(p))
        .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
    const found = newest("pending") ?? newest();
    if (found) return found;
    throw new NotFoundError(`No proposal found for ref "${idOrRef}".`, "PROPOSAL_NOT_FOUND");
  }
  const prefixMatches = listStateProposalIdsByPrefix(db, stateBundleId(stashDir), idOrRef);
  if (prefixMatches.length === 1) return requireProposal(db, stashDir, prefixMatches[0]!);
  if (prefixMatches.length > 1) {
    throw new UsageError(`Ambiguous prefix "${idOrRef}" — matches: ${prefixMatches.join(", ")}`, "INVALID_FLAG_VALUE");
  }
  throw new NotFoundError(`Proposal "${idOrRef}" not found.`, "PROPOSAL_NOT_FOUND");
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

/**
 * What a decision's ledger row is about. A promotion's row is keyed by its
 * source memory, so a decision on it names that memory, together with the body
 * hash the promotion was queued against — this is what holds the memory back
 * until it changes (`isContentDrivenDecision`). Any other proposal, and a
 * promotion minted before the hash was recorded, is keyed by its own ref.
 * Every decision that can create a row when none carries the proposal id — a
 * reject, an accept and a drain deferral alike — must key it this way: a stray
 * row under the knowledge ref carries the proposal id, so a later verdict
 * updates that one and never reaches the memory's own row.
 */
function decisionLedgerSubject(proposal: Proposal): { ref: string; contentHash?: string } {
  if (
    proposal.source === CONSOLIDATE_LEDGER_SOURCE &&
    proposal.promotionSource !== undefined &&
    proposal.promotionSourceHash !== undefined
  ) {
    return { ref: proposal.promotionSource, contentHash: proposal.promotionSourceHash };
  }
  return { ref: proposal.ref };
}

/** Archive a pending proposal as accepted/rejected, recording the decision in the ledger in the same transaction. */
export function archiveProposal(
  stashDir: string,
  id: string,
  status: "accepted" | "rejected",
  reason: string | undefined,
  ctx?: ProposalsContext,
  gateDecision?: GateDecisionInput,
  decidedBy?: ProposalDecider,
): Proposal {
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const existing = requireProposal(db, stashDir, id);
      if (existing.status !== "pending") {
        throw new UsageError(
          `Proposal ${id} is not pending (current status: ${existing.status}). Only pending proposals can be ${status}.`,
          "PROPOSAL_NOT_PENDING",
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
          ...(decidedBy ? { decidedBy } : {}),
        },
        ...(gateDecision ? { gateDecision: { ...gateDecision, decidedAt: gateDecision.decidedAt ?? decidedAt } } : {}),
      };
      upsertProposal(db, updated, stateBundleId(stashDir));
      recordImproveLedgerDecision(db, {
        proposalId: updated.id,
        bundleId: stateBundleId(stashDir),
        ...decisionLedgerSubject(updated),
        source: updated.source,
        outcome: ledgerOutcomeForDecision(status, gateDecision),
        at: decidedAt,
        ...(reason !== undefined ? { detail: reason } : {}),
      });
      // The pair pass settles initiators under bare refs, independently of the
      // proposal's durable ref. A stale decision must release both inputs for
      // reassessment through that same ledger, rather than hold an old body forever.
      if (isRetireProposal(updated) && gateDecision?.reason === STALE_TARGET_GATE_REASON) {
        for (const ref of retireHeldRefs(updated)) {
          recordImproveLedger(db, {
            bundleId: stateBundleId(stashDir),
            ref,
            source: PAIR_PASS_LEDGER_SOURCE,
            outcome: "failed",
            at: decidedAt,
          });
        }
      }
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
      const existing = getStateProposal(db, id, stateBundleId(stashDir));
      if (!existing || existing.status !== "pending") return undefined;
      const decidedAt = decision.decidedAt ?? nowIso(ctx);
      const updated: Proposal = { ...existing, gateDecision: { ...decision, decidedAt } };
      upsertProposal(db, updated, stateBundleId(stashDir));
      if (decision.outcome === "deferred") {
        recordImproveLedgerDecision(db, {
          proposalId: updated.id,
          bundleId: stateBundleId(stashDir),
          ...decisionLedgerSubject(updated),
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
      parsed = parsePlacementRef(p.ref);
    } catch {
      continue;
    }
    const spec = stashDirFor(parsed.type);
    if (parsed.type === "lesson" || !spec) continue;
    const exists = sourceDirs.some((root) => {
      try {
        return addressOf(materialiseBundleDir(root), p.ref).exists;
      } catch {
        return false;
      }
    });
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
 * 0 disables; counted from the last reopen, if any) as rejected with an
 * `expired` gate decision and a `proposal_expired` event. The ledger records
 * `expired` — a short grace, not the rejection window, since nobody judged the
 * content.
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
    // A retire proposal expires like any other: `akm proposal reopen` (#997)
    // brings an expired one back while its files and hashes are still fresh,
    // and an unexpired one would hold its pair (pair-pass.ts's
    // pendingRetireRefs) for good.
    // A reopened proposal's wait starts over at the reopen (#997): expiring it
    // on its original age would undo the reopen at the next sweep.
    const createdMs = new Date(proposalWaitingSince(p)).getTime();
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
        /** The accepted asset's ref, and the file it is kept in (display: the event records it). */
        ref: string;
        assetPath: string;
        content: string;
        existed: boolean;
        backupContent?: string;
        eventMetadata?: Record<string, unknown>;
        gateDecision?: GateDecisionInput;
        decidedBy?: ProposalDecider;
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
        const persisted: Proposal =
          proposal.changes.length > 0
            ? withProposalContent(proposal, decision.content)
            : {
                ...proposal,
                payload: { ...proposal.payload, content: decision.content },
                changes: [{ ref: decision.ref, op: decision.existed ? "update" : "create", content: decision.content }],
                proposedTarget: { source: decision.target.source.name },
              };
        next = {
          ...persisted,
          status: "accepted",
          updatedAt: decision.decidedAt,
          acceptedAt: decision.decidedAt,
          review: {
            outcome: "accepted",
            decidedAt: decision.decidedAt,
            ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}),
          },
          acceptedTarget: { bundle: decision.target.source.name, ref: decision.ref, contentHash: publishedHash },
          ...(decision.gateDecision
            ? {
                gateDecision: {
                  // The drain's verdict replaces the quality judge's stamp; the judge's evidence stays on the row.
                  ...(current.gateDecision?.scores ? { scores: current.gateDecision.scores } : {}),
                  ...(current.gateDecision?.judgeReason ? { judgeReason: current.gateDecision.judgeReason } : {}),
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
            ...(current.review?.decidedBy ? { decidedBy: current.review.decidedBy } : {}),
          },
        };
      }
      const accept = decision.operation === "accept";
      upsertProposal(db, next, stateBundleId(stashDir));
      recordImproveLedgerDecision(db, {
        proposalId: next.id,
        bundleId: stateBundleId(stashDir),
        ...decisionLedgerSubject(next),
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
  decidedBy?: ProposalDecider,
): Proposal {
  const decidedAt = nowIso(ctx);
  const rejected = archiveProposal(
    stashDir,
    proposalId,
    "rejected",
    reason,
    { ...ctx, now: () => Date.parse(decidedAt) },
    gateDecision,
    decidedBy,
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

/** Index the files just written or moved; the next `akm index` catches up when this cannot. */
async function indexWrittenProposalAssets(target: ResolvedWriteTarget, assetPaths: string[]): Promise<void> {
  const label = assetPaths.join(", ");
  try {
    if (!(await indexFiles(target.source.name, assetPaths))) {
      warn(`[proposals] ${label} was written but not indexed; run \`akm index\`.`);
    }
  } catch (error) {
    warn(
      `[proposals] ${label} was written but not indexed (${error instanceof Error ? error.message : String(error)}); run \`akm index\`.`,
    );
  }
}

export interface PromoteResult {
  proposal: Proposal;
  /** Cleanup that could not be verified; never an assertion that native schedules are absent. */
  warnings?: string[];
  assetPath: string;
  ref: string;
  /** What this accept's own commit came to. Absent when a collector holds the commit for its caller, or nothing was written. */
  commit?: CommitOutcome;
}

function resolveRecordedProposalTarget(
  config: AkmConfig,
  proposalId: string,
  binding: { source: string },
  explicitTarget?: string,
): ResolvedWriteTarget {
  let target: ResolvedWriteTarget;
  try {
    target = explicitTarget
      ? resolveWriteTarget(config, explicitTarget)
      : resolveBundleWriteTarget(config, binding.source);
  } catch {
    throw new UsageError(
      `Proposal ${proposalId} is bound to target "${binding.source}", but that writable target is no longer configured.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const targetBundleId = canonicalBundleIdForTarget(config, target);
  if (targetBundleId !== binding.source) {
    throw new UsageError(
      `Proposal ${proposalId} is bound to target "${binding.source}"; ` +
        `--bundle "${explicitTarget}" resolves to "${targetBundleId}" at ${target.source.path}.`,
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
    // Only a legacy ref reaches this without an identity: the row codec refuses every other defect (#1513).
    if (!identity) {
      throw new UsageError(
        `Proposal ${proposal.id} predates concept IDs: its ref "${proposal.ref}" names no asset, so it cannot be applied; \`akm proposal show ${proposal.id}\` says what it lacks.`,
        "INVALID_PROPOSAL",
      );
    }
    if (identity.bundle !== undefined) {
      const target = named(resolveBundleWriteTarget(config, identity.bundle));
      if (
        explicitTarget !== undefined &&
        canonicalBundleIdForTarget(config, resolveWriteTarget(config, explicitTarget)) !== identity.bundle
      ) {
        throw new UsageError(
          `Proposal ${proposal.id} ref is bound to bundle "${identity.bundle}", which conflicts with --bundle "${explicitTarget}".`,
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
        `Unbound short proposal ${proposal.id} requires an explicit --bundle or authenticated --queue context.`,
        "INVALID_PROPOSAL",
      );
    }
    return named(target);
  }
  if (
    queueTarget &&
    explicitTarget === undefined &&
    canonicalBundleIdForTarget(config, queueTarget) !== proposal.proposedTarget.source
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
 * citation-string convention.
 *
 * Source preservation: an existing frontmatter block is edited as text and not
 * written out again through the YAML serializer, which rewraps long values,
 * requotes and drops comments in lines the stamp never touched. The blocks of
 * the keys the stamp sets (`generated`, `verified`, `provenance`) are removed
 * wherever they were and written again, serialized, as the last lines of the
 * frontmatter; every other byte, the body included, stays as written. The
 * edited text is parsed back to confirm it holds exactly the intended mapping;
 * when it does not (an indented `---` inside a block scalar), the frontmatter is
 * written out again instead.
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
  if (parsed.frontmatter === null) return assembleAsset(fm, parsed.content);
  const stamped: Record<string, unknown> = { generated: fm.generated, verified: fm.verified };
  if (fm.provenance !== undefined) stamped.provenance = fm.provenance;
  const edited = replaceFrontmatterBlocks(
    content,
    ["generated", "verified", "provenance"],
    serializeFrontmatter(stamped).split("\n"),
  );
  if (edited !== null && isDeepStrictEqual(parseFrontmatter(edited).data, fm)) return edited;
  return `---\n${serializeFrontmatter(fm)}\n---\n${parsed.content}`;
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
    decidedBy?: ProposalDecider;
    /** Defer the commit to the caller (see {@link AcceptCommitCollector}). */
    commitCollector?: AcceptCommitCollector;
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
  let bodyStartLine = 1;
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
    ({ data, content: body, frontmatter, bodyStartLine } = parseFrontmatter(raw));
  }
  const resolvedRoot = path.resolve(targetRoot);
  return runBaseChecks({
    filePath: assetPath,
    relPath: path.relative(targetRoot, assetPath),
    raw,
    data,
    body,
    frontmatter,
    bodyStartLine,
    fix: false,
    stashRoot: targetRoot,
    stalePathRoots: stalePathRoots(config, targetRoot),
    extraStashRoots: resolveSourceEntries(targetRoot, config)
      .map((source) => source.path)
      .filter((sourcePath) => path.resolve(sourcePath) !== resolvedRoot),
  }).filter((finding) => PROMOTION_LINT_ISSUE_TYPES.has(finding.issue));
}

export interface ProposalPromotionPreflight {
  proposal: Proposal;
  repairedContent: string;
  ref: AssetAddress;
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
  const target = resolveProposalWriteTarget(config, prepared, options.target, options.queueTarget);
  const ref = addressOf(target.source.name, prepared.ref);
  if (!ref.exists && ref.file === undefined && stashDirFor(ref.type) === undefined) {
    throw new UsageError(`Proposal ${proposal.id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }
  assertAdapterWrites(target.source.name, ref.type);
  const assetPath = ref.file;
  if (!assetPath) {
    throw new UsageError(`Proposal ${proposal.id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }
  const markdown = assetPath.toLowerCase().endsWith(".md");
  let stampedContent = markdown
    ? stampProposalProvenance(repairedContent, prepared, options.gateDecision, ctx, nowIso(ctx))
    : repairedContent;
  const live = markdown && ref.exists ? readAsset(target.source.name, ref.conceptId) : undefined;
  if (live) {
    // Keep the live target's bookkeeping frontmatter the proposal doesn't set
    // (STALE, R20) — dropping `inferenceProcessed` would re-run inference.
    try {
      stampedContent = carryForwardBookkeepingFrontmatter(stampedContent, live.entry.content());
    } catch {
      // best-effort; the freshness check is the real staleness gate
    }
  }
  if (prepared.promotionSource) {
    const source = currentAsset(target.source, prepared.promotionSource);
    if (
      source &&
      !sameScope(
        scopeFromFrontmatter(parseFrontmatter(source.entry.content()).data),
        scopeFromFrontmatter(parseFrontmatter(stampedContent).data),
      )
    ) {
      throw new UsageError(
        `Promotion ${proposal.id} has incompatible source/output scope — reject and reassess.`,
        "INVALID_FLAG_VALUE",
      );
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
  bundle: string,
  address: AssetAddress,
  stampedContent: string,
): Buffer | undefined {
  const current = address.exists ? readAsset(bundle, address.conceptId)?.entry.bytes() : undefined;
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
        "PROPOSAL_STALE",
      );
    }
  } else if (current !== undefined && proposal.changes.some((change) => change.op === "create")) {
    throw new UsageError(
      `Proposal target was created after proposal ${proposal.id}; refusing to overwrite newer content.`,
      "PROPOSAL_STALE",
    );
  }
  return current;
}

/**
 * The ref an accepted/reverted proposal recorded and the file it is kept in (display only: where its ref is kept, or
 * would be when it is gone, a retired asset), provided `target` is the bundle it was accepted into.
 */
function acceptedAsset(proposal: Proposal, target: ResolvedWriteTarget): { ref: string; assetPath: string } {
  const accepted = proposal.acceptedTarget;
  if (accepted?.bundle !== target.source.name) {
    throw new UsageError(`proposal ${proposal.id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
  }
  return { ref: accepted.ref, assetPath: resolveAssetFilePathSafe(target.source, accepted.ref) ?? accepted.ref };
}

function requireAcceptedTarget(proposal: Proposal): NonNullable<Proposal["acceptedTarget"]> {
  if (!proposal.acceptedTarget) {
    const label = proposal.status === "reverted" ? "Reverted" : "Accepted";
    throw new UsageError(`${label} proposal ${proposal.id} has no recorded target.`, "INVALID_PROPOSAL");
  }
  return proposal.acceptedTarget;
}

/** An accept's commit subject: the generator, the proposal id's first 8 characters and the asset ref. */
function acceptCommitMessage(proposal: Proposal): string {
  return `akm accept: ${proposal.source} ${proposal.id.slice(0, 8)} ${proposal.ref}`;
}

/**
 * Accepts whose commit waits for the end of the process (#1185). A loop of
 * accepts (a drain, a bulk accept, `accept <id> <id>`) passes one collector to
 * every accept, then commits the lot once with {@link commitCollectedAccepts};
 * without a collector an accept commits as it happens.
 */
export type AcceptCommitCollector = Array<{ target: ResolvedWriteTarget; proposal: Proposal; paths: string[] }>;

function commitAccept(
  collector: AcceptCommitCollector | undefined,
  target: ResolvedWriteTarget,
  proposal: Proposal,
  paths: string[],
): CommitOutcome | undefined {
  if (collector) {
    collector.push({ target, proposal, paths });
    return undefined;
  }
  return commitAcceptedPaths(target, acceptCommitMessage(proposal), paths);
}

/**
 * Commit everything `collector` holds, one commit per target repository: a lone
 * accept keeps its own subject; several get `<label>: N accepted (source count,
 * ...)` with one `<id8> <source> <ref>` body line per proposal. Empties the
 * collector. A failed commit only warns, as for a single accept. Returns what
 * each proposal's commit came to, by proposal id.
 */
export function commitCollectedAccepts(collector: AcceptCommitCollector, label: string): Map<string, CommitOutcome> {
  const outcomes = new Map<string, CommitOutcome>();
  const byRepo = new Map<string, AcceptCommitCollector>();
  for (const entry of collector.splice(0)) {
    const key = path.resolve(entry.target.source.repoPath ?? entry.target.source.path);
    byRepo.set(key, [...(byRepo.get(key) ?? []), entry]);
  }
  for (const entries of byRepo.values()) {
    const first = entries[0] as AcceptCommitCollector[number];
    if (entries.length === 1) {
      outcomes.set(
        first.proposal.id,
        commitAcceptedPaths(first.target, acceptCommitMessage(first.proposal), first.paths),
      );
      continue;
    }
    const counts = new Map<string, number>();
    for (const { proposal } of entries) counts.set(proposal.source, (counts.get(proposal.source) ?? 0) + 1);
    const bySource = [...counts].sort((a, b) => b[1] - a[1]).map(([source, count]) => `${source} ${count}`);
    const outcome = commitAcceptedPaths(
      first.target,
      `${label}: ${entries.length} accepted (${bySource.join(", ")})`,
      entries.flatMap((entry) => entry.paths),
      entries.map(({ proposal }) => `${proposal.id.slice(0, 8)} ${proposal.source} ${proposal.ref}`),
    );
    for (const { proposal } of entries) outcomes.set(proposal.id, outcome);
  }
  return outcomes;
}

/**
 * O1: an accepted consolidate PROMOTION retires its source memory
 * (and its `.derived` twin), so promotion leaves no memory/
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
function retirePromotionSource(mutationTarget: ResolvedWriteTarget, accepted: Proposal, paths: string[]): void {
  if (!accepted.promotionSource) return;
  // Every file the retirement touches goes into the accept's commit.
  const journal = beginWriteProvenance();
  try {
    const sourceRef = addressOf(mutationTarget.source.name, accepted.promotionSource);
    const source = sourceRef.exists ? readAsset(mutationTarget.source.name, sourceRef.conceptId) : undefined;
    if (!source) return;
    if (!accepted.promotionSourceHash) {
      warn(
        `[proposal] O1: ${accepted.id} has no recorded source hash (minted by an older release) — leaving its source ${accepted.promotionSource} unarchived.`,
      );
      return;
    }
    const sourceContent = source.entry.content();
    if (
      !sameScope(
        scopeFromFrontmatter(parseFrontmatter(sourceContent).data),
        scopeFromFrontmatter(parseFrontmatter(proposalContent(accepted)).data),
      )
    ) {
      warn(`[proposal] source scope changed for ${accepted.id} — leaving ${accepted.promotionSource} unarchived.`);
      return;
    }
    const currentHash = contentHash(sourceContent, "body");
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
    writeAssets(mutationTarget, { purpose: "proposal-accept" }, (w) => {
      retireCleanupCandidate(w, source.conceptId, candidate);
      const twinId = derivedTwinOf(source.conceptId, sourceRef.type);
      const twin = twinId === undefined ? undefined : w.read(twinId);
      if (
        twin &&
        sameScope(
          scopeFromFrontmatter(parseFrontmatter(twin.entry.content()).data),
          scopeFromFrontmatter(parseFrontmatter(sourceContent).data),
        )
      ) {
        retireCleanupCandidate(w, twin.conceptId, candidate);
      }
    });
  } catch (error) {
    warn(
      `[proposal] O1: failed to retire promotion source ${accepted.promotionSource} for ${accepted.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    paths.push(...journal.end());
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
    decidedBy?: ProposalDecider;
    /** Defer the commit to the caller (see {@link AcceptCommitCollector}). */
    commitCollector?: AcceptCommitCollector;
  },
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const proposal = getProposal(stashDir, id, ctx);
  if (isRetireProposal(proposal)) return retireProposalWithLease(stashDir, config, proposal, options, ctx);
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  if (proposal.status === "accepted") {
    // Accepting again is a no-op, provided the published bytes are still there.
    const recorded = requireAcceptedTarget(proposal);
    const { assetPath } = acceptedAsset(proposal, target);
    const current = readAsset(target.source.name, parseBundleRef(recorded.ref).conceptId);
    if (!current || contentHash(current.entry.bytes()) !== recorded.contentHash) {
      throw new UsageError(`Accepted proposal ${id} does not match the current asset content.`, "INVALID_FLAG_VALUE");
    }
    return { proposal, assetPath, ref: proposal.ref };
  }
  if (proposal.status !== "pending") {
    throw new UsageError(
      `Proposal ${id} is not pending (current status: ${proposal.status}). Only pending proposals can be accepted.`,
      "PROPOSAL_NOT_PENDING",
    );
  }
  const preflight = preflightProposalPromotion(config, proposal, { ...options, queueTarget: target }, ctx);
  const mutationTarget = prepareWriteTargetForMutation(target);
  const address = resolveAddressSafe(mutationTarget.source, proposal.ref);
  const plannedPath = address?.file;
  if (!address || !plannedPath)
    throw new UsageError(`Cannot resolve proposal target ${proposal.ref}.`, "INVALID_PROPOSAL");
  const backup = readFreshProposalTarget(proposal, mutationTarget.source.name, address, preflight.stampedContent);
  assertAdapterWrites(mutationTarget.source.name, address.type);
  const refIdentity = proposalRefIdentity(preflight.proposal.ref);
  const proposalForMutation: Proposal =
    refIdentity?.bundle === undefined
      ? { ...preflight.proposal, ref: `${target.source.name}//${refIdentity?.conceptId ?? ""}` }
      : preflight.proposal;
  const decidedAt = nowIso(ctx);
  const stamped = preflight.stampedContent.endsWith("\n") ? preflight.stampedContent : `${preflight.stampedContent}\n`;
  // The bundle's adapter writes the asset: the published content, in place of the existing one or as a new asset.
  const written = writeAssets(mutationTarget, { purpose: "proposal-accept" }, (w) =>
    backup !== undefined
      ? w.update(address.conceptId, stamped)
      : w.create({ type: address.type, name: address.name, content: stamped }, { verbatim: true }),
  );
  const assetPath = plannedPath;
  const content = String(written.content ?? stamped);
  const accepted = persistProposalDecision(
    stashDir,
    proposalForMutation,
    {
      operation: "accept",
      target: mutationTarget,
      ref: written.ref,
      assetPath,
      content,
      existed: backup !== undefined,
      ...(backup !== undefined ? { backupContent: backup.toString("utf8") } : {}),
      ...(options.eventMetadata ? { eventMetadata: options.eventMetadata } : {}),
      ...(options.gateDecision ? { gateDecision: options.gateDecision } : {}),
      ...(options.decidedBy ? { decidedBy: options.decidedBy } : {}),
      decidedAt,
    },
    ctx,
  );
  await indexWrittenProposalAssets(mutationTarget, [assetPath]);
  const paths = [assetPath];
  if (accepted.status === "accepted" && accepted.source === "consolidate")
    retirePromotionSource(mutationTarget, accepted, paths);
  const commit = commitAccept(options.commitCollector, mutationTarget, accepted, paths);
  return { proposal: accepted, assetPath, ref: accepted.ref, ...(commit ? { commit } : {}) };
}

/**
 * Record a retire accept's intent — `backupContent` and which
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
      upsertProposal(db, next, stateBundleId(stashDir));
      return next;
    }),
  );
}

/**
 * Persist a retire's "accepted" decision — the row, its ledger decision and
 * its event — the one finalize step a fresh accept and one resumed after a
 * crash share: by the time either calls it, every file move
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
    /** The retired asset's ref, and the file it was kept in (display: the event records it). */
    ref: string;
    assetPath: string;
    contentHash: string;
    /** Each retirement the accept made, by the ref of the asset it holds. */
    retired: Array<{ ref: string; handle: string }>;
    backupContent: string;
    gateDecision?: GateDecisionInput;
    decidedBy?: ProposalDecider;
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
        acceptedAt: decidedAt,
        review: { outcome: "accepted", decidedAt, ...(info.decidedBy ? { decidedBy: info.decidedBy } : {}) },
        acceptedTarget: { bundle: info.targetName, ref: info.ref, contentHash: info.contentHash },
        // Each retirement is recorded under the proposal's ref, the twin's included, as the reference corpus pins it.
        retiredArchive: { retired: info.retired.map(({ handle }) => ({ ref: info.ref, handle })) },
        backupContent: info.backupContent,
        ...(info.gateDecision
          ? { gateDecision: { ...info.gateDecision, decidedAt: info.gateDecision.decidedAt ?? decidedAt } }
          : {}),
      };
      upsertProposal(db, next, stateBundleId(stashDir));
      recordImproveLedgerDecision(db, {
        proposalId: next.id,
        bundleId: stateBundleId(stashDir),
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
 * Throws a stale-retire `UsageError` unless the successor still exists
 * and both sides' recorded body hashes and judged scopes still match — the
 * durable half of the chain guard. Used for a fresh accept, and to
 * re-check a resumed accept whose intent was recorded but
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
  const successorBytes = currentAsset(targetSource, retirement.successorRef)?.entry.bytes();
  const judgedScope = retirement.judgedScope;
  if (!judgedScope || typeof judgedScope !== "object" || Array.isArray(judgedScope)) {
    throw new UsageError(
      `Retire proposal ${proposalId} is stale — judged scope cannot be established; reject it and reassess the pair before acceptance.`,
      "PROPOSAL_STALE",
    );
  }
  if (
    !sameScope(scopeFromFrontmatter(parseFrontmatter(retiredCurrentBytes.toString("utf8")).data), judgedScope) ||
    (successorBytes &&
      !sameScope(scopeFromFrontmatter(parseFrontmatter(successorBytes.toString("utf8")).data), judgedScope))
  ) {
    throw new UsageError(
      `Retire proposal ${proposalId} is stale — scope changed since judging; reject and reassess.`,
      "PROPOSAL_STALE",
    );
  }
  const retiredFresh = contentHash(retiredCurrentBytes, "body") === retirement.retiredContentHash;
  const successorFresh =
    successorBytes !== undefined && contentHash(successorBytes, "body") === retirement.successorContentHash;
  if (!successorBytes || !retiredFresh || !successorFresh) {
    throw new UsageError(
      `Retire proposal ${proposalId} is stale — successor ${retirement.successorRef} ` +
        `${successorBytes === undefined ? "no longer exists" : !successorFresh ? "changed" : `and ${proposalRef} changed`} ` +
        "since judging; refusing to retire.",
      "PROPOSAL_STALE",
    );
  }
}

/**
 * Accept a `retire` proposal: no
 * new content is written. It is a
 * three-phase, resume-safe sequence: (1) record intent — `backupContent` —
 * on the still-pending proposal; (2) retire the asset and its `.derived` twin
 * into the recoverable cleanup archive (`retireCleanupCandidate`), skipping any
 * a retirement under this proposal's id shows a prior, crashed attempt already
 * retired; (3) finalize via
 * {@link persistRetireAcceptance}. A `supersedes` judgement writes the
 * supersede edge on the retired (older) side AFTER intent is recorded —
 * recording it first means a crash before the edge
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
    decidedBy?: ProposalDecider;
    /** Defer the commit to the caller (see {@link AcceptCommitCollector}). */
    commitCollector?: AcceptCommitCollector;
  },
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  if (proposal.status === "accepted") {
    // Accepting again is a no-op, provided the target is still gone (retired) and its archive is still there.
    requireAcceptedTarget(proposal);
    const accepted = acceptedAsset(proposal, target);
    const archive = proposal.retiredArchive;
    const held = new Set(retirementsOf(target).map((retirement) => retirement.handle));
    const archivedStill = archive?.retired.every(({ handle }) => held.has(handle)) === true;
    if (readAsset(target.source.name, parseBundleRef(accepted.ref).conceptId) || !archivedStill) {
      throw new UsageError(
        `Accepted retire proposal ${proposal.id} no longer matches its archive.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { proposal, assetPath: accepted.assetPath, ref: proposal.ref };
  }
  if (proposal.status !== "pending") {
    throw new UsageError(
      `Proposal ${proposal.id} is not pending (current status: ${proposal.status}). Only pending proposals can be accepted.`,
      "PROPOSAL_NOT_PENDING",
    );
  }
  const ref = resolveAddressSafe(target.source, proposal.ref);
  const assetPath = ref?.file;
  if (!ref || !assetPath) throw new UsageError(`Cannot resolve proposal target ${proposal.ref}.`, "INVALID_PROPOSAL");

  let working = proposal;
  let intent = proposal.retireAcceptIntent;
  let scheduler: Awaited<ReturnType<typeof disableRetiredTask>>;
  if (!intent) {
    // Fresh accept — no recorded intent yet, so the target must still be there.
    const current = readAsset(target.source.name, ref.conceptId);
    if (!current) {
      throw new UsageError(
        `Retire proposal ${proposal.id} target (${proposal.ref}) no longer exists — it may already have been retired, promoted away, or removed by another proposal.`,
        "PROPOSAL_STALE",
      );
    }
    const currentBytes = current.entry.bytes();
    const retirement = proposal.retirement;
    // B2 (this is the durable half of the chain guard; the same-run half is
    // `retiredThisRun` in pair-pass.ts). A human retirement has no judged pair, so
    // it only has to match the bytes it was minted against.
    if (retirement) {
      assertRetirementStillFresh(proposal.id, proposal.ref, retirement, target.source, currentBytes);
    } else if (!matchesBeforeHash(proposal, currentBytes)) {
      throw new UsageError(
        `Retire proposal ${proposal.id} target (${proposal.ref}) changed since the proposal was created.`,
        "INVALID_FLAG_VALUE",
      );
    }
    assertAdapterWrites(target.source.name, ref.type);
    // Phase 1: record intent BEFORE any move, and BEFORE the supersede edge:
    // `backupContent` is `currentBytes`, read
    // above, before any mutation of this file. Recording first means a crash
    // between here and the edge write below can never cause a resume to
    // re-read the file and capture the edge INTO backupContent as if it were
    // the original.
    intent = { backupContent: currentBytes.toString("utf8") };
    working = recordRetireAcceptIntent(stashDir, proposal.id, intent, ctx);
    scheduler = await disableRetiredTask(ref, target.source.name);
    if (retirement?.judgeLabel === "supersedes") {
      try {
        writeAssets(target, { purpose: "proposal-retire" }, (w) =>
          writeSupersededEdge(w, ref.conceptId, retirement.successorRef),
        );
      } catch (error) {
        warn(
          `[proposal] failed to write the supersede edge for ${proposal.id} (continuing with the retire): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else {
    assertAdapterWrites(target.source.name, ref.type);
    assertRetiringTaskUnchanged(target.source.name, ref, intent, proposal);
    // Revalidate the survivor even after a partial archive. The recorded original
    // is the judged retired side when its file has already moved.
    if (working.retirement) {
      assertRetirementStillFresh(
        proposal.id,
        proposal.ref,
        working.retirement,
        target.source,
        readAsset(target.source.name, ref.conceptId)?.entry.bytes() ?? Buffer.from(intent.backupContent),
      );
    }
    scheduler = await disableRetiredTask(ref, target.source.name);
  }

  // The twin is re-derived, not carried on the intent — it is a pure function
  // of the ref and its type, and the retirements under this proposal's id
  // (`alreadyDone` below) already show one retired earlier.
  const twinId = derivedTwinOf(ref.conceptId, ref.type);
  const backupContent = intent.backupContent;
  let commit: ReturnType<typeof commitAccept>;
  let accepted: Proposal;
  try {
    // Native reconciliation awaits external work; a direct file edit can happen outside AKM's mutation lease.
    assertRetiringTaskUnchanged(target.source.name, ref, intent, proposal);

    // Phase 2: retire, idempotently — a resumed call skips whichever asset a
    // retirement under this proposal's own id already holds. A failure undoes this
    // call's own retirements, so a refused accept leaves no asset half-retired.
    const mutationTarget = prepareWriteTargetForMutation(target);
    const journal = beginWriteProvenance();
    let retired: Array<{ ref: string; handle: string }>;
    try {
      retired = writeAssets(mutationTarget, { purpose: "proposal-retire" }, (w) => {
        const mine = w.retired().filter((retirement) => retirement.note.proposalId === proposal.id);
        // A retirement is done only once its asset is gone: a crash between the tombstone and the move leaves the
        // asset in place. Nothing was moved under such a tombstone, so it goes; one holding an archived copy is kept.
        const already = mine.filter((retirement) => !w.read(retirement.conceptId));
        for (const left of mine) if (!already.includes(left) && !left.restorable) w.forget(left.handle);
        const alreadyDone = new Set(already.map((retirement) => retirement.conceptId));
        const made: Array<{ ref: string; handle: string }> = [];
        const candidate: MemoryPruneCandidate = {
          ref: proposal.ref,
          reason: working.retirement?.reason ?? "manual",
          proposalId: proposal.id,
          ...(working.retirement?.successorRef ? { successorRefs: [working.retirement.successorRef] } : {}),
        };
        const retire = (conceptId: string) => {
          made.push(...retireCleanupCandidate(w, conceptId, candidate).retired);
        };
        try {
          if (!alreadyDone.has(ref.conceptId) && w.read(ref.conceptId)) retire(ref.conceptId);
          const twin = twinId === undefined || alreadyDone.has(twinId) ? undefined : w.read(twinId);
          if (
            twin &&
            sameScope(
              scopeFromFrontmatter(parseFrontmatter(twin.entry.content()).data),
              scopeFromFrontmatter(parseFrontmatter(backupContent).data),
            )
          )
            retire(twin.conceptId);
        } catch (error) {
          for (const { ref: madeRef, handle } of made.reverse()) {
            // A failed undo must not hide the failure that caused it; the retirement stays to explain the asset.
            try {
              w.restore(handle);
              w.forget(handle);
            } catch (undoError) {
              warn(
                `[retire] could not put ${resolveAssetFilePathSafe(mutationTarget.source, madeRef) ?? madeRef} back from ${handle}: ${undoError instanceof Error ? undoError.message : String(undoError)}`,
              );
            }
          }
          throw error;
        }
        return [
          ...already.map((retirement) => ({
            ref: makeBundleRef(mutationTarget.source.name, retirement.conceptId),
            handle: retirement.handle,
          })),
          ...made,
        ];
      });
    } finally {
      journal.end();
    }
    const paths = journal.writtenPaths();
    commit = paths.length > 0 ? commitAccept(options.commitCollector, mutationTarget, proposal, paths) : undefined;

    if (retired.length === 0) {
      // Recorded intent, but neither file is at its original location NOR
      // archived under this proposal's id: something else removed the target
      // between intent and move. Refuse cleanly rather than finalize on
      // nothing.
      throw new UsageError(
        `Retire proposal ${proposal.id} target (${proposal.ref}) no longer exists and was not archived by this proposal — refusing to accept.`,
        "PROPOSAL_STALE",
      );
    }

    // Phase 3: finalize — always from the recorded intent's own backupContent,
    // never a hash guessed from the archived copy.
    accepted = persistRetireAcceptance(
      stashDir,
      working,
      {
        targetName: mutationTarget.source.name,
        ref: makeBundleRef(mutationTarget.source.name, ref.conceptId),
        assetPath,
        contentHash: contentHash(backupContent),
        retired,
        backupContent,
        ...(options.gateDecision ? { gateDecision: options.gateDecision } : {}),
        ...(options.decidedBy ? { decidedBy: options.decidedBy } : {}),
        ...(options.eventMetadata ? { eventMetadata: options.eventMetadata } : {}),
      },
      ctx,
    );
  } catch (error) {
    // A retirement that does not go through leaves the task scheduled as it was.
    await scheduler.restore();
    throw error;
  }
  return {
    proposal: accepted,
    assetPath,
    ref: accepted.ref,
    ...(commit ? { commit } : {}),
    ...(scheduler.warnings.length ? { warnings: scheduler.warnings } : {}),
  };
}

function assertRetiringTaskUnchanged(
  bundle: string,
  ref: AssetAddress,
  intent: RetireAcceptIntent,
  proposal: Proposal,
): void {
  // The intent holds the bytes this retirement was validated against; `beforeHash` is absent on some proposals.
  const current = ref.type === "task" ? readAsset(bundle, ref.conceptId) : undefined;
  if (current && current.entry.content() !== intent.backupContent) {
    throw new UsageError(
      `Retire proposal ${proposal.id} target (${proposal.ref}) changed since retirement started.`,
      "PROPOSAL_STALE",
    );
  }
}

/**
 * Stop scheduling a task that is being retired. Activation and reconciliation
 * stay with the operation `task disable` uses. `restore` puts back the
 * activation this call removed, for a retirement that does not go through.
 */
async function disableRetiredTask(
  ref: AssetAddress,
  bundle: string,
): Promise<{ warnings: string[]; restore: () => Promise<void> }> {
  if (ref.type !== "task") return { warnings: [], restore: async () => {} };
  const qualifiedRef = makeBundleRef(bundle, ref.conceptId);
  let disabled = false;
  const restore = async () => {
    if (!disabled) return;
    disabled = false;
    try {
      await akmTasksEnable(qualifiedRef);
    } catch (error) {
      warn(
        `[retire] could not re-enable ${qualifiedRef} after its retirement was refused: ${error instanceof Error ? error.message : String(error)}. Run akm task enable ${qualifiedRef}.`,
      );
    }
  };
  const unverified = (reason: string) => [
    `Task ${qualifiedRef} is disabled in local config, but native scheduler cleanup is unverified: ${reason}. ` +
      "Installed bindings may remain; repair the scheduler and run akm doctor scheduler sync.",
  ];
  try {
    const warnings = await withSchedulerLock(async () => {
      const before = await inspectTaskSchedulerBindings(qualifiedRef);
      const enabledRefs = schedulerEnabledRefs(loadConfig());
      const enabled = enabledRefs?.includes(qualifiedRef) === true;
      if (before.state === "unavailable") {
        // No native state can be read, so none can be reconciled: only this host's own list changes.
        if (enabled) disabled = setSchedulerRefEnabled(qualifiedRef, false).changed;
        return unverified(before.reason);
      }
      // Not on the host's list and not installed (a host with no list schedules exactly what is installed).
      if (!enabled && before.state === "not-installed") return [];
      if (!enabled && before.state === "unknown") return unverified(before.reason);
      disabled = enabled || enabledRefs === undefined;
      const { sync } = await akmTasksDisable(qualifiedRef);
      const failures = sync.failures.map((failure) => `${failure.path}: ${failure.reason}`).join("; ");
      const after = await inspectTaskSchedulerBindings(qualifiedRef);
      if (after.state === "installed") {
        throw new Error(
          `Task ${qualifiedRef} remains installed in the native scheduler after cleanup${failures ? `: ${failures}` : ""}. ` +
            "Retry retirement or run akm doctor scheduler sync.",
        );
      }
      // The sync covers the whole bundle; only this task's own bindings decide its retirement.
      return [
        ...("reason" in after ? unverified(after.reason) : []),
        ...(failures ? [`Scheduler sync of bundle ${bundle} also reported: ${failures}.`] : []),
      ];
    });
    return { warnings, restore };
  } catch (error) {
    await restore();
    throw error;
  }
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
 * Revert an accepted `retire` proposal: restore its retirements — the
 * retired asset, and its `.derived` twin when one was retired alongside it —
 * then overwrite the primary with the exact pre-retire bytes `backupContent`
 * recorded at accept — byte-exact, so it also undoes any supersede edge
 * accept wrote without touching one a person had already written, and
 * without appending a trailing newline the original never had. Each
 * retirement is the one `retiredArchive.retired` names by handle (set at
 * accept time).
 *
 * Every retirement is found and validated before any of them is restored,
 * AND that validation tells "not yet restored" apart from "already restored
 * by an earlier, crashed attempt of our own" (asset present, retired copy
 * gone) rather than treating the latter as a conflict — so a retry of a
 * crashed revert resumes instead of erroring on its own prior work. The
 * retirements are forgotten only after the "reverted" decision is durably
 * recorded, not interleaved with the restores — a crash between restoring an
 * asset and recording the decision would otherwise drop its retirement first,
 * leaving an "accepted" proposal a retry could neither finish nor re-validate.
 */
async function unretireProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  proposal: Proposal,
  options: { target?: string; queueTarget?: ResolvedWriteTarget },
  ctx?: ProposalsContext,
): Promise<RevertResult> {
  if (proposal.status !== "accepted" && proposal.status !== "reverted") {
    throw new UsageError(
      `only accepted proposals can be reverted (proposal ${proposal.id} status: ${proposal.status})`,
      "INVALID_FLAG_VALUE",
    );
  }
  const recorded = requireAcceptedTarget(proposal);
  const boundTarget = resolveRecordedProposalTarget(config, proposal.id, { source: recorded.bundle }, options.target);
  const { assetPath } = acceptedAsset(proposal, boundTarget);
  if (proposal.status === "reverted") {
    return { proposal, assetPath, ref: proposal.ref };
  }
  const archive = proposal.retiredArchive;
  if (!archive || archive.retired.length === 0) {
    throw new UsageError(
      `no archive recorded for this retire proposal (id: ${proposal.id})`,
      "MISSING_REQUIRED_ARGUMENT",
      "A retire proposal's archive is recorded at accept time; a proposal missing it cannot be reverted through this path.",
    );
  }
  const target = prepareWriteTargetForMutation(boundTarget);
  const bundle = target.source.name;
  /** Where the asset `ref` is kept, as base named it in a refusal: its file in the bundle (display only). */
  const shown = (ref: string): string => {
    const file = resolveAssetFilePathSafe(target.source, ref);
    return file === undefined ? ref : path.relative(target.source.path, file).split(path.sep).join("/");
  };
  interface PendingRestore {
    handle: string;
    conceptId: string;
    primary: boolean;
    /** The archived copy was purged: nothing to move, the primary is rewritten from `backupContent`. */
    fromBackup: boolean;
    /** The derived twin's archived copy was purged and cannot be restored. */
    gone: boolean;
  }
  const recordedAddress = addressOf(bundle, recorded.ref);
  const derivedTwinId = derivedTwinOf(recordedAddress.conceptId, recordedAddress.type);
  // Every file the restores and the primary's rewrite touch goes into the revert's commit.
  const journal = beginWriteProvenance();
  let pending: PendingRestore[];
  try {
    pending = writeAssets(target, { purpose: "proposal-revert" }, (w) => {
      const retirements = new Map(w.retired().map((retirement) => [retirement.handle, retirement]));
      const found: PendingRestore[] = [];
      for (const { handle } of archive.retired) {
        const retirement = retirements.get(handle);
        if (!retirement) {
          throw new UsageError(
            `Archive for proposal ${proposal.id} is missing its tombstone (${handle}); cannot revert.`,
            "INVALID_FLAG_VALUE",
          );
        }
        const ref = makeBundleRef(bundle, retirement.conceptId);
        const current = w.read(retirement.conceptId);
        const originalExists = current !== undefined;
        const archivedExists = retirement.restorable;
        if (originalExists && archivedExists) {
          throw new UsageError(
            `Cannot revert proposal ${proposal.id}: ${shown(ref)} already exists (created since retirement); refusing to overwrite it.`,
            "INVALID_FLAG_VALUE",
          );
        }
        // The graced purge deletes the archived bytes once git holds them, but the
        // proposal keeps the primary's exact pre-retire bytes (`backupContent`),
        // so the primary can still be restored from those.
        const primary = ref === recorded.ref;
        const fromBackup = !originalExists && !archivedExists && proposal.backupContent !== undefined && primary;
        const gone = !originalExists && !archivedExists && retirement.conceptId === derivedTwinId;
        if (!originalExists && !archivedExists && !fromBackup && !gone) {
          throw new UsageError(
            `Cannot revert proposal ${proposal.id}: archived copy of ${shown(ref)} (${handle}) is missing.`,
            "INVALID_FLAG_VALUE",
          );
        }
        // "asset present, retired copy
        // missing" is not necessarily our own earlier, crashed revert — once a
        // purge can delete an archived copy on its own, a LATER, unrelated file
        // can occupy this same path (a new memory reusing a retired one's name),
        // and the restore below would overwrite it with the retired asset's
        // pre-retire bytes. Only the primary has a recorded pre-retire hash
        // (`retirement.retiredContentHash`, or `beforeHash` for a person's retirement) to tell the two apart; resume only
        // when it matches the asset actually there, otherwise refuse
        // exactly as the conflict case above does.
        if (current && !archivedExists && primary) {
          // A retirement with no judged pair (a person's) has only the `beforeHash` it was minted against.
          let matches = false;
          try {
            const bytes = current.entry.bytes();
            const judged = proposal.retirement;
            matches = judged
              ? contentHash(bytes, "body") === judged.retiredContentHash
              : matchesBeforeHash(proposal, bytes);
          } catch {
            matches = false;
          }
          if (!matches) {
            throw new UsageError(
              `Cannot revert proposal ${proposal.id}: ${shown(ref)} exists but its content does not match what was retired (its path may have been reused since); refusing to overwrite it.`,
              "INVALID_FLAG_VALUE",
            );
          }
        }
        found.push({ handle, conceptId: retirement.conceptId, primary, fromBackup, gone });
      }
      // The primary first: a refusal its restore makes (a retirement that does not say where its file went) leaves
      // every other retirement as it was, whatever order the accept recorded them in.
      const ordered = [...found.filter((p) => p.primary), ...found.filter((p) => !p.primary)];
      for (const p of ordered) {
        if (!p.gone) w.restore(p.handle, p.fromBackup ? proposal.backupContent : undefined);
      }
      // Overwrite the primary with the EXACT pre-retire bytes recorded
      // at accept (`backupContent`) — no appended trailing newline either, so
      // YAML comments, key order, a pre-existing human `supersededBy` edge, and
      // even the exact absence of a final newline all survive the round trip.
      // The archived copy just restored may carry a `supersededBy` edge THIS
      // accept wrote (a `supersedes` judgement); restoring the recorded original
      // bytes already removes exactly that edge, so no separate
      // removeSupersededEdge mutation runs here — one that could not tell "the
      // edge accept wrote" from "an edge a person had already written" apart,
      // and would delete either.
      // Skipped when the restored bytes already decode to `backupContent`: that leaves a
      // non-UTF-8 asset byte-exact, since `backupContent` is only its lossy text. After the
      // grace purge (`fromBackup`) the restore wrote `backupContent` itself; git history keeps the bytes.
      const restoredPrimary = found.find((p) => p.primary);
      if (restoredPrimary && proposal.backupContent !== undefined) {
        if (w.read(restoredPrimary.conceptId)?.entry.content() !== proposal.backupContent) {
          w.update(restoredPrimary.conceptId, proposal.backupContent);
        }
      }
      return found;
    });
  } finally {
    journal.end();
  }
  for (const p of pending) {
    if (p.gone)
      warn(
        `[proposal] ${bundle}//${p.conceptId} was purged from the archive and is gone; only ${proposal.ref} was restored.`,
      );
  }
  commitWriteTargetBoundary(target, `Revert ${proposal.ref}`, { paths: journal.writtenPaths() });
  const restoredPath = resolveAssetFilePathSafe(target.source, recorded.ref) ?? assetPath;
  const decidedAt = nowIso(ctx);
  const reverted = withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const current = requireProposal(db, stashDir, proposal.id);
      if (current.status === "reverted") return current;
      const next: Proposal = {
        ...current,
        status: "reverted",
        updatedAt: decidedAt,
        review: {
          outcome: "rejected",
          reason: "reverted: archived asset restored",
          decidedAt,
          ...(current.review?.decidedBy ? { decidedBy: current.review.decidedBy } : {}),
        },
      };
      upsertProposal(db, next, stateBundleId(stashDir));
      recordImproveLedgerDecision(db, {
        proposalId: next.id,
        bundleId: stateBundleId(stashDir),
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
        metadata: { proposalId: next.id, source: next.source, assetPath: restoredPath },
        idempotencyKey: `${next.id}:reverted`,
      });
      return next;
    }),
  );
  // Only now — after the decision is durably recorded — forget the
  // retirements. See the function doc comment for why this ordering matters.
  writeAssets(target, { purpose: "proposal-revert" }, (w) => {
    for (const p of pending) w.forget(p.handle);
  });
  return { proposal: reverted, assetPath: restoredPath, ref: proposal.ref };
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
  const boundTarget = resolveRecordedProposalTarget(config, id, { source: recorded.bundle }, options.target);
  const { assetPath } = acceptedAsset(proposal, boundTarget);
  if (proposal.status === "reverted" || backupContent === undefined) {
    return { proposal, assetPath, ref: proposal.ref };
  }
  const target = prepareWriteTargetForMutation(boundTarget);
  const accepted = readAsset(target.source.name, parseBundleRef(recorded.ref).conceptId);
  if (!accepted || contentHash(accepted.entry.bytes()) !== recorded.contentHash) {
    // By-ref resolution skips retire proposals, so reverting by ref when a
    // SEPARATE retire proposal
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
  writeAssets(target, { purpose: "proposal-revert" }, (w) =>
    w.update(accepted.conceptId, backupContent.endsWith("\n") ? backupContent : `${backupContent}\n`),
  );
  const restoredPath = assetPath;
  commitWriteTargetBoundary(target, `Revert ${proposal.ref}`, { paths: [restoredPath] });
  const reverted = persistProposalDecision(
    stashDir,
    proposal,
    { operation: "revert", assetPath: restoredPath, decidedAt },
    ctx,
  );
  await indexWrittenProposalAssets(target, [restoredPath]);
  return { proposal: reverted, assetPath: restoredPath, ref: proposal.ref };
}

export interface ReopenOptions {
  queueTarget?: ResolvedWriteTarget;
  /** Why the rejection is being undone: kept in the review history, the ledger row and the event. */
  reason?: string;
}

/** The message of the stale-target refusal `check` raises, else `undefined`. */
function staleRefusal(check: () => void): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
}

/**
 * Why `proposal` cannot be reopened, or `undefined` when it can. Only a
 * rejected proposal comes back, and only one accept would not refuse as stale:
 * a retire proposal needs its successor and both recorded body hashes to still
 * match (B2), any other its target to be what it was minted against
 * (STALE, R20) — so a reopened proposal is never one the next accept refuses.
 */
function reopenRefusal(config: AkmConfig, proposal: Proposal, queueTarget?: ResolvedWriteTarget): string | undefined {
  if (proposal.status !== "rejected") {
    return `it is not rejected (current status: ${proposal.status}); only a rejected proposal can be reopened.`;
  }
  if (proposal.changes.length === 0 || proposal.proposedTarget === undefined) {
    // A pending row must carry both (proposalToRowValues), which a row from
    // before the change envelope existed cannot.
    return "it was recorded before proposals carried their change envelope, so it cannot go back in the queue.";
  }
  const target = resolveProposalWriteTarget(config, proposal, undefined, queueTarget);
  const address = resolveAddressSafe(target.source, proposal.ref);
  if (!address?.file) return "its target cannot be resolved.";
  if (!isRetireProposal(proposal)) {
    return staleRefusal(
      () => void readFreshProposalTarget(proposal, target.source.name, address, proposalContent(proposal)),
    );
  }
  if (!proposal.retirement) return "it has no retirement metadata.";
  const current = address.exists ? readAsset(target.source.name, address.conceptId) : undefined;
  if (!current) {
    return "its retired file no longer exists (already retired, or removed by something else).";
  }
  const { retirement } = proposal;
  return staleRefusal(() =>
    assertRetirementStillFresh(proposal.id, proposal.ref, retirement, target.source, current.entry.bytes()),
  );
}

/** The assets a retire proposal speaks for — the one it retires and its successor — as bundle-less concept ids, the way the pair pass keys them. */
function retireHeldRefs(proposal: Proposal): string[] {
  return [proposal.ref, proposal.retirement?.successorRef].flatMap((ref) => {
    const conceptId = ref === undefined ? undefined : proposalRefIdentity(ref)?.conceptId;
    return conceptId === undefined ? [] : [conceptId];
  });
}

const REOPEN_REFUSED_HINT =
  "Only a rejected proposal whose target is unchanged can be reopened; `akm proposal list --status rejected` lists the candidates.";
const REOPEN_RETIRE_CONFLICT_HINT =
  "Only one pending retire proposal can involve a document: accept or reject the pending one (or reopen just one of a clashing pair), then reopen the other.";

/**
 * The pair pass never has two pending retire proposals speak for one asset
 * (`pendingRetireRefs`): accepting one would strand the other. Reopening must
 * not break that either — a rejected pair can meanwhile have been re-paired
 * with something else. `held` maps each asset to the pending retire proposal
 * that has it; a proposal that clears this claims its assets, so two in one
 * batch that clash refuse the later.
 */
function retireConflict(proposal: Proposal, held: Map<string, string>): string | undefined {
  if (!isRetireProposal(proposal)) return undefined;
  const refs = retireHeldRefs(proposal);
  for (const ref of refs) {
    const holder = held.get(ref);
    if (holder !== undefined) {
      return `${ref} is already part of retire proposal ${holder}, which is pending or being reopened with this one; only one pending retire proposal may involve an asset.`;
    }
  }
  for (const ref of refs) held.set(ref, proposal.id);
  return undefined;
}

/**
 * Put rejected proposals back in the queue (`akm proposal reopen`, #997): a
 * rejection is otherwise final, and it also suppresses the pair pass from ever
 * re-proposing a retirement (its record keys the pair), so a mistaken one
 * could not be undone. Each proposal returns to `pending` with the rejection —
 * and the gate verdict that came with it — kept in `reviewHistory` (the verdict
 * itself is cleared, unless it is a `deferred` hand-off to a person), its
 * ledger row reset (the pair pass keys off proposal status, so the pair is no
 * longer suppressed and, while pending, cannot be minted twice), and a
 * `proposal_reopened` event recorded, all in one transaction.
 *
 * All-or-nothing: every id is checked (see {@link reopenRefusal} and
 * {@link retireConflict}) before any is reopened, and one refusal leaves the
 * whole batch untouched.
 */
export function reopenProposals(
  stashDir: string,
  config: AkmConfig,
  ids: readonly string[],
  options: ReopenOptions = {},
  ctx?: ProposalsContext,
): Proposal[] {
  return withProposalsDb(ctx, (db) =>
    withImmediateTransaction(db, () => {
      const proposals = [...new Set(ids)].map((id) => requireProposal(db, stashDir, id));
      const held = new Map<string, string>();
      for (const pending of listStateProposals(db, { bundleId: stateBundleId(stashDir), status: "pending" })) {
        if (isRetireProposal(pending)) for (const ref of retireHeldRefs(pending)) held.set(ref, pending.id);
      }
      const refusals = proposals.flatMap((proposal) => {
        const refusal = reopenRefusal(config, proposal, options.queueTarget);
        const conflict = refusal === undefined ? retireConflict(proposal, held) : undefined;
        const reason = refusal ?? conflict;
        return reason === undefined
          ? []
          : [{ proposal: `${proposal.id} (${proposal.ref})`, reason, isConflict: conflict !== undefined }];
      });
      if (refusals.length > 0) {
        // A retire conflict is not about the target changing, so it gets its own hint.
        const hints = [
          ...(refusals.some((refusal) => !refusal.isConflict) ? [REOPEN_REFUSED_HINT] : []),
          ...(refusals.some((refusal) => refusal.isConflict) ? [REOPEN_RETIRE_CONFLICT_HINT] : []),
        ];
        throw new UsageError(
          proposals.length === 1
            ? `Proposal ${refusals[0]?.proposal} cannot be reopened: ${refusals[0]?.reason}`
            : `Cannot reopen ${refusals.length} of ${proposals.length} proposals; none were reopened:\n${refusals
                .map((refusal) => `  - ${refusal.proposal}: ${refusal.reason}`)
                .join("\n")}`,
          "INVALID_FLAG_VALUE",
          hints.join(" "),
        );
      }
      const decidedAt = nowIso(ctx);
      return proposals.map((existing) => {
        const reopened: Proposal = {
          ...existing,
          status: "pending",
          updatedAt: decidedAt,
          review: undefined,
          // A reopened proposal is adjudicated afresh: a `staged` verdict would
          // let the drain accept it unseen, and another gate's `auto-rejected`
          // would have the drain skip it. A `deferred` one is the quality
          // gate's hand-off to a person, which the drain must keep honouring
          // (drainProposals leaves it alone), so it stays.
          gateDecision: existing.gateDecision?.outcome === "deferred" ? existing.gateDecision : undefined,
          reviewHistory: [
            ...(existing.reviewHistory ?? []),
            {
              ...(existing.review !== undefined ? { review: existing.review } : {}),
              ...(existing.gateDecision !== undefined ? { gateDecision: existing.gateDecision } : {}),
              reopenedAt: decidedAt,
              ...(options.reason !== undefined ? { reopenReason: options.reason } : {}),
            },
          ],
        };
        upsertProposal(db, reopened, stateBundleId(stashDir));
        if (isRetireProposal(existing)) {
          // A retire mint writes no ledger row, so the one its rejection wrote goes.
          forgetImproveLedgerDecision(db, stateBundleId(stashDir), existing.id);
        } else {
          reopenImproveLedgerDecision(db, {
            proposalId: existing.id,
            bundleId: stateBundleId(stashDir),
            source: existing.source,
            at: decidedAt,
            detail: options.reason !== undefined ? `reopened: ${options.reason}` : "reopened",
          });
        }
        insertEventOnce(db, {
          eventType: "proposal_reopened",
          ts: decidedAt,
          ref: reopened.ref,
          metadata: {
            proposalId: reopened.id,
            source: reopened.source,
            ...(reopened.sourceRun !== undefined ? { sourceRun: reopened.sourceRun } : {}),
            ...(options.reason !== undefined ? { reason: options.reason } : {}),
          },
          idempotencyKey: `${reopened.id}:reopened:${decidedAt}`,
        });
        return reopened;
      });
    }),
  );
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
  return diffLoadedProposal(config, getProposal(stashDir, id, ctx), options);
}

/** {@link diffProposal} for a proposal the caller already read (the workspace reads state.db read-only). */
export function diffLoadedProposal(
  config: AkmConfig,
  proposal: Proposal,
  options: { target?: string; queueTarget?: ResolvedWriteTarget } = {},
): ProposalDiff {
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  const address = resolveAddressSafe(target.source, proposal.ref);
  const targetPath = address?.file;
  const existing = address?.exists ? (readAsset(target.source.name, address.conceptId)?.entry.content() ?? null) : null;
  if (isRetireProposal(proposal)) {
    // A retire proposal's primary change deletes its target rather than
    // writing content (proposalContent() has nothing to read for a delete):
    // accept archives the file, it never replaces it with a blank one, so the
    // diff shows the file leaving — not a "proposed" side (#997).
    return {
      existing,
      proposed: "",
      unified: formatRetireDiff(proposal.ref, existing, proposal.retirement?.successorRef),
      isNew: false,
      ...(targetPath ? { targetPath } : {}),
    };
  }
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

/**
 * A retire proposal's `beforeHash` is the raw-byte hash of its target. Proposals minted before that hashed the
 * UTF-8-decoded text (same value for valid UTF-8, lossy for anything else), so that form still counts.
 */
function matchesBeforeHash(proposal: Proposal, bytes: Buffer): boolean {
  return (
    proposal.beforeHash !== undefined &&
    (proposal.beforeHash === contentHash(bytes) || proposal.beforeHash === contentHash(bytes.toString("utf8")))
  );
}

/** The file a write to `ref` goes to in `source` (see {@link addressOf}), or undefined. */
function resolveAssetFilePathSafe(source: WriteTargetSource, ref: string): string | undefined {
  return resolveAddressSafe(source, ref)?.file;
}

function resolveAddressSafe(source: WriteTargetSource, ref: string): AssetAddress | undefined {
  try {
    return addressOf(source.name, ref);
  } catch {
    return undefined;
  }
}

/** The asset `ref` names in `source` now; undefined when none holds it, or the ref names none. */
function currentAsset(source: WriteTargetSource, ref: string): Asset | undefined {
  const address = resolveAddressSafe(source, ref);
  return address?.exists ? readAsset(source.name, address.conceptId) : undefined;
}

/** The retirements of `target`'s bundle, as its adapter lists them. */
function retirementsOf(target: ResolvedWriteTarget) {
  return writeAssets(target, { purpose: "proposal-accept" }, (w) => w.retired());
}
