// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { assembleAsset, serializeFrontmatter } from "../core/asset/asset-serialize";
import { parseFrontmatter, parseFrontmatterBlock, spliceFrontmatterLine } from "../core/asset/frontmatter";
import { type AssetRef, displayDefaultBundle, displayRef } from "../core/asset/resolve-ref";
import { isWithin, resolveStashDir, safeRealpath, writeFileAtomic } from "../core/common";
import { type AkmConfig, loadConfig } from "../core/config/config";
import { ConfigError, NotFoundError, TransientError, UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { getStateDbPath, withStateDb } from "../core/state-db";
import { warn } from "../core/warn";
import { NO_INDEX_MESSAGE, openUsableIndex } from "../indexer/index-readiness";
import { heldRebuildLock } from "../indexer/index-rebuild-lock";
import { recomputeUtilityScores } from "../indexer/indexer";
import { currentConceptId, resolveWriteAddress } from "../indexer/lookup/adapter-concept-owner";
import { findSourceForPath, resolveSourceEntries, type SearchSource } from "../indexer/search/search-source";
import { insertUsageEventStrict, resolveUsageEventSource } from "../indexer/usage/usage-events";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import { resolveMutationTarget } from "../sources/mutation-target";
import { withWriteTargetMutation } from "../sources/write-source";
import type { Database } from "../storage/database";
import {
  closeDatabase,
  indexDbIsDamaged,
  isCorruptionError,
  openExistingDatabase,
} from "../storage/repositories/index-connection";
import {
  findEntryIdByRef,
  getEntryById,
  getEntryFilePathById,
  getItemRefById,
} from "../storage/repositories/index-entries-repository";
import { getUtilityScore } from "../storage/repositories/index-utility-repository";
import { contentHash } from "./improve/content-hash";
import { readEdgeList } from "./improve/memory/memory-belief";
import { akmProposalAccept } from "./proposal/proposal";
import { createProposal, recordGateDecision, rejectProposalDurably } from "./proposal/repository";

// ── Tag validation ────────────────────────────────────────────────────────────

const TAG_KEY_RE = /^[a-z_][a-z0-9_]*$/;

function validateFeedbackTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of raw) {
    const parts = tag.split(":");
    if (parts.length < 2 || parts[0] === "" || parts.slice(1).join("") === "") {
      throw new UsageError(
        `Invalid tag "${tag}". Tags must be in key:value format where key matches [a-z_][a-z0-9_]* and value is non-empty.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const key = parts[0]!;
    if (!TAG_KEY_RE.test(key)) {
      throw new UsageError(
        `Invalid tag key "${key}" in "${tag}". Key must match [a-z_][a-z0-9_]*.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

// ── Lesson strength helper ────────────────────────────────────────────────────

/**
 * Phase 7A: append a feedback ref to a lesson's `lessonStrength[]`
 * frontmatter array. Returns `{ strength }` (post-update count) on success,
 * or `null` when the lesson cannot be located. Idempotent: if the ref is
 * already credited, no write occurs.
 *
 * The function looks up the lesson's file via the indexer DB so the write
 * targets the canonical on-disk location. Frontmatter is rewritten in
 * place (no asset-spec round-trip) because we're modifying a single key on
 * an existing asset — the same pattern memory-inference uses for
 * `inferenceProcessed`.
 */
function appendLessonStrength(
  raw: string,
  origin: string | undefined,
  feedbackRef: string,
): { ref: string; strength: number } | null {
  // `findEntryIdByRef` keys on the stored `item_ref`; the lesson's type is the one its entry records.
  const config = loadConfig();
  const conceptId = currentConceptId(parseBundleRef(raw), resolveSourceEntries(undefined, config));
  let filePath: string | undefined;
  let bundleId: string | undefined;
  let type: string | undefined;
  const db = openExistingDatabase();
  try {
    const entryId = findEntryIdByRef(db, makeBundleRef(origin, conceptId));
    if (entryId !== undefined) {
      const itemRef = getItemRefById(db, entryId);
      const parsedItemRef = itemRef ? parseBundleRef(itemRef) : undefined;
      filePath = getEntryFilePathById(db, entryId) ?? undefined;
      bundleId = parsedItemRef?.bundle;
      type = getEntryById(db, entryId)?.entry.type;
    }
  } finally {
    closeDatabase(db);
  }

  const requestedRef = makeBundleRef(origin, conceptId);
  if (type !== undefined && type !== "lesson") {
    warn(
      `[feedback] --applied-to ${requestedRef} was ignored: it resolves to a "${type}" asset, ` +
        "not a lesson. Only lesson refs can be credited via --applied-to.",
    );
    return null;
  }
  if (!filePath || !bundleId || !fs.existsSync(filePath)) {
    warn(`[feedback] --applied-to: lesson ${requestedRef} is not in the index or is missing on disk.`);
    return null;
  }

  const resolved = resolveMutationTarget(config, { type: "lesson", name: conceptId, origin: bundleId });
  if (!isWithin(filePath, resolved.target.source.path)) {
    throw new UsageError(`Resolved lesson ${requestedRef} is outside bundle "${bundleId}".`);
  }

  fs.lstatSync(filePath);
  const initialUpdate = buildLessonStrengthUpdate(fs.readFileSync(filePath), feedbackRef);
  if (!initialUpdate.nextBytes) {
    return { ref: makeBundleRef(bundleId, conceptId), strength: initialUpdate.strength };
  }

  let strength = initialUpdate.strength;
  let mutationStarted = false;
  try {
    withWriteTargetMutation(
      resolved.target,
      [filePath],
      {
        purpose: "feedback-lesson-credit",
        message: `Update ${makeBundleRef(bundleId, conceptId)}`,
      },
      () => {
        const stat = fs.lstatSync(filePath);
        const update = buildLessonStrengthUpdate(fs.readFileSync(filePath), feedbackRef);
        strength = update.strength;
        if (!update.nextBytes) return;
        mutationStarted = true;
        // Preserve the existing file's permission bits (markdown assets are typically 0o644).
        writeFileAtomic(filePath, update.nextBytes, stat.mode & 0o777);
      },
    );
  } catch (err) {
    if (mutationStarted) throw err;
    warn(`[feedback] --applied-to: failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return { ref: makeBundleRef(bundleId, conceptId), strength };
}

function buildLessonStrengthUpdate(rawBytes: Buffer, feedbackRef: string): { strength: number; nextBytes?: Buffer } {
  const raw = rawBytes.toString("utf8");
  const parsed = parseFrontmatter(raw);
  const data = { ...parsed.data };
  const existing = data.lessonStrength;
  const strengthList: string[] = Array.isArray(existing)
    ? existing.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : typeof existing === "string" && existing.trim().length > 0
      ? [existing.trim()]
      : [];
  if (strengthList.includes(feedbackRef)) {
    return { strength: strengthList.length };
  }
  strengthList.push(feedbackRef);
  data.lessonStrength = strengthList;

  const block = parseFrontmatterBlock(raw);
  const body = block?.content ?? raw;
  const next = assembleAsset(data, body);
  const nextBytes = Buffer.from(next);
  return rawBytes.equals(nextBytes) ? { strength: strengthList.length } : { strength: strengthList.length, nextBytes };
}

/** Utility at or above this is "high"; falling below it after feedback emits `improve_review_needed`. */
const UTILITY_REVIEW_THRESHOLD = 0.5;

/**
 * Result of {@link recordFeedbackUsage}: the entry's utility before and after
 * (when the recompute ran) plus whether the event counts toward `akm search` /
 * `akm curate` ranking, and why not when it doesn't. Ranking counts the
 * recorded user-attributed events themselves, so this does not depend on the
 * utility update succeeding.
 */
interface RecordFeedbackUsageResult {
  utilityResult: { previousUtility: number; nextUtility: number } | undefined;
  /** True iff the recorded event is user-attributed, i.e. counted by the ranking factor. */
  countsTowardRanking: boolean;
  /** Set whenever `countsTowardRanking` is false; explains why. */
  rankingSkippedReason: string | undefined;
}

/**
 * Persist the feedback usage-event (state.db) and, for a user-attributed event,
 * recompute the entry's utility score (index.db) with the same function the
 * `akm index` finalize pass uses, scoped to this one entry, so there is one
 * formula and the stored value is what the next index would compute. Chunk-8
 * WI-8.3: usage_events lives in state.db; entries + utility_scores stay in `indexDb`.
 * Search ranking does not read the utility score: it counts the recorded
 * `source='user'` feedback events itself, so a user-attributed event affects
 * ranking at once and an `improve`/`task`/`audit`/`unknown` one never does — an
 * anti-self-reinforcement guard that stops an agent or automated pipeline from
 * boosting its own picks. This is by design and must not be removed. The
 * utility score is read by improve and metrics only; its update is best-effort
 * and its failure never fails the feedback record or changes the ranking effect.
 * A failed usage-event write fails the command (DATA_DIR_NOT_WRITABLE).
 */
function recordFeedbackUsage(
  indexDb: Database,
  entryId: number,
  durableEntryRef: string,
  signal: "positive" | "negative",
  metadataStr: string | undefined,
): RecordFeedbackUsageResult {
  let utilityResult: RecordFeedbackUsageResult["utilityResult"];
  let rankingSkippedReason: string | undefined;
  const eventSource = resolveUsageEventSource();
  withStateDb((stateDb) => {
    // The usage event IS the feedback record, so a failed write fails the command
    // instead of reporting ok while nothing was stored.
    try {
      insertUsageEventStrict(stateDb, {
        event_type: "feedback",
        entry_ref: durableEntryRef,
        entry_id: entryId,
        signal,
        metadata: metadataStr,
        source: eventSource,
      });
    } catch (err) {
      throw new ConfigError(
        `Feedback was not recorded: could not write ${getStateDbPath()} (${err instanceof Error ? err.message : String(err)}).`,
        "DATA_DIR_NOT_WRITABLE",
      );
    }
    if (eventSource !== "user") {
      rankingSkippedReason =
        `feedback source is "${eventSource}", not "user" — it does not count toward search ranking, which counts ` +
        "user-attributed feedback only (anti-self-reinforcement guard; set AKM_EVENT_SOURCE=user to record as user demand).";
      return;
    }
    try {
      const previousUtility = getUtilityScore(indexDb, entryId)?.utility ?? 0;
      recomputeUtilityScores(indexDb, stateDb, entryId);
      utilityResult = { previousUtility, nextUtility: getUtilityScore(indexDb, entryId)?.utility ?? previousUtility };
    } catch (err) {
      // best-effort — the event is recorded (and ranked) even if the utility update fails
      warn(`[feedback] utility update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { utilityResult, countsTowardRanking: eventSource === "user", rankingSkippedReason };
}

// ── Judged text ──────────────────────────────────────────────────────────────

/**
 * The body hash of the text a piece of feedback judges: the asset's file as it
 * stands when the feedback is given. `undefined` when the file cannot be read.
 * Reflect compares it with the asset's current body to tell feedback given on
 * an earlier version of the text. An env or secret file is never read.
 */
function judgedTextHash(type: string | undefined, filePath: string | undefined): string | undefined {
  try {
    if (!filePath || type === "env" || type === "secret") return undefined;
    return contentHash(fs.readFileSync(filePath, "utf8"), "body");
  } catch {
    return undefined;
  }
}

// ── Exact fixes ──────────────────────────────────────────────────────────────

/** 1-based numbers of the lines on which `needle` starts. */
function startLines(text: string, needle: string): number[] {
  const lines: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    lines.push(text.slice(0, at).split("\n").length);
  }
  return lines;
}

/**
 * Apply `--replace`/`--with` pairs in order. Each `--replace` text must appear
 * exactly once in the text as it stands at that point, so the edit can only
 * land where the caller meant it.
 */
export function applyExactReplacements(
  text: string,
  pairs: ReadonlyArray<{ old: string; new: string }>,
  file: string,
): string {
  let out = text;
  pairs.forEach((pair, i) => {
    const label = `--replace #${i + 1}`;
    if (!pair.old) throw new UsageError(`${label} is empty.`, "INVALID_FLAG_VALUE");
    const lines = startLines(out, pair.old);
    if (lines.length === 0) {
      throw new UsageError(
        `${label} was not found in ${file}.`,
        "INVALID_FLAG_VALUE",
        "Copy the text verbatim from the file, including whitespace and punctuation.",
      );
    }
    if (lines.length > 1) {
      throw new UsageError(
        `${label} appears ${lines.length} times in ${file} (lines ${lines.join(", ")}).`,
        "INVALID_FLAG_VALUE",
        "Include more of the surrounding text so it appears once.",
      );
    }
    const at = out.indexOf(pair.old);
    out = out.slice(0, at) + pair.new + out.slice(at + pair.old.length);
  });
  return out;
}

/** A fix may change the frontmatter's values, but it must still parse as YAML. */
function assertFrontmatterStillParses(before: string, after: string, file: string): void {
  if (!parseFrontmatterBlock(before)) return;
  const block = parseFrontmatterBlock(after);
  let problem: string | undefined;
  if (!block) {
    problem = "the frontmatter block is gone";
  } else if (block.frontmatter.trim()) {
    try {
      const data = yamlParse(block.frontmatter) as unknown;
      if (typeof data !== "object" || data === null || Array.isArray(data)) problem = "it is no longer a mapping";
    } catch (err) {
      problem = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    }
  }
  if (problem) {
    throw new UsageError(
      `The fix breaks the frontmatter of ${file}: ${problem}.`,
      "INVALID_FLAG_VALUE",
      'Quote a value that contains ": ", or leave the frontmatter alone.',
    );
  }
}

/**
 * Refuse a fix that a proposal could not apply to the asset's file: the file
 * `createProposal` writes for the ref in the bundle (the file that owns it) is
 * not the indexed one, so accepting the proposal would leave the real one unfixed.
 */
export function assertProposalWritesFile(itemRef: string, root: string, filePath: string): void {
  const { type, path: writes } = resolveWriteAddress(path.resolve(root), itemRef);
  if (writes !== undefined && safeRealpath(writes) === safeRealpath(filePath)) return;
  throw new UsageError(
    `akm cannot queue a fix for ${itemRef}: its file is ${filePath}, but a proposal would write ${writes ?? `no file (akm has no directory for "${type}" assets)`}. Edit the file directly.`,
    "INVALID_PROPOSAL",
  );
}

// ── History marks ────────────────────────────────────────────────────────────

/** What `--superseded-by` or `--outdated` records: `supersededBy` is the successor's durable ref. */
type HistoryMark = { supersededBy: string } | { outdated: true };

/**
 * The durable ref of the asset `--superseded-by` names. It must be indexed and
 * must not be the asset itself, or nothing is recorded.
 */
function resolveSuccessorRef(db: Database, input: string, itemRef: string, sources: SearchSource[]): string {
  const parsed = parseBundleRef(input);
  const id = findEntryIdByRef(db, makeBundleRef(parsed.bundle, currentConceptId(parsed, sources)), parsed.bundle);
  const successor = id === undefined ? null : getItemRefById(db, id);
  if (!successor) {
    throw new UsageError(
      `--superseded-by ${input} is not in the index.`,
      "INVALID_FLAG_VALUE",
      "Run 'akm search' to find the asset that replaces it, then 'akm index' if it was recently added.",
    );
  }
  if (successor === itemRef) {
    throw new UsageError(`--superseded-by ${input} is the asset itself.`, "INVALID_FLAG_VALUE");
  }
  return successor;
}

/** The frontmatter of `text` as a YAML mapping: `{}` when it has none (or only comments), `undefined` when it is not valid YAML or not a mapping. */
function frontmatterMapping(text: string): Record<string, unknown> | undefined {
  const block = parseFrontmatterBlock(text);
  if (!block?.frontmatter.trim()) return {};
  try {
    const data = (yamlParse(block.frontmatter) ?? {}) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `mark` sets on frontmatter `data`, `{}` when it already says so. The rules
 * of `writeSupersededEdge`: a ref already listed is not added again,
 * `contradicted` and `archived` stay, and a scalar `supersededBy` joins the list.
 * `--outdated` also leaves `superseded`, which says more than `deprecated`.
 */
function historyMarkChanges(
  data: Record<string, unknown>,
  mark: HistoryMark,
): { beliefState?: string; supersededBy?: string[] } {
  const state = data.beliefState;
  if ("outdated" in mark) {
    return state === "deprecated" || state === "superseded" || state === "contradicted" || state === "archived"
      ? {}
      : { beliefState: "deprecated" };
  }
  const existing = readEdgeList(data.supersededBy);
  return {
    ...(state === "superseded" || state === "contradicted" || state === "archived"
      ? {}
      : { beliefState: "superseded" }),
    ...(existing.includes(mark.supersededBy) ? {} : { supersededBy: [...existing, mark.supersededBy] }),
  };
}

/** Index of the top-level `key:` line inside the frontmatter block of `lines`, or -1. */
function topLevelKeyLine(lines: string[], key: string): number {
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (lines[0]?.trim() !== "---" || close === -1) return -1;
  return lines.findIndex((line, i) => i > 0 && i < close && line.startsWith(`${key}:`));
}

/** Put a one-line `beliefState` in the frontmatter of `text`: in place of its line, or just before the closing fence. */
function setBeliefState(text: string, state: string): string {
  const lines = text.split("\n");
  const at = topLevelKeyLine(lines, "beliefState");
  if (at === -1) return spliceFrontmatterLine(text, `beliefState: ${state}`) ?? text;
  lines[at] = `beliefState: ${state}`;
  return lines.join("\n");
}

/** Put the `supersededBy` list `list`, whose last item is `ref`, in the frontmatter of `text`. */
function setSupersededBy(text: string, list: string[], ref: string): string {
  const item = (value: string) => `- ${yamlStringify(value, { lineWidth: 0 }).trimEnd()}`;
  const whole = ["supersededBy:", ...list.map((value) => `  ${item(value)}`)];
  const lines = text.split("\n");
  const at = topLevelKeyLine(lines, "supersededBy");
  if (at === -1) return whole.reduce((out, line) => spliceFrontmatterLine(out, line) ?? out, text);
  // The item lines of a block list, which may have blank lines and comments between them.
  const items: number[] = [];
  for (let i = at + 1; i < lines.length && /^\s*(-(\s|$)|#|$)/.test(lines[i] as string); i++) {
    if (/^\s*-(\s|$)/.test(lines[i] as string)) items.push(i);
  }
  if (items.length > 0 && /^supersededBy:\s*(#.*)?$/.test(lines[at] as string)) {
    // A block list: the new item follows the last one, indented like the first.
    const indent = /^\s*/.exec(lines[items[0] as number] as string)?.[0] ?? "";
    lines.splice((items[items.length - 1] as number) + 1, 0, `${indent}${item(ref)}`);
  } else {
    // A flow list, a scalar or no value: this one key is written out as a block list.
    lines.splice(at, 1, ...whole);
  }
  return lines.join("\n");
}

/**
 * Mark an asset's history in the frontmatter of its text, as a proposal's content:
 * `{ supersededBy }` sets `beliefState: superseded` and adds the ref to the
 * `supersededBy` list, `{ outdated }` sets `beliefState: deprecated`. Only those
 * two keys change, by line edits that keep every other byte (comments, quoting,
 * key order, line endings, the body). When a line edit does not give exactly the
 * intended frontmatter (an unusual spelling of a key), the frontmatter is
 * written out again instead. Returns `raw` when it already says what the mark sets.
 */
export function applyHistoryMark(raw: string, mark: HistoryMark, file: string): string {
  const crlf = raw.includes("\r\n");
  const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  const data = frontmatterMapping(text);
  if (!data) {
    throw new UsageError(
      `The frontmatter of ${file} is not a valid YAML mapping, so akm cannot mark it.`,
      "INVALID_FLAG_VALUE",
      "Fix the frontmatter first.",
    );
  }
  const changes = historyMarkChanges(data, mark);
  if (Object.keys(changes).length === 0) return raw;

  let out = text;
  if (changes.beliefState !== undefined) out = setBeliefState(out, changes.beliefState);
  if (changes.supersededBy !== undefined && "supersededBy" in mark) {
    out = setSupersededBy(out, changes.supersededBy, mark.supersededBy);
  }
  const intended = { ...data, ...changes };
  if (!isDeepStrictEqual(frontmatterMapping(out), intended)) {
    const block = parseFrontmatterBlock(text);
    out = `---\n${serializeFrontmatter(intended)}\n---\n${block ? block.content : text}`;
  }
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

// ── Recording ─────────────────────────────────────────────────────────────────

export interface FeedbackInput {
  ref: string;
  signal: "positive" | "negative";
  reason?: string;
  tags?: string[];
  /** Exact text replacements the asset should receive, in order. */
  fix?: Array<{ replace: string; with: string }>;
  /** Where the correct fact comes from. Required with a fix or a mark. */
  source?: string;
  /** Ref of the asset that replaces this one. */
  supersededBy?: string;
  /** The asset describes a past state and nothing replaces it. */
  outdated?: boolean;
  /** A `lessons/<name>` ref that helped; credited on positive feedback. */
  appliedTo?: string;
}

/** What `--replace/--with`, `--source`, `--superseded-by` and `--outdated` ask of the asset's text, read from the input. */
interface FixRequest {
  pairs: Array<{ old: string; new: string }>;
  source: string | undefined;
  supersededBy: string | undefined;
  outdated: boolean;
  hasMark: boolean;
}

function readFixRequest(input: FeedbackInput): FixRequest {
  const supersededBy = input.supersededBy;
  const outdated = input.outdated === true;
  return {
    pairs: (input.fix ?? []).map((pair) => ({ old: pair.replace, new: pair.with })),
    source: input.source?.trim() || undefined,
    supersededBy,
    outdated,
    hasMark: supersededBy !== undefined || outdated,
  };
}

/** A fix: an exact edit of the asset's text, a mark of its history (--superseded-by or --outdated), or both. */
function assertFixFlags(signal: FeedbackInput["signal"], reason: string | undefined, request: FixRequest): void {
  const { pairs, source, supersededBy, outdated, hasMark } = request;
  if (pairs.length === 0 && source === undefined && !hasMark) return;
  if (signal !== "negative") {
    throw new UsageError(
      "--replace, --with, --source, --superseded-by and --outdated are only for negative feedback.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (supersededBy !== undefined && outdated) {
    throw new UsageError(
      "--superseded-by names the asset that replaces this one and --outdated says none does; use one.",
      "INVALID_FLAG_VALUE",
    );
  }
  if (supersededBy !== undefined && !supersededBy.trim()) {
    throw new UsageError(
      "--superseded-by needs the ref of the asset that replaces this one.",
      "MISSING_REQUIRED_ARGUMENT",
    );
  }
  if (pairs.length === 0 && !hasMark) {
    throw new UsageError("Each --replace needs one --with (got 0 --replace and 0 --with).", "INVALID_FLAG_VALUE");
  }
  if (!source) {
    throw new UsageError(
      "A fix needs --source: the URL, command or file that shows the correct fact.",
      "MISSING_REQUIRED_ARGUMENT",
    );
  }
  if (!reason?.trim()) {
    throw new UsageError("A fix needs --reason: say what is wrong.", "MISSING_REQUIRED_ARGUMENT");
  }
}

function assertNegativeReason(ref: string, reason: string | undefined): void {
  if (reason?.trim()) return;
  // F-3 / #384: Default requireReason is now true. Load config to allow
  // operators to opt out via feedback.requireReason: false in config.json.
  const requireReason = loadConfig().feedback?.requireReason ?? true;
  if (requireReason) {
    throw new UsageError(
      "Negative feedback requires --reason: say what is wrong and what should change. " +
        "Set feedback.requireReason: false in config.json to downgrade to a warning.",
      "MISSING_REQUIRED_ARGUMENT",
      `Hint: akm feedback ${ref} --negative --reason "<what is wrong and what should change>"`,
    );
  }
  warn("Warning: negative feedback without --reason says nothing about what is wrong.");
}

interface PreparedFix {
  content: string;
  target: { source: string; root: string };
  marked?: { beliefState: string; supersededBy?: string };
}

/** The asset's text after the fix, checked against its file; nothing is written, so a fix that does not apply leaves no trace. */
function prepareFix(
  db: Database,
  config: AkmConfig,
  sources: SearchSource[],
  itemRef: string,
  entryType: string | undefined,
  filePath: string | undefined,
  request: FixRequest,
): PreparedFix {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new NotFoundError(`The file for ${itemRef} is missing on disk.`, "ASSET_NOT_FOUND");
  }
  // The existing asset is written where it is: its bundle picks the target, and
  // assertProposalWritesFile checks its write address is this file.
  const { bundle, conceptId } = parseBundleRef(itemRef);
  const assetRef: AssetRef = { type: entryType ?? "", name: conceptId, origin: bundle };
  const resolved = resolveMutationTarget(config, assetRef, undefined, { requireWritable: true });
  if (!isWithin(filePath, resolved.target.source.path)) {
    throw new UsageError(`${itemRef} is outside bundle "${resolved.target.source.name}".`);
  }
  assertProposalWritesFile(itemRef, resolved.target.source.path, filePath);
  let mark: HistoryMark | undefined;
  if (request.hasMark) {
    if (entryType === "env" || entryType === "secret" || !filePath.toLowerCase().endsWith(".md")) {
      throw new UsageError(
        `--superseded-by and --outdated mark the frontmatter of a markdown asset, and ${itemRef} is not one.`,
        "INVALID_FLAG_VALUE",
      );
    }
    mark =
      request.supersededBy !== undefined
        ? { supersededBy: resolveSuccessorRef(db, request.supersededBy.trim(), itemRef, sources) }
        : { outdated: true };
  }
  const before = fs.readFileSync(filePath, "utf8");
  let after = applyExactReplacements(before, request.pairs, filePath);
  if (mark) after = applyHistoryMark(after, mark, filePath);
  if (after === before) throw new UsageError("The fix changes nothing.", "INVALID_FLAG_VALUE");
  assertFrontmatterStillParses(before, after, filePath);
  // What the proposal leaves the asset saying, for the output and the event.
  const marked = mark && {
    beliefState: String(parseFrontmatter(after).data.beliefState),
    ...("supersededBy" in mark ? { supersededBy: mark.supersededBy } : {}),
  };
  return {
    content: after,
    target: { source: resolved.target.source.name, root: resolved.target.source.path },
    ...(marked ? { marked } : {}),
  };
}

/**
 * A person typed the fix, so it is applied now: the proposal is minted for the audit trail, `akm proposal
 * revert` and reflect's "already acted on" rule, then accepted through the ordinary accept path (the same
 * checks and git commit). If that refuses, the proposal is rejected and the command fails.
 */
async function applyFix(
  durableRef: string,
  fix: PreparedFix,
  reason: string,
  fixSource: string,
): Promise<ReturnType<typeof createProposal>> {
  const stashDir = resolveStashDir();
  const minted = createProposal(stashDir, {
    ref: durableRef,
    itemRef: durableRef,
    target: fix.target,
    source: "feedback",
    payload: { content: fix.content },
    feedback: { reason, source: fixSource },
  });
  try {
    recordGateDecision(stashDir, minted.id, { outcome: "auto-accepted", reason: "manual-fix", gate: "feedback" });
    return (await akmProposalAccept({ stashDir, id: minted.id })).proposal;
  } catch (err) {
    try {
      rejectProposalDurably(
        stashDir,
        minted.id,
        `manual fix not applied: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch (rejectErr) {
      warn(
        `[feedback] could not reject proposal ${minted.id}: ${rejectErr instanceof Error ? rejectErr.message : String(rejectErr)}`,
      );
    }
    throw err;
  }
}

/**
 * F-5 / #386: When a high-utility asset crosses below the review threshold,
 * emit a structured review-needed event so a human can confirm whether the
 * negative feedback is valid before the asset falls out of the improve loop.
 * An event rather than a proposal, so the signal cannot overwrite an asset if
 * it is accepted. Best-effort: a failure is logged but does not fail the
 * feedback command.
 */
function escalateIfBelowReview(
  ref: string,
  durableRef: string,
  utilityResult: RecordFeedbackUsageResult["utilityResult"],
  reason: string | undefined,
): void {
  if (
    !utilityResult ||
    utilityResult.previousUtility < UTILITY_REVIEW_THRESHOLD ||
    utilityResult.nextUtility >= UTILITY_REVIEW_THRESHOLD
  ) {
    return;
  }
  try {
    appendEvent({
      eventType: "improve_review_needed",
      ref: durableRef,
      metadata: {
        previousUtility: utilityResult.previousUtility,
        nextUtility: utilityResult.nextUtility,
        reason: reason?.trim() ?? null,
      },
    });
  } catch (escalationErr) {
    warn(
      `[feedback] Could not emit review-needed event for ${ref}: ${escalationErr instanceof Error ? escalationErr.message : String(escalationErr)}`,
    );
  }
}

/**
 * Phase 7A / Advantage D4b: --applied-to credits a lesson. On a positive
 * signal, the feedback ref is appended to the target lesson's `lessonStrength[]`
 * frontmatter array (dedup, idempotent). Non-lesson targets are REJECTED
 * with a loud warning (R-033b) rather than silently doing nothing.
 * Failures here are warnings: feedback recording is the primary contract and
 * must not regress on lesson-write errors.
 */
function creditAppliedLesson(
  appliedTo: string | undefined,
  signal: FeedbackInput["signal"],
  durableRef: string,
): { lessonRef: string; strength: number } | null {
  const appliedToRaw = appliedTo?.trim();
  if (!appliedToRaw) return null;
  if (signal !== "positive") {
    warn("[feedback] --applied-to is ignored without --positive; lesson credit is only recorded on positive signals.");
    return null;
  }
  let appliedOrigin: BundleRef | undefined;
  try {
    appliedOrigin = parseBundleRef(appliedToRaw);
  } catch (err) {
    warn(`[feedback] --applied-to failed for ${appliedToRaw}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!appliedOrigin) return null;
  const updated = appendLessonStrength(appliedToRaw, appliedOrigin.bundle, durableRef);
  return updated ? { lessonRef: updated.ref, strength: updated.strength } : null;
}

/**
 * Record feedback on an indexed asset, with an optional fix or history mark: what `akm feedback` does once its flags
 * are read. The usage event's source is the ambient `AKM_EVENT_SOURCE`, else `user`.
 */
export async function akmFeedback(input: FeedbackInput) {
  const ref = (input.ref ?? "").trim();
  if (!ref) {
    throw new UsageError(
      "Asset ref is required. Usage: akm feedback <ref> --positive|--negative",
      "MISSING_REQUIRED_ARGUMENT",
      "Pass a ref like `skills/deploy` and either --positive or --negative.",
    );
  }
  const parsedRef = parseBundleRef(ref);
  const signal = input.signal;
  const reason = input.reason;

  const request = readFixRequest(input);
  assertFixFlags(signal, reason, request);
  if (signal === "negative") assertNegativeReason(ref, reason);
  const validatedTags = validateFeedbackTags(input.tags ?? []);
  const metadataObj: Record<string, unknown> = {
    signal,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
    ...(validatedTags.length > 0 ? { tags: validatedTags } : {}),
  };

  // Feedback needs only a usable index, not a current one, and builds none: with no index it says so, as every
  // reader does. It writes two rows (usage_events and a utility score); SQLite's busy timeout covers a concurrent
  // improve run, so no application-level lock is taken.
  let utilityResult: RecordFeedbackUsageResult["utilityResult"];
  let countsTowardRanking = false;
  let rankingSkippedReason: string | undefined;
  let durableRef = ref;
  let shownRef = ref;
  let fix: PreparedFix | undefined;
  const config = loadConfig();
  const sources = resolveSourceEntries(undefined, config);
  // The library is the primary source, as in search.
  const library = sources[0];
  const usable = library ? openUsableIndex(library.path) : undefined;
  if (!usable) {
    // A build in progress is a retry, not a usage error.
    if (heldRebuildLock()) {
      throw new TransientError(
        "The search index for this library is being built; retry when the build finishes.",
        "INDEX_DB_CONTENDED",
      );
    }
    throw new UsageError(NO_INDEX_MESSAGE, "MISSING_REQUIRED_ARGUMENT", "akm index");
  }
  const { db } = usable;
  try {
    const requestedSource = parsedRef.bundle ? resolveSourcesForOrigin(parsedRef.bundle, sources)[0] : undefined;
    if (parsedRef.bundle && !requestedSource) {
      throw new UsageError(`Source "${parsedRef.bundle}" is not configured.`, "INVALID_FLAG_VALUE");
    }
    const lookupRef = makeBundleRef(parsedRef.bundle, currentConceptId(parsedRef, sources));
    const entryId = findEntryIdByRef(db, lookupRef, parsedRef.bundle);
    if (entryId === undefined) {
      // NotFoundError (exit 1), not UsageError (exit 2): the flags parsed
      // fine, the asset just isn't there. The documented exit-code table
      // reserves 1 for "requested resource missing", and scripts branch on it.
      throw new NotFoundError(
        `Ref "${ref}" is not in the index. ` +
          "Run 'akm search' to verify the asset exists, then 'akm index' if it was recently added.",
        "ASSET_NOT_FOUND",
      );
    }
    // Persist the feedback signal into usage_events. A user-attributed signal
    // also recomputes the entry's utility at once (see recordFeedbackUsage).
    // Search ranking reads the recorded events directly, so no `akm index`
    // run is needed.
    // WI-8.5b: the `feedback` / `improve_review_needed` events key on the
    // resolved entry's fully-qualified item_ref — the SAME durable key the
    // usage_events row carries and the SAME spelling the signal-delta
    // correlation reads (buildLatestFeedbackTsMap, collapsed to [item_ref]).
    const itemRef = getItemRefById(db, entryId);
    if (!itemRef) throw new UsageError(`Indexed ref "${ref}" has no durable item ref.`, "INVALID_PROPOSAL");
    durableRef = itemRef;
    const filePath = getEntryFilePathById(db, entryId);
    const { bundle, conceptId } = parseBundleRef(itemRef);
    shownRef = displayRef(
      { conceptId, bundleId: bundle },
      displayDefaultBundle(config.defaultBundle, filePath ? findSourceForPath(filePath, sources) : undefined, bundle),
    );
    const entryType = getEntryById(db, entryId)?.entry.type;
    const textHash = judgedTextHash(entryType, filePath);
    if (textHash) metadataObj.contentHash = textHash;
    if (request.pairs.length > 0 || request.hasMark) {
      // Checked before anything is recorded, so a fix that does not apply leaves no trace.
      fix = prepareFix(db, config, sources, itemRef, entryType, filePath, request);
      metadataObj.fix = { source: request.source, replacements: request.pairs.length, ...fix.marked };
    }
    const metadataStr = Object.keys(metadataObj).length > 1 ? JSON.stringify(metadataObj) : undefined;
    const recordResult = recordFeedbackUsage(db, entryId, itemRef, signal, metadataStr);
    utilityResult = recordResult.utilityResult;
    countsTowardRanking = recordResult.countsTowardRanking;
    rankingSkippedReason = recordResult.rankingSkippedReason;
  } catch (error) {
    if (isCorruptionError(error) && indexDbIsDamaged())
      throw new UsageError(NO_INDEX_MESSAGE, "MISSING_REQUIRED_ARGUMENT", "akm index");
    throw error;
  } finally {
    closeDatabase(db);
  }

  appendEvent({
    eventType: "feedback",
    ref: durableRef,
    metadata: metadataObj,
  });

  const fixProposal =
    fix && reason?.trim() && request.source
      ? await applyFix(durableRef, fix, reason.trim(), request.source)
      : undefined;
  escalateIfBelowReview(ref, durableRef, utilityResult, reason);
  const appliedToResult = creditAppliedLesson(input.appliedTo, signal, durableRef);

  return {
    ok: true,
    ref: shownRef,
    signal,
    reason: reason?.trim() ?? null,
    tags: validatedTags,
    rankingUpdate: countsTowardRanking
      ? { applied: true }
      : { applied: false, reason: rankingSkippedReason ?? "unknown" },
    ...(fixProposal
      ? {
          fix: {
            proposalId: fixProposal.id,
            replacements: request.pairs.length,
            source: request.source,
            ...fix?.marked,
          },
        }
      : {}),
    ...(appliedToResult
      ? { appliedTo: { ref: appliedToResult.lessonRef, lessonStrength: appliedToResult.strength } }
      : {}),
  };
}
