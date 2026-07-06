// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenHands CLI result extractor (P2, plan §"The adapter contract" step 3 /
 * §"Structured-output normalization", tier "native-json").
 *
 * Normalizes one raw {@link AgentRunResult} from a headless
 * `openhands --headless --json` run into `{ text, sessionId? }` — the
 * {@link AgentResultExtraction} seam. The engine's shared schema-validation /
 * retry-until-valid loop runs *after* this; the extractor only strips
 * transport framing.
 *
 * With `--json` OpenHands emits ONE JSON event per stdout line — its
 * action/observation event stream, e.g.:
 *
 *   {"id":0,"source":"user","action":"message","args":{"content":"<task>"},"message":"<task>"}
 *   {"id":1,"source":"agent","action":"run","args":{"command":"ls"},"message":"Running command: ls"}
 *   {"id":2,"source":"agent","observation":"run","content":"README.md","message":"Command `ls` executed."}
 *   {"id":3,"source":"agent","action":"message","args":{"content":"<answer>"},"message":"<answer>"}
 *   {"id":4,"source":"agent","action":"finish","args":{"final_thought":"<answer>","outputs":{}},"message":"..."}
 *
 * Extraction rules ("parse JSONL final message" per the capability matrix):
 *   - text: the LAST agent-sourced *message-bearing* event wins. Only two
 *     event kinds carry the agent's answer: `action:"message"`
 *     (`args.content`, falling back to the top-level `message` mirror) and
 *     `action:"finish"` (`args.final_thought`/`args.thought`, falling back to
 *     `message`). User echoes, observations, and tool actions (`run`, `edit`,
 *     …, whose `message` is progress noise like "Running command: ls") never
 *     contribute.
 *   - sessionId: the FIRST id-bearing event supplies it (`session_id`,
 *     `sessionId`, `sid`, `conversation_id`), falling back to any sessionId
 *     the spawn layer already attached. Stored opportunistically on the unit
 *     row; per the matrix OpenHands resume is workspace-state, so akm never
 *     depends on it (plan §"Session, MCP, and identity across harnesses").
 *
 * Also handled, so version churn stays contained in this one file (per the
 * adapter contract):
 *   - a single whole-stdout JSON document (or a spawn-layer `result.parsed`
 *     value) is interpreted with the same rules;
 *   - plain text (no `--json`, or an unrecognized envelope) passes through
 *     trimmed — the engine's embedded-JSON parsing still runs downstream for
 *     schema units;
 *   - non-JSON banner lines interleaved in the stream are skipped.
 *
 * NOT registered anywhere: attaching this as `AkmHarness.resultExtractor` on
 * an openhands registry entry is the follow-up integration task.
 */

import type { AgentResultExtraction, AgentResultExtractor } from "../../agent/builder-shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that may carry the harness-native session id, in precedence order. */
const SESSION_KEYS = ["session_id", "sessionId", "sid", "conversation_id"] as const;

/** Return a non-empty string, else undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract the agent's answer text from one parsed OpenHands event, if the
 * event is one of the two message-bearing kinds (see module doc). Everything
 * else — user echoes, observations, tool actions — yields undefined.
 */
function extractAgentText(event: Record<string, unknown>): string | undefined {
  // Only agent-authored events count; a missing `source` is tolerated for
  // finish/message actions from older serializations, but an explicit
  // non-agent source (user echo, environment) never contributes.
  if (event.source !== undefined && event.source !== "agent") return undefined;
  if (typeof event.action !== "string") return undefined;
  const args = isRecord(event.args) ? event.args : undefined;
  if (event.action === "message") {
    return nonEmptyString(args?.content) ?? nonEmptyString(event.message);
  }
  if (event.action === "finish") {
    return nonEmptyString(args?.final_thought) ?? nonEmptyString(args?.thought) ?? nonEmptyString(event.message);
  }
  return undefined;
}

/** Extract a harness-native session id from one parsed JSON value, if any. */
function extractSessionId(event: Record<string, unknown>): string | undefined {
  for (const key of SESSION_KEYS) {
    const candidate = nonEmptyString(event[key]);
    if (candidate) return candidate;
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
 * Normalize a raw openhands run result into `{ text, sessionId? }`.
 * See the module doc for the stdout shapes handled.
 */
export const openhandsResultExtractor: AgentResultExtractor = (result): AgentResultExtraction => {
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
      // Unknown envelope (no agent message): fall back to raw stdout so
      // downstream embedded-JSON parsing still has material to work with.
      const text = extractAgentText(whole) ?? raw;
      return { text, ...(sessionId ? { sessionId } : {}) };
    }
  }

  // Shape 2 — JSONL event stream (`--json`): last message-bearing agent event
  // wins; first id-bearing event supplies the session id. Non-JSON banner
  // lines are skipped.
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
    const text = extractAgentText(event);
    if (text !== undefined) lastText = text;
  }
  if (sawJsonLine) {
    const sessionId = streamSessionId ?? fallbackSessionId;
    return { text: lastText ?? raw, ...(sessionId ? { sessionId } : {}) };
  }

  // Shape 3 — plain text passthrough.
  return { text: raw, ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}) };
};
