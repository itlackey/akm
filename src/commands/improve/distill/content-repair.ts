// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Deterministic lesson repairs and checks for `akm distill` (pure; the caller keeps the lesson-path guard). */

import { assembleAssetFromString, serializeFrontmatterQuoted } from "../../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { repairTruncatedDescription } from "../../../core/text-truncation";
import {
  isValidDescription,
  isValidWhenToUse,
  lessonQualityIssues,
} from "../../proposal/validators/proposal-quality-validators";

export interface DistillValidationFinding {
  kind: string;
  field: string;
  message: string;
}

/**
 * Fill a missing description / when_to_use from body lines that pass their
 * validators — small models often write a good body with no header. Never a
 * placeholder: those produced hundreds of broken proposals; a field nothing
 * qualifies for stays missing for lint to reject.
 */
export function autoRepairLessonFrontmatter(content: string, inputRef: string): string {
  const parsed = parseFrontmatter(content);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const missingDesc = typeof fm.description !== "string" || !(fm.description as string).trim();
  const missingWtu = typeof fm.when_to_use !== "string" || !(fm.when_to_use as string).trim();
  if (!missingDesc && !missingWtu) return content;
  const body = parsed.content.trim();
  const stripMd = (l: string) =>
    l
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^[#*\->_]+\s*/, "")
      .replace(/:\s*$/, "")
      .trim();
  // Leaked frontmatter lines in the body would yield `description: "description: …"`.
  const isYamlLike = (l: string) => /^---/.test(l) || /^[a-z_]+:\s/i.test(l);
  const bodyLines = body.split("\n").map(stripMd);
  let descLine: string | undefined;
  for (const l of bodyLines) {
    if (isYamlLike(l)) continue;
    if (l.length <= 10 || l.length >= 400) continue;
    if (isValidDescription(l, inputRef).ok) {
      descLine = l;
      break;
    }
  }
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
  if (Object.keys(repairedFm).length > 0) {
    return assembleAssetFromString(fmLines, body);
  }
  return content;
}

/**
 * Swap a conditional description ("When X, do Y") with a declarative
 * when_to_use — mis-fielded, as the description validator says — when both
 * then pass; this recovers most `^when` rejections at no LLM cost.
 */
export function autoSwapDescriptionWhenToUse(content: string, inputRef: string): { content: string; swapped: number } {
  const parsedSwap = parseFrontmatter(content);
  const fmSwap = (parsedSwap.data ?? {}) as Record<string, unknown>;
  const descRaw = typeof fmSwap.description === "string" ? fmSwap.description.trim() : "";
  const wtuRaw = typeof fmSwap.when_to_use === "string" ? fmSwap.when_to_use.trim() : "";
  const descStartsConditional = /^(when|if)\b/i.test(descRaw);
  const wtuStartsConditional = /^(when|if)\b/i.test(wtuRaw);
  if (descStartsConditional && !wtuStartsConditional && wtuRaw.length > 0) {
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

/** Complete a description cut mid-sentence from its own text or the body (#556); a complete one is untouched. */
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

/** The shared lesson quality checks, for a lesson whose lint pass was clean. */
export function collectLessonQualityFindings(content: string, inputRef: string): DistillValidationFinding[] {
  const fm = (parseFrontmatter(content).data ?? {}) as Record<string, unknown>;
  return lessonQualityIssues(fm, content, inputRef).map((issue) => ({
    kind: issue.kind,
    field: issue.field,
    message: `Distilled lesson for ${inputRef}${issue.text}`,
  }));
}
