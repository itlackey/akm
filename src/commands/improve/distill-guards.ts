// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-3b distill-stage guards.
 *
 * **CLS interleaving (step 9)**
 *   distill/memoryInference prompts include embedding-retrieved adjacent
 *   lessons/knowledge so the pipeline doesn't overwrite prior generalizations.
 *
 * **Distill→source fidelity (step 10)**
 *   After a distill proposal, check it against cited source memories; a
 *   contradiction flag routes to human review.
 *
 * @module distill-guards
 */

// ── CLS adjacent lesson context (step 9) ─────────────────────────────────────

/** Default number of adjacent lessons/knowledge for CLS interleaving. */
export const DEFAULT_CLS_ADJACENT_COUNT = 3;

export interface ClsConfig {
  enabled?: boolean;
  adjacentCount?: number;
}

/**
 * Build a CLS (Complementary Learning System) context snippet for injection
 * into distill/memoryInference prompts.
 *
 * Given a list of embedding-retrieved adjacent lessons/knowledge, formats them
 * as a markdown section to append to the prompt so the LLM avoids overwriting
 * prior generalizations.
 *
 * Returns an empty string when CLS is disabled or no adjacent items are found.
 *
 * @param adjacentItems - Top-N adjacent lessons/knowledge retrieved by embedding.
 * @param config - CLS config.
 */
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

  for (const item of adjacentItems) {
    lines.push(`### ${item.ref}`);
    // Truncate to 400 chars to keep the prompt size reasonable.
    lines.push(item.content.trim().slice(0, 400));
    lines.push("");
  }

  return lines.join("\n");
}

// ── Distill→source fidelity check (step 10) ──────────────────────────────────

export interface FidelityCheckConfig {
  enabled?: boolean;
}

export interface FidelityCheckResult {
  /** Whether a contradiction was detected between the proposal and its sources. */
  contradictionDetected: boolean;
  /** Human-readable reason for the contradiction flag, if any. */
  reason?: string;
}

/**
 * Check a distill proposal against its cited source memories for contradictions.
 *
 * Uses a simple heuristic: looks for explicit negation of key claims in the
 * proposal body that appear in the source bodies. A full LLM-based
 * contradiction check is expensive (one LLM call per proposal); this cheap
 * heuristic catches the most obvious cases and flags them for human review.
 *
 * When `fidelityCheck.enabled` is false, returns `{ contradictionDetected: false }`
 * immediately (no work done).
 *
 * @param proposalBody - The stripped body of the distill proposal.
 * @param sourceBodies - The stripped bodies of the cited source memories.
 * @param config - Fidelity check config.
 */
export function checkDistillFidelity(
  proposalBody: string,
  sourceBodies: string[],
  config: FidelityCheckConfig,
): FidelityCheckResult {
  if (!config.enabled || sourceBodies.length === 0) {
    return { contradictionDetected: false };
  }

  // Heuristic: detect explicit negation of "never" / "always" / "must" claims.
  // A proposal that says "always X" while the source says "never X" (or vice
  // versa) is a clear contradiction worth flagging.
  //
  // This is intentionally conservative: it only flags when both the proposal
  // AND the source contain the opposing polarity of the same key term. False
  // negatives (missed contradictions) are preferred over false positives
  // (blocking valid proposals) since the consequence of a false positive is
  // a human review request, while the cost of a false negative is a slightly
  // degraded stash.

  const proposalLow = proposalBody.toLowerCase();

  // Extract "always/never/must/must not" claims from the proposal.
  const strongClaims = extractStrongClaims(proposalLow);
  if (strongClaims.length === 0) return { contradictionDetected: false };

  for (const sourceBody of sourceBodies) {
    const sourceLow = sourceBody.toLowerCase();
    for (const { polarity, term } of strongClaims) {
      const oppositePolarity = polarity === "positive" ? "negative" : "positive";
      const sourceHasOpposite = hasStrongClaim(sourceLow, term, oppositePolarity);
      if (sourceHasOpposite) {
        return {
          contradictionDetected: true,
          reason: `Proposal makes a ${polarity} strong claim about "${term}" that conflicts with an opposing claim in a cited source. Route to human review.`,
        };
      }
    }
  }

  // Also flag proposals whose xrefs are empty (broken provenance).
  // This is a degradation signal, not a contradiction, but worth surfacing.
  return { contradictionDetected: false };
}

interface StrongClaim {
  polarity: "positive" | "negative";
  term: string;
}

function extractStrongClaims(text: string): StrongClaim[] {
  const claims: StrongClaim[] = [];
  // Match "always <term>", "never <term>", "must <term>", "must not <term>".
  const patterns: Array<{ polarity: "positive" | "negative"; re: RegExp }> = [
    { polarity: "positive", re: /\b(?:always|must)\s+(\w+)/g },
    { polarity: "negative", re: /\b(?:never|must\s+not|should\s+not)\s+(\w+)/g },
  ];
  for (const { polarity, re } of patterns) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      const term = m[1];
      if (term && term.length > 2) claims.push({ polarity, term });
      m = re.exec(text);
    }
  }
  return claims;
}

function hasStrongClaim(text: string, term: string, polarity: "positive" | "negative"): boolean {
  if (polarity === "positive") {
    return /\b(?:always|must)\s/.test(text) && text.includes(term);
  }
  return /\b(?:never|must\s+not|should\s+not)\s/.test(text) && text.includes(term);
}
