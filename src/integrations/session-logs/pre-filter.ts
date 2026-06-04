// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pre-filter a normalized session event stream down to high-signal entries
 * before handing it to the extraction LLM. Pure, deterministic, separately
 * testable — keeps the LLM call cheap and focused on content that might
 * actually carry durable signal.
 *
 * Drop rules (in priority order):
 *   1. read-only `akm` meta-ops (show/search/curate/history/info/hints/...)
 *   2. tool-event aggregate patterns (`akm_search unknown` enumerations)
 *   3. post-compact XML wrappers (`<analysis>`, `<summary>`, `<thinking>`)
 *      that the platform pastes verbatim into session text
 *   4. claude-code session preamble (`<local-command-caveat>` etc.)
 *   5. system-role events whose text is harness boilerplate
 *   6. empty / sub-10-char events (defensive)
 *
 * Truncation (when keeping but reducing for prompt budget):
 *   - events longer than {@link DEFAULT_MAX_EVENT_LENGTH} are clipped to a
 *     head+tail summary so failures with long stack traces are still seen
 *     but the prompt doesn't blow past context limits.
 *
 * This is a deliberately conservative filter — it errs on the side of
 * keeping content, because dropping a real signal is worse than passing
 * a bit of noise the LLM can ignore. False negatives in extraction are
 * the more recoverable failure mode.
 */

import type { SessionData, SessionEvent } from "./types";

/** Default cap for any single event's text length. Head+tail summary applies above this. */
export const DEFAULT_MAX_EVENT_LENGTH = 2000;

/**
 * Default cap on total transcript characters fed to the LLM. Chosen for a
 * 32K-token context model with room for the prompt scaffolding (~3K chars)
 * and JSON output (~4K chars). Adjust via {@link PreFilterOptions.maxTotalChars}
 * when targeting larger-context models.
 */
export const DEFAULT_MAX_TOTAL_CHARS = 80_000;

/**
 * `akm` subcommands that are read-only / introspective — their invocations
 * are operational noise, not engineering signal. Mutating commands (remember,
 * feedback, accept, reject, extract, import, save, ...) are kept.
 */
export const DEFAULT_AKM_READONLY_OPS: ReadonlySet<string> = new Set([
  "show",
  "search",
  "curate",
  "history",
  "info",
  "hints",
  "help",
  "list",
  "completions",
  "lessons",
  "graph",
  "db",
  "events",
  "config",
  "health",
]);

/**
 * Regex patterns that identify post-compact / activity-log noise. Conservative
 * — only matches text that's clearly transcript pollution, not engineering
 * content that happens to contain similar words.
 */
const NOISE_PATTERNS: RegExp[] = [
  // Claude Code injects this caveat block before every bash invocation result.
  /<local-command-caveat>/i,
  // Post-compact dumps embed analysis/summary XML blocks pasted from prior context.
  /<analysis>[\s\S]{200,}<\/analysis>/i,
  /<summary>[\s\S]{200,}<\/summary>/i,
  // System reminders the harness injects every few turns — never carry signal.
  /<system-reminder>/i,
  // Opencode tool-event aggregate dumps look like repeated `akm_search unknown` blocks.
  /^(##\s+\d+.*akm_search unknown\s*\n){3,}/im,
];

export interface PreFilterStats {
  inputCount: number;
  outputCount: number;
  /** Per-rule kill counts, useful for tuning + debug surfaces. */
  droppedByRule: Record<string, number>;
  /** Events that were kept but had their text truncated. */
  truncatedCount: number;
  /** Total characters across kept event texts (post-truncation). */
  totalChars: number;
  /**
   * Events dropped solely because the running character total would have
   * exceeded {@link PreFilterOptions.maxTotalChars}. Separate from rule-based
   * drops so operators can see if context-budget pressure is the real loss.
   */
  budgetDroppedCount: number;
}

export interface PreFilterResult {
  events: SessionEvent[];
  stats: PreFilterStats;
}

export interface PreFilterOptions {
  akmReadOnlyOps?: ReadonlySet<string>;
  maxEventTextLength?: number;
  /**
   * Total character budget across all kept events. Once the running total
   * crosses this threshold, additional events are dropped from the HEAD
   * (oldest first) — insight typically emerges through the session, so
   * recency-bias keeps the most signal-dense events. Defaults to
   * {@link DEFAULT_MAX_TOTAL_CHARS}.
   */
  maxTotalChars?: number;
}

/**
 * Apply the drop+truncate rules to a single event. Returns `undefined` when
 * the event should be dropped, or the (possibly truncated) event when kept.
 * The third return tracks why dropped, for stats.
 */
function classifyEvent(
  event: SessionEvent,
  akmReadOnlyOps: ReadonlySet<string>,
  maxLen: number,
): { keep: false; reason: string } | { keep: true; event: SessionEvent; truncated: boolean } {
  const text = event.text ?? "";

  if (text.trim().length < 10) return { keep: false, reason: "too-short" };

  // Rule 1: read-only akm meta-ops. The flattened tool_use shape from the
  // claude-code provider looks like: `[tool:Bash] akm show knowledge:foo`.
  // Match the verb directly after `akm ` (with or without the `[tool:...]`
  // prefix, since some platforms surface the command differently).
  const akmCallMatch = text.match(/\bakm\s+(\w[\w-]*)\b/);
  if (akmCallMatch) {
    const op = (akmCallMatch[1] ?? "").toLowerCase();
    if (akmReadOnlyOps.has(op)) {
      return { keep: false, reason: `akm-readonly-${op}` };
    }
  }

  // Rule 2-5: noise patterns
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(text)) {
      return { keep: false, reason: `noise-pattern-${pattern.source.slice(0, 24)}` };
    }
  }

  // Rule 6: bare system events that are pure boilerplate (no engineering content).
  // Heuristic: role=system AND short, OR role=system AND just contains `caveat`/`reminder` markers.
  if (event.role === "system" && (text.length < 200 || /caveat|reminder/i.test(text))) {
    return { keep: false, reason: "system-boilerplate" };
  }

  // Truncate long events to head + tail summary.
  if (text.length > maxLen) {
    const headLen = Math.floor(maxLen * 0.7);
    const tailLen = maxLen - headLen - 32; // 32 chars for the marker
    const truncated =
      text.slice(0, headLen) +
      `\n... [truncated ${text.length - headLen - tailLen} chars] ...\n` +
      text.slice(text.length - tailLen);
    return { keep: true, event: { ...event, text: truncated }, truncated: true };
  }

  return { keep: true, event, truncated: false };
}

export function preFilterSession(data: SessionData, options: PreFilterOptions = {}): PreFilterResult {
  const akmReadOnlyOps = options.akmReadOnlyOps ?? DEFAULT_AKM_READONLY_OPS;
  const maxLen = options.maxEventTextLength ?? DEFAULT_MAX_EVENT_LENGTH;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const droppedByRule: Record<string, number> = {};
  const kept: SessionEvent[] = [];
  let truncatedCount = 0;

  // First pass: apply per-event rules. Track running char total so the budget
  // pass can operate on already-truncated events.
  type KeptEvent = { event: SessionEvent; truncated: boolean; chars: number };
  const candidates: KeptEvent[] = [];
  for (const event of data.events) {
    const verdict = classifyEvent(event, akmReadOnlyOps, maxLen);
    if (!verdict.keep) {
      droppedByRule[verdict.reason] = (droppedByRule[verdict.reason] ?? 0) + 1;
      continue;
    }
    candidates.push({
      event: verdict.event,
      truncated: verdict.truncated,
      chars: verdict.event.text.length,
    });
  }

  // Second pass: total-budget cap. Walk from the END (most recent first) and
  // accept events until the budget is exhausted. The remaining (head) events
  // are dropped — insight typically emerges later in a session, so this
  // recency-bias is the cheapest sampling heuristic that respects context
  // limits. Maintains original timestamp order in the output.
  let totalChars = 0;
  let budgetDroppedCount = 0;
  const keptIdxFromTail: number[] = [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (!c) continue;
    if (totalChars + c.chars > maxTotalChars && keptIdxFromTail.length > 0) {
      budgetDroppedCount += 1;
      continue;
    }
    keptIdxFromTail.push(i);
    totalChars += c.chars;
  }
  keptIdxFromTail.reverse(); // restore timestamp order
  for (const idx of keptIdxFromTail) {
    const c = candidates[idx];
    if (!c) continue;
    kept.push(c.event);
    if (c.truncated) truncatedCount += 1;
  }

  return {
    events: kept,
    stats: {
      inputCount: data.events.length,
      outputCount: kept.length,
      droppedByRule,
      truncatedCount,
      totalChars,
      budgetDroppedCount,
    },
  };
}
