// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure content-repair + quality-validation stages for `akm distill`.
 *
 * Extracted verbatim from the inline body of `akmDistill` so each normalization
 * pass is an independently testable unit. Every function is a pure transform of
 * `(content, inputRef) → content | findings` with no I/O — logic is
 * byte-identical to the pre-extraction inline code. The lesson-path guard
 * (`effectiveProposalKind !== "knowledge"`) stays in the caller; these helpers
 * assume the lesson path.
 */

import { assembleAssetFromString, serializeFrontmatterQuoted } from "../../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { repairTruncatedDescription } from "../../../core/text-truncation";
import {
  detectDoubleFrontmatter,
  isValidDescription,
  isValidWhenToUse,
} from "../../proposal/validators/proposal-quality-validators";

export interface DistillValidationFinding {
  kind: string;
  field: string;
  message: string;
}

/**
 * Auto-repair missing frontmatter fields before hard-failing. Small models
 * frequently produce a good lesson body but omit the YAML header entirely.
 * Rather than discarding valid content, we extract description/when_to_use
 * from the body and prepend the required frontmatter block.
 *
 * IMPORTANT: We do NOT synthesise placeholder strings here. If the body
 * does not contain text that passes the post-LLM validators
 * (`isValidDescription` / `isValidWhenToUse`), we leave the field missing
 * and let the lesson lint reject the proposal as `validation_failed`.
 * Emitting placeholders like `"Lesson distilled from <ref>"` or
 * `"When working with <slug>"` is what produced the systematic broken
 * proposals observed across 323 archived rejections.
 */
export function autoRepairLessonFrontmatter(content: string, inputRef: string): string {
  const parsed = parseFrontmatter(content);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const missingDesc = typeof fm.description !== "string" || !(fm.description as string).trim();
  const missingWtu = typeof fm.when_to_use !== "string" || !(fm.when_to_use as string).trim();
  if (!missingDesc && !missingWtu) return content;
  const body = parsed.content.trim();
  // Strip markdown formatting tokens from a line so extracted text is clean.
  const stripMd = (l: string) =>
    l
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^[#*\->_]+\s*/, "")
      .replace(/:\s*$/, "")
      .trim();
  // Skip lines that look like YAML field assignments (key: value) or frontmatter delimiters.
  // These appear when the LLM leaks frontmatter content into the body, causing
  // auto-repair to produce description: "description: Key Takeaways".
  const isYamlLike = (l: string) => /^---/.test(l) || /^[a-z_]+:\s/i.test(l);
  const bodyLines = body.split("\n").map(stripMd);
  // Extract description: first body line that BOTH looks like prose AND
  // passes isValidDescription. If nothing qualifies, leave the field
  // missing — the lint pass will reject the proposal cleanly.
  let descLine: string | undefined;
  for (const l of bodyLines) {
    if (isYamlLike(l)) continue;
    if (l.length <= 10 || l.length >= 400) continue;
    if (isValidDescription(l, inputRef).ok) {
      descLine = l;
      break;
    }
  }
  // Extract when_to_use: a line starting with "When" / "Use when" / "Apply when"
  // that ALSO passes isValidWhenToUse (rejects circular fallbacks).
  let wtuLine: string | undefined;
  for (const l of bodyLines) {
    if (!/^(when |use when|apply when)/i.test(l)) continue;
    if (l.length >= 400) continue;
    if (isValidWhenToUse(l, inputRef).ok) {
      wtuLine = l;
      break;
    }
  }
  const repairedFm = {
    ...fm,
    ...(missingDesc && descLine ? { description: descLine } : {}),
    ...(missingWtu && wtuLine ? { when_to_use: wtuLine } : {}),
  };
  const fmLines = serializeFrontmatterQuoted(repairedFm);
  // Only rewrite content if we actually have at least one field to write.
  // Otherwise leave the original content for the lint pass to reject.
  if (Object.keys(repairedFm).length > 0) {
    return assembleAssetFromString(fmLines, body);
  }
  return content;
}

/**
 * Description ↔ when_to_use auto-swap normalization (recover ~93% of
 * qwen-9b's `^when\b/i` rejections at zero LLM cost). When the LLM emits
 * a conditional-framed description ("When X happens, do Y") and the
 * when_to_use field looks like a declarative description (or is empty),
 * the two fields are mis-fielded — exactly what `isValidDescription`'s
 * error message says ("that pattern belongs in when_to_use"). We swap
 * them and revalidate; the swap is committed only if BOTH fields pass
 * their respective validators afterwards. If revalidation still fails,
 * we fall through returning the original content (swapped: 0).
 */
export function autoSwapDescriptionWhenToUse(content: string, inputRef: string): { content: string; swapped: number } {
  const parsedSwap = parseFrontmatter(content);
  const fmSwap = (parsedSwap.data ?? {}) as Record<string, unknown>;
  const descRaw = typeof fmSwap.description === "string" ? fmSwap.description.trim() : "";
  const wtuRaw = typeof fmSwap.when_to_use === "string" ? fmSwap.when_to_use.trim() : "";
  const descStartsConditional = /^(when|if)\b/i.test(descRaw);
  const wtuStartsConditional = /^(when|if)\b/i.test(wtuRaw);
  if (descStartsConditional && !wtuStartsConditional && wtuRaw.length > 0) {
    // Try the swap and revalidate. The when_to_use validator requires the
    // value not match `/^when working with\b/i` (the circular fallback) —
    // a real description rarely does, so this usually passes.
    const swappedDescCheck = isValidDescription(wtuRaw, inputRef);
    const swappedWtuCheck = isValidWhenToUse(descRaw, inputRef);
    if (swappedDescCheck.ok && swappedWtuCheck.ok) {
      const swappedFm = {
        ...fmSwap,
        description: wtuRaw,
        when_to_use: descRaw,
      };
      const swappedFmLines = serializeFrontmatterQuoted(swappedFm);
      return { content: assembleAssetFromString(swappedFmLines, parsedSwap.content), swapped: 1 };
    }
  }
  return { content, swapped: 0 };
}

/**
 * Post-generation truncation repair (#556): if the LLM sliced the
 * description mid-sentence, deterministically complete it from its own text
 * / the lesson body BEFORE the lint + quality validators run. No-op
 * (byte-identical) for already-complete descriptions, so this never alters
 * a valid proposal.
 */
export function repairLessonDescriptionTruncation(content: string): string {
  const parsedRepair = parseFrontmatter(content);
  const fmRepair = (parsedRepair.data ?? {}) as Record<string, unknown>;
  const descRepairRaw = typeof fmRepair.description === "string" ? fmRepair.description : "";
  if (!descRepairRaw) return content;
  const repaired = repairTruncatedDescription(descRepairRaw, parsedRepair.content);
  if (repaired === descRepairRaw) return content;
  const repairedFmLines = serializeFrontmatterQuoted({ ...fmRepair, description: repaired });
  return assembleAssetFromString(repairedFmLines, parsedRepair.content);
}

/**
 * Additional quality validators that run only on lessons whose lesson-lint
 * pass was clean. lesson-lint checks "field is present and non-empty"; these
 * reject the systematic failure modes observed across 323 archived rejected
 * proposals:
 *   - description is a body fragment, section heading, or placeholder
 *   - when_to_use is the circular "When working with <ref>" fallback
 *   - description == when_to_use (LLM duplicated a single sentence)
 *   - body contains a second pseudo-frontmatter block
 */
export function collectLessonQualityFindings(content: string, inputRef: string): DistillValidationFinding[] {
  const findings: DistillValidationFinding[] = [];
  const parsedQC = parseFrontmatter(content);
  const fmQC = (parsedQC.data ?? {}) as Record<string, unknown>;

  const descCheck = isValidDescription(fmQC.description, inputRef);
  if (!descCheck.ok) {
    findings.push({
      kind: "invalid-description",
      field: "description",
      message: `Distilled lesson for ${inputRef} has an invalid description: ${descCheck.reason}.`,
    });
  }

  const wtuCheck = isValidWhenToUse(fmQC.when_to_use, inputRef);
  if (!wtuCheck.ok) {
    findings.push({
      kind: "invalid-when_to_use",
      field: "when_to_use",
      message: `Distilled lesson for ${inputRef} has an invalid when_to_use: ${wtuCheck.reason}.`,
    });
  }

  // description and when_to_use must say different things.
  if (
    descCheck.ok &&
    wtuCheck.ok &&
    typeof fmQC.description === "string" &&
    typeof fmQC.when_to_use === "string" &&
    fmQC.description.trim().toLowerCase() === fmQC.when_to_use.trim().toLowerCase()
  ) {
    findings.push({
      kind: "description-equals-when_to_use",
      field: "description",
      message: `Distilled lesson for ${inputRef} has identical description and when_to_use.`,
    });
  }

  // Double-frontmatter / pseudo-frontmatter pollution in the body.
  const dfm = detectDoubleFrontmatter(content);
  if (dfm) {
    findings.push({ kind: dfm.kind, field: "body", message: `Distilled lesson for ${inputRef}: ${dfm.message}` });
  }
  return findings;
}
