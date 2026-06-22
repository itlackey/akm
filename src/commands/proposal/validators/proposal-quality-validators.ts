// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared content-quality validators consumed by the improve pipeline
 * (`distill`, `consolidate`, `reflect`) and by the `proposal accept` gate.
 *
 * ## Reflect size gate — calibrated blended formula (2026-05-22)
 *
 * ### Distribution baseline (n=844 reflect-eligible stash assets)
 *
 *   min=1  p10=371  p25=778  p50=1508  p75=5456  p90=11721  p99=43463  max=298010 bytes
 *   Buckets: <500=135 (16%), 500–2000=340 (40%), 2000–8000=222 (26%), >8000=147 (17%)
 *
 * ### Problem with the original fixed-ratio gate
 *
 *   - Small sources (~420 bytes, 16th pct): the 200% expansion ceiling fires at
 *     only 840 bytes proposed — one good paragraph.  Hair-trigger for a terse
 *     reference note.
 *   - Large sources (~7KB, 75th pct): 200% ceiling = 14KB; reasonable, but a hard
 *     cap prevents runaway expansion from LLM hallucinations.
 *
 * ### Blended-bound formula
 *
 *   Shrinkage floor (accept if proposed >= lower):
 *     lower = max(REFLECT_SHRINK_RATIO_MIN * sourceLen, REFLECT_ABSOLUTE_FLOOR_BYTES)
 *     → For tiny sources (sourceLen < 300), the absolute floor dominates so a
 *       genuinely tightened note still passes.
 *     → For large sources (>1KB), the ratio floor dominates (50% of 7KB = 3.5KB).
 *
 *   Expansion ceiling (accept if proposed <= upper):
 *     upper = max(REFLECT_EXPAND_RATIO_MAX * sourceLen, REFLECT_ABSOLUTE_CEILING_BYTES)
 *     …but always capped at REFLECT_ABSOLUTE_MAX_BYTES.
 *     → For small sources (≤778 bytes, p25), the absolute ceiling (2000 bytes)
 *       dominates — one substantive paragraph is always acceptable.
 *     → For medium/large sources (>1KB), the ratio ceiling dominates.
 *     → Any proposal exceeding 25000 bytes is always rejected regardless of ratio.
 *
 * ### Constant calibration rationale
 *
 *   REFLECT_ABSOLUTE_FLOOR_BYTES = 150
 *     Half of p10 (371) ≈ 185; we set 150 so even very aggressive condensation
 *     of a seed note is allowed down to roughly a two-sentence summary.
 *
 *   REFLECT_ABSOLUTE_CEILING_BYTES = 2500
 *     Raised from 2000 (2026-05-22): small-source rejections at 248–281% on
 *     900–953 byte assets were borderline false positives. 2500 gives a short
 *     lesson or command ~1.5KB of room to grow before the absolute kicks in.
 *
 *   REFLECT_ABSOLUTE_MAX_BYTES = 25000
 *     Below p99 (43463). Catches genuine LLM runaway (whole-chapter insertions)
 *     without blocking legitimate large rewrites of large sources.
 *
 *   REFLECT_EXPAND_RATIO_MAX = 2.5
 *     Raised from 2.0 (2026-05-22): 2× was too tight for dense short assets
 *     (lessons, commands) that have legitimate room to grow. 2.5× resolves
 *     248% expansion on a 900-byte lesson while still catching 281%+ on ~1KB
 *     assets where the absolute ceiling takes over.
 */

// ── Reflect-size guard ───────────────────────────────────────────────────────

import { parseFrontmatter } from "../../../core/asset/frontmatter";
import {
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MIN_CHARS,
  WHEN_TO_USE_MAX_CHARS,
  WHEN_TO_USE_MIN_CHARS,
} from "../../../core/authoring-rules";
import { detectTruncatedDescription, TRUNCATION_TRAILING_WORDS } from "../../../core/text-truncation";
import type { ProposalValidator } from "./proposal-validators";

// ── Description / when_to_use shape ─────────────────────────────────────────

export const HEADING_FRAGMENT_PATTERNS: readonly RegExp[] = [
  /^for example\b/i,
  /^to reduce\b/i,
  /^key (pitfalls|fixes|points|takeaways|considerations|steps|notes|tips|insights|features|benefits|risks)\b/i,
  /^example[s]?$/i,
  /^summary$/i,
  /^overview$/i,
  /^introduction$/i,
  /^takeaways$/i,
  /^conclusion$/i,
  /^notes?$/i,
  /^tips?$/i,
];

export interface DescriptionValidationOptions {
  /**
   * Skip the heuristic that flags descriptions which "appear to just name the
   * input ref" (e.g. a lesson `lesson:deploy-tips` with description "deploy
   * tips"). Useful for asset types like `knowledge` where a description that
   * mentions the topic name is perfectly normal — only the placeholder and
   * shape checks should apply.
   */
  skipRefTailCheck?: boolean;
}

export function isValidDescription(
  value: unknown,
  inputRef: string,
  options: DescriptionValidationOptions = {},
): { ok: true } | { ok: false; reason: string; severity?: "warn" } {
  if (typeof value !== "string") return { ok: false, reason: "description is not a string" };
  const v = value.trim();
  if (!v) return { ok: false, reason: "description is empty" };
  if (v.length < DESCRIPTION_MIN_CHARS)
    return { ok: false, reason: `description is too short (${v.length} chars; need ≥${DESCRIPTION_MIN_CHARS})` };
  if (v.length > DESCRIPTION_MAX_CHARS)
    return { ok: false, reason: `description is too long (${v.length} chars; max ${DESCRIPTION_MAX_CHARS})` };
  if (/^\s*[\d#*\->`]/.test(v)) return { ok: false, reason: "description starts with a digit or markdown marker" };
  const last = v.slice(-1);
  if (last === ":" || last === ";" || last === ",")
    return { ok: false, reason: `description ends with truncation indicator "${last}"` };
  const lastWordMatch = v.match(/([A-Za-z']+)[.!?]*$/);
  if (lastWordMatch) {
    const lastWord = lastWordMatch[1].toLowerCase();
    if (TRUNCATION_TRAILING_WORDS.has(lastWord))
      return { ok: false, reason: `description ends with truncation-indicator word "${lastWord}"` };
  }
  if (/^lesson distilled from\b/i.test(v))
    return { ok: false, reason: "description matches the auto-repair placeholder text" };
  for (const re of HEADING_FRAGMENT_PATTERNS) {
    if (re.test(v)) return { ok: false, reason: `description looks like a section heading: "${v.slice(0, 40)}"` };
  }
  if (
    /^(def|function|async\s+def|async\s+function|class|const|let|var|export\s+function|export\s+const|export\s+default|import|public|private|protected|fn|func)\s+\S/i.test(
      v,
    )
  ) {
    const firstWord = v.split(/\s+/)[0] ?? "";
    return {
      ok: false,
      reason: `description starts with code keyword "${firstWord}" — looks like a code fragment, not prose`,
    };
  }
  const backtickCount = (v.match(/`/g) ?? []).length;
  if (backtickCount % 2 !== 0)
    return {
      ok: false,
      reason: `description has ${backtickCount} backticks (unbalanced); likely contains a malformed code fragment`,
    };
  if (/^when\b/i.test(v))
    return {
      ok: false,
      reason: "description starts with 'When' — that pattern belongs in when_to_use",
      severity: "warn",
    };
  if (!options.skipRefTailCheck) {
    const refTail = inputRef.split(":").pop()?.toLowerCase() ?? "";
    if (refTail.length >= 6 && v.toLowerCase().includes(refTail) && v.length < refTail.length + 40)
      return { ok: false, reason: "description appears to just name the input ref" };
  }
  return { ok: true };
}

export function isValidWhenToUse(value: unknown, inputRef: string): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "when_to_use is not a string" };
  const v = value.trim();
  if (!v) return { ok: false, reason: "when_to_use is empty" };
  if (v.length < WHEN_TO_USE_MIN_CHARS)
    return { ok: false, reason: `when_to_use is too short (${v.length} chars; need ≥${WHEN_TO_USE_MIN_CHARS})` };
  if (v.length > WHEN_TO_USE_MAX_CHARS)
    return { ok: false, reason: `when_to_use is too long (${v.length} chars; max ${WHEN_TO_USE_MAX_CHARS})` };
  if (/^when working with\b/i.test(v))
    return { ok: false, reason: "when_to_use is the circular 'When working with ...' fallback" };
  const refTail = inputRef.split(":").pop()?.toLowerCase() ?? "";
  if (refTail.length >= 6 && v.toLowerCase().includes(refTail) && v.length < refTail.length + 25)
    return { ok: false, reason: "when_to_use appears to just name the input ref" };
  return { ok: true };
}

export function detectDoubleFrontmatter(content: string): { kind: string; message: string } | null {
  const fenceLines = content.split(/\r?\n/).filter((l) => /^---\s*$/.test(l));
  if (fenceLines.length > 2)
    return {
      kind: "double-frontmatter-fence",
      message: `Content contains ${fenceLines.length} \`---\` fence lines; assets with frontmatter must have exactly 2 (one open, one close).`,
    };
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const pseudoLine = body
    .split(/\r?\n/)
    .find((l) => /^\s*(\*\*|__)?\s*(description|when_to_use)\s*(\*\*|__)?\s*:/i.test(l));
  if (pseudoLine)
    return {
      kind: "pseudo-frontmatter-in-body",
      message: `Body contains a pseudo-frontmatter restatement: "${pseudoLine.slice(0, 80)}". Fields belong in YAML frontmatter only.`,
    };
  return null;
}

export function validateProposalFrontmatter(fm: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const desc = fm.description;
  if (typeof desc !== "string" || desc.trim().length === 0)
    return { ok: false, reason: "MISSING_FRONTMATTER_DESCRIPTION" };
  const truncReason = detectTruncatedDescription(desc);
  if (truncReason) return { ok: false, reason: `TRUNCATED_DESCRIPTION (${truncReason})` };
  return { ok: true };
}

export function hasSupersededStatus(frontmatter: Record<string, unknown> | undefined): boolean {
  const status = frontmatter?.status;
  return typeof status === "string" && status.trim().toLowerCase() === "superseded";
}

export function hasHotCaptureMode(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.captureMode === "hot";
}

// ── Consolidate merge size gate ──────────────────────────────────────────────

/**
 * Ratio lower-bound for merged body vs. the larger source body.
 * Lower than reflect (0.5) because deduplication is expected — two memories
 * with 80-90% overlap legitimately compress to well under 50% of the larger.
 */
export const MERGE_SHRINK_RATIO_MIN = 0.3;

/**
 * Absolute floor (chars) for merged body.  When sources are short (<~333 chars),
 * `MERGE_SHRINK_RATIO_MIN × largerBodyLen` falls below this and the absolute
 * floor dominates — prevents false positives on very terse memory pairs.
 * Matches the existing `promote_source_too_small` floor of 100 chars.
 */
export const MERGE_ABSOLUTE_FLOOR_CHARS = 100;

// ── Reflect size gate ────────────────────────────────────────────────────────

/** Ratio lower-bound: proposed body must be at least this fraction of source. */
export const REFLECT_SHRINK_RATIO_MIN = 0.5;
/** Ratio upper-bound: proposed body must not exceed this fraction of source. */
export const REFLECT_EXPAND_RATIO_MAX = 2.5;

/**
 * Below this byte count, ratio checks are too noisy — skip them entirely.
 * Unchanged from the original gate.
 */
export const REFLECT_SIZE_GUARD_MIN_BYTES = 200;

/**
 * Absolute shrinkage floor (bytes).  Even if `ratio * sourceLen` is lower, a
 * proposed body of at least this many bytes is always accepted on the shrinkage
 * side.  Protects against false positives when the source is small (<300 bytes).
 */
export const REFLECT_ABSOLUTE_FLOOR_BYTES = 150;

/**
 * Absolute expansion ceiling (bytes).  Even if `ratio * sourceLen` is lower, a
 * proposed body up to this many bytes is always accepted on the expansion side.
 * Protects against false positives when the source is small (≤778 bytes, p25).
 */
export const REFLECT_ABSOLUTE_CEILING_BYTES = 2500;

/**
 * Hard expansion cap (bytes).  Regardless of ratio, a proposed body exceeding
 * this limit is always rejected.  Guards against runaway LLM hallucinations on
 * large sources.
 */
export const REFLECT_ABSOLUTE_MAX_BYTES = 25000;

/** Outcome of {@link checkReflectSize}: ok, or a rejection envelope. */
export type ReflectSizeOutcome =
  | { ok: true }
  | { ok: false; code: "EXCESSIVE_SHRINKAGE" | "EXCESSIVE_EXPANSION"; ratio: number };

/**
 * Calibrated size check: compare proposed body length against source body
 * length using a blended-bound formula.
 *
 * **Shrinkage** — accept if:
 *   `proposedLen >= max(REFLECT_SHRINK_RATIO_MIN * sourceLen, REFLECT_ABSOLUTE_FLOOR_BYTES)`
 *
 * **Expansion** — accept if:
 *   `proposedLen <= min(max(REFLECT_EXPAND_RATIO_MAX * sourceLen, REFLECT_ABSOLUTE_CEILING_BYTES), REFLECT_ABSOLUTE_MAX_BYTES)`
 *
 * Returns `{ ok: true }` when:
 *   - `sourceBody` is absent or `undefined`
 *   - source body is shorter than {@link REFLECT_SIZE_GUARD_MIN_BYTES}
 *   - the proposed length is within the blended bounds
 */
export function checkReflectSize(sourceBody: string | undefined, proposedBody: string): ReflectSizeOutcome {
  if (typeof sourceBody !== "string") return { ok: true };
  const sourceLen = sourceBody.trim().length;
  if (sourceLen < REFLECT_SIZE_GUARD_MIN_BYTES) return { ok: true };
  const proposedLen = proposedBody.trim().length;
  const ratio = proposedLen / sourceLen;

  // Shrinkage check: lower bound = max(ratio floor, absolute floor)
  const shrinkFloor = Math.max(REFLECT_SHRINK_RATIO_MIN * sourceLen, REFLECT_ABSOLUTE_FLOOR_BYTES);
  if (proposedLen < shrinkFloor) {
    return { ok: false, code: "EXCESSIVE_SHRINKAGE", ratio };
  }

  // Expansion check: upper bound = min(max(ratio ceiling, absolute ceiling), hard cap)
  const expandCeiling = Math.min(
    Math.max(REFLECT_EXPAND_RATIO_MAX * sourceLen, REFLECT_ABSOLUTE_CEILING_BYTES),
    REFLECT_ABSOLUTE_MAX_BYTES,
  );
  if (proposedLen > expandCeiling) {
    return { ok: false, code: "EXCESSIVE_EXPANSION", ratio };
  }

  return { ok: true };
}

// ── ProposalValidator entries (registered with proposal-validators.ts) ──────

const descriptionQualityValidator: ProposalValidator = {
  name: "description-quality",
  appliesTo(_proposal, ctx) {
    return ctx.parsedRef?.type === "knowledge" || ctx.parsedRef?.type === "memory" || ctx.parsedRef?.type === "lesson";
  },
  validate(proposal) {
    if (typeof proposal.payload?.content !== "string" || proposal.payload.content.trim() === "") return [];
    let fm: Record<string, unknown>;
    try {
      fm = parseFrontmatter(proposal.payload.content).data as Record<string, unknown>;
    } catch {
      return [];
    }
    const check = validateProposalFrontmatter(fm);
    if (check.ok) return [];
    return [
      {
        kind: "invalid-description",
        message: `Proposal ${proposal.id} (${proposal.ref}) has an invalid description: ${check.reason}.`,
      },
    ];
  },
};

const lessonContentQualityValidator: ProposalValidator = {
  name: "lesson-content-quality",
  appliesTo(_proposal, ctx) {
    return ctx.parsedRef?.type === "lesson";
  },
  validate(proposal) {
    if (typeof proposal.payload?.content !== "string") return [];
    let fm: Record<string, unknown>;
    try {
      fm = parseFrontmatter(proposal.payload.content).data as Record<string, unknown>;
    } catch {
      return [];
    }
    const findings = [] as { kind: string; message: string; severity?: "warn" }[];
    const descCheck = isValidDescription(fm.description, proposal.ref);
    if (!descCheck.ok)
      findings.push({
        kind: "invalid-description",
        message: `Lesson proposal ${proposal.id} (${proposal.ref}) has an invalid description: ${descCheck.reason}.`,
        ...(descCheck.severity ? { severity: descCheck.severity } : {}),
      });
    const wtuCheck = isValidWhenToUse(fm.when_to_use, proposal.ref);
    if (!wtuCheck.ok)
      findings.push({
        kind: "invalid-when_to_use",
        message: `Lesson proposal ${proposal.id} (${proposal.ref}) has an invalid when_to_use: ${wtuCheck.reason}.`,
      });
    if (
      descCheck.ok &&
      wtuCheck.ok &&
      typeof fm.description === "string" &&
      typeof fm.when_to_use === "string" &&
      fm.description.trim().toLowerCase() === fm.when_to_use.trim().toLowerCase()
    ) {
      findings.push({
        kind: "description-equals-when_to_use",
        message: `Lesson proposal ${proposal.id} (${proposal.ref}) has identical description and when_to_use.`,
      });
    }
    const dfm = detectDoubleFrontmatter(proposal.payload.content);
    if (dfm)
      findings.push({ kind: dfm.kind, message: `Lesson proposal ${proposal.id} (${proposal.ref}): ${dfm.message}` });
    return findings;
  },
};

const sourceNotSupersededValidator: ProposalValidator = {
  name: "source-not-superseded",
  appliesTo(proposal, ctx) {
    return proposal.source === "consolidate" && !!ctx.source?.frontmatter;
  },
  validate(proposal, ctx) {
    if (hasSupersededStatus(ctx.source?.frontmatter)) {
      return [
        {
          kind: "source-superseded",
          message: `Proposal ${proposal.id} (${proposal.ref}) has a source asset marked status:superseded; superseded memories are not promotable knowledge.`,
        },
      ];
    }
    return [];
  },
};

/** Strip an opening frontmatter block (`---\n…\n---`) from `content`, returning the body. */
function stripFrontmatterBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

const reflectSizeGuardValidator: ProposalValidator = {
  name: "reflect-size-guard",
  appliesTo(proposal, ctx) {
    return proposal.source === "reflect" && typeof ctx.source?.content === "string";
  },
  validate(proposal, ctx) {
    const sourceBody = stripFrontmatterBody(ctx.source?.content ?? "");
    const proposedBody =
      typeof proposal.payload?.content === "string" ? stripFrontmatterBody(proposal.payload.content) : "";
    const outcome = checkReflectSize(sourceBody, proposedBody);
    if (outcome.ok) return [];
    const pct = (outcome.ratio * 100).toFixed(0);
    const limit = outcome.code === "EXCESSIVE_SHRINKAGE" ? "minimum 50%" : "maximum 250%";
    const cause =
      outcome.code === "EXCESSIVE_SHRINKAGE"
        ? "Concrete content was likely deleted."
        : "Speculative material was likely added.";
    return [
      {
        kind: outcome.code.toLowerCase(),
        message: `Reflect rejected: ${outcome.code} — proposed body is ${pct}% of source (${limit}) for ref ${proposal.ref}. ${cause}`,
      },
    ];
  },
};

/**
 * Full set of quality validators in registration order. Appended onto
 * {@link defaultProposalValidators} so they run inside `validateProposal` on
 * `proposal accept` automatically.
 */
export const defaultProposalQualityValidators: ProposalValidator[] = [
  descriptionQualityValidator,
  lessonContentQualityValidator,
  sourceNotSupersededValidator,
  reflectSizeGuardValidator,
];
