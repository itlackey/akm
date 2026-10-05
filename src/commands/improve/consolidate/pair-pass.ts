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
import { warnOnce } from "../../../core/warn";
import { type RunnerSpec, runnerLlmConnection } from "../../../integrations/agent/runner";
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
import {
  isRetireProposal,
  PAIR_PASS_GATE,
  type RetirementMetadata,
  type RetireReason,
} from "../../proposal/proposal-types";
import {
  createRetireProposal,
  listProposalsReadOnly,
  type ProposalsContext,
  proposalContentHash,
  recordGateDecision,
} from "../../proposal/repository";
import { type AkmConsolidateOptions, isHotCapturedMemory } from "../consolidate";
import { contentHash, stripFrontmatterBody } from "../content-hash";
import { loadLedgerSnapshot, PAIR_PASS_LEDGER_SOURCE, recordLedgerAttempt, stripBundle } from "../ledger";
import { isInRetrievalScope, loadRetrievalScope } from "../retrieval-scope";
import { callStage } from "../stage";
import { type ContinuitySearch, checkRetirementContinuity, createContinuitySearch } from "./continuity-check";

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
const PAIR_BODY_TRUNCATE_CHARS = 12_000;
const MS_PER_DAY = 86_400_000;

const RELATION_LABELS = ["duplicate", "subsumed", "supersedes", "contradicts", "overlap", "unrelated"] as const;

type RetireJudgeLabel = "duplicate" | "subsumed" | "supersedes";
const RETIRE_LABELS: ReadonlySet<string> = new Set<RetireJudgeLabel>(["duplicate", "subsumed", "supersedes"]);

/** The classes that mint a `retire` proposal (the calibrated combined retire class, 20/22 precision). */
function isRetireLabel(label: ConsolidatePairJudgeLabel): label is RetireJudgeLabel {
  return RETIRE_LABELS.has(label);
}

export const PAIR_JUDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["onlyInA", "onlyInB", "relation", "redundant", "stale", "confidence", "reason"],
  additionalProperties: false,
  properties: {
    onlyInA: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    onlyInB: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    relation: { type: "string", enum: [...RELATION_LABELS] },
    redundant: { type: ["string", "null"], enum: ["A", "B", null] },
    stale: { type: ["string", "null"], enum: ["A", null] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", maxLength: 400 },
  },
};

interface RawPairJudgeResponse {
  onlyInA?: unknown;
  onlyInB?: unknown;
  relation?: unknown;
  redundant?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

export interface PairJudgeVerdict {
  /** Durable claims of A that B neither states nor updates; [] when none. */
  onlyInA: string[];
  /** Durable claims of B that A neither states nor updates; [] when none. */
  onlyInB: string[];
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
  const onlyInA = claimList(parsed.onlyInA);
  const onlyInB = claimList(parsed.onlyInB);
  if (!onlyInA || !onlyInB) return undefined;
  return { onlyInA, onlyInB, relation: parsed.relation as ConsolidatePairJudgeLabel, redundant, confidence, reason };
}

function claimList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
  return value.map((v) => v.trim()).filter(Boolean);
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

/** 16 MiB — see the buffer-overflow comment inside {@link loadGitFirstAddedMap}. */
const GIT_LOG_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Every tracked path's first-add time (unix ms), from one `git log` over the
 * whole bundle (~2.1s measured against the owner's real bundle) — never
 * shelled out per pair or per initiator. Follows renames (`-M
 * --diff-filter=AR`, oldest-first via `--reverse`): a renamed path inherits
 * its pre-rename first-add time, not the rename's own timestamp — the owner's
 * 2026-08-24 bulk rename alone re-dated 966 files under `--no-renames`, and
 * 11% of real candidate pairs flipped which side counted as older. A raised
 * `diff.renameLimit` keeps a large bulk-rename commit (exactly this
 * scenario) from silently falling back to detecting no renames at all.
 * `undefined` when `stashDir` is not itself a git root (no `.git` directly
 * inside it): every asset then falls back to mtime in {@link createdMsOf},
 * one fallback code path instead of a second git-aware one for a bundle
 * nested inside a larger repo.
 */
export function loadGitFirstAddedMap(stashDir: string): ReadonlyMap<string, number> | undefined {
  if (!fs.existsSync(path.join(stashDir, ".git"))) return undefined;
  let result: ReturnType<typeof runGit>;
  try {
    result = runGit(
      ["-c", "diff.renameLimit=20000", "log", "--reverse", "-M", "--diff-filter=AR", "--name-status", "--format=@%ct"],
      {
        cwd: stashDir,
        // spawnSync's default maxBuffer (1 MB) is too small for a bundle
        // with real history — the owner's real bundle alone prints
        // multiple MB here (migration-tool.ts's own git subprocess call
        // uses the same 16 MiB figure). Silently exceeding it looks
        // identical to "git failed" from the caller's side (status stays
        // non-zero) — checked explicitly below instead of folded into the
        // same silent fallback as "no .git", since raising the buffer
        // again is an actual fix and worth telling the operator about.
        maxBuffer: GIT_LOG_MAX_BUFFER,
      },
    );
  } catch {
    return undefined;
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOBUFS" || /maxBuffer/i.test(result.error.message ?? "")) {
      warnOnce(
        "pair-pass-git-log-maxbuffer",
        `[consolidate] pair pass: git log for first-add dates in ${stashDir} exceeded its ${GIT_LOG_MAX_BUFFER / (1024 * 1024)} MiB buffer — dates fall back to mtime this run.`,
      );
    }
    return undefined;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  // Oldest-first (--reverse): the FIRST time a path is seen, whether as a
  // plain add or as a rename's destination, IS its true first-add time — no
  // backward walk needed. A rename's destination inherits the source's
  // already-recorded time (or, failing that — the source itself predates
  // this log's window — this commit's own time).
  const firstAdd = new Map<string, number>();
  let currentMs: number | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("@")) {
      const sec = Number(line.slice(1));
      currentMs = Number.isFinite(sec) ? sec * 1000 : undefined;
      continue;
    }
    if (currentMs === undefined) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const status = line.slice(0, tab);
    if (status === "A") {
      const p = line.slice(tab + 1).trim();
      if (p && !firstAdd.has(p)) firstAdd.set(p, currentMs);
    } else if (status.startsWith("R")) {
      const rest = line.slice(tab + 1);
      const tab2 = rest.indexOf("\t");
      if (tab2 < 0) continue;
      const oldPath = rest.slice(0, tab2).trim();
      const newPath = rest.slice(tab2 + 1).trim();
      if (oldPath && newPath && !firstAdd.has(newPath)) {
        firstAdd.set(newPath, firstAdd.get(oldPath) ?? currentMs);
      }
    }
  }
  return firstAdd;
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
 * A rejected retirement's dedup key (item 0): the exact ref pair plus both
 * content hashes at judge time, so a re-selected initiator (its own ledger
 * row missing because a sibling candidate was dropped or failed, not because
 * this pair changed) does not get this same, already-rejected pair re-judged
 * into a new proposal.
 */
function rejectedPairKey(retiredRef: string, successorRef: string, retiredHash: string, successorHash: string): string {
  return [retiredRef, successorRef, retiredHash, successorHash].join("\u0000");
}

/**
 * Item 0 / S1: every rejected OR reverted consolidate-pair retirement on
 * record, as {@link rejectedPairKey}s — read once per run, the same shape as
 * `pendingRetireRefs` in {@link runConsolidatePairPass}. `reverted` is
 * included alongside `rejected`: a person undoing an accept via `akm proposal
 * revert` is the same "no, not this" signal as a reject — without it, the next
 * run would re-mint the identical retirement, and a bulk accept could
 * re-apply a decision the person just undid. The keys follow each proposal's
 * CURRENT status, so one `akm proposal reopen` put back to `pending` (#997) is
 * no longer among them — and, pending, blocks its pair from a second mint.
 *
 * @internal exported for unit tests.
 */
export function loadRejectedPairKeys(stashDir: string, proposalsCtx: ProposalsContext | undefined): Set<string> {
  const keys = new Set<string>();
  try {
    for (const status of ["rejected", "reverted"] as const) {
      for (const p of listProposalsReadOnly(stashDir, { status, includeArchive: true }, proposalsCtx)) {
        if (!isRetireProposal(p) || !p.retirement) continue;
        keys.add(
          rejectedPairKey(
            p.retirement.retiredRef,
            p.retirement.successorRef,
            p.retirement.retiredContentHash,
            p.retirement.successorContentHash,
          ),
        );
      }
    }
  } catch {
    // Best-effort de-dup only; a failed read never blocks judging.
  }
  return keys;
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
export function buildPairUserPrompt(older: PairSide, newer: PairSide): string {
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
 * if that pointer is missing or invalid). A side is retired only when the
 * judge listed nothing that it alone holds.
 */
export function decideRetirement(
  label: ConsolidatePairJudgeLabel,
  redundant: "A" | "B" | null,
  older: PairSide,
  newer: PairSide,
  only: { onlyInA: string[]; onlyInB: string[] },
): PairDecision | undefined {
  let decision: PairDecision | undefined;
  if (label === "duplicate" || label === "supersedes") decision = { retired: older, successor: newer };
  else if (label === "subsumed" && redundant === "A") decision = { retired: older, successor: newer };
  else if (label === "subsumed" && redundant === "B") decision = { retired: newer, successor: older };
  if (!decision) return undefined;
  return (decision.retired === older ? only.onlyInA : only.onlyInB).length === 0 ? decision : undefined;
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
  llmRunner: RunnerSpec;
  gitFirstAdded: ReadonlyMap<string, number> | undefined;
  labelCounts: Record<ConsolidatePairJudgeLabel, number>;
  perInitiatorProposed: Set<string>;
  retired: string[];
  warnings: string[];
  chat?: PairJudgeChat;
  /**
   * The continuity check's search call (item 1) — one shared instance for
   * the whole run (S2), production or test. `runConsolidatePairPass` builds
   * the real one via {@link createContinuitySearch} unless a test seam
   * overrides it.
   */
  continuitySearch: ContinuitySearch;
  /**
   * {@link rejectedPairKey} of every rejected OR reverted `consolidate-pair`
   * retirement on record (item 0, S1), so a pair the owner already declined
   * — by rejecting it, or by accepting then reverting it — is never
   * re-proposed just because its initiator's OWN ledger row went missing (a
   * sibling candidate dropped or failed this run — see the ledger-write step
   * in {@link runConsolidatePairPass}).
   */
  rejectedPairKeys: ReadonlySet<string>;
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

  // Item 0 / S1: this exact pair (same two refs, same two content hashes,
  // EITHER orientation) was already judged and rejected OR reverted. Checked
  // HERE, before the judge call, not after — the judge (not yet run) is what
  // decides which side would be "retired" this time, so both orientations
  // are checked against the current content hashes rather than waiting for
  // a verdict to pick one. A settled pair therefore costs no LLM call.
  const initiatorHash = contentHash(initiatorSide.raw, "body");
  const otherHash = contentHash(otherSide.raw, "body");
  if (
    ctx.rejectedPairKeys.has(rejectedPairKey(initiatorSide.asset.ref, otherSide.asset.ref, initiatorHash, otherHash)) ||
    ctx.rejectedPairKeys.has(rejectedPairKey(otherSide.asset.ref, initiatorSide.asset.ref, otherHash, initiatorHash))
  ) {
    return { failed: false };
  }

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
      ...(Object.hasOwn(ctx.llmRunner, "timeoutMs") ? { timeoutMs: ctx.llmRunner.timeoutMs } : {}),
      signal: ctx.opts.signal,
      ...(ctx.chat ? { chat: ctx.chat } : {}),
    },
    parse: parsePairJudgeResponse,
    ...(ctx.opts.onNotices ? { onNotices: ctx.opts.onNotices } : {}),
  });
  if (!outcome.ok) return { failed: true };
  const verdict = parsePairJudgeResponse(outcome.raw);
  if (!verdict) return { failed: true };

  ctx.labelCounts[verdict.relation]++;
  if (verdict.relation === "contradicts") return { failed: false }; // counted; stays human — no proposal, no belief write
  if (!isRetireLabel(verdict.relation)) return { failed: false }; // overlap / unrelated: judged_no_action

  const decision = decideRetirement(verdict.relation, verdict.redundant, older, newer, verdict);
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
  const retiredHash = contentHash(retired.raw, "body");
  const successorHash = contentHash(successor.raw, "body");
  // B2: an asset retired (or already spent as a successor) earlier in this
  // run cannot be retired or reused as a successor again — the same-run half
  // of the chain guard (the accept-time hash/existence check is the other,
  // durable half).
  const retiredKey = stripBundle(retired.asset.ref);
  const successorKey = stripBundle(successor.asset.ref);
  // Must-fix 1 (third review round): a retire-worthy verdict the same-run
  // chain guard drops is not a settled "no action" — a LATER run, once the
  // conflicting retirement has been reviewed, may well mint it. Counted as
  // failed so its initiator gets no row (real data: night 1 alone judged 177
  // duplicate verdicts into only 59 proposals — 118 silently abandoned).
  if (ctx.retiredThisRun.has(retiredKey) || ctx.retiredThisRun.has(successorKey)) return { failed: true };
  ctx.retiredThisRun.add(retiredKey);
  ctx.retiredThisRun.add(successorKey);

  const reason = tombstoneReason(verdict.relation);
  if (ctx.opts.dryRun) {
    ctx.retired.push(`${retired.asset.ref} -> ${successor.asset.ref}`);
    ctx.perInitiatorProposed.add(candidate.initiator.ref);
    return { failed: false };
  }
  // Continuity check (plan §5.4, rule R3): replay the retired asset's own
  // past queries and flag, but do not block, a pair where the successor
  // would not have shown up where the retired asset did.
  const continuityRisk = await checkRetirementContinuity({
    stashDir: ctx.stashDir,
    config: ctx.config,
    retiredRef: retired.asset.ref,
    successorRef: successor.asset.ref,
    retiredRaw: retired.raw,
    successorRaw: successor.raw,
    ledgerAccess: { proposalsCtx: ctx.opts.proposalsCtx },
    search: ctx.continuitySearch,
  });
  const retirement: RetirementMetadata = {
    retiredRef: retired.asset.ref,
    successorRef: successor.asset.ref,
    cosine: candidate.cosine,
    judgeLabel: verdict.relation,
    judgeReason: verdict.reason,
    retiredContentHash: retiredHash,
    successorContentHash: successorHash,
    reason,
    ...(continuityRisk ? { continuityRisk } : {}),
  };
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
    // A duplicate with nothing unique on either side is the one class that
    // retires unattended (56 of 56 safe on the owner's reviewed pairs,
    // 2026-10-04): the triage drain accepts it under its usual applyMode.
    // Every other retirement waits for a person.
    if (verdict.relation === "duplicate" && verdict.onlyInA.length + verdict.onlyInB.length === 0 && !continuityRisk) {
      recordGateDecision(
        ctx.stashDir,
        proposal.id,
        {
          outcome: "staged",
          reason: "duplicate",
          gate: PAIR_PASS_GATE,
          contentHash: proposalContentHash(proposal),
        },
        ctx.opts.proposalsCtx,
      );
    }
    return { failed: false };
  } catch (error) {
    ctx.warnings.push(
      `Pair pass: could not mint a retire proposal for ${retired.asset.ref}: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Must-fix 1: a mint failure is transient (a lock, a disk error, a
    // validation hiccup) — treated the same as a same-run drop, so no row is
    // written and the pair is retried next run instead of abandoned.
    return { failed: true };
  }
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
  /** Test seams: a transport override for the judge call, and for the continuity check's search call. Production callers omit both. */
  seams: { chat?: PairJudgeChat; continuitySearch?: ContinuitySearch } = {},
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

  // Never judge a pair when either side already has a pending retire
  // proposal, as the retired ref OR its successor (B2 widens this from the
  // retired ref alone): an asset spoken for by one pending decision cannot
  // also be judged as part of another until that decision resolves.
  const pendingRetireRefs = new Set<string>();
  try {
    for (const p of listProposalsReadOnly(stashDir, { status: "pending" }, opts.proposalsCtx)) {
      if (!isRetireProposal(p)) continue;
      pendingRetireRefs.add(stripBundle(p.ref));
      if (p.retirement?.successorRef) pendingRetireRefs.add(stripBundle(p.retirement.successorRef));
    }
  } catch {
    // Best-effort de-dup only; a failed read never blocks judging.
  }
  const isPendingBlocked = (c: PairCandidate): boolean =>
    pendingRetireRefs.has(stripBundle(c.initiator.ref)) || pendingRetireRefs.has(stripBundle(c.other.ref));

  const rejectedPairKeys = loadRejectedPairKeys(stashDir, opts.proposalsCtx);

  // Blocker 2: admit WHOLE initiators under MAX_PAIRS_PER_RUN, never
  // individual pairs — the old flat "top 300 candidates by cosine" cap let a
  // pending-blocked pair spend a budget slot doing nothing, and left
  // whichever initiators landed past slot 300 partially judged forever (no
  // row per S1's own rule, so the SAME pairs got re-judged every night with
  // no way to ever finish; the reviewer's simulation measured 30 nights
  // making 9,000 calls but completing only 455 distinct pairs). A group with
  // any pending-blocked pair is skipped before it can spend any budget at
  // all. New-or-changed initiators (T_PAIR floor) are admitted before ANY
  // backlog initiator regardless of cosine, then backlog initiators by their
  // own best cosine — within a tier, a later, smaller group that still fits
  // is admitted even after an earlier, larger one did not (first-fit), so
  // the budget is not left idle just because the next-best group overflows
  // it. Simulated, this drains the real backlog in ~12 nights instead of
  // never.
  const byInitiator = new Map<string, PairCandidate[]>();
  for (const c of candidates) {
    const list = byInitiator.get(c.initiator.ref);
    if (list) list.push(c);
    else byInitiator.set(c.initiator.ref, [c]);
  }
  const isNewOrChanged = (i: Initiator): boolean => !i.backlog || i.newMaterial;
  const groups = [...byInitiator.values()]
    .filter((group) => !group.some(isPendingBlocked))
    .sort((a, b) => {
      const tierA = isNewOrChanged(a[0]!.initiator) ? 0 : 1;
      const tierB = isNewOrChanged(b[0]!.initiator) ? 0 : 1;
      if (tierA !== tierB) return tierA - tierB;
      return b[0]!.cosine - a[0]!.cosine; // candidates is cosine-desc, so group[0] is this initiator's best.
    });
  const judgeable: PairCandidate[] = [];
  for (const group of groups) {
    if (judgeable.length + group.length > MAX_PAIRS_PER_RUN) continue; // first-fit: a smaller later group may still fit.
    judgeable.push(...group);
  }

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
    rejectedPairKeys,
    retiredThisRun: new Set(),
    ...(seams.chat ? { chat: seams.chat } : {}),
    // S2: one instance for the whole run (not one per proposal), so its
    // "fell back once, go keyword-only from here" throttle actually covers
    // every remaining query in this run, not just one proposal's own five.
    continuitySearch: seams.continuitySearch ?? createContinuitySearch(stashDir, config),
  };

  let failedJudgments = 0;
  // Should-fix 3: an initiator with any failed (or never-sent) judge call
  // gets no ledger row — a failure attempted nothing conclusive, so writing
  // one would mean the pair is never retried.
  const failedInitiators = new Set<string>();
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
      runnerLlmConnection(llmRunner)?.concurrency ?? 1,
      { signal: opts.signal },
    );
    results.forEach((r, idx) => {
      // Must-fix 3: `concurrentMap` leaves an entry `undefined` for a call an
      // aborted run never sent at all — `r?.failed === true` reads that as
      // `undefined === true` (false), so an unsent call counted as a clean
      // "no action" verdict. Explicit `undefined` check closes that gap.
      if (r === undefined || r.failed === true) {
        failedJudgments++;
        failedInitiators.add(judgeable[idx]!.initiator.ref);
      }
    });
  }

  // S1: a ledger row is written for an initiator only once ALL of its OWN
  // candidates were admitted (whole-initiator admission above makes this a
  // simple membership check: judgeable either has every one of an
  // initiator's candidates, or none of them) and none of them failed
  // (should-fix 3) — including an initiator with zero candidates, which
  // trivially satisfies both. One left out by the cap or a pending-proposal
  // collision gets no row at all, so the next run reconsiders it rather
  // than treating it as settled.
  if (!opts.dryRun) {
    const admittedRefs = new Set(judgeable.map((c) => c.initiator.ref));
    const ledgerInputs = initiators
      .filter((i) => {
        const hasCandidates = byInitiator.has(i.ref);
        if (!hasCandidates) return true;
        if (!admittedRefs.has(i.ref)) return false;
        return !failedInitiators.has(i.ref);
      })
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
    // Must-fix 3: parsed verdicts only — judgeable.length counted pairs that
    // were admitted, not pairs a verdict actually came back for.
    pairsJudged: judgeable.length - failedJudgments,
    labelCounts: ctx.labelCounts,
    retired: ctx.retired,
    failedJudgments,
  };
}
