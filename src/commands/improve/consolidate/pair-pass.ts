// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The consolidate pair pass (0.9.17-alpha.9 plan §5.2, brief §A): runs
 * alongside the existing promote pass inside `akmConsolidate`, over new and
 * changed memory-tier assets. Judges each near-duplicate/superseding pair
 * with the calibrated relation prompt and mints a reviewed `retire` proposal
 * for the `duplicate` / `subsumed` / `supersedes` classes — never merges,
 * never writes belief edges for `contradicts`, and is never auto-accepted by
 * triage (`drain.ts`).
 *
 * Calibration (owner grades, 2026-09-28; see the plan's "Human calibration,
 * O5" section): the combined retire class (duplicate ∪ subsumed ∪
 * supersedes) is 20/22 = 0.91 precision against the owner. `T_PAIR` is 0.93,
 * not the initial 0.90, because the 0.90–0.93 band alone graded 3/4 (R1).
 *
 * Initiator eligibility and dating (post-review, alpha.9): "created" is the
 * asset's git first-add time (one `git log` per run, {@link loadGitFirstAddedMap}),
 * not frontmatter or mtime — mtime is only the fallback for a file git does
 * not know. An initiator is eligible when it has no prior `consolidate-pair`
 * ledger row, or its current body hash differs from the row's recorded one;
 * that row is written only once ALL of the initiator's own candidates were
 * judged this run (a run capped mid-way through its candidates leaves it
 * without a row, so the next run picks it back up) — see
 * {@link selectInitiators} and the ledger-write step in
 * {@link runConsolidatePairPass}.
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
import { runGit } from "../../../sources/providers/git-install";
import type { Database } from "../../../storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../../../storage/repositories/index-connection";
import { getAllEntries, getEntryById } from "../../../storage/repositories/index-entries-repository";
import { getNeighborsByEntryId } from "../../../storage/repositories/index-vec-repository";
import { isRetireProposal, type RetirementMetadata, type RetireReason } from "../../proposal/proposal-types";
import { createRetireProposal, listProposalsReadOnly } from "../../proposal/repository";
import { type AkmConsolidateOptions, isHotCapturedMemory } from "../consolidate";
import { contentHash, stripFrontmatterBody } from "../content-hash";
import { loadLedgerSnapshot, PAIR_PASS_LEDGER_SOURCE, recordLedgerAttempt, stripBundle } from "../ledger";
import { isInRetrievalScope, loadRetrievalScope } from "../retrieval-scope";
import { callStage, type LlmRunner } from "../stage";

export { PAIR_PASS_LEDGER_SOURCE };

/** Neighbours fetched per initiator before filtering (S2: wide enough that self/twin/bundle/tier misses rarely starve the kept 5 below). */
export const PAIR_NEIGHBOR_FETCH_K = 20;
/** Passing candidates kept per initiator, nearest-cosine-first. */
export const PAIR_NEIGHBOR_K = 5;
/** Calibrated floor (R1): the 0.90–0.93 band alone graded 3/4 against the owner. */
export const T_PAIR = 0.93;
/** O2: the existing backlog (an initiator with no prior pair-pass attempt) goes >= 0.95 first. */
export const BACKFILL_FLOOR = 0.95;
/**
 * An initiator git first-added within this many days judges at `T_PAIR` even
 * with no prior ledger row: new material earns the same scrutiny as an edit,
 * not the higher bar reserved for working through the pre-existing backlog.
 */
export const NEW_MATERIAL_DAYS = 7;
/** Pairs judged per run, highest cosine first (plan §7's nightly cost budget). */
export const MAX_PAIRS_PER_RUN = 300;
/** Body characters sent to the judge per side (plan §4.3: bodies were truncated at this length for calibration). */
const PAIR_BODY_TRUNCATE_CHARS = 2500;
const MS_PER_DAY = 86_400_000;

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

// ── B1: created/updated dates from git, not frontmatter/mtime ──────────────

/** A path relative to `stashDir`, POSIX-separated — how `git log --name-only` spells it. */
function repoRelativeKey(stashDir: string, filePath: string): string {
  return path.relative(stashDir, filePath).replace(/\\/g, "/");
}

/**
 * Every tracked path's first-add time (unix ms), from one `git log` over the
 * whole bundle (~1.8s measured against the owner's real bundle) — never
 * shelled out per pair or per initiator. `undefined` when `stashDir` is not
 * itself a git root (no `.git` directly inside it): every asset then falls
 * back to mtime in {@link createdMsOf}, one fallback code path instead of a
 * second git-aware one for a bundle nested inside a larger repo.
 */
export function loadGitFirstAddedMap(stashDir: string): ReadonlyMap<string, number> | undefined {
  if (!fs.existsSync(path.join(stashDir, ".git"))) return undefined;
  let result: ReturnType<typeof runGit>;
  try {
    result = runGit(["log", "--diff-filter=A", "--no-renames", "--name-only", "--format=@%ct"], {
      cwd: stashDir,
      // spawnSync's default maxBuffer (1 MB) is too small for a bundle with
      // real history — the owner's real bundle alone prints ~1.8 MB here
      // (migration-tool.ts's own git subprocess call uses the same 16 MB
      // figure). Silently exceeding it looks identical to "git failed" from
      // the caller's side (status stays non-zero), so every date would have
      // quietly fallen back to mtime with no error at all.
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const map = new Map<string, number>();
  let currentMs: number | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("@")) {
      const sec = Number(line.slice(1));
      currentMs = Number.isFinite(sec) ? sec * 1000 : undefined;
      continue;
    }
    const rel = line.trim();
    if (!rel || currentMs === undefined) continue;
    // `git log` lists newest-first; overwriting on every occurrence keeps
    // whichever commit is processed LAST for this path — the oldest one,
    // i.e. the true first add (also correct for a delete + re-add).
    map.set(rel, currentMs);
  }
  return map;
}

/** Created instant (ms): git first-add when known, else file mtime (B1) — the one fallback both dating and the S1 new-material check use. */
function createdMsOf(
  asset: PairAsset,
  gitFirstAdded: ReadonlyMap<string, number> | undefined,
  stashDir: string,
): number {
  const known = gitFirstAdded?.get(repoRelativeKey(stashDir, asset.filePath));
  if (known !== undefined) return known;
  try {
    return fs.statSync(asset.filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export interface Initiator extends PairAsset {
  /** No prior `consolidate-pair` ledger row: judged at `BACKFILL_FLOOR` unless `newMaterial`. */
  backlog: boolean;
  /** Git first-added (or, git-unknown, mtime-dated) within `NEW_MATERIAL_DAYS` (S1). */
  newMaterial: boolean;
  /** This run's own read of the asset's current body hash — the ledger-write step reuses it, never re-reading the file. */
  bodyHash: string;
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
 * Initiators (plan §5.2 step 1, S1 post-review): the pool, in the retrieval
 * scope, and content-eligible — no prior `consolidate-pair` ledger row, or a
 * row whose recorded body hash differs from the asset's current one. A row's
 * `next_eligible_at` is never consulted (the pair pass's own source carries
 * no timer at all — see `windowDays` in improve-ledger-repository.ts):
 * eligibility here is purely a function of content, matching the brief's "no
 * row, or changed" rule and the ledger-write step this run finishes with.
 */
export function selectInitiators(
  pool: PairAsset[],
  opts: AkmConsolidateOptions,
  stashDir: string,
  gitFirstAdded: ReadonlyMap<string, number> | undefined,
): { initiators: Initiator[] } {
  const retrievalScope = loadRetrievalScope({ proposalsCtx: opts.proposalsCtx }, stashDir);
  const ledger = loadLedgerSnapshot({ proposalsCtx: opts.proposalsCtx }, stashDir, [PAIR_PASS_LEDGER_SOURCE]);
  const nowMs = (opts.proposalsCtx?.now ?? Date.now)();
  const initiators: Initiator[] = [];
  for (const asset of pool) {
    if (!isInRetrievalScope(retrievalScope, asset.ref, asset.filePath)) continue;
    const row = ledger.get(`${PAIR_PASS_LEDGER_SOURCE}\0${asset.ref}`);
    let raw: string;
    try {
      raw = fs.readFileSync(asset.filePath, "utf8");
    } catch {
      continue; // unreadable: selectCandidates/judgeOne would skip it anyway
    }
    const bodyHash = contentHash(raw, "body");
    if (row && row.contentHash === bodyHash) continue; // unchanged since the last full attempt: not eligible
    const createdMs = createdMsOf(asset, gitFirstAdded, stashDir);
    const newMaterial = nowMs - createdMs <= NEW_MATERIAL_DAYS * MS_PER_DAY;
    initiators.push({ ...asset, backlog: row === undefined, newMaterial, bodyHash });
  }
  return { initiators };
}

/**
 * Candidates (plan §5.2 step 2, S1/S2 post-review): each initiator's nearest
 * neighbours, filtered and thresholded — the FULL set, sorted by cosine
 * descending, uncapped. `runConsolidatePairPass` applies `MAX_PAIRS_PER_RUN`
 * (needing the uncapped per-initiator totals to tell a cap-cut initiator
 * apart from a fully-judged one). S2: fetches `PAIR_NEIGHBOR_FETCH_K` (20)
 * raw neighbours and keeps the first `PAIR_NEIGHBOR_K` (5) that clear every
 * filter, so a few self/twin/bundle/tier misses in the raw top-5 no longer
 * starve an initiator down to zero real candidates.
 */
export function selectCandidates(db: Database, initiators: Initiator[], bundleId: string): PairCandidate[] {
  const candidates: PairCandidate[] = [];
  const seenPairs = new Set<string>();
  for (const initiator of initiators) {
    // S1: a changed-content or new-material initiator judges at T_PAIR; the
    // rest of the backlog (no row, not recently git-added) needs the higher
    // BACKFILL_FLOOR.
    const floor = initiator.backlog && !initiator.newMaterial ? BACKFILL_FLOOR : T_PAIR;
    let kept = 0;
    for (const hit of getNeighborsByEntryId(db, initiator.entryId, PAIR_NEIGHBOR_FETCH_K)) {
      if (kept >= PAIR_NEIGHBOR_K) break;
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
      kept++;
    }
  }
  candidates.sort((a, b) => b.cosine - a.cosine);
  return candidates;
}

/** @internal exported for unit tests. */
export interface PairSide {
  asset: PairAsset;
  frontmatter: Record<string, unknown>;
  raw: string;
  createdIso: string;
  updatedIso: string;
}

function loadSide(
  asset: PairAsset,
  gitFirstAdded: ReadonlyMap<string, number> | undefined,
  stashDir: string,
): PairSide | undefined {
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
  // B1: created is the git first-add time (mtime only when git does not know
  // the file, or the bundle has none) — frontmatter createdAt/created is not
  // consulted; too few real assets carry it to be a reliable ordering.
  // Updated stays frontmatter `updated` when present, else falls back to created.
  const createdIso = new Date(createdMsOf(asset, gitFirstAdded, stashDir)).toISOString();
  return {
    asset,
    frontmatter,
    raw,
    createdIso,
    updatedIso: asNonEmptyString(frontmatter.updated) ?? createdIso,
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
  gitFirstAdded: ReadonlyMap<string, number> | undefined;
  labelCounts: Record<ConsolidatePairJudgeLabel, number>;
  perInitiatorProposed: Set<string>;
  retired: string[];
  warnings: string[];
  chat?: PairJudgeChat;
  /**
   * ConceptIds (stripped of bundle) already given a retire decision earlier
   * in THIS run — by an earlier pair, not a prior run (`pendingRetireRefs`
   * covers that) — as EITHER the retired side or the successor (B2's
   * same-run chain guard: a just-used successor cannot itself be retired
   * later in this run, and an already-retired asset cannot be re-used as a
   * successor). Checked and updated synchronously (no `await` in between),
   * so it is race-safe under `concurrentMap`.
   */
  retiredThisRun: Set<string>;
}

/**
 * One pair: judge it, then (for a retire class) apply the guards and mint
 * the proposal. Never throws — a failure is counted in `failedJudgments` or
 * pushed to `warnings`, never lost silently and never aborting the run.
 */
async function judgeOne(ctx: PairPassContext, candidate: PairCandidate): Promise<{ failed: boolean }> {
  const initiatorSide = loadSide(candidate.initiator, ctx.gitFirstAdded, ctx.stashDir);
  const otherSide = loadSide(candidate.other, ctx.gitFirstAdded, ctx.stashDir);
  if (!initiatorSide || !otherSide) return { failed: false }; // unreadable since selection — skip, not a judge failure
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
    // S3: derive the parent path from the FULL file path, not from name +
    // dirname — for a subfolder memory (e.g. memories/sub/foo.derived) the
    // name already carries "sub/", so joining dirname(filePath) (which ALSO
    // ends in "sub") with it used to double the subfolder segment.
    const parentPath = retired.asset.filePath.replace(/\.derived\.md$/, ".md");
    if (fs.existsSync(parentPath)) return { failed: false }; // never retire a .derived memory whose parent still exists
  }
  // B2: an asset retired (or already spent as a successor) earlier in this
  // run cannot be retired or reused as a successor again — the same-run half
  // of the chain guard (the accept-time hash/existence check is the other,
  // durable half).
  const retiredKey = stripBundle(retired.asset.ref);
  const successorKey = stripBundle(successor.asset.ref);
  if (ctx.retiredThisRun.has(retiredKey) || ctx.retiredThisRun.has(successorKey)) return { failed: false };
  ctx.retiredThisRun.add(retiredKey);
  ctx.retiredThisRun.add(successorKey);

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
        // S6: its own generator, kept apart from the promote pass's
        // "consolidate" proposals — `accept --generator consolidate` (bulk
        // promotion review) never sweeps a retire proposal, and the reverse.
        source: "consolidate-pair",
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
    failedJudgments: 0,
  };
  const llmRunner = opts.llmRunner ?? undefined;
  if (!bundleId || !llmRunner) return empty;

  let initiators: Initiator[];
  let candidates: PairCandidate[];
  let gitFirstAdded: ReadonlyMap<string, number> | undefined;
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = opts.dryRun ? openReadonlyExistingDatabase(undefined, { isolatedSnapshot: true }) : openExistingDatabase();
    if (!db) return empty;
    gitFirstAdded = loadGitFirstAddedMap(stashDir);
    const pool = loadPairPassPool(db, bundleId);
    initiators = selectInitiators(pool, opts, stashDir, gitFirstAdded).initiators;
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
  const capped = candidates.slice(0, MAX_PAIRS_PER_RUN);

  // Never judge a pair when either side already has a pending retire
  // proposal, as the retired ref OR its successor (B2 widens this from the
  // retired ref alone): an asset spoken for by one pending decision cannot
  // also be judged as part of another until that decision resolves.
  const pendingRetireRefs = new Set<string>();
  try {
    for (const p of listProposalsReadOnly(stashDir, { status: "pending" })) {
      if (!isRetireProposal(p)) continue;
      pendingRetireRefs.add(stripBundle(p.ref));
      if (p.retirement?.successorRef) pendingRetireRefs.add(stripBundle(p.retirement.successorRef));
    }
  } catch {
    // Best-effort de-dup only; a failed read never blocks judging.
  }
  const judgeable = capped.filter(
    (c) => !pendingRetireRefs.has(stripBundle(c.initiator.ref)) && !pendingRetireRefs.has(stripBundle(c.other.ref)),
  );

  const ctx: PairPassContext = {
    opts,
    config,
    stashDir,
    llmRunner,
    gitFirstAdded,
    labelCounts: emptyLabelCounts(),
    perInitiatorProposed: new Set(),
    retired: [],
    warnings,
    retiredThisRun: new Set(),
    ...(seams.chat ? { chat: seams.chat } : {}),
  };

  let failedJudgments = 0;
  if (judgeable.length > 0) {
    // The promote pass validates opts.llmRunner's credentials once, but only
    // when it has memories to dispatch — the pair pass can still have work
    // when that pool is empty, so it validates independently before its
    // first real dispatch. A test-injected chat seam bypasses the transport
    // entirely and needs no credential.
    if (!seams.chat) assertRunnerCredentials(llmRunner);
    const results = await concurrentMap(
      judgeable,
      (candidate) => judgeOne(ctx, candidate),
      llmRunner.connection.concurrency ?? 1,
      { signal: opts.signal },
    );
    failedJudgments = results.filter((r) => r?.failed === true).length;
  }

  // S1: a ledger row is written for an initiator only once ALL of its OWN
  // candidates (before MAX_PAIRS_PER_RUN capping or the pending-proposal
  // skip above) were actually judged this run — including an initiator with
  // zero candidates, which trivially satisfies "all of them". One left out
  // by the cap or a pending-proposal collision gets no row at all, so the
  // next run reconsiders it rather than treating it as settled.
  if (!opts.dryRun) {
    const totalByInitiator = new Map<string, number>();
    for (const c of candidates) totalByInitiator.set(c.initiator.ref, (totalByInitiator.get(c.initiator.ref) ?? 0) + 1);
    const attemptedByInitiator = new Map<string, number>();
    for (const c of judgeable) {
      attemptedByInitiator.set(c.initiator.ref, (attemptedByInitiator.get(c.initiator.ref) ?? 0) + 1);
    }
    const ledgerInputs = initiators
      .filter((i) => (attemptedByInitiator.get(i.ref) ?? 0) === (totalByInitiator.get(i.ref) ?? 0))
      .map((i) => ({
        stashDir,
        ref: i.ref,
        source: PAIR_PASS_LEDGER_SOURCE,
        outcome: ctx.perInitiatorProposed.has(i.ref) ? ("proposed" as const) : ("judged_no_action" as const),
        contentHash: i.bodyHash,
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
    failedJudgments,
  };
}
