// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { parse as yamlParse } from "yaml";
import { defineJsonCommand, output, parseAllFlagValues } from "../cli/shared";
import { makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { assembleAsset } from "../core/asset/asset-serialize";
import { parseFrontmatter, parseFrontmatterBlock } from "../core/asset/frontmatter";
import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../core/asset/resolve-ref";
import { isWithin, resolveStashDir, writeFileAtomic } from "../core/common";
import { loadConfig } from "../core/config/config";
import { NotFoundError, UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { resolveMutationTarget } from "../core/mutation-target";
import { isPathAbsent } from "../core/path-access";
import { getDbPath } from "../core/paths";
import { withStateDb } from "../core/state-db";
import { warn } from "../core/warn";
import { withWriteTargetMutation } from "../core/write-source";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { countFeedbackSignals, insertUsageEvent, resolveUsageEventSource } from "../indexer/usage/usage-events";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import type { Database } from "../storage/database";
import { closeDatabase, openExistingDatabase } from "../storage/repositories/index-connection";
import {
  findEntryIdByRef,
  getEntryFilePathById,
  getItemRefById,
} from "../storage/repositories/index-entries-repository";
import { applyFeedbackToUtilityScore } from "../storage/repositories/index-utility-repository";
import { createProposal } from "./proposal/repository";

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
function appendLessonStrength(refInput: AssetRef, feedbackRef: string): { ref: string; strength: number } | null {
  // Canonical conceptId (`lessons/<name>`, D-R3): `findEntryIdByRef` keys on
  // the stored `item_ref`.
  const conceptId = conceptIdFromTypeName(refInput.type, refInput.name);
  const config = loadConfig();
  let filePath: string | undefined;
  let bundleId: string | undefined;
  const db = openExistingDatabase();
  try {
    const entryId = findEntryIdByRef(db, makeBundleRef(refInput.origin, conceptId));
    if (entryId !== undefined) {
      const itemRef = getItemRefById(db, entryId);
      const parsedItemRef = itemRef ? parseBundleRef(itemRef) : undefined;
      filePath = getEntryFilePathById(db, entryId) ?? undefined;
      bundleId = parsedItemRef?.bundle;
    }
  } finally {
    closeDatabase(db);
  }

  const requestedRef = makeBundleRef(refInput.origin, conceptId);
  if (!filePath || !bundleId || !fs.existsSync(filePath)) {
    warn(`[feedback] --applied-to: lesson ${requestedRef} is not in the index or is missing on disk.`);
    return null;
  }

  const resolved = resolveMutationTarget(config, { ...refInput, origin: bundleId });
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

/**
 * Result of {@link recordFeedbackUsage}: the raw utility-policy result (when
 * the update ran) plus whether the ranking update was actually applied, and
 * why not when it wasn't. R-034: the caller could not previously distinguish
 * "no update needed" from "update was skipped" — this makes that explicit so
 * `akm feedback`'s response envelope can report it instead of staying silent.
 */
interface RecordFeedbackUsageResult {
  utilityResult: ReturnType<typeof applyFeedbackToUtilityScore> | undefined;
  rankingUpdateApplied: boolean;
  /** Set whenever `rankingUpdateApplied` is false; explains why. */
  rankingUpdateSkippedReason: string | undefined;
}

/**
 * Persist the feedback usage-event (state.db) and immediately fold it into the
 * entry's MemRL utility score (index.db). Chunk-8 WI-8.3: usage_events lives in
 * state.db; entries + utility_scores stay in `indexDb`. BOTH positive and
 * negative signals apply the EMA utility update unconditionally and
 * immediately when the source is user-attributed — no `akm index` run is
 * required for either signal to affect search ranking. Uses the bounded-step
 * EMA policy (F-5 / #386, arXiv:2601.03192).
 *
 * The update is intentionally SKIPPED for non-`user` event sources (`improve`,
 * `task`, `audit`, `unknown`) — an anti-self-reinforcement guard that stops an
 * agent or automated pipeline from boosting its own picks. This is by design
 * and must not be removed; R-034 only asks that the skip be surfaced to the
 * caller rather than passing silently. Best-effort: a utility-update failure
 * never fails the feedback record.
 */
function recordFeedbackUsage(
  indexDb: Database,
  entryId: number,
  durableEntryRef: string,
  signal: "positive" | "negative",
  metadataStr: string | undefined,
): RecordFeedbackUsageResult {
  let utilityResult: ReturnType<typeof applyFeedbackToUtilityScore> | undefined;
  let rankingUpdateApplied = false;
  let rankingUpdateSkippedReason: string | undefined;
  const eventSource = resolveUsageEventSource();
  withStateDb((stateDb) => {
    insertUsageEvent(stateDb, {
      event_type: "feedback",
      entry_ref: durableEntryRef,
      entry_id: entryId,
      signal,
      metadata: metadataStr,
      source: eventSource,
    });
    if (eventSource !== "user") {
      rankingUpdateSkippedReason =
        `feedback source is "${eventSource}", not "user" — ranking updates only apply to user-attributed ` +
        "feedback (anti-self-reinforcement guard; set AKM_EVENT_SOURCE=user to record as user demand).";
      return;
    }
    try {
      const { pos, neg } = countFeedbackSignals(stateDb, entryId);
      utilityResult = applyFeedbackToUtilityScore(indexDb, entryId, pos, neg);
      rankingUpdateApplied = true;
    } catch (err) {
      // best-effort — feedback recording succeeds even if utility update fails
      rankingUpdateSkippedReason = `utility update failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  return { utilityResult, rankingUpdateApplied, rankingUpdateSkippedReason };
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

// ── Command definition ────────────────────────────────────────────────────────

export const feedbackCommand = defineJsonCommand({
  meta: {
    name: "feedback",
    description:
      "Record positive or negative feedback for any indexed bundle asset.\n\n" +
      '`akm feedback <ref> --negative --reason "<what is wrong and what should change>"` flags\n' +
      "the asset: the next improve run may repair its description, title or when_to_use from\n" +
      "your reason, but it does not rewrite the text. To correct a wrong fact in the text, attach\n" +
      'the exact fix: --replace "<exact current text>" --with "<corrected text>" --source "<URL,\n' +
      'command or file that shows it>" (repeat --replace/--with for several edits; use --with=...\n' +
      "for a value that starts with -). akm checks that each --replace text appears exactly once\n" +
      "and queues the edit as a proposal for review. `--positive` records that an asset helped\n" +
      "(it raises its ranking) and does not trigger a rewrite.\n\n" +
      "Both signals adjust the asset's usefulness score right away, in the same\n" +
      "process: positive feedback raises it, negative lowers it, and recent\n" +
      "feedback counts for more than old feedback. No reindex is needed — the new\n" +
      "score affects ranking starting with the very next `akm search`.",
  },
  args: {
    // Optional in citty so run() is invoked even when omitted; we re-validate
    // and throw a structured UsageError below so exit code is 2 (USAGE) rather
    // than citty's default 0 (help banner).
    ref: { type: "positional", description: "Asset ref ([bundle//]conceptId, e.g. lessons/deploy)", required: false },
    positive: {
      type: "boolean",
      description: "Record that the asset helped (raises its ranking immediately; does not trigger a rewrite)",
      default: false,
    },
    negative: {
      type: "boolean",
      description:
        "Flag the asset: lowers its ranking immediately (no reindex needed), and the next improve run may repair its frontmatter from --reason. Attach --replace/--with/--source to correct its text.",
      default: false,
    },
    reason: {
      type: "string",
      description:
        "What is wrong with the asset's content and what should change, specifically (required for negative feedback by default). Not for akm command errors.",
    },
    replace: {
      type: "string",
      description:
        "Exact text to correct, copied verbatim from the asset file; it must appear exactly once (repeatable, each paired with a --with in order). Negative feedback only.",
    },
    with: {
      type: "string",
      description: "Corrected text for the matching --replace (repeatable, in the same order).",
    },
    source: {
      type: "string",
      description: "Where the correct fact comes from: a URL, command or file. Required with --replace.",
    },
    tag: {
      type: "string",
      description: "Tag to attach to the feedback (repeatable, e.g. --tag slice:train --tag team:platform)",
    },
    "applied-to": {
      type: "string",
      description:
        "Credit a lesson that helped resolve this task. Accepts a `lessons/<name>` ref. " +
        "When combined with --positive, appends this feedback ref to the target lesson's " +
        "`lessonStrength[]` frontmatter array (dedup, idempotent). A non-lesson target or a " +
        "missing --positive produces a warning rather than silently doing nothing.",
    },
  },
  async run({ args }) {
    const ref = (args.ref ?? "").trim();
    if (!ref) {
      throw new UsageError(
        "Asset ref is required. Usage: akm feedback <ref> --positive|--negative",
        "MISSING_REQUIRED_ARGUMENT",
        "Pass a ref like `skills/deploy` and either --positive or --negative.",
      );
    }
    const parsedRef = parseBundleRef(ref);
    if (args.positive && args.negative) {
      throw new UsageError("Specify either --positive or --negative, not both.");
    }
    if (!args.positive && !args.negative) {
      throw new UsageError("Specify --positive or --negative.");
    }
    const signal = args.positive ? "positive" : "negative";
    const reason = args.reason as string | undefined;

    // An exact fix for the asset's text: each --replace pairs with a --with, in order.
    const replaces = parseAllFlagValues("--replace");
    const withs = parseAllFlagValues("--with");
    const fixSource = (args.source as string | undefined)?.trim() || undefined;
    const fixPairs = replaces.map((old, i) => ({ old, new: withs[i] ?? "" }));
    if (replaces.length > 0 || withs.length > 0 || fixSource !== undefined) {
      if (!args.negative) {
        throw new UsageError("--replace, --with and --source are only for negative feedback.", "INVALID_FLAG_VALUE");
      }
      if (replaces.length === 0 || replaces.length !== withs.length) {
        throw new UsageError(
          `Each --replace needs one --with (got ${replaces.length} --replace and ${withs.length} --with).`,
          "INVALID_FLAG_VALUE",
        );
      }
      if (!fixSource) {
        throw new UsageError(
          "A fix needs --source: the URL, command or file that shows the correct fact.",
          "MISSING_REQUIRED_ARGUMENT",
        );
      }
      if (!reason?.trim()) {
        throw new UsageError("A fix needs --reason: say what is wrong.", "MISSING_REQUIRED_ARGUMENT");
      }
    }

    if (args.negative === true && !reason?.trim()) {
      // F-3 / #384: Default requireReason is now true. Load config to allow
      // operators to opt out via feedback.requireReason: false in akm.json.
      const cfg = loadConfig();
      const requireReason = cfg.feedback?.requireReason ?? true; // Default: true (F-3 / #384)
      if (requireReason) {
        throw new UsageError(
          "Negative feedback requires --reason: say what is wrong and what should change. " +
            "Set feedback.requireReason: false in akm.json to downgrade to a warning.",
          "MISSING_REQUIRED_ARGUMENT",
          `Hint: akm feedback ${ref} --negative --reason "<what is wrong and what should change>"`,
        );
      } else {
        warn("Warning: negative feedback without --reason says nothing about what is wrong.");
      }
    }
    const rawTags = parseAllFlagValues("--tag");
    const validatedTags = validateFeedbackTags(rawTags);
    const metadataObj = {
      signal,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      ...(validatedTags.length > 0 ? { tags: validatedTags } : {}),
      ...(fixPairs.length > 0 ? { fix: { source: fixSource, replacements: fixPairs.length } } : {}),
    };
    const metadataStr = Object.keys(metadataObj).length > 1 ? JSON.stringify(metadataObj) : undefined;

    // Feedback only needs the index to exist, not to be current. A stale index
    // is fine — the ref lookup works against any populated DB. We do NOT call
    // ensureIndex here: it either blocks (3+ min inline reindex) or spawns a
    // background process that holds the writer lock, causing the feedback write
    // to spin-wait for the full reindex duration. If the DB is absent we give a
    // clear error below rather than silently triggering a rebuild.
    // "Run 'akm index' first" is only true advice for an index that was never
    // built. Told to someone whose index exists but is unreadable it is a lie
    // that sends them to rebuild a file they may not have permission to touch
    // (#791), so that case falls through to `openExistingDatabase` below, which
    // names the path, errno, mode/owner and uid instead.
    if (isPathAbsent(getDbPath())) {
      throw new UsageError(
        "Index not found. Run 'akm index' first to build the index before recording feedback.",
        "MISSING_REQUIRED_ARGUMENT",
        "akm index",
      );
    }

    // Feedback writes exactly 2 rows (usage_events + utility_score). SQLite
    // WAL mode + busy_timeout=30s handles concurrent access with an ongoing
    // `akm improve` run without needing the application-level writer lock.
    // The lock was originally needed to prevent feedback from racing a
    // background reindex it spawned — now that ensureIndex is removed, holding
    // the lock only causes feedback to block for the full improve run duration.
    let utilityResult: ReturnType<typeof applyFeedbackToUtilityScore> | undefined;
    let rankingUpdateApplied = false;
    let rankingUpdateSkippedReason: string | undefined;
    let durableRef = ref;
    let fix: { content: string; target: { source: string; root: string } } | undefined;
    const db = openExistingDatabase();
    try {
      const config = loadConfig();
      const sources = resolveSourceEntries(undefined, config);
      const requestedSource = parsedRef.bundle ? resolveSourcesForOrigin(parsedRef.bundle, sources)[0] : undefined;
      if (parsedRef.bundle && !requestedSource) {
        throw new UsageError(`Source "${parsedRef.bundle}" is not configured.`, "INVALID_FLAG_VALUE");
      }
      const lookupRef = makeBundleRef(parsedRef.bundle, parsedRef.conceptId);
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
      // Persist the feedback signal into usage_events. Both positive and
      // negative signals apply the EMA utility update immediately — no
      // `akm index` run is required for either signal to affect ranking in
      // search results (see recordFeedbackUsage / applyFeedbackToUtilityScore).
      // WI-8.5b: the `feedback` / `improve_review_needed` events key on the
      // resolved entry's fully-qualified item_ref — the SAME durable key the
      // usage_events row carries and the SAME spelling the signal-delta
      // correlation reads (buildLatestFeedbackTsMap, collapsed to [item_ref]).
      const itemRef = getItemRefById(db, entryId);
      if (!itemRef) throw new UsageError(`Indexed ref "${ref}" has no durable item ref.`, "INVALID_PROPOSAL");
      durableRef = itemRef;
      if (fixPairs.length > 0) {
        // Checked before anything is recorded, so a fix that does not apply leaves no trace.
        const filePath = getEntryFilePathById(db, entryId);
        if (!filePath || !fs.existsSync(filePath)) {
          throw new NotFoundError(`The file for ${itemRef} is missing on disk.`, "ASSET_NOT_FOUND");
        }
        const resolved = resolveMutationTarget(config, parseRefInput(itemRef), undefined, { requireWritable: true });
        if (!isWithin(filePath, resolved.target.source.path)) {
          throw new UsageError(`${itemRef} is outside bundle "${resolved.target.source.name}".`);
        }
        const before = fs.readFileSync(filePath, "utf8");
        const after = applyExactReplacements(before, fixPairs, filePath);
        if (after === before) throw new UsageError("The fix changes nothing.", "INVALID_FLAG_VALUE");
        assertFrontmatterStillParses(before, after, filePath);
        fix = { content: after, target: { source: resolved.target.source.name, root: resolved.target.source.path } };
      }
      const recordResult = recordFeedbackUsage(db, entryId, itemRef, signal, metadataStr);
      utilityResult = recordResult.utilityResult;
      rankingUpdateApplied = recordResult.rankingUpdateApplied;
      rankingUpdateSkippedReason = recordResult.rankingUpdateSkippedReason;
    } finally {
      closeDatabase(db);
    }

    appendEvent({
      eventType: "feedback",
      ref: durableRef,
      metadata: metadataObj,
    });

    const fixProposal =
      fix && reason?.trim() && fixSource
        ? createProposal(resolveStashDir(), {
            ref: durableRef,
            itemRef: durableRef,
            target: fix.target,
            source: "feedback",
            payload: { content: fix.content },
            feedback: { reason: reason.trim(), source: fixSource },
          })
        : undefined;

    // F-5 / #386: When a high-utility asset crosses below the review threshold,
    // auto-create a review-needed escalation proposal so a human can confirm
    // whether the negative feedback is valid before the asset falls out of
    // the improve loop. Best-effort — failure is logged but does not fail the
    // feedback command.
    // Emit a structured event rather than a proposal so the review-needed
    // signal doesn't risk an accidental asset overwrite if the proposal is
    // accepted.
    if (utilityResult?.crossedReviewThreshold) {
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

    // Phase 7A / Advantage D4b: --applied-to credits a lesson. When the
    // target is a `lessons/<name>` ref and the signal is positive, append
    // the feedback ref to the target lesson's `lessonStrength[]`
    // frontmatter array (dedup, idempotent). Non-lesson targets are REJECTED
    // with a loud warning (R-033b) rather than silently doing nothing.
    // Failures here are warnings — feedback recording is the primary
    // contract and must not regress on lesson-write errors.
    const appliedToRaw = (args["applied-to"] as string | undefined)?.trim();
    let appliedToResult: { lessonRef: string; strength: number } | null = null;
    if (appliedToRaw && signal === "positive") {
      let parsedApplied: AssetRef | undefined;
      try {
        parsedApplied = parseRefInput(appliedToRaw);
      } catch (err) {
        warn(`[feedback] --applied-to failed for ${appliedToRaw}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (parsedApplied) {
        if (parsedApplied.type === "lesson") {
          const updated = appendLessonStrength(parsedApplied, durableRef);
          if (updated) {
            appliedToResult = { lessonRef: updated.ref, strength: updated.strength };
          }
        } else {
          warn(
            `[feedback] --applied-to ${appliedToRaw} was ignored: it resolves to a "${parsedApplied.type}" asset, ` +
              "not a lesson. Only `lessons/<name>` refs can be credited via --applied-to.",
          );
        }
      }
    } else if (appliedToRaw && signal !== "positive") {
      warn(
        "[feedback] --applied-to is ignored without --positive; lesson credit is only recorded on positive signals.",
      );
    }

    output("feedback", {
      ok: true,
      ref,
      signal,
      reason: reason?.trim() ?? null,
      tags: validatedTags,
      rankingUpdate: rankingUpdateApplied
        ? { applied: true }
        : { applied: false, reason: rankingUpdateSkippedReason ?? "unknown" },
      ...(fixProposal ? { fix: { proposalId: fixProposal.id, replacements: fixPairs.length, source: fixSource } } : {}),
      ...(appliedToResult
        ? { appliedTo: { ref: appliedToResult.lessonRef, lessonStrength: appliedToResult.strength } }
        : {}),
    });
  },
});
