// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Gemini CLI result extractor (P2, plan §"The adapter contract" step 3 /
 * §"Structured-output normalization", tier "native-json").
 *
 * Normalizes one raw {@link AgentRunResult} from a headless `gemini` run into
 * `{ text, sessionId? }` — the {@link AgentResultExtraction} seam. The
 * engine's shared schema-validation / retry-until-valid loop runs *after*
 * this; the extractor only strips transport framing.
 *
 * Gemini's stdout takes one of three shapes depending on flags/version
 * (`--output-format json` per the capability matrix), all handled here:
 *
 *  1. **Single JSON document** — the documented `--output-format json`
 *     envelope, e.g. `{"response":"<final answer>","stats":{...}}` (an
 *     `error` variant carries `{error:{type,message,code}}` and no usable
 *     response — that degrades to the raw-stdout fallback so the engine's
 *     failure handling sees the whole envelope). Pretty-printed multi-line
 *     JSON is included (whole-stdout parse is attempted first).
 *  2. **JSONL event stream** (`--output-format stream-json`) — one JSON
 *     object per line; the LAST text-bearing event wins, the first
 *     session-id-bearing event supplies the session id. Non-JSON banner
 *     lines ("Loaded cached credentials.", update notices) are skipped.
 *  3. **Plain text** — no JSON anywhere; trimmed stdout passes through
 *     verbatim (the engine's embedded-JSON parsing still runs downstream for
 *     schema units).
 *
 * Key names are matched tolerantly (`response` first — Gemini's documented
 * envelope key — then `result`/`text`/`output`/`content`/`message`;
 * snake_case and camelCase session-id variants) so point-release renames in
 * the CLI's envelope degrade to the plain-text fallback instead of
 * hard-failing — version churn stays contained in this one file, per the
 * adapter contract. The session id feeds `--resume <id>` opportunistically;
 * `workflow_run_units` remains the durable source of truth.
 *
 * NOT registered anywhere: attaching this as `AkmHarness.resultExtractor` on
 * a gemini registry entry is the follow-up integration task.
 */

import type { AgentResultExtraction, AgentResultExtractor } from "../../agent/builder-shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys that may carry the final answer, in precedence order. `response` is
 * Gemini's documented `--output-format json` envelope key.
 */
const TEXT_KEYS = ["response", "result", "text", "output", "content", "message"] as const;

/** Keys that may carry the harness-native session id, in precedence order. */
const SESSION_KEYS = ["session_id", "sessionId", "conversation_id", "conversationId", "chat_id", "chatId"] as const;

/**
 * Coerce a candidate value into text. Handles the shapes Gemini nests
 * answers in: bare strings, `{content|text}` wrappers (assistant message
 * objects), and arrays of `{type:"text",text}` content blocks (Gemini API
 * `parts`-style lists). Depth-bounded: JSON.parse output is acyclic, but
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

/** JSON.parse that returns undefined instead of throwing. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a raw gemini run result into `{ text, sessionId? }`.
 * See the module doc for the three stdout shapes handled.
 */
export const geminiResultExtractor: AgentResultExtractor = (result): AgentResultExtraction => {
  // The raw result's own sessionId (SDK-style paths) is the fallback; an id
  // found in the output stream wins because it is fresher.
  const fallbackSessionId = result.sessionId;
  const raw = result.stdout.trim();

  // Shape 1 — whole stdout is one JSON document (spawn may have pre-parsed
  // it when the profile requested parseOutput: "json").
  const whole = result.parsed !== undefined ? result.parsed : raw.length > 0 ? tryParseJson(raw) : undefined;
  if (whole !== undefined) {
    const sessionId = extractSessionId(whole) ?? fallbackSessionId;
    // Unknown envelope (no recognized text key — includes the error-only
    // variant): fall back to raw stdout so downstream embedded-JSON parsing
    // and failure handling still have the full material to work with.
    const text = extractText(whole) ?? raw;
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
