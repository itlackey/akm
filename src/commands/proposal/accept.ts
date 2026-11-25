// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { stashDirFor } from "../../core/asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { assembleAsset, serializeFrontmatter } from "../../core/asset/asset-serialize";
import {
  carryForwardBookkeepingFrontmatter,
  parseFrontmatter,
  replaceFrontmatterBlocks,
} from "../../core/asset/frontmatter";
import { stalePathRoots } from "../../core/asset/stale-path";
import { indexFiles } from "../../core/assets/files";
import { assertAdapterWrites } from "../../core/assets/gate";
import { type Asset, readAsset } from "../../core/assets/read";
import { type AssetAddress, addressOf, writeAssets } from "../../core/assets/write";
import { stateBundleId } from "../../core/bundle-at-dir";
import { toErrorMessage } from "../../core/common";
import { type AkmConfig, loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import type { MemoryPruneCandidate } from "../../core/improve-types";
import { runBaseChecks } from "../../core/lint/base-linter";
import type { LintIssue, LintIssueType } from "../../core/lint/types";
import { canonicalBundleIdForTarget, resolveBundleWriteTarget } from "../../core/mutation-target";
import { warn } from "../../core/warn";
import { beginWriteProvenance } from "../../core/write-provenance";
import {
  type CommitOutcome,
  commitAcceptedPaths,
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWriteTarget,
  type WriteTargetSource,
} from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { sameScope, scopeFromFrontmatter } from "../../indexer/passes/metadata";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { upsertProposal } from "../../storage/repositories/proposals-repository";
import { schedulerEnabledRefs, setSchedulerRefEnabled } from "../../tasks/activation-config";
import { withSchedulerLock } from "../../tasks/scheduler-lock";
import { pkgVersion } from "../../version";
import { contentHash } from "../improve/content-hash";
import { writeSupersededEdge } from "../improve/memory/memory-belief";
import { derivedTwinOf, retireCleanupCandidate } from "../improve/memory/memory-improve";
import { akmTasksDisable, akmTasksEnable, inspectTaskSchedulerBindings } from "../tasks/tasks";
import { formatNewAssetDiff, formatRetireDiff, formatUnifiedDiff } from "./diff-format";
import {
  isAutomatedProposalSource,
  isRetireProposal,
  type Proposal,
  type ProposalDecider,
  proposalContent,
  type RetireAcceptIntent,
  type RetirementMetadata,
} from "./proposal-types";
import {
  assertPending,
  type GateDecisionInput,
  getProposal,
  nowIso,
  type ProposalsContext,
  persistProposalDecision,
  proposalRefIdentity,
  recordDecidedProposal,
  requireProposal,
  withProposalContent,
  withProposalTx,
} from "./repository";
import { repairProposalContent, validateProposal } from "./validators/proposals";

const scopeOf = (content: string) => scopeFromFrontmatter(parseFrontmatter(content).data);

const PROMOTION_LINT_ISSUE_TYPES = new Set<LintIssueType>(["unquoted-colon", "missing-ref", "stale-path"]);

/** Index the files just written or moved; the next `akm index` catches up when this cannot. */
export async function indexWrittenProposalAssets(target: ResolvedWriteTarget, assetPaths: string[]): Promise<void> {
  const label = assetPaths.join(", ");
  try {
    if (!(await indexFiles(target.source, assetPaths))) {
      warn(`[proposals] ${label} was written but not indexed; run \`akm index\`.`);
    }
  } catch (error) {
    warn(`[proposals] ${label} was written but not indexed (${toErrorMessage(error)}); run \`akm index\`.`);
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

export function resolveRecordedProposalTarget(
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

export function resolveProposalWriteTarget(
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
  options: AcceptOptions = {},
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
  const ref = addressOf(target.source, prepared.ref);
  if (!ref.exists && ref.file === undefined && stashDirFor(ref.type) === undefined) {
    throw new UsageError(`Proposal ${proposal.id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }
  assertAdapterWrites(target.source, ref.type);
  const assetPath = ref.file;
  if (!assetPath) {
    throw new UsageError(`Proposal ${proposal.id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }
  const markdown = assetPath.toLowerCase().endsWith(".md");
  let stampedContent = markdown
    ? stampProposalProvenance(repairedContent, prepared, options.gateDecision, ctx, nowIso(ctx))
    : repairedContent;
  const live = markdown && ref.exists ? readAsset(target.source, ref.conceptId) : undefined;
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
    if (source && !sameScope(scopeOf(source.entry.content()), scopeOf(stampedContent))) {
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
  bundle: WriteTargetSource,
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
export function acceptedAsset(proposal: Proposal, target: ResolvedWriteTarget): { ref: string; assetPath: string } {
  const accepted = proposal.acceptedTarget;
  if (accepted?.bundle !== target.source.name) {
    throw new UsageError(`proposal ${proposal.id} is bound to a different accepted target`, "INVALID_FLAG_VALUE");
  }
  return { ref: accepted.ref, assetPath: resolveAddressSafe(target.source, accepted.ref)?.file ?? accepted.ref };
}

export function requireAcceptedTarget(proposal: Proposal): NonNullable<Proposal["acceptedTarget"]> {
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

export interface AcceptOptions {
  target?: string;
  queueTarget?: ResolvedWriteTarget;
  eventMetadata?: Record<string, unknown>;
  gateDecision?: GateDecisionInput;
  decidedBy?: ProposalDecider;
  /** Defer the commit to the caller (see {@link AcceptCommitCollector}). */
  commitCollector?: AcceptCommitCollector;
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
    const sourceRef = addressOf(mutationTarget.source, accepted.promotionSource);
    const source = sourceRef.exists ? readAsset(mutationTarget.source, sourceRef.conceptId) : undefined;
    if (!source) return;
    if (!accepted.promotionSourceHash) {
      warn(
        `[proposal] O1: ${accepted.id} has no recorded source hash (minted by an older release) — leaving its source ${accepted.promotionSource} unarchived.`,
      );
      return;
    }
    const sourceContent = source.entry.content();
    if (!sameScope(scopeOf(sourceContent), scopeOf(proposalContent(accepted)))) {
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
      if (twin && sameScope(scopeOf(twin.entry.content()), scopeOf(sourceContent))) {
        retireCleanupCandidate(w, twin.conceptId, candidate);
      }
    });
  } catch (error) {
    warn(
      `[proposal] O1: failed to retire promotion source ${accepted.promotionSource} for ${accepted.id}: ${toErrorMessage(error)}`,
    );
  } finally {
    paths.push(...journal.end());
  }
}

async function promoteProposalWithLease(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: AcceptOptions,
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const proposal = getProposal(stashDir, id, ctx);
  if (isRetireProposal(proposal)) return retireProposalWithLease(stashDir, config, proposal, options, ctx);
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  if (proposal.status === "accepted") {
    // Accepting again is a no-op, provided the published bytes are still there.
    const recorded = requireAcceptedTarget(proposal);
    const { assetPath } = acceptedAsset(proposal, target);
    const current = readAsset(target.source, parseBundleRef(recorded.ref).conceptId);
    if (!current || contentHash(current.entry.bytes()) !== recorded.contentHash) {
      throw new UsageError(`Accepted proposal ${id} does not match the current asset content.`, "INVALID_FLAG_VALUE");
    }
    return { proposal, assetPath, ref: proposal.ref };
  }
  assertPending(proposal, "accepted");
  const preflight = preflightProposalPromotion(config, proposal, { ...options, queueTarget: target }, ctx);
  const mutationTarget = prepareWriteTargetForMutation(target);
  const address = resolveAddressSafe(mutationTarget.source, proposal.ref);
  const plannedPath = address?.file;
  if (!address || !plannedPath)
    throw new UsageError(`Cannot resolve proposal target ${proposal.ref}.`, "INVALID_PROPOSAL");
  const backup = readFreshProposalTarget(proposal, mutationTarget.source, address, preflight.stampedContent);
  assertAdapterWrites(mutationTarget.source, address.type);
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
  return withProposalTx(ctx, (db) => {
    const current = requireProposal(db, stashDir, proposalId);
    if (current.retireAcceptIntent) return current;
    const next: Proposal = { ...current, retireAcceptIntent: intent };
    upsertProposal(db, next, stateBundleId(stashDir));
    return next;
  });
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
  return withProposalTx(ctx, (db) => {
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
    return recordDecidedProposal(db, stashDir, next, "accept", info.assetPath, decidedAt, {
      retired: true,
      ...info.eventMetadata,
    });
  });
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
export function assertRetirementStillFresh(
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
    !sameScope(scopeOf(retiredCurrentBytes.toString("utf8")), judgedScope) ||
    (successorBytes && !sameScope(scopeOf(successorBytes.toString("utf8")), judgedScope))
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
  options: AcceptOptions,
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const target = resolveProposalWriteTarget(config, proposal, options.target, options.queueTarget);
  if (proposal.status === "accepted") {
    // Accepting again is a no-op, provided the target is still gone (retired) and its archive is still there.
    requireAcceptedTarget(proposal);
    const accepted = acceptedAsset(proposal, target);
    const archive = proposal.retiredArchive;
    const held = new Set(
      writeAssets(target, { purpose: "proposal-accept" }, (w) => w.retired()).map((retirement) => retirement.handle),
    );
    const archivedStill = archive?.retired.every(({ handle }) => held.has(handle)) === true;
    if (readAsset(target.source, parseBundleRef(accepted.ref).conceptId) || !archivedStill) {
      throw new UsageError(
        `Accepted retire proposal ${proposal.id} no longer matches its archive.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { proposal, assetPath: accepted.assetPath, ref: proposal.ref };
  }
  assertPending(proposal, "accepted");
  const ref = resolveAddressSafe(target.source, proposal.ref);
  const assetPath = ref?.file;
  if (!ref || !assetPath) throw new UsageError(`Cannot resolve proposal target ${proposal.ref}.`, "INVALID_PROPOSAL");

  let working = proposal;
  let intent = proposal.retireAcceptIntent;
  let scheduler: Awaited<ReturnType<typeof disableRetiredTask>>;
  if (!intent) {
    // Fresh accept — no recorded intent yet, so the target must still be there.
    const current = readAsset(target.source, ref.conceptId);
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
    assertAdapterWrites(target.source, ref.type);
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
          `[proposal] failed to write the supersede edge for ${proposal.id} (continuing with the retire): ${toErrorMessage(error)}`,
        );
      }
    }
  } else {
    assertAdapterWrites(target.source, ref.type);
    assertRetiringTaskUnchanged(target.source, ref, intent, proposal);
    // Revalidate the survivor even after a partial archive. The recorded original
    // is the judged retired side when its file has already moved.
    if (working.retirement) {
      assertRetirementStillFresh(
        proposal.id,
        proposal.ref,
        working.retirement,
        target.source,
        readAsset(target.source, ref.conceptId)?.entry.bytes() ?? Buffer.from(intent.backupContent),
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
    assertRetiringTaskUnchanged(target.source, ref, intent, proposal);

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
          if (twin && sameScope(scopeOf(twin.entry.content()), scopeOf(backupContent))) retire(twin.conceptId);
        } catch (error) {
          for (const { ref: madeRef, handle } of made.reverse()) {
            // A failed undo must not hide the failure that caused it; the retirement stays to explain the asset.
            try {
              w.restore(handle);
              w.forget(handle);
            } catch (undoError) {
              warn(
                `[retire] could not put ${resolveAddressSafe(mutationTarget.source, madeRef)?.file ?? madeRef} back from ${handle}: ${toErrorMessage(undoError)}`,
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
  bundle: WriteTargetSource,
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
        `[retire] could not re-enable ${qualifiedRef} after its retirement was refused: ${toErrorMessage(error)}. Run akm task enable ${qualifiedRef}.`,
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
  const existing = address?.exists ? (readAsset(target.source, address.conceptId)?.entry.content() ?? null) : null;
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
export function matchesBeforeHash(proposal: Proposal, bytes: Buffer): boolean {
  return (
    proposal.beforeHash !== undefined &&
    (proposal.beforeHash === contentHash(bytes) || proposal.beforeHash === contentHash(bytes.toString("utf8")))
  );
}

export function resolveAddressSafe(source: WriteTargetSource, ref: string): AssetAddress | undefined {
  try {
    return addressOf(source, ref);
  } catch {
    return undefined;
  }
}

/** The asset `ref` names in `source` now; undefined when none holds it, or the ref names none. */
function currentAsset(source: WriteTargetSource, ref: string): Asset | undefined {
  const address = resolveAddressSafe(source, ref);
  return address?.exists ? readAsset(source, address.conceptId) : undefined;
}
