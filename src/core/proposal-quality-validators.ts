/**
 * Shared content-quality validators consumed by the improve pipeline
 * (`distill`, `consolidate`, `reflect`) and by the `proposal accept` gate
 * (`validateProposal` → `runProposalValidators`).
 *
 * Historically each improve stage carried its own copy of these heuristics
 * (description shape, frontmatter shape, hot-captured guard, superseded
 * guard, body-size guard). The duplication produced systematic drift between
 * what improve checked at emit-time and what `accept` checked at promote-time
 * — and a steady stream of small bugs where a fix landed in one site and not
 * the other.
 *
 * This module is the single source of truth for **pure, per-proposal**
 * content quality checks. Stage-specific orchestration (within-run dedup,
 * pending-proposal idempotency, LLM-backed judges) stays inline per the
 * 2026-05-20 architecture review.
 *
 * Each validator is exported individually so the improve stages can register
 * a subset (e.g. distill only cares about lesson + knowledge content shape;
 * reflect needs source-context-aware checks). The full set is also exported
 * as {@link defaultProposalQualityValidators} for the `accept` path.
 */

import { parseFrontmatter } from "./frontmatter";
import type { ProposalValidator } from "./proposal-validators";
import { detectTruncatedDescription, TRUNCATION_TRAILING_WORDS } from "./text-truncation";

// ── Description / when_to_use shape (formerly distill-local) ────────────────

/**
 * Headings / section labels that show up verbatim as "descriptions" in the
 * archived rejected proposals. Lifted from `commands/distill.ts` where the
 * pattern set was originally curated.
 */
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

/**
 * Heuristic check on a lesson's `description` frontmatter field.
 *
 * Returns `{ ok: true }` if the description looks like a real one-sentence
 * summary, otherwise `{ ok: false, reason }` with a human-readable diagnosis.
 *
 * Pure — exported so distill and tests can pin individual cases.
 *
 * @param value      Raw frontmatter value (the validator handles non-string input).
 * @param inputRef   The ref the lesson was distilled from; used to detect
 *                   circular descriptions that merely name the source ref.
 */
export function isValidDescription(value: unknown, inputRef: string): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "description is not a string" };
  const v = value.trim();
  if (!v) return { ok: false, reason: "description is empty" };
  if (v.length < 20) return { ok: false, reason: `description is too short (${v.length} chars; need ≥20)` };
  if (v.length > 400) return { ok: false, reason: `description is too long (${v.length} chars; max 400)` };
  if (/^\s*[\d#*\->`]/.test(v)) return { ok: false, reason: "description starts with a digit or markdown marker" };
  const last = v.slice(-1);
  if (last === ":" || last === ";" || last === ",") {
    return { ok: false, reason: `description ends with truncation indicator "${last}"` };
  }
  const lastWordMatch = v.match(/([A-Za-z']+)[.!?]*$/);
  if (lastWordMatch) {
    const lastWord = lastWordMatch[1].toLowerCase();
    if (TRUNCATION_TRAILING_WORDS.has(lastWord)) {
      return { ok: false, reason: `description ends with truncation-indicator word "${lastWord}"` };
    }
  }
  if (/^lesson distilled from\b/i.test(v)) {
    return { ok: false, reason: "description matches the auto-repair placeholder text" };
  }
  for (const re of HEADING_FRAGMENT_PATTERNS) {
    if (re.test(v)) return { ok: false, reason: `description looks like a section heading: "${v.slice(0, 40)}"` };
  }
  // Code-fragment shape — triage 2026-05-21 found a proposal with
  // `description: "def _dedup_proposal(proposal)"`. The LLM had pasted a
  // function signature from the source memory into the description field.
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
  if (backtickCount % 2 !== 0) {
    return {
      ok: false,
      reason: `description has ${backtickCount} backticks (unbalanced); likely contains a malformed code fragment`,
    };
  }
  if (/^when\b/i.test(v)) {
    return { ok: false, reason: "description starts with 'When' — that pattern belongs in when_to_use" };
  }
  const refTail = inputRef.split(":").pop()?.toLowerCase() ?? "";
  if (refTail.length >= 6 && v.toLowerCase().includes(refTail) && v.length < refTail.length + 40) {
    return { ok: false, reason: "description appears to just name the input ref" };
  }
  return { ok: true };
}

/**
 * Heuristic check on a lesson's `when_to_use` frontmatter field.
 *
 * Returns `{ ok: true }` if the field reads as a real trigger sentence, else
 * `{ ok: false, reason }`. Rejects the circular `"When working with <slug>"`
 * auto-repair fallback explicitly.
 */
export function isValidWhenToUse(value: unknown, inputRef: string): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "when_to_use is not a string" };
  const v = value.trim();
  if (!v) return { ok: false, reason: "when_to_use is empty" };
  if (v.length < 15) return { ok: false, reason: `when_to_use is too short (${v.length} chars; need ≥15)` };
  if (v.length > 400) return { ok: false, reason: `when_to_use is too long (${v.length} chars; max 400)` };
  if (/^when working with\b/i.test(v)) {
    return { ok: false, reason: "when_to_use is the circular 'When working with ...' fallback" };
  }
  const refTail = inputRef.split(":").pop()?.toLowerCase() ?? "";
  if (refTail.length >= 6 && v.toLowerCase().includes(refTail) && v.length < refTail.length + 25) {
    return { ok: false, reason: "when_to_use appears to just name the input ref" };
  }
  return { ok: true };
}

/**
 * Detect the systematic "double frontmatter" defect: the LLM emits the
 * required YAML frontmatter AND then restates the same fields inside the
 * body using bold-markdown markers (e.g. `**description:** ...`) or a
 * second `---` fence pair. These contradict the canonical frontmatter and
 * confuse reviewers.
 *
 * Pure — exported so distill / tests can pin individual cases.
 */
export function detectDoubleFrontmatter(content: string): { kind: string; message: string } | null {
  const fenceLines = content.split(/\r?\n/).filter((l) => /^---\s*$/.test(l));
  if (fenceLines.length > 2) {
    return {
      kind: "double-frontmatter-fence",
      message: `Content contains ${fenceLines.length} \`---\` fence lines; lessons must have exactly 2 (opening and closing of one frontmatter block).`,
    };
  }
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const pseudoLine = body
    .split(/\r?\n/)
    .find((l) => /^\s*(\*\*|__)?\s*(description|when_to_use)\s*(\*\*|__)?\s*:/i.test(l));
  if (pseudoLine) {
    return {
      kind: "pseudo-frontmatter-in-body",
      message: `Body contains a pseudo-frontmatter restatement: "${pseudoLine.slice(0, 80)}". The fields belong in the YAML frontmatter only.`,
    };
  }
  return null;
}

// ── Consolidate-frontmatter shape (formerly consolidate-local) ──────────────

/**
 * Validate the frontmatter of a consolidate-bound asset. The bare-minimum
 * field a reviewer needs to triage the proposal is `description`; the field
 * also must not look obviously truncated.
 *
 * Pure — exported so the consolidate promote path and tests can call it
 * with already-parsed frontmatter.
 */
export function validateProposalFrontmatter(fm: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const desc = fm.description;
  if (typeof desc !== "string" || desc.trim().length === 0) {
    return { ok: false, reason: "MISSING_FRONTMATTER_DESCRIPTION" };
  }
  const truncReason = detectTruncatedDescription(desc);
  if (truncReason) {
    return { ok: false, reason: `TRUNCATED_DESCRIPTION (${truncReason})` };
  }
  return { ok: true };
}

// ── Consolidate-source guards (formerly consolidate-local) ──────────────────

/**
 * Predicate over a parsed-frontmatter record: does it carry
 * `status: superseded`?  Source memories marked superseded are by definition
 * no-longer-current and must not be promoted as fresh knowledge.
 */
export function hasSupersededStatus(frontmatter: Record<string, unknown> | undefined): boolean {
  const status = frontmatter?.status;
  return typeof status === "string" && status.trim().toLowerCase() === "superseded";
}

/**
 * Predicate over a memory entry's parsed frontmatter: does it carry
 * `captureMode: hot`?  Hot-captured memories are user-explicit and must not
 * be merged or auto-deleted by the consolidate LLM.
 *
 * Takes parsed frontmatter rather than a file path so the predicate stays
 * pure; the file-IO wrapper used by consolidate (`isHotCapturedMemory` in
 * `commands/consolidate.ts`) layers an `fs.readFileSync` + parse on top.
 */
export function hasHotCaptureMode(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.captureMode === "hot";
}

// ── Reflect-size guard (NEEDS GLUE — uses source content) ───────────────────

/** Safety-rail thresholds for reflect body-size changes. Mirrors `commands/reflect.ts`. */
export const REFLECT_SHRINK_RATIO_MIN = 0.5;
export const REFLECT_EXPAND_RATIO_MAX = 2.0;
/** Below this byte count, ratio checks are too noisy — skip them. */
export const REFLECT_SIZE_GUARD_MIN_BYTES = 200;

/** Outcome of {@link checkReflectSize}: ok, or a rejection envelope. */
export type ReflectSizeOutcome =
  | { ok: true }
  | { ok: false; code: "EXCESSIVE_SHRINKAGE" | "EXCESSIVE_EXPANSION"; ratio: number };

/**
 * Pure check: compare proposed body length against source body length and
 * flag changes outside the [50%, 200%] band. Returns `{ ok: true }` when the
 * source body is too short to apply the guard, when the source is absent, or
 * when the ratio is in band.
 */
export function checkReflectSize(sourceBody: string | undefined, proposedBody: string): ReflectSizeOutcome {
  if (typeof sourceBody !== "string") return { ok: true };
  const sourceLen = sourceBody.trim().length;
  if (sourceLen < REFLECT_SIZE_GUARD_MIN_BYTES) return { ok: true };
  const ratio = proposedBody.trim().length / sourceLen;
  if (ratio < REFLECT_SHRINK_RATIO_MIN) return { ok: false, code: "EXCESSIVE_SHRINKAGE", ratio };
  if (ratio > REFLECT_EXPAND_RATIO_MAX) return { ok: false, code: "EXCESSIVE_EXPANSION", ratio };
  return { ok: true };
}

// ── ProposalValidator entries (registered with proposal-validators.ts) ──────

/**
 * Description-quality validator. Fires for any proposal whose payload
 * carries a `description` frontmatter field that is non-empty but
 * structurally broken (truncated, looks like a heading fragment, ...).
 *
 * Applied to knowledge / memory / lesson refs only — other asset types have
 * different shape expectations.
 */
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

/**
 * Lesson-specific content quality validator. Extends the existing
 * lesson-lint check (field-presence) with the description-shape and
 * when_to_use-shape heuristics formerly in `distill.ts`.
 */
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
    const findings = [] as { kind: string; message: string }[];
    const descCheck = isValidDescription(fm.description, proposal.ref);
    if (!descCheck.ok) {
      findings.push({
        kind: "invalid-description",
        message: `Lesson proposal ${proposal.id} (${proposal.ref}) has an invalid description: ${descCheck.reason}.`,
      });
    }
    const wtuCheck = isValidWhenToUse(fm.when_to_use, proposal.ref);
    if (!wtuCheck.ok) {
      findings.push({
        kind: "invalid-when_to_use",
        message: `Lesson proposal ${proposal.id} (${proposal.ref}) has an invalid when_to_use: ${wtuCheck.reason}.`,
      });
    }
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
    if (dfm) {
      findings.push({
        kind: dfm.kind,
        message: `Lesson proposal ${proposal.id} (${proposal.ref}): ${dfm.message}`,
      });
    }
    return findings;
  },
};

/**
 * Source-not-superseded validator. Fires when a consolidate-source proposal
 * is being validated and the supplied `ctx.source.frontmatter` carries
 * `status: superseded`. The consolidate promote path populates the context;
 * the `accept` path leaves it absent (no source content to check), in which
 * case this validator no-ops.
 */
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

/**
 * Reflect-body-size validator. Fires when source content is supplied via
 * `ctx.source.content`; flags proposals whose body has shrunk to <50% or
 * grown past 200% of the source body length.
 */
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
    const limit = outcome.code === "EXCESSIVE_SHRINKAGE" ? "minimum 50%" : "maximum 200%";
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

/** Strip an opening frontmatter block (`---\n…\n---`) from `content`, returning the body. */
function stripFrontmatterBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

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
