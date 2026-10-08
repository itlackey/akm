// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pre-filter a normalized session event stream down to high-signal entries
 * before handing it to the extraction LLM. Pure, deterministic, separately
 * testable — keeps the LLM call cheap and focused on content that might
 * actually carry durable signal.
 *
 * Post-pass (after the per-event rules AND the total-budget cap, on the
 * final kept set):
 *   0. stub a parent's `<task-notification>` event when its `<result>` is a
 *      near-duplicate of a subagent transcript's own event that ALSO
 *      survived into that same kept set (#839) — see
 *      {@link dedupeTaskNotifications}.
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
  "metrics",
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

/**
 * A parent-side `<task-notification>` event, as Claude Code writes it into a
 * session's own transcript: a `role: "user"` event whose text is (or wraps)
 * `<task-notification>...<task-id>ID</task-id>...<result>TEXT</result>...</task-notification>`.
 * Matched on the tags themselves (not a dedicated field) because
 * {@link SessionEvent} carries no structural provenance beyond `text`/`role`/
 * `filePath` — the same constraint #830 (subagent provenance) worked within.
 */
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*<\/task-notification>/;
const TASK_ID_RE = /<task-id>([^<]+)<\/task-id>/;
const RESULT_RE = /<result>([\s\S]*)<\/result>/;
const SUMMARY_RE = /<summary>([^<]*)<\/summary>/;
/** Claude Code's own `<summary>` phrasing for a finished agent: `Agent "<description>" finished`. */
const AGENT_SUMMARY_DESCRIPTION_RE = /^Agent "(.*)" finished$/;
/** Provenance {@link subagentProvenance} stamps on every folded subagent event; stripped before comparison. */
const PROVENANCE_PREFIX_RE = /^\[subagent:[^\]]*\][^\n]*\n/;
/** Claude Code's own agentId file naming: `<...>/subagents/<...>agent-<agentId>.jsonl`. */
const SUBAGENT_FILEPATH_RE = /agent-([^/\\]+?)\.jsonl$/;
/** Dice (bigram) similarity at/above this counts as "the same content" (#839). */
const DEDUPE_SIMILARITY_THRESHOLD = 0.9;

/** A handful of named-entity decodes — enough for what Claude Code escapes when it wraps `<result>` text in XML. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Sørensen–Dice coefficient over character bigrams — a cheap, symmetric textual-overlap measure. */
function diceSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      counts.set(bg, (counts.get(bg) ?? 0) + 1);
    }
    return counts;
  };
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  let intersection = 0;
  let totalA = 0;
  let totalB = 0;
  for (const count of bigramsA.values()) totalA += count;
  for (const count of bigramsB.values()) totalB += count;
  for (const [bg, count] of bigramsA) {
    const other = bigramsB.get(bg);
    if (other) intersection += Math.min(count, other);
  }
  return totalA + totalB === 0 ? 1 : (2 * intersection) / (totalA + totalB);
}

/**
 * Stub out a parent's `<task-notification>` event when its `<result>` is a
 * near-duplicate of a subagent transcript's own event that ALSO survived
 * into this same kept set (#839).
 *
 * After #830 folds a session's subagent transcripts into its event stream,
 * a completed subagent's report can appear twice: once as the subagent's own
 * folded final event, once as the parent's `<task-notification>` record of
 * that same call — the notification wraps the subagent's own text almost
 * verbatim (Claude Code XML-escapes `<`/`>`/`&`/quotes in the `<result>`
 * body, which {@link decodeXmlEntities} reverses before comparing). Direction
 * is owner-decided (#839): drop the parent's copy, keep the subagent's
 * original — the inverse was evaluated and rejected in #836 because some
 * subagent transcripts consist ONLY of their terminal event, so dropping it
 * would destroy the harvesting #830 added.
 *
 * **Runs on `kept` — the FINAL post-budget list — not the raw stream**, and
 * only stubs a notification when a matching subagent event is ALSO present
 * in that same `kept` list. This is required, not incidental: the recency-
 * biased budget already evicts one side of most raw duplicate pairs before
 * dedupe would matter (#840's design doc measured zero pairs where both
 * copies reached the pre-dedupe prompt across four real sessions), and any
 * future prompt-composition design that stops including subagent-origin
 * events in the prompt at all (#840's recommended "harvest-without-
 * prompting hybrid") makes the parent's `<task-notification>` the ONLY
 * surviving trace of that delegated work. An unconditional raw-stream stub
 * would delete that sole copy the moment the subagent's own event is absent
 * for ANY reason — evicted by budget today, or never present by design
 * tomorrow. Scoping to "both sides survived into the same kept set" makes
 * this dedupe a no-op whenever there is only one copy left to dedupe
 * against, which is exactly the case where deleting it would be a bug, not
 * a fix.
 *
 * Matching is scoped by `<task-id>` (which is the subagent's agentId) to the
 * SPECIFIC subagent transcript it names, via the `agent-<agentId>.jsonl`
 * filename #830's folding already stamps onto every folded event's
 * `filePath` — then requires the decoded `<result>` to be a near-duplicate
 * (Dice similarity ≥ {@link DEDUPE_SIMILARITY_THRESHOLD}) of that subagent's
 * text, not merely a same-agent match. This matters because a task-notification
 * fires every time an agent stops (Claude Code's own note in the event: "the
 * same task-id may notify more than once") — an EARLIER notification for a
 * resumed agent can carry a genuinely different (intermediate) result that
 * must NOT be stubbed just because the ids line up.
 *
 * The event is kept (not dropped) so event counts/timestamps stay stable and
 * the parent's narrative — *why* it delegated — survives as a short stub:
 * `[subagent <agentId> completed: <description>]`.
 */
function dedupeTaskNotifications(kept: readonly SessionEvent[]): SessionEvent[] {
  // Index the KEPT subagent events by the agentId embedded in their
  // transcript's filename, so a notification's <task-id> narrows the
  // comparison to the ONE subagent it reports on — and so an agentId with no
  // surviving event here means "nothing to dedupe against", not "assume it
  // exists upstream".
  const byAgentId = new Map<string, SessionEvent[]>();
  for (const event of kept) {
    const agentId = event.filePath?.match(SUBAGENT_FILEPATH_RE)?.[1];
    if (!agentId) continue;
    const list = byAgentId.get(agentId);
    if (list) list.push(event);
    else byAgentId.set(agentId, [event]);
  }
  if (byAgentId.size === 0) return kept as SessionEvent[]; // no folded subagent survived the budget — nothing to dedupe

  return kept.map((event) => {
    if (event.role !== "user" || !TASK_NOTIFICATION_RE.test(event.text)) return event;
    const taskId = event.text.match(TASK_ID_RE)?.[1];
    const resultRaw = event.text.match(RESULT_RE)?.[1];
    if (!taskId || !resultRaw) return event; // no <result> (e.g. a background-command notification) — nothing to compare
    const candidates = byAgentId.get(taskId);
    if (!candidates || candidates.length === 0) return event; // that subagent's own event didn't survive into this kept set
    const decodedResult = decodeXmlEntities(resultRaw);
    const isDuplicate = candidates.some(
      (c) => diceSimilarity(decodedResult, c.text.replace(PROVENANCE_PREFIX_RE, "")) >= DEDUPE_SIMILARITY_THRESHOLD,
    );
    if (!isDuplicate) return event;
    const summary = event.text.match(SUMMARY_RE)?.[1]?.trim();
    const description = (summary && (summary.match(AGENT_SUMMARY_DESCRIPTION_RE)?.[1] ?? summary)) || "completed";
    return { ...event, text: `[subagent ${taskId} completed: ${description}]` };
  });
}

export function preFilterSession(data: SessionData, options: PreFilterOptions = {}): PreFilterResult {
  const akmReadOnlyOps = options.akmReadOnlyOps ?? DEFAULT_AKM_READONLY_OPS;
  const maxLen = options.maxEventTextLength ?? DEFAULT_MAX_EVENT_LENGTH;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const droppedByRule: Record<string, number> = {};
  let kept: SessionEvent[] = [];
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

  // Post-pass (#839): dedupe a task-notification against a subagent event
  // ONLY when both survived into this exact kept set — see
  // dedupeTaskNotifications's doc for why that scoping is required. Recompute
  // totalChars afterward since stubbing can only shrink kept text, never move
  // anything across the budget boundary already decided above.
  kept = dedupeTaskNotifications(kept);
  const finalTotalChars = kept.reduce((sum, e) => sum + e.text.length, 0);

  return {
    events: kept,
    stats: {
      inputCount: data.events.length,
      outputCount: kept.length,
      droppedByRule,
      truncatedCount,
      totalChars: finalTotalChars,
      budgetDroppedCount,
    },
  };
}
