// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pi coding-agent CLI result extractor (P2, plan §"The adapter contract"
 * step 3 / §"Structured-output normalization", tier "native-json").
 *
 * Normalizes one raw {@link AgentRunResult} from a headless `pi` run into
 * `{ text, sessionId? }` — the {@link AgentResultExtraction} seam. The
 * engine's shared schema-validation / retry-until-valid loop runs *after*
 * this; the extractor only strips transport framing.
 *
 * With `--mode json` (the capability matrix's structured mode) Pi emits ONE
 * JSON event per stdout line — the agent-session event stream, e.g.:
 *
 *   {"type":"session_start","session_id":"<id>"}
 *   {"type":"agent_start"}
 *   {"type":"message_start","message":{"role":"assistant","content":[]}}
 *   {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"<text>"}]}}
 *   {"type":"agent_end","messages":[{"role":"assistant","content":[...]}]}
 *
 * Extraction rules:
 *   - text: the LAST assistant text-bearing event wins (`message_end` bodies;
 *     an `agent_end` transcript's final assistant message; tolerant flat
 *     `role:"assistant"` events). User-role echoes / tool events never
 *     contribute. Assistant content blocks are flattened; non-text blocks
 *     (thinking, tool use) are skipped.
 *   - sessionId: the FIRST session-id-bearing event supplies it (snake_case /
 *     camelCase variants, plus `id` on `session*`-typed events), falling back
 *     to any sessionId the spawn layer already attached. Stored
 *     opportunistically on the unit row for `--session <id>` resume; akm
 *     never depends on it (plan §"Session, MCP, and identity").
 *
 * Also handled, so version churn stays contained in this one file (per the
 * adapter contract):
 *   - a single whole-stdout JSON document (or a spawn-layer `result.parsed`
 *     value) is interpreted with the same rules;
 *   - plain text (no `--mode json`, or an unrecognized envelope) passes
 *     through trimmed — the engine's embedded-JSON parsing still runs
 *     downstream for schema units;
 *   - non-JSON banner lines interleaved in the stream are skipped.
 *
 * NOT registered anywhere: attaching this as `AkmHarness.resultExtractor` on
 * a pi registry entry is the follow-up integration task.
 */

import type { AgentResultExtraction, AgentResultExtractor } from "../../agent/builder-shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that may carry the harness-native session id, in precedence order. */
const SESSION_KEYS = ["session_id", "sessionId", "session"] as const;

/**
 * Coerce a candidate value into text. Handles the shapes Pi nests assistant
 * answers in: bare strings, arrays of content blocks, and `{content|text}`
 * wrappers. Blocks without a `content`/`text` string (thinking, tool-use)
 * contribute nothing. Depth-bounded: JSON.parse output is acyclic, but
 * nesting is capped anyway so a pathological envelope cannot recurse
 * unboundedly.
 */
function textOf(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const block of value) {
      const t = textOf(block, depth + 1);
      if (t) parts.push(t);
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (isRecord(value)) {
    return textOf(value.content ?? value.text, depth + 1);
  }
  return undefined;
}

/** Extract the text of one assistant-authored message record, if it is one. */
function assistantMessageText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  return textOf(message.content ?? message.text);
}

/**
 * Extract assistant text from one parsed JSON event/value:
 * `message` envelopes (`message_start`/`message_end`), `messages` transcripts
 * (`agent_end` — last assistant entry wins), and tolerant flat
 * `role:"assistant"` events.
 */
function extractAssistantText(event: Record<string, unknown>): string | undefined {
  const fromEnvelope = assistantMessageText(event.message);
  if (fromEnvelope !== undefined) return fromEnvelope;
  const transcript = event.messages;
  if (Array.isArray(transcript)) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const text = assistantMessageText(transcript[i]);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  return assistantMessageText(event);
}

/** Extract a harness-native session id from one parsed JSON value, if any. */
function extractSessionId(event: Record<string, unknown>): string | undefined {
  for (const key of SESSION_KEYS) {
    const candidate = event[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  // Session-lifecycle events may carry the id under a bare `id` key.
  if (typeof event.type === "string" && event.type.startsWith("session") && typeof event.id === "string" && event.id) {
    return event.id;
  }
  return undefined;
}

/** JSON.parse that returns undefined instead of throwing. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a raw pi run result into `{ text, sessionId? }`.
 * See the module doc for the stdout shapes handled.
 */
export const piResultExtractor: AgentResultExtractor = (result): AgentResultExtraction => {
  // The raw result's own sessionId (SDK-style paths) is the fallback; an id
  // found in the output stream wins because it is fresher.
  const fallbackSessionId = result.sessionId;
  const raw = result.stdout.trim();

  // Shape 1 — whole stdout is one JSON document (spawn may have pre-parsed it
  // when the profile requested parseOutput: "json"). A multi-event JSONL
  // stream never parses as a single document, so this cannot shadow shape 2.
  const whole = result.parsed !== undefined ? result.parsed : raw.length > 0 ? tryParseJson(raw) : undefined;
  if (whole !== undefined) {
    if (typeof whole === "string") {
      return { text: whole, ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}) };
    }
    if (isRecord(whole)) {
      const sessionId = extractSessionId(whole) ?? fallbackSessionId;
      // Unknown envelope (no assistant text): fall back to raw stdout so
      // downstream embedded-JSON parsing still has material to work with.
      const text = extractAssistantText(whole) ?? textOf(whole) ?? raw;
      return { text, ...(sessionId ? { sessionId } : {}) };
    }
  }

  // Shape 2 — JSONL event stream (`--mode json`): last assistant text-bearing
  // event wins; first session-id-bearing event supplies the id. Non-JSON
  // banner lines are skipped.
  let lastText: string | undefined;
  let streamSessionId: string | undefined;
  let sawJsonLine = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const event = tryParseJson(trimmed);
    if (event === undefined || !isRecord(event)) continue;
    sawJsonLine = true;
    streamSessionId ??= extractSessionId(event);
    const text = extractAssistantText(event);
    if (text !== undefined && text.length > 0) lastText = text;
  }
  if (sawJsonLine) {
    const sessionId = streamSessionId ?? fallbackSessionId;
    return { text: lastText ?? raw, ...(sessionId ? { sessionId } : {}) };
  }

  // Shape 3 — plain text passthrough.
  return { text: raw, ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}) };
};
