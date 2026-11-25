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
import path from "node:path";
import { ensureAkmMarkdownType } from "../../core/asset/akm-markdown";
import { placementTypes, stashDirFor } from "../../core/asset/asset-placement";
import { isBundleSlug, makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, parsePlacementRef } from "../../core/asset/resolve-ref";
import { currentConceptId, qualifyRef, readAsset } from "../../core/assets/read";
import { type AssetAddress, addressOf } from "../../core/assets/write";
import { materialiseBundleDir, stateBundleId } from "../../core/bundle-at-dir";
import { bundleIdForDir } from "../../core/bundle-id";
import { toErrorMessage } from "../../core/common";
import { type AkmConfig, loadConfig } from "../../core/config/config";
import { bundleAtDir } from "../../core/config/config-sources";
import { ConfigError, NotFoundError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveBundleWriteTarget } from "../../core/mutation-target";
import { getStateDbPath, openStateReadSnapshot, withImmediateTransaction, withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import type { ResolvedWriteTarget } from "../../core/write-source";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { sha256Hex } from "../../runtime";
import type { Database } from "../../storage/database";
import { insertEventOnce } from "../../storage/repositories/events-repository";
import {
  CONSOLIDATE_LEDGER_SOURCE,
  type ImproveLedgerOutcome,
  PAIR_PASS_LEDGER_SOURCE,
  recordImproveLedger,
  recordImproveLedgerDecision,
} from "../../storage/repositories/improve-ledger-repository";
import {
  getStateProposal,
  isLegacyProposalRef,
  listStateProposalIdsByPrefix,
  listStateProposals,
  upsertProposal,
} from "../../storage/repositories/proposals-repository";
import { contentHash } from "../improve/content-hash";
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
  type RetirementMetadata,
  STALE_TARGET_GATE_REASON,
} from "./proposal-types";
import {
  canonicalOnlyProposalValidators,
  hasCanonicalProposalValidator,
  runProposalValidators,
} from "./validators/proposal-validators";

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

const MS_PER_DAY = 86_400_000;

export type GateDecisionInput = Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string };

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
export function withProposalContent(p: Proposal, content: string): Proposal {
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

export function nowIso(ctx?: ProposalsContext): string {
  return new Date((ctx?.now ?? Date.now)()).toISOString();
}

export function withProposalsDb<T>(ctx: ProposalsContext | undefined, fn: (db: Database) => T): T {
  return withStateDb(fn, { path: ctx?.dbPath });
}

/** A confidence in [0, 1]; anything else is dropped. */
function unitConfidence(value: number | undefined): number | undefined {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;
}

/** {@link withProposalsDb} in one immediate transaction. */
export function withProposalTx<T>(ctx: ProposalsContext | undefined, fn: (db: Database) => T): T {
  return withProposalsDb(ctx, (db) => withImmediateTransaction(db, () => fn(db)));
}

interface ProposalRefIdentity {
  conceptId: string;
  bundle?: string;
}

export function proposalRefIdentity(ref: string): ProposalRefIdentity | undefined {
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
  const invalidRef = (err: unknown) =>
    rejectProposal("invalid_ref", `Invalid proposal ref "${input.ref}": ${toErrorMessage(err)}`);
  try {
    origin = parseBundleRef(input.ref).bundle;
  } catch (err) {
    return invalidRef(err);
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
    return invalidRef(err);
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

  const confidence = unitConfidence(input.confidence);
  return withProposalTx(ctx, (db) => {
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
  });
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
    new UsageError(`Invalid retire proposal ref "${input.ref}": ${toErrorMessage(err)}`, "INVALID_PROPOSAL");
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
  const confidence = unitConfidence(input.confidence);
  return withProposalTx(ctx, (db) => {
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
  });
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

/** Throws unless `proposal` is pending: only a pending proposal can be `verb`. */
export function assertPending({ id, status }: Proposal, verb: string): void {
  if (status !== "pending") {
    throw new UsageError(
      `Proposal ${id} is not pending (current status: ${status}). Only pending proposals can be ${verb}.`,
      "PROPOSAL_NOT_PENDING",
    );
  }
}

/** A proposal by id, live or archived. */
export function getProposal(stashDir: string, id: string, ctx?: ProposalsContext): Proposal {
  return withProposalsDb(ctx, (db) => requireProposal(db, stashDir, id));
}

export function requireProposal(db: Database, stashDir: string, id: string): Proposal {
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
  return withProposalTx(ctx, (db) => {
    const existing = requireProposal(db, stashDir, id);
    assertPending(existing, status);
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
  });
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
  return withProposalTx(ctx, (db) => {
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
  });
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
      warn(`[proposals] purgeOrphanProposals: failed to reject ${p.id}: ${toErrorMessage(err)}`);
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
      warn(`[proposals] expireStaleProposals: failed to expire ${p.id}: ${toErrorMessage(err)}`);
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
export function persistProposalDecision(
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
  return withProposalTx(ctx, (db) => {
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
    return recordDecidedProposal(
      db,
      stashDir,
      next,
      decision.operation,
      decision.assetPath,
      decision.decidedAt,
      decision.operation === "accept" ? decision.eventMetadata : undefined,
    );
  });
}

/** Write `next` with its ledger decision and event: the rows an accept or revert leaves behind. */
export function recordDecidedProposal(
  db: Database,
  stashDir: string,
  next: Proposal,
  operation: "accept" | "revert",
  assetPath: string,
  decidedAt: string,
  eventMetadata?: Record<string, unknown>,
): Proposal {
  const accept = operation === "accept";
  upsertProposal(db, next, stateBundleId(stashDir));
  recordImproveLedgerDecision(db, {
    proposalId: next.id,
    bundleId: stateBundleId(stashDir),
    ...decisionLedgerSubject(next),
    source: next.source,
    outcome: ledgerOutcomeForDecision(accept ? "accepted" : "reverted"),
    at: decidedAt,
    ...(accept ? {} : { detail: "reverted" }),
  });
  insertEventOnce(db, {
    eventType: accept ? "promoted" : "proposal_reverted",
    ts: decidedAt,
    ref: next.ref,
    metadata: {
      proposalId: next.id,
      source: next.source,
      ...(next.sourceRun !== undefined ? { sourceRun: next.sourceRun } : {}),
      assetPath,
      ...(next.eligibilitySource !== undefined ? { eligibilitySource: next.eligibilitySource } : {}),
      ...eventMetadata,
    },
    idempotencyKey: `${next.id}:${accept ? "promoted" : "reverted"}`,
  });
  return next;
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
  withProposalTx(ctx, (db) => {
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
  });
  return rejected;
}

/** The assets a retire proposal speaks for — the one it retires and its successor — as bundle-less concept ids, the way the pair pass keys them. */
export function retireHeldRefs(proposal: Proposal): string[] {
  return [proposal.ref, proposal.retirement?.successorRef].flatMap((ref) => {
    const conceptId = ref === undefined ? undefined : proposalRefIdentity(ref)?.conceptId;
    return conceptId === undefined ? [] : [conceptId];
  });
}
