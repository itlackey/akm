// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The consolidate pair pass (0.9.17-alpha.9 plan §5.2, brief §A): runs
 * alongside the promote pass inside `akmConsolidate`, over new and changed
 * memory-tier assets. Judges each near-duplicate/superseding pair with the
 * calibrated relation prompt and mints a reviewed `retire` proposal for the
 * `duplicate` / `subsumed` / `supersedes` classes — never merges, never
 * writes belief edges for `contradicts`, and is never auto-accepted by
 * triage (`drain.ts`).
 *
 * Calibration (owner grades, 2026-09-28; see the plan's "Human calibration,
 * O5" section): the combined retire class (duplicate ∪ subsumed ∪
 * supersedes) is 20/22 = 0.91 precision against the owner. `T_PAIR` is 0.93,
 * not the initial 0.90, because the 0.90–0.93 band alone graded 3/4 (R1).
 */

import fs from "node:fs";
import path from "node:path";
import consolidatePairPrompt from "../../../assets/prompts/consolidate-pair.md" with { type: "text" };
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { conceptIdFromTypeName } from "../../../core/asset/resolve-ref";
import { asNonEmptyString } from "../../../core/common";
import { concurrentMap } from "../../../core/concurrent";
import type { AkmConfig, LlmConnectionConfig } from "../../../core/config/config";
import type { ConsolidatePairJudgeLabel, ConsolidatePairPassResult } from "../../../core/improve-types";
import { parseEmbeddedJsonResponse } from "../../../core/parse";
import { DERIVED_SUFFIX } from "../../../core/recognition-util";
import { assertRunnerCredentials } from "../../../integrations/agent/runner-dispatch";
import type { ChatCompletionOptions, ChatMessage } from "../../../llm/client";
import type { Database } from "../../../storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../../../storage/repositories/index-connection";
import { getAllEntries, getEntryById } from "../../../storage/repositories/index-entries-repository";
import { getNeighborsByEntryId } from "../../../storage/repositories/index-vec-repository";
import type { RetirementMetadata, RetireReason } from "../../proposal/proposal-types";
import { createRetireProposal, listProposalsReadOnly } from "../../proposal/repository";
import { type AkmConsolidateOptions, isHotCapturedMemory } from "../consolidate";
import { contentHash, stripFrontmatterBody } from "../content-hash";
import { isLedgerBlocked, ledgerKey, loadLedgerSnapshot, recordLedgerAttempt, stripBundle } from "../ledger";
import { isInRetrievalScope, loadRetrievalScope } from "../retrieval-scope";
import { callStage, type LlmRunner } from "../stage";

/** Nearest neighbours considered per initiator (`getNeighborsByEntryId`'s `k`). */
export const PAIR_NEIGHBOR_K = 5;
/** Calibrated floor (R1): the 0.90–0.93 band alone graded 3/4 against the owner. */
export const T_PAIR = 0.93;
/** O2: the existing backlog (an initiator with no prior pair-pass attempt) goes >= 0.95 first. */
export const BACKFILL_FLOOR = 0.95;
/** Pairs judged per run, highest cosine first (plan §7's nightly cost budget). */
export const MAX_PAIRS_PER_RUN = 300;
/** Body characters sent to the judge per side (plan §4.3: bodies were truncated at this length for calibration). */
const PAIR_BODY_TRUNCATE_CHARS = 2500;
/** Ledger `source` for pair-pass attempts — distinguishable from the promote pass's own `consolidate` rows. */
export const PAIR_PASS_LEDGER_SOURCE = "consolidate-pair";

const RELATION_LABELS = ["duplicate", "subsumed", "supersedes", "contradicts", "overlap", "unrelated"] as const;

type RetireJudgeLabel = "duplicate" | "subsumed" | "supersedes";
const RETIRE_LABELS: ReadonlySet<string> = new Set<RetireJudgeLabel>(["duplicate", "subsumed", "supersedes"]);

/** The classes that mint a `retire` proposal (the calibrated combined retire class, 20/22 precision). */
function isRetireLabel(label: ConsolidatePairJudgeLabel): label is RetireJudgeLabel {
  return RETIRE_LABELS.has(label);
}

const PAIR_JUDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["relation", "redundant", "stale", "confidence", "reason"],
  additionalProperties: false,
  properties: {
    relation: { type: "string", enum: [...RELATION_LABELS] },
    redundant: { type: ["string", "null"], enum: ["A", "B", null] },
    stale: { type: ["string", "null"], enum: ["A", null] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", maxLength: 400 },
  },
};

interface RawPairJudgeResponse {
  relation?: unknown;
  redundant?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

export interface PairJudgeVerdict {
  relation: ConsolidatePairJudgeLabel;
  redundant: "A" | "B" | null;
  confidence: number;
  reason: string;
}

/** Hand-validates the judge's JSON, independent of whatever the provider's own schema enforcement did. */
export function parsePairJudgeResponse(raw: string): PairJudgeVerdict | undefined {
  const parsed = parseEmbeddedJsonResponse<RawPairJudgeResponse>(raw);
  if (!parsed) return undefined;
  if (typeof parsed.relation !== "string" || !(RELATION_LABELS as readonly string[]).includes(parsed.relation)) {
    return undefined;
  }
  const redundant = parsed.redundant;
  if (redundant !== "A" && redundant !== "B" && redundant !== null) return undefined;
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)) return undefined;
  const confidence = Math.max(0, Math.min(1, parsed.confidence));
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  return { relation: parsed.relation as ConsolidatePairJudgeLabel, redundant, confidence, reason };
}

/** A pair-pass asset: any type `getAllEntries` returns, not just memories. @internal exported for unit tests. */
export interface PairAsset {
  ref: string;
  type: string;
  name: string;
  filePath: string;
  entryId: number;
}

function isFlatName(name: string): boolean {
  return !name.includes("/");
}

/**
 * True only for a memory's own direct `.derived` child or parent — never a
 * sibling or an unrelated pair. @internal exported for unit tests.
 */
export function isOwnTwinOrParent(a: PairAsset, b: PairAsset): boolean {
  if (a.type !== "memory" || b.type !== "memory") return false;
  return a.name === `${b.name}${DERIVED_SUFFIX}` || b.name === `${a.name}${DERIVED_SUFFIX}`;
}

/**
 * Every asset eligible to be a pair-pass initiator or candidate: memory (any
 * depth), flat knowledge, or a lesson. @internal exported for unit tests.
 */
export function loadPairPassPool(db: Database, bundleId: string): PairAsset[] {
  const assets: PairAsset[] = [];
  for (const e of getAllEntries(db, "memory")) {
    if (e.bundleId !== bundleId || !fs.existsSync(e.filePath)) continue;
    assets.push({
      ref: conceptIdFromTypeName("memory", e.entry.name),
      type: "memory",
      name: e.entry.name,
      filePath: e.filePath,
      entryId: e.id,
    });
  }
  for (const e of getAllEntries(db, "knowledge")) {
    if (e.bundleId !== bundleId || !isFlatName(e.entry.name) || !fs.existsSync(e.filePath)) continue;
    assets.push({
      ref: conceptIdFromTypeName("knowledge", e.entry.name),
      type: "knowledge",
      name: e.entry.name,
      filePath: e.filePath,
      entryId: e.id,
    });
  }
  for (const e of getAllEntries(db, "lesson")) {
    if (e.bundleId !== bundleId || !fs.existsSync(e.filePath)) continue;
    assets.push({
      ref: conceptIdFromTypeName("lesson", e.entry.name),
      type: "lesson",
      name: e.entry.name,
      filePath: e.filePath,
      entryId: e.id,
    });
  }
  return assets;
}

export interface Initiator extends PairAsset {
  /** No prior `consolidate-pair` ledger attempt: the backlog, judged at `BACKFILL_FLOOR`. */
  backlog: boolean;
}

export interface PairCandidate {
  initiator: Initiator;
  other: PairAsset;
  cosine: number;
}

/** An unordered pair's dedup key, so a pair reachable from either side is judged once. */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join("\u0000");
}

/**
 * Initiators (plan §5.2 step 1): the pool, in the retrieval scope, changed
 * since their last pair-pass ledger attempt or never attempted.
 */
export function selectInitiators(
  pool: PairAsset[],
  opts: AkmConsolidateOptions,
  stashDir: string,
): { initiators: Initiator[] } {
  const retrievalScope = loadRetrievalScope({ proposalsCtx: opts.proposalsCtx }, stashDir);
  const ledger = loadLedgerSnapshot({ proposalsCtx: opts.proposalsCtx }, stashDir, [PAIR_PASS_LEDGER_SOURCE]);
  const nowIso = new Date().toISOString();
  const initiators: Initiator[] = [];
  for (const asset of pool) {
    if (!isInRetrievalScope(retrievalScope, asset.ref, asset.filePath)) continue;
    const row = ledger.get(ledgerKey(PAIR_PASS_LEDGER_SOURCE, asset.ref));
    let changedAt: string | undefined;
    try {
      changedAt = fs.statSync(asset.filePath).mtime.toISOString();
    } catch {
      changedAt = undefined;
    }
    if (row && isLedgerBlocked(row, nowIso, changedAt)) continue;
    initiators.push({ ...asset, backlog: row === undefined });
  }
  return { initiators };
}

/** Candidates (plan §5.2 step 2): each initiator's k nearest neighbours, filtered and thresholded. */
export function selectCandidates(db: Database, initiators: Initiator[], bundleId: string): PairCandidate[] {
  const candidates: PairCandidate[] = [];
  const seenPairs = new Set<string>();
  for (const initiator of initiators) {
    const floor = initiator.backlog ? Math.max(T_PAIR, BACKFILL_FLOOR) : T_PAIR;
    for (const hit of getNeighborsByEntryId(db, initiator.entryId, PAIR_NEIGHBOR_K)) {
      if (hit.id === initiator.entryId) continue;
      const entry = getEntryById(db, hit.id);
      if (!entry || entry.bundleId !== bundleId) continue;
      if (entry.entry.type !== "memory" && entry.entry.type !== "knowledge" && entry.entry.type !== "lesson") continue;
      if (entry.entry.type === "knowledge" && !isFlatName(entry.entry.name)) continue;
      if (!fs.existsSync(entry.filePath)) continue;
      const other: PairAsset = {
        ref: conceptIdFromTypeName(entry.entry.type, entry.entry.name),
        type: entry.entry.type,
        name: entry.entry.name,
        filePath: entry.filePath,
        entryId: hit.id,
      };
      if (other.ref === initiator.ref || isOwnTwinOrParent(initiator, other)) continue;
      // distance = sqrt(2 * (1 - cosine)) (index-vec-repository.ts) — invert it back to cosine.
      const cosine = 1 - (hit.distance * hit.distance) / 2;
      if (cosine < floor) continue;
      const key = pairKey(initiator.ref, other.ref);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      candidates.push({ initiator, other, cosine });
    }
  }
  candidates.sort((a, b) => b.cosine - a.cosine);
  return candidates.slice(0, MAX_PAIRS_PER_RUN);
}

/** @internal exported for unit tests. */
export interface PairSide {
  asset: PairAsset;
  frontmatter: Record<string, unknown>;
  raw: string;
  createdIso: string;
  updatedIso: string;
}

function mtimeIsoOf(filePath: string): string {
  try {
    return new Date(fs.statSync(filePath).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function loadSide(asset: PairAsset): PairSide | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(asset.filePath, "utf8");
  } catch {
    return undefined;
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(raw).data;
  } catch {
    frontmatter = {};
  }
  const mtime = mtimeIsoOf(asset.filePath);
  return {
    asset,
    frontmatter,
    raw,
    // Frontmatter date fields akm already records, else file mtime — never shells out to git per pair (the brief).
    createdIso: asNonEmptyString(frontmatter.createdAt) ?? asNonEmptyString(frontmatter.created) ?? mtime,
    updatedIso: asNonEmptyString(frontmatter.updated) ?? asNonEmptyString(frontmatter.updatedAt) ?? mtime,
  };
}

function sideSection(label: string, side: PairSide): string[] {
  return [
    `Asset ${label}:`,
    `Ref: ${side.asset.ref}`,
    `Type: ${side.asset.type}`,
    `Created: ${side.createdIso}`,
    `Updated: ${side.updatedIso}`,
    `Description: ${asNonEmptyString(side.frontmatter.description) ?? "(none)"}`,
    "Content:",
    "```",
    stripFrontmatterBody(side.raw).slice(0, PAIR_BODY_TRUNCATE_CHARS),
    "```",
    "",
  ];
}

/** Orders two loaded sides by date (older/newer) for the "A (older)"/"B (newer)" labelling the prompt requires. */
function orderByAge(x: PairSide, y: PairSide): { older: PairSide; newer: PairSide } {
  const xMs = Date.parse(x.createdIso);
  const yMs = Date.parse(y.createdIso);
  const xIsOlder = Number.isFinite(xMs) && Number.isFinite(yMs) ? xMs <= yMs : true;
  return xIsOlder ? { older: x, newer: y } : { older: y, newer: x };
}

/** The user message: dates decide "A (older)" / "B (newer)" (plan Appendix A), matching the calibration sample's own ordering. */
function buildPairUserPrompt(older: PairSide, newer: PairSide): string {
  return [...sideSection("A (older)", older), ...sideSection("B (newer)", newer)].join("\n");
}

/** The tombstone-vocabulary reason a judge label maps to (`supersedes` -> `superseded`; the rest unchanged). */
export function tombstoneReason(label: "duplicate" | "subsumed" | "supersedes"): Exclude<RetireReason, "promoted"> {
  return label === "supersedes" ? "superseded" : label;
}

export interface PairDecision {
  retired: PairSide;
  successor: PairSide;
}

/**
 * The calibrated outcome table (owner grades, replacing plan §5.2's
 * "shorter body" rule): `duplicate`/`supersedes` keep the newer copy;
 * `subsumed` keeps the side the judge did NOT name `redundant` (no proposal
 * if that pointer is missing or invalid).
 */
export function decideRetirement(
  label: ConsolidatePairJudgeLabel,
  redundant: "A" | "B" | null,
  older: PairSide,
  newer: PairSide,
): PairDecision | undefined {
  if (label === "duplicate" || label === "supersedes") return { retired: older, successor: newer };
  if (label === "subsumed") {
    if (redundant === "A") return { retired: older, successor: newer };
    if (redundant === "B") return { retired: newer, successor: older };
    return undefined; // the judge's pointer is missing or invalid — no proposal
  }
  return undefined;
}

/** Transport override for tests (matches `CallStructuredRequest["chat"]`); production callers leave it unset. */
export type PairJudgeChat = (
  connection: LlmConnectionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
) => Promise<string>;

interface PairPassContext {
  opts: AkmConsolidateOptions;
  config: AkmConfig;
  stashDir: string;
  llmRunner: LlmRunner;
  labelCounts: Record<ConsolidatePairJudgeLabel, number>;
  perInitiatorProposed: Set<string>;
  perInitiatorJudged: Set<string>;
  retired: string[];
  warnings: string[];
  chat?: PairJudgeChat;
}

/**
 * One pair: judge it, then (for a retire class) apply the guards and mint
 * the proposal. Never throws — a failure is counted in `failedJudgments` or
 * pushed to `warnings`, never lost silently and never aborting the run.
 */
async function judgeOne(ctx: PairPassContext, candidate: PairCandidate): Promise<{ failed: boolean }> {
  const initiatorSide = loadSide(candidate.initiator);
  const otherSide = loadSide(candidate.other);
  if (!initiatorSide || !otherSide) return { failed: false }; // unreadable since selection — skip, not a judge failure
  ctx.perInitiatorJudged.add(candidate.initiator.ref);
  const { older, newer } = orderByAge(initiatorSide, otherSide);

  const outcome = await callStage({
    feature: "memory_consolidation",
    runner: ctx.llmRunner,
    system: consolidatePairPrompt,
    prompt: buildPairUserPrompt(older, newer),
    gate: { config: ctx.config, enabled: true },
    request: {
      responseSchema: PAIR_JUDGE_JSON_SCHEMA,
      enableThinking: false,
      timeoutMs: ctx.llmRunner.timeoutMs,
      signal: ctx.opts.signal,
      ...(ctx.chat ? { chat: ctx.chat } : {}),
    },
    ...(ctx.opts.onNotices ? { onNotices: ctx.opts.onNotices } : {}),
  });
  if (!outcome.ok) return { failed: true };
  const verdict = parsePairJudgeResponse(outcome.raw);
  if (!verdict) return { failed: true };

  ctx.labelCounts[verdict.relation]++;
  if (verdict.relation === "contradicts") return { failed: false }; // counted; stays human — no proposal, no belief write
  if (!isRetireLabel(verdict.relation)) return { failed: false }; // overlap / unrelated: judged_no_action

  const decision = decideRetirement(verdict.relation, verdict.redundant, older, newer);
  if (!decision) return { failed: false };
  const { retired, successor } = decision;

  // Guards (plan §5.2 step 4 / brief §A "Guards").
  if (retired.asset.type === "memory" && isHotCapturedMemory(retired.asset.filePath)) {
    return { failed: false }; // never propose retiring a captureMode: hot memory — leave the pair alone
  }
  if (retired.asset.type === "memory" && retired.asset.name.endsWith(DERIVED_SUFFIX)) {
    const parentPath = path.join(
      path.dirname(retired.asset.filePath),
      `${retired.asset.name.slice(0, -DERIVED_SUFFIX.length)}.md`,
    );
    if (fs.existsSync(parentPath)) return { failed: false }; // never retire a .derived memory whose parent still exists
  }

  const reason = tombstoneReason(verdict.relation);
  const retirement: RetirementMetadata = {
    retiredRef: retired.asset.ref,
    successorRef: successor.asset.ref,
    cosine: candidate.cosine,
    judgeLabel: verdict.relation,
    judgeReason: verdict.reason,
    retiredContentHash: contentHash(retired.raw, "body"),
    successorContentHash: contentHash(successor.raw, "body"),
    reason,
  };
  if (ctx.opts.dryRun) {
    ctx.retired.push(`${retired.asset.ref} -> ${successor.asset.ref}`);
    ctx.perInitiatorProposed.add(candidate.initiator.ref);
    return { failed: false };
  }
  try {
    const proposal = createRetireProposal(
      ctx.stashDir,
      {
        ref: retired.asset.ref,
        source: "consolidate",
        sourceRun: ctx.opts.sourceRun,
        ...(ctx.opts.writeTarget
          ? { target: { source: ctx.opts.writeTarget.source.name, root: ctx.opts.writeTarget.source.path } }
          : {}),
        confidence: verdict.confidence,
        retirement,
      },
      ctx.opts.proposalsCtx,
    );
    ctx.retired.push(proposal.id);
    ctx.perInitiatorProposed.add(candidate.initiator.ref);
  } catch (error) {
    ctx.warnings.push(
      `Pair pass: could not mint a retire proposal for ${retired.asset.ref}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { failed: false };
}

const emptyLabelCounts = (): Record<ConsolidatePairJudgeLabel, number> => ({
  duplicate: 0,
  subsumed: 0,
  supersedes: 0,
  contradicts: 0,
  overlap: 0,
  unrelated: 0,
});

/**
 * The pair pass (alpha.9): initiators -> candidates -> one judge call per
 * pair -> retire proposals for the calibrated classes. Runs alongside the
 * promote pass, sharing its gate, its frozen LLM runner and its engine
 * concurrency. `bundleId` is the target bundle's id (`undefined` skips the
 * pass — nothing to scope candidates to).
 */
export async function runConsolidatePairPass(
  opts: AkmConsolidateOptions,
  config: AkmConfig,
  stashDir: string,
  bundleId: string | undefined,
  warnings: string[],
  /** Test seam: a transport override for the judge call. Production callers omit it. */
  seams: { chat?: PairJudgeChat } = {},
): Promise<ConsolidatePairPassResult> {
  const empty: ConsolidatePairPassResult = {
    initiators: 0,
    initiatorsBacklog: 0,
    pairsJudged: 0,
    labelCounts: emptyLabelCounts(),
    retired: [],
    contradictionsFound: 0,
    failedJudgments: 0,
  };
  const llmRunner = opts.llmRunner ?? undefined;
  if (!bundleId || !llmRunner) return empty;

  let initiators: Initiator[];
  let candidates: PairCandidate[];
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = opts.dryRun ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true }) : openExistingDatabase();
    if (!db) return empty;
    const pool = loadPairPassPool(db, bundleId);
    initiators = selectInitiators(pool, opts, stashDir).initiators;
    candidates = selectCandidates(db, initiators, bundleId);
  } catch (error) {
    warnings.push(
      `Pair pass: index unavailable — skipped (${error instanceof Error ? error.message : String(error)}).`,
    );
    return empty;
  } finally {
    if (db) closeDatabase(db);
  }
  const initiatorsBacklog = initiators.filter((i) => i.backlog).length;
  if (candidates.length === 0) {
    return { ...empty, initiators: initiators.length, initiatorsBacklog, pairsConsidered: 0 };
  }

  // Never judge a pair when either side already has a pending retire proposal.
  // Proposal refs are bundle-qualified ("stash//memories/x"); pair-pass asset
  // refs are not — compare on the stripped conceptId, as retrieval scope does.
  const pendingRetireRefs = new Set<string>();
  try {
    for (const p of listProposalsReadOnly(stashDir, { status: "pending" })) {
      if (p.source === "consolidate" && p.changes[0]?.op === "delete") pendingRetireRefs.add(stripBundle(p.ref));
    }
  } catch {
    // Best-effort de-dup only; a failed read never blocks judging.
  }
  const judgeable = candidates.filter(
    (c) => !pendingRetireRefs.has(stripBundle(c.initiator.ref)) && !pendingRetireRefs.has(stripBundle(c.other.ref)),
  );
  if (judgeable.length === 0) {
    return { ...empty, initiators: initiators.length, initiatorsBacklog, pairsConsidered: candidates.length };
  }
  // The promote pass validates opts.llmRunner's credentials once, but only
  // when it has memories to dispatch — the pair pass can still have work
  // when that pool is empty, so it validates independently before its first
  // real dispatch. A test-injected chat seam bypasses the transport entirely
  // and needs no credential.
  if (!seams.chat) assertRunnerCredentials(llmRunner);

  const ctx: PairPassContext = {
    opts,
    config,
    stashDir,
    llmRunner,
    labelCounts: emptyLabelCounts(),
    perInitiatorProposed: new Set(),
    perInitiatorJudged: new Set(),
    retired: [],
    warnings,
    ...(seams.chat ? { chat: seams.chat } : {}),
  };
  const results = await concurrentMap(
    judgeable,
    (candidate) => judgeOne(ctx, candidate),
    llmRunner.connection.concurrency ?? 1,
    { signal: opts.signal },
  );
  const failedJudgments = results.filter((r) => r?.failed === true).length;

  if (!opts.dryRun) {
    const ledgerInputs = [...ctx.perInitiatorJudged].map((ref) => ({
      stashDir,
      ref,
      source: PAIR_PASS_LEDGER_SOURCE,
      outcome: ctx.perInitiatorProposed.has(ref) ? ("proposed" as const) : ("judged_no_action_stable" as const),
    }));
    recordLedgerAttempt({ proposalsCtx: opts.proposalsCtx }, ledgerInputs);
  }

  return {
    initiators: initiators.length,
    initiatorsBacklog,
    pairsConsidered: candidates.length,
    pairsJudged: judgeable.length,
    labelCounts: ctx.labelCounts,
    retired: ctx.retired,
    contradictionsFound: ctx.labelCounts.contradicts,
    failedJudgments,
  };
}
