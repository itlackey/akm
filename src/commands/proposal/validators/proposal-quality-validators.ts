// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Content-quality validators for the improve stages and `proposal accept`.
 *
 * The reflect size gate bounds a rewrite's body against its source's:
 * shrinking below max(50% of the source, 150 bytes) suggests deleted content,
 * growing past min(max(250% of the source, 2500 bytes), 25000 bytes) suggests
 * speculation. The absolute bounds keep small assets (a p25 source is ~780
 * bytes) from tripping on one good paragraph, and 25000 (below p99) still
 * catches runaway expansion. Sources under 200 bytes are too noisy to judge.
 */

import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { parseRefInput } from "../../../core/asset/resolve-ref";
import {
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MIN_CHARS,
  WHEN_TO_USE_MAX_CHARS,
  WHEN_TO_USE_MIN_CHARS,
} from "../../../core/authoring-rules";
import {
  containsRedactedContent,
  containsReflectPromptScaffolding,
  REDACTED_CONTENT_MARKER,
  REFLECT_AVOID_PATTERNS_HEADING,
} from "../../../core/content-safety";
import { proposalContent } from "../../../core/file-change";
import { detectTruncatedDescription, TRUNCATION_TRAILING_WORDS } from "../../../core/text-truncation";
import { REFLECT_TRUNCATION_MARKER } from "../../../integrations/agent/prompts";
import { splitFrontmatter } from "../../improve/reflect-noise";
import type { ProposalValidator } from "../proposal-types";

/** The asset name a ref names, lower-cased — what the "just restates the ref" checks compare. */
function refNameTail(inputRef: string): string {
  return parseRefInput(inputRef).name.toLowerCase();
}

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
  /** Allow a description that just names the ref (normal for knowledge). */
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
    const lastWord = lastWordMatch[1]!.toLowerCase();
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
    const refTail = refNameTail(inputRef);
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
  const refTail = refNameTail(inputRef);
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
  const pseudoLine = splitFrontmatter(content)
    .body.split(/\r?\n/)
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

export const REFLECT_SHRINK_RATIO_MIN = 0.5;
export const REFLECT_EXPAND_RATIO_MAX = 2.5;
export const REFLECT_SIZE_GUARD_MIN_BYTES = 200;
export const REFLECT_ABSOLUTE_FLOOR_BYTES = 150;
export const REFLECT_ABSOLUTE_CEILING_BYTES = 2500;
export const REFLECT_ABSOLUTE_MAX_BYTES = 25000;

export type ReflectSizeOutcome =
  | { ok: true }
  | { ok: false; code: "EXCESSIVE_SHRINKAGE" | "EXCESSIVE_EXPANSION"; ratio: number };

/** The reflect size gate (see the module note); no source or a tiny one passes. */
export function checkReflectSize(sourceBody: string | undefined, proposedBody: string): ReflectSizeOutcome {
  if (typeof sourceBody !== "string") return { ok: true };
  const sourceLen = sourceBody.trim().length;
  if (sourceLen < REFLECT_SIZE_GUARD_MIN_BYTES) return { ok: true };
  const proposedLen = proposedBody.trim().length;
  const ratio = proposedLen / sourceLen;
  if (proposedLen < Math.max(REFLECT_SHRINK_RATIO_MIN * sourceLen, REFLECT_ABSOLUTE_FLOOR_BYTES)) {
    return { ok: false, code: "EXCESSIVE_SHRINKAGE", ratio };
  }
  const expandCeiling = Math.min(
    Math.max(REFLECT_EXPAND_RATIO_MAX * sourceLen, REFLECT_ABSOLUTE_CEILING_BYTES),
    REFLECT_ABSOLUTE_MAX_BYTES,
  );
  if (proposedLen > expandCeiling) return { ok: false, code: "EXCESSIVE_EXPANSION", ratio };
  return { ok: true };
}

const descriptionQualityValidator: ProposalValidator = {
  name: "description-quality",
  appliesTo(_proposal, ctx) {
    return ctx.parsedRef?.type === "knowledge" || ctx.parsedRef?.type === "memory" || ctx.parsedRef?.type === "lesson";
  },
  validate(proposal) {
    if (typeof proposal.payload?.content !== "string" || proposal.payload.content.trim() === "") return [];
    let fm: Record<string, unknown>;
    try {
      fm = parseFrontmatter(proposalContent(proposal)).data as Record<string, unknown>;
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

/**
 * The lesson checks distill and accept share: a valid description and
 * when_to_use that differ, and no pseudo-frontmatter in the body. `text`
 * continues a caller-specific subject.
 */
export function lessonQualityIssues(
  fm: Record<string, unknown>,
  content: string,
  inputRef: string,
): Array<{ kind: string; field: string; text: string; severity?: "warn" }> {
  const issues: Array<{ kind: string; field: string; text: string; severity?: "warn" }> = [];
  const descCheck = isValidDescription(fm.description, inputRef);
  if (!descCheck.ok) {
    issues.push({
      kind: "invalid-description",
      field: "description",
      text: ` has an invalid description: ${descCheck.reason}.`,
      ...(descCheck.severity ? { severity: descCheck.severity } : {}),
    });
  }
  const wtuCheck = isValidWhenToUse(fm.when_to_use, inputRef);
  if (!wtuCheck.ok) {
    issues.push({
      kind: "invalid-when_to_use",
      field: "when_to_use",
      text: ` has an invalid when_to_use: ${wtuCheck.reason}.`,
    });
  }
  if (
    descCheck.ok &&
    wtuCheck.ok &&
    typeof fm.description === "string" &&
    typeof fm.when_to_use === "string" &&
    fm.description.trim().toLowerCase() === fm.when_to_use.trim().toLowerCase()
  ) {
    issues.push({
      kind: "description-equals-when_to_use",
      field: "description",
      text: " has identical description and when_to_use.",
    });
  }
  const dfm = detectDoubleFrontmatter(content);
  if (dfm) issues.push({ kind: dfm.kind, field: "body", text: `: ${dfm.message}` });
  return issues;
}

const lessonContentQualityValidator: ProposalValidator = {
  name: "lesson-content-quality",
  appliesTo(_proposal, ctx) {
    return ctx.parsedRef?.type === "lesson";
  },
  validate(proposal) {
    if (typeof proposal.payload?.content !== "string") return [];
    let fm: Record<string, unknown>;
    try {
      fm = parseFrontmatter(proposalContent(proposal)).data as Record<string, unknown>;
    } catch {
      return [];
    }
    return lessonQualityIssues(fm, proposalContent(proposal), proposal.ref).map((issue) => ({
      kind: issue.kind,
      message: `Lesson proposal ${proposal.id} (${proposal.ref})${issue.text}`,
      ...(issue.severity ? { severity: issue.severity } : {}),
    }));
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

const reflectSizeGuardValidator: ProposalValidator = {
  name: "reflect-size-guard",
  appliesTo(proposal, ctx) {
    return proposal.source === "reflect" && typeof ctx.source?.content === "string";
  },
  validate(proposal, ctx) {
    const sourceBody = splitFrontmatter(ctx.source?.content ?? "").body;
    const proposedBody =
      typeof proposal.payload?.content === "string" ? splitFrontmatter(proposalContent(proposal)).body : "";
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
 * A body still carrying {@link REFLECT_TRUNCATION_MARKER} (its source was too
 * large to send in full) would overwrite the asset with an incomplete rewrite:
 * data loss, so this blocks at accept even for a proposal that never passed
 * reflect's own creation-time check (#952).
 */
const reflectTruncationMarkerValidator: ProposalValidator = {
  name: "reflect-truncation-marker",
  appliesTo(proposal) {
    return proposal.source === "reflect" && typeof proposal.payload?.content === "string";
  },
  validate(proposal) {
    if (!proposalContent(proposal).includes(REFLECT_TRUNCATION_MARKER)) return [];
    return [
      {
        kind: "reflect-truncation-marker-leak",
        message: `Proposal ${proposal.id} (${proposal.ref}) body still contains the reflect truncation marker "${REFLECT_TRUNCATION_MARKER}" — the source asset was too large to send in full and this body would overwrite it with an incomplete rewrite. Reflect this ref again (or raise its content budget) and re-propose.`,
      },
    ];
  },
};

/** Never promote proposal text that already contains an output-redaction marker (#962). */
const redactedContentValidator: ProposalValidator = {
  name: "redacted-content",
  appliesTo(proposal) {
    return typeof proposal.payload?.content === "string";
  },
  validate(proposal) {
    if (!containsRedactedContent(proposalContent(proposal))) return [];
    return [
      {
        kind: "redacted-content",
        message: `Proposal ${proposal.id} (${proposal.ref}) contains ${REDACTED_CONTENT_MARKER}. Restore the original non-secret prose and create a clean proposal; redacted output cannot be promoted.`,
      },
    ];
  },
};

/** Defense in depth when a reflect proposal bypasses creation-time sanitization (#963). */
const reflectPromptScaffoldingValidator: ProposalValidator = {
  name: "reflect-prompt-scaffolding",
  appliesTo(proposal) {
    return proposal.source === "reflect" && typeof proposal.payload?.content === "string";
  },
  validate(proposal) {
    if (!containsReflectPromptScaffolding(proposalContent(proposal))) return [];
    return [
      {
        kind: "reflect-prompt-scaffolding",
        message: `Proposal ${proposal.id} (${proposal.ref}) still contains the run-only "${REFLECT_AVOID_PATTERNS_HEADING}" prompt section. Reflect the asset again before promotion.`,
      },
    ];
  },
};

/**
 * Prose-quality findings only advise: a human accepting after reading the diff
 * has no way to edit the proposal, so blocking on them left no remedy.
 * Structural findings (in the default validators) still block.
 */
function advisory(validator: ProposalValidator): ProposalValidator {
  return {
    ...validator,
    validate: (proposal, ctx) =>
      validator.validate(proposal, ctx).map((finding) => ({ ...finding, severity: "warn" as const })),
  };
}

/** The quality validators `validateProposal` runs; the last three protect durable content and block. */
export const defaultProposalQualityValidators: ProposalValidator[] = [
  ...[
    descriptionQualityValidator,
    lessonContentQualityValidator,
    sourceNotSupersededValidator,
    reflectSizeGuardValidator,
  ].map(advisory),
  reflectTruncationMarkerValidator,
  redactedContentValidator,
  reflectPromptScaffoldingValidator,
];
