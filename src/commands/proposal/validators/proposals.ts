// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal validation and content repair.
 *
 * The proposal repository, domain service, and legacy filesystem import moved
 * to `../repository.ts` and `../legacy-import.ts` (#578 storage consolidation).
 * This module keeps only the two proposal *validators* — {@link validateProposal}
 * and {@link repairProposalContent} — and re-exports the repository API so the
 * historical `proposal/validators/proposals` import path keeps resolving.
 */

import { repairTruncatedDescription } from "../../../core/text-truncation";
import type { Proposal } from "../repository";
import { runProposalValidators } from "./proposal-validators";

// Re-export the proposal repository / domain API so existing importers of this
// path keep working (barrel — the substrate now lives in `../repository.ts`).
export * from "../repository";

// ── Validation ──────────────────────────────────────────────────────────────

export interface ProposalValidationFinding {
  kind: string;
  message: string;
  /** "warn" findings are surfaced but do not block proposal acceptance. Defaults to error-level when absent. */
  severity?: "warn";
}

export interface ProposalValidationReport {
  ok: boolean;
  findings: ProposalValidationFinding[];
}

/**
 * Validate a proposal payload before promotion. Generic by default — any
 * proposal must parse cleanly and carry a non-empty body. Lessons get the
 * extra per-type lint from {@link lintLessonContent} so the contract documented
 * in v1 spec §13 is enforced at promotion time. Other asset types can hook
 * here in the future without changing call sites.
 */
export function validateProposal(proposal: Proposal): ProposalValidationReport {
  return runProposalValidators(proposal);
}

// ── Content repair ──────────────────────────────────────────────────────────

/**
 * Attempt bounded, deterministic repair of mechanically-fixable defects in a
 * proposal's markdown content. NEVER fabricates text — only strips known-bad
 * structure and applies {@link repairTruncatedDescription} to a truncated
 * description when one is detected.
 *
 * Repairs performed (in order):
 *   1. Strip body lines that restate frontmatter fields as pseudo-frontmatter
 *      (e.g. `**description**: …` or `when_to_use: …` in the body).
 *   2. Remove stray body `---` horizontal-rule lines (leaving exactly the two
 *      frontmatter fences when the content has a valid frontmatter block).
 *   3. Apply {@link repairTruncatedDescription} to a truncated/hanging
 *      `description` field in the frontmatter.
 *
 * Returns the repaired content string. When no repairs apply the input is
 * returned byte-identical so callers can use strict equality to detect
 * whether a repair actually happened.
 *
 * CRITICAL: This function is CONTENT-PRESERVING. Callers MUST re-validate the
 * repaired output via {@link validateProposal} / {@link runProposalValidators}
 * before promotion — a repair that makes things *worse* (or is simply
 * insufficient) must be caught by the existing gate.
 */
export function repairProposalContent(content: string): string {
  if (typeof content !== "string" || content.trim() === "") return content;

  // Determine whether the content has a frontmatter block so we know how
  // many `---` fence lines are expected.
  const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/.test(content);

  // Split into lines for structural repairs.
  const lines = content.split(/\r?\n/);

  // Track whether we are inside the opening frontmatter block so we can
  // leave it untouched and only repair the body.
  let inFrontmatter = false;

  // Frontmatter fence index tracking: first fence opens FM, second closes it.
  let fmOpenSeen = false;
  let fmCloseSeen = false;

  const repairedLines: string[] = [];

  for (const line of lines) {
    const isFence = /^---\s*$/.test(line);

    // Track frontmatter fences (first two `---` fences delimit the FM block).
    if (isFence && !fmCloseSeen) {
      if (!fmOpenSeen) {
        fmOpenSeen = true;
        inFrontmatter = true;
        repairedLines.push(line);
        continue;
      }
      if (inFrontmatter) {
        fmCloseSeen = true;
        inFrontmatter = false;
        repairedLines.push(line);
        continue;
      }
    }

    // We are now in the body (past the frontmatter or no frontmatter).
    if (inFrontmatter) {
      // Still inside the frontmatter — keep as-is.
      repairedLines.push(line);
      continue;
    }

    // Repair 1: Strip pseudo-frontmatter restatements in the body.
    // Matches lines like `**description**: …` or `when_to_use: …`.
    if (/^\s*(\*\*|__)?\s*(description|when_to_use)\s*(\*\*|__)?\s*:/i.test(line)) {
      // Drop the line — it is a structural defect, not user content.
      continue;
    }

    // Repair 2: Remove stray `---` horizontal-rule lines in the body.
    // We keep these only when the content has NO frontmatter (in that case
    // `---` is a legitimate thematic break in plain-body content).
    if (isFence && hasFrontmatter) {
      // Drop: these are extra `---` fences beyond the two frontmatter delimiters.
      continue;
    }

    repairedLines.push(line);
  }

  let repaired = repairedLines.join("\n");

  // Repair 3: Apply repairTruncatedDescription to the description field.
  // We operate on the raw text rather than re-parsing YAML to avoid
  // reformatting unrelated frontmatter keys.
  if (hasFrontmatter) {
    // Extract the body text (after the second `---`) so we can pass it to
    // repairTruncatedDescription as context for the swap-in heuristic.
    const bodyMatch = repaired.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const bodyText = bodyMatch?.[1] ?? "";

    repaired = repaired.replace(
      /^(description:\s*)(.*?)(\r?\n)/m,
      (_match, prefix: string, rawDesc: string, nl: string) => {
        const fixed = repairTruncatedDescription(rawDesc.trim(), bodyText);
        return `${prefix}${fixed}${nl}`;
      },
    );
  }

  return repaired;
}
