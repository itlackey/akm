// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { defineJsonCommand, output, parseAllFlagValues } from "../cli/shared";
import { parseAssetRef } from "../core/asset/asset-ref";
import { assembleAsset } from "../core/asset/asset-serialize";
import { parseFrontmatter, parseFrontmatterBlock } from "../core/asset/frontmatter";
import { writeFileAtomic } from "../core/common";
import { FEEDBACK_FAILURE_MODES, loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import {
  applyFeedbackToUtilityScore,
  closeDatabase,
  findEntryIdByRef,
  getEntryFilePathById,
  openExistingDatabase,
} from "../indexer/db/db";
import { countFeedbackSignals, insertUsageEvent } from "../indexer/usage/usage-events";

// ── Tag validation ────────────────────────────────────────────────────────────

const TAG_KEY_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_FEEDBACK_TAGS = 10;

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
    const key = parts[0];
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
  if (out.length > MAX_FEEDBACK_TAGS) {
    throw new UsageError(`Too many tags: ${out.length}. Maximum is ${MAX_FEEDBACK_TAGS}.`, "INVALID_FLAG_VALUE");
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
function appendLessonStrength(type: string, name: string, feedbackRef: string): { strength: number } | null {
  const ref = `${type}:${name}`;
  let filePath: string | undefined;
  const db = openExistingDatabase();
  try {
    const entryId = findEntryIdByRef(db, ref);
    if (entryId === undefined) {
      warn(`[feedback] --applied-to: lesson ${ref} is not in the index.`);
      return null;
    }
    const resolvedPath = getEntryFilePathById(db, entryId);
    if (!resolvedPath) {
      warn(`[feedback] --applied-to: cannot resolve file path for ${ref}.`);
      return null;
    }
    filePath = resolvedPath;
  } finally {
    closeDatabase(db);
  }

  if (!filePath || !fs.existsSync(filePath)) {
    warn(`[feedback] --applied-to: lesson file missing on disk for ${ref}.`);
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  const data = { ...parsed.data };
  const existing = data.lessonStrength;
  const strengthList: string[] = Array.isArray(existing)
    ? existing.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : typeof existing === "string" && existing.trim().length > 0
      ? [existing.trim()]
      : [];
  if (strengthList.includes(feedbackRef)) {
    // Already credited — idempotent no-op.
    return { strength: strengthList.length };
  }
  strengthList.push(feedbackRef);
  data.lessonStrength = strengthList;

  const block = parseFrontmatterBlock(raw);
  const body = block?.content ?? raw;
  const next = assembleAsset(data, body);
  try {
    // Preserve the existing file's permission bits (markdown assets are
    // typically 0o644); writeFileAtomic defaults to 0o600 otherwise.
    const mode = fs.statSync(filePath).mode & 0o777;
    writeFileAtomic(filePath, next, mode);
  } catch (err) {
    warn(`[feedback] --applied-to: failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return { strength: strengthList.length };
}

// ── Command definition ────────────────────────────────────────────────────────

export const feedbackCommand = defineJsonCommand({
  meta: {
    name: "feedback",
    description:
      "Record positive or negative feedback for any indexed stash asset.\n\n" +
      "Positive feedback boosts an asset's EMA utility score, making it rank higher\n" +
      "in future searches without requiring a full reindex.\n\n" +
      "Negative feedback records a negative signal in usage_events and state.db events.\n" +
      "It does NOT immediately lower the asset's ranking — the EMA utility score is\n" +
      "updated the next time `akm index` runs (incremental or full). Run `akm index`\n" +
      "after recording negative feedback to have it reflected in search results.",
  },
  args: {
    // Optional in citty so run() is invoked even when omitted; we re-validate
    // and throw a structured UsageError below so exit code is 2 (USAGE) rather
    // than citty's default 0 (help banner).
    ref: { type: "positional", description: "Asset ref (type:name)", required: false },
    positive: { type: "boolean", description: "Record positive feedback (boosts ranking immediately)", default: false },
    negative: {
      type: "boolean",
      description:
        "Record negative feedback (suppresses ranking after next `akm index`). " +
        "Reindexing is required for the signal to affect search results.",
      default: false,
    },
    reason: {
      type: "string",
      description: "Reason for the feedback (required for negative feedback by default; used by distillation)",
    },
    "failure-mode": {
      type: "string",
      description:
        `Structured failure-mode taxonomy for negative feedback (F-3 / #384). ` +
        `Accepted values: ${FEEDBACK_FAILURE_MODES.join(", ")}. ` +
        "Stored alongside --reason in event metadata for aggregation by the distill pipeline.",
    },
    tag: {
      type: "string",
      description: "Tag to attach to the feedback (repeatable, e.g. --tag slice:train --tag team:platform)",
    },
    "applied-to": {
      type: "string",
      description:
        "Credit a lesson that helped resolve this task. Accepts a `lesson:<name>` ref. " +
        "When combined with --positive, appends this feedback ref to the target lesson's " +
        "`lessonStrength[]` frontmatter array (dedup, idempotent). Ignored on non-lesson targets.",
    },
  },
  async run({ args }) {
    const ref = (args.ref ?? "").trim();
    if (!ref) {
      throw new UsageError(
        "Asset ref is required. Usage: akm feedback <ref> --positive|--negative",
        "MISSING_REQUIRED_ARGUMENT",
        "Pass a ref like `skill:deploy` and either --positive or --negative.",
      );
    }
    parseAssetRef(ref);
    if (args.positive && args.negative) {
      throw new UsageError("Specify either --positive or --negative, not both.");
    }
    if (!args.positive && !args.negative) {
      throw new UsageError("Specify --positive or --negative.");
    }
    const signal = args.positive ? "positive" : "negative";
    const reason = args.reason as string | undefined;

    // F-3 / #384: Validate --failure-mode against the curated enum.
    const failureMode = (args["failure-mode"] as string | undefined)?.trim() || undefined;
    if (failureMode) {
      if (args.positive) {
        throw new UsageError(
          "--failure-mode is only valid for negative feedback.",
          "INVALID_FLAG_VALUE",
          "Remove --failure-mode or switch to --negative.",
        );
      }
      const cfg = loadConfig();
      const allowedModes: readonly string[] = cfg.feedback?.allowedFailureModes ?? FEEDBACK_FAILURE_MODES;
      if (allowedModes.length > 0 && !allowedModes.includes(failureMode)) {
        throw new UsageError(
          `Invalid --failure-mode "${failureMode}". Accepted values: ${allowedModes.join(", ")}.`,
          "INVALID_FLAG_VALUE",
          `Use one of: ${allowedModes.join(", ")}`,
        );
      }
    }

    if (args.negative === true && !reason?.trim()) {
      // F-3 / #384: Default requireReason is now true. Load config to allow
      // operators to opt out via feedback.requireReason: false in akm.json.
      const cfg = loadConfig();
      const requireReason = cfg.feedback?.requireReason ?? true; // Default: true (F-3 / #384)
      if (requireReason) {
        throw new UsageError(
          "Negative feedback requires --reason (structured failure signals are needed for distillation). " +
            "Use --failure-mode for a curated taxonomy or --reason for free text. " +
            "Set feedback.requireReason: false in akm.json to downgrade to a warning.",
          "MISSING_REQUIRED_ARGUMENT",
          `Hint: akm feedback ${ref} --negative --reason "..." [--failure-mode incorrect|outdated|dangerous|incomplete|redundant]`,
        );
      } else {
        warn("Warning: negative feedback without --reason provides less distillation signal.");
      }
    }
    const rawTags = parseAllFlagValues("--tag");
    const validatedTags = validateFeedbackTags(rawTags);
    const metadataObj = {
      signal,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      ...(failureMode ? { failureMode } : {}),
      ...(validatedTags.length > 0 ? { tags: validatedTags } : {}),
    };
    const metadataStr = Object.keys(metadataObj).length > 1 ? JSON.stringify(metadataObj) : undefined;

    // Feedback only needs the index to exist, not to be current. A stale index
    // is fine — the ref lookup works against any populated DB. We do NOT call
    // ensureIndex here: it either blocks (3+ min inline reindex) or spawns a
    // background process that holds the writer lock, causing the feedback write
    // to spin-wait for the full reindex duration. If the DB is absent we give a
    // clear error below rather than silently triggering a rebuild.
    if (!fs.existsSync(getDbPath())) {
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
    const db = openExistingDatabase();
    try {
      const entryId = findEntryIdByRef(db, ref);
      if (entryId === undefined) {
        throw new UsageError(
          `Ref "${ref}" is not in the index. ` +
            "Run 'akm search' to verify the asset exists, then 'akm index' if it was recently added.",
        );
      }
      // Persist the feedback signal into usage_events. For positive signals,
      // the EMA utility score is updated immediately on the next read path.
      // For negative signals, the score is adjusted the next time `akm index`
      // runs — the signal is durable in the DB but does NOT suppress ranking
      // in search results until after reindexing.
      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: ref,
        entry_id: entryId,
        signal,
        metadata: metadataStr,
      });

      // Apply feedback-derived utility score adjustment immediately so that
      // positive/negative signals influence search ranking without requiring
      // a full reindex. We query the total accumulated feedback counts from
      // usage_events so the delta reflects the entire signal history.
      // Uses MemRL bounded-step EMA (F-5 / #386, arXiv:2601.03192).
      try {
        const { pos, neg } = countFeedbackSignals(db, entryId);
        utilityResult = applyFeedbackToUtilityScore(db, entryId, pos, neg);
      } catch {
        // best-effort — feedback recording succeeds even if utility update fails
      }
    } finally {
      closeDatabase(db);
    }

    appendEvent({
      eventType: "feedback",
      ref,
      metadata: metadataObj,
    });

    // F-5 / #386: When a high-utility asset crosses below the review threshold,
    // auto-create a review-needed escalation proposal so a human can confirm
    // whether the negative feedback is valid before the asset falls out of
    // the improve loop. Best-effort — failure is logged but does not fail the
    // feedback command.
    // Emit a structured event rather than a proposal so the review-needed
    // signal is queryable via `akm events list --type improve_review_needed`
    // without risking accidental asset overwrite if the proposal is accepted.
    if (utilityResult?.crossedReviewThreshold) {
      try {
        appendEvent({
          eventType: "improve_review_needed",
          ref,
          metadata: {
            previousUtility: utilityResult.previousUtility,
            nextUtility: utilityResult.nextUtility,
            reason: reason?.trim() ?? null,
            failureMode: failureMode ?? null,
          },
        });
      } catch (escalationErr) {
        warn(
          `[feedback] Could not emit review-needed event for ${ref}: ${escalationErr instanceof Error ? escalationErr.message : String(escalationErr)}`,
        );
      }
    }

    // Phase 7A / Advantage D4b: --applied-to credits a lesson. When the
    // target is a `lesson:<name>` ref and the signal is positive, append
    // the feedback ref to the target lesson's `lessonStrength[]`
    // frontmatter array (dedup, idempotent). Non-lesson targets are
    // ignored. Failures here are warnings — feedback recording is the
    // primary contract and must not regress on lesson-write errors.
    const appliedToRaw = (args["applied-to"] as string | undefined)?.trim();
    let appliedToResult: { lessonRef: string; strength: number } | null = null;
    if (appliedToRaw && signal === "positive") {
      try {
        const parsedApplied = parseAssetRef(appliedToRaw);
        if (parsedApplied.type === "lesson") {
          const updated = appendLessonStrength(parsedApplied.type, parsedApplied.name, ref);
          if (updated) {
            appliedToResult = { lessonRef: appliedToRaw, strength: updated.strength };
          }
        }
      } catch (err) {
        warn(`[feedback] --applied-to failed for ${appliedToRaw}: ${err instanceof Error ? err.message : String(err)}`);
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
      failureMode: failureMode ?? null,
      tags: validatedTags,
      ...(appliedToResult
        ? { appliedTo: { ref: appliedToResult.lessonRef, lessonStrength: appliedToResult.strength } }
        : {}),
    });
  },
});
