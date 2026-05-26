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
}

export interface PreFilterResult {
  events: SessionEvent[];
  stats: PreFilterStats;
}

export interface PreFilterOptions {
  akmReadOnlyOps?: ReadonlySet<string>;
  maxEventTextLength?: number;
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
  const droppedByRule: Record<string, number> = {};
  const kept: SessionEvent[] = [];
  let truncatedCount = 0;

  for (const event of data.events) {
    const verdict = classifyEvent(event, akmReadOnlyOps, maxLen);
    if (!verdict.keep) {
      droppedByRule[verdict.reason] = (droppedByRule[verdict.reason] ?? 0) + 1;
      continue;
    }
    kept.push(verdict.event);
    if (verdict.truncated) truncatedCount += 1;
  }

  return {
    events: kept,
    stats: {
      inputCount: data.events.length,
      outputCount: kept.length,
      droppedByRule,
      truncatedCount,
    },
  };
}
