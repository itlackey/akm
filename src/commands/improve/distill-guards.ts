// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Distill guards: related lessons/knowledge shown to the model so it does not
 * overwrite prior generalizations (CLS context), and a cheap check that a
 * proposal does not contradict the memories it came from.
 */

export const DEFAULT_CLS_ADJACENT_COUNT = 3;

export interface ClsConfig {
  enabled?: boolean;
  adjacentCount?: number;
}

/** The CLS prompt section (each entry capped at 400 chars); empty when disabled or nothing is related. */
export function buildClsContext(adjacentItems: Array<{ ref: string; content: string }>, config: ClsConfig): string {
  if (!config.enabled || adjacentItems.length === 0) return "";
  const lines = [
    "",
    "## Existing adjacent lessons / knowledge (CLS context)",
    "The following are semantically related entries already in the stash.",
    "Your proposal MUST NOT contradict or silently overwrite these — if you",
    "disagree with one, flag it as contradicted (do not ignore it).",
    "",
  ];
  for (const item of adjacentItems) lines.push(`### ${item.ref}`, item.content.trim().slice(0, 400), "");
  return lines.join("\n");
}

export interface FidelityCheckConfig {
  enabled?: boolean;
}

export interface FidelityCheckResult {
  contradictionDetected: boolean;
  reason?: string;
}

/**
 * Flag a proposal whose "always/must X" (or "never/must not X") claim meets
 * the opposite claim about X in a source. Deliberately conservative: a flag
 * only costs a human review, while a model call per proposal is expensive.
 */
export function checkDistillFidelity(
  proposalBody: string,
  sourceBodies: string[],
  config: FidelityCheckConfig,
): FidelityCheckResult {
  if (!config.enabled || sourceBodies.length === 0) return { contradictionDetected: false };
  const strongClaims = extractStrongClaims(proposalBody.toLowerCase());
  for (const sourceBody of sourceBodies) {
    const sourceLow = sourceBody.toLowerCase();
    for (const { polarity, term } of strongClaims) {
      if (hasStrongClaim(sourceLow, term, polarity === "positive" ? "negative" : "positive")) {
        return {
          contradictionDetected: true,
          reason: `Proposal makes a ${polarity} strong claim about "${term}" that conflicts with an opposing claim in a cited source. Route to human review.`,
        };
      }
    }
  }
  return { contradictionDetected: false };
}

type Polarity = "positive" | "negative";

const CLAIM_PATTERNS: Array<{ polarity: Polarity; re: RegExp }> = [
  { polarity: "positive", re: /\b(?:always|must)\s+(\w+)/g },
  { polarity: "negative", re: /\b(?:never|must\s+not|should\s+not)\s+(\w+)/g },
];

function extractStrongClaims(text: string): Array<{ polarity: Polarity; term: string }> {
  const claims: Array<{ polarity: Polarity; term: string }> = [];
  for (const { polarity, re } of CLAIM_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const term = m[1];
      if (term && term.length > 2) claims.push({ polarity, term });
    }
  }
  return claims;
}

function hasStrongClaim(text: string, term: string, polarity: Polarity): boolean {
  const marker = polarity === "positive" ? /\b(?:always|must)\s/ : /\b(?:never|must\s+not|should\s+not)\s/;
  return marker.test(text) && text.includes(term);
}
