// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * GitHub Copilot CLI result extractor (P2, plan §"The adapter contract"
 * step 3 / §"Structured-output normalization", tier "native-json").
 *
 * Normalizes one raw {@link AgentRunResult} from a headless `copilot` run
 * into `{ text, sessionId? }` — the {@link AgentResultExtraction} seam. The
 * engine's shared schema-validation / retry-until-valid loop runs *after*
 * this; the extractor only strips transport framing.
 *
 * Copilot's stdout takes one of three shapes depending on flags/version
 * (`--output-format json` per the capability matrix), all handled here:
 *
 *  1. **Single JSON document** — a result envelope, e.g.
 *     `{"type":"result","session_id":"…","result":"<final answer>"}`.
 *     Pretty-printed multi-line JSON is included (whole-stdout parse is
 *     attempted first). Only objects carrying a transport marker (a `type`
 *     discriminator or a session-id field) are unwrapped; a bare JSON answer
 *     with no marker (a schema unit's `{"result":"ok"}`) is passed through
 *     raw so the engine's schema validator sees the whole object.
 *  2. **JSONL event stream** — one JSON object per line
 *     (`session.start` / assistant `message` / `result` events); the LAST
 *     text-bearing event wins, the first session-id-bearing event supplies
 *     the session id. Non-JSON banner lines are skipped.
 *  3. **Plain text** — no JSON anywhere; trimmed stdout passes through
 *     verbatim (the engine's embedded-JSON parsing still runs downstream for
 *     schema units).
 *
 * Key names are matched tolerantly (`result`/`response`/`text`/`output`/
 * `content`/`message`, snake_case and camelCase session-id variants) so
 * point-release renames in the CLI's envelope degrade to the plain-text
 * fallback instead of hard-failing — version churn stays contained in this
 * one file, per the adapter contract.
 *
 * NOT registered anywhere: attaching this as `AkmHarness.resultExtractor` on
 * a copilot registry entry is the follow-up integration task.
 */

import type { AgentResultExtraction, AgentResultExtractor } from "../../agent/builder-shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that may carry the final answer, in precedence order. */
const TEXT_KEYS = ["result", "response", "text", "output", "content", "message"] as const;

/** Keys that may carry the harness-native session id, in precedence order. */
const SESSION_KEYS = ["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId"] as const;

/**
 * Coerce a candidate value into text. Handles the shapes Copilot's envelope
 * nests answers in: bare strings, `{content|text}` wrappers (assistant
 * message objects), and arrays of `{type:"text",text}` content blocks.
 * Depth-bounded: JSON.parse output is acyclic, but nesting is capped anyway
 * so a pathological envelope cannot recurse unboundedly.
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

/** Extract the final-answer text from one parsed JSON value, if any. */
function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const key of TEXT_KEYS) {
    if (!(key in value)) continue;
    const text = textOf(value[key]);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** Extract a harness-native session id from one parsed JSON value, if any. */
function extractSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of SESSION_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * `type` discriminator values Copilot's `--output-format json` envelopes are
 * documented to use (plus the `session.*` event family). Deliberately a
 * CLOSED set: a schema unit's own answer may legitimately be a discriminated
 * union with a `type` field (`{"type":"success","output":"data"}`), and
 * treating ANY string `type` as a transport marker would unwrap — and
 * corrupt — such answers. An unrecognized type degrades to raw pass-through,
 * which the schema validator handles (whole object) and free-text tolerates.
 */
const ENVELOPE_TYPES = new Set(["result", "response", "message", "assistant", "error"]);

/**
 * Does this parsed object look like one of Copilot's transport ENVELOPES (a
 * `result`/event document) rather than a bare JSON answer the model produced?
 *
 * Copilot's `--output-format json` documents always carry a transport marker:
 * a known `type` discriminator (`"result"`, `"session.start"`, `"message"`, …)
 * and, in every documented result envelope, a session-id field. A bare
 * structured answer a schema unit was asked for — e.g. `{"result":"ok"}` or
 * `{"type":"success","output":"data"}` — carries neither a known discriminator
 * nor (normally) a session-id key. Unwrapping such an answer would hand the
 * schema validator only the field value (`"ok"`) and reject the run despite
 * valid JSON (PR #714 review), so we only unwrap objects that are genuinely
 * envelopes and pass everything else through raw.
 */
function isTransportEnvelope(value: Record<string, unknown>): boolean {
  const type = value.type;
  if (typeof type === "string" && (ENVELOPE_TYPES.has(type) || type.startsWith("session."))) return true;
  return extractSessionId(value) !== undefined;
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
 * Normalize a raw copilot run result into `{ text, sessionId? }`.
 * See the module doc for the three stdout shapes handled.
 */
export const copilotResultExtractor: AgentResultExtractor = (result): AgentResultExtraction => {
  // The raw result's own sessionId (SDK-style paths) is the fallback; an id
  // found in the output stream wins because it is fresher.
  const fallbackSessionId = result.sessionId;
  const raw = result.stdout.trim();

  // Shape 1 — whole stdout is one JSON document (spawn may have pre-parsed
  // it when the profile requested parseOutput: "json").
  const whole = result.parsed !== undefined ? result.parsed : raw.length > 0 ? tryParseJson(raw) : undefined;
  if (whole !== undefined) {
    const sessionId = extractSessionId(whole) ?? fallbackSessionId;
    // A bare JSON OBJECT with no transport marker is a legitimate structured
    // answer (a schema unit's `{"result":"ok"}`), NOT an envelope — pass its
    // raw JSON through so the engine's schema validator receives the whole
    // object instead of an unwrapped field value (PR #714 review). Only
    // genuine Copilot envelopes are unwrapped; non-object JSON (a top-level
    // string/array/primitive) keeps the prior extraction. Either way, an
    // unknown envelope with no recognized text key falls back to raw stdout.
    const text = isRecord(whole) && !isTransportEnvelope(whole) ? raw : (extractText(whole) ?? raw);
    return { text, ...(sessionId ? { sessionId } : {}) };
  }

  // Shape 2 — JSONL event stream: last text-bearing event wins; first
  // session-id-bearing event supplies the id. Non-JSON lines are banner
  // noise and are skipped.
  let lastText: string | undefined;
  let streamSessionId: string | undefined;
  let sawJsonLine = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const event = tryParseJson(trimmed);
    if (event === undefined) continue;
    sawJsonLine = true;
    streamSessionId ??= extractSessionId(event);
    const text = extractText(event);
    if (text !== undefined) lastText = text;
  }
  if (sawJsonLine) {
    const sessionId = streamSessionId ?? fallbackSessionId;
    return { text: lastText ?? raw, ...(sessionId ? { sessionId } : {}) };
  }

  // Shape 3 — plain text passthrough.
  return { text: raw, ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}) };
};
