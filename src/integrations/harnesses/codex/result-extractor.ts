// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenAI Codex CLI result extractor (P2, plan §"The adapter contract" step 3 /
 * §"Structured-output normalization").
 *
 * Normalizes the raw {@link AgentRunResult} of a `codex exec --json` run into
 * `{ text, sessionId? }` ({@link AgentResultExtraction}). Schema validation and
 * the retry-until-valid loop stay in the engine, shared across harnesses —
 * this module only strips transport framing.
 *
 * `--json` emits ONE JSON event per stdout line. Two documented event dialects
 * exist across codex versions; the adapter contract localizes that churn here,
 * so both are handled:
 *
 * Legacy protocol (envelope with an `msg` object):
 *   {"id":"0","msg":{"type":"session_configured","session_id":"<uuid>", ...}}
 *   {"id":"1","msg":{"type":"agent_message","message":"<text>"}}
 *   {"id":"1","msg":{"type":"task_complete","last_agent_message":"<text>"}}
 *
 * Newer experimental-JSON protocol (flat `type` field):
 *   {"type":"thread.started","thread_id":"<id>"}
 *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"<text>"}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * Extraction rules:
 *   - text: `task_complete.last_agent_message` wins when present (it is the
 *     harness's own "final answer" designation); otherwise the LAST
 *     agent-message event seen; otherwise the trimmed raw stdout (plain-text
 *     fallback for runs without `--json`, or unrecognized formats — the
 *     engine's `parseEmbeddedJsonResponse` tier still gets a fair input).
 *   - sessionId: `session_configured.session_id` / `thread.started.thread_id`,
 *     falling back to any sessionId the spawn layer already attached. Stored
 *     opportunistically on the unit row for `codex exec resume <id>`; akm
 *     never depends on it (plan §"Session, MCP, and identity").
 *
 * Non-event JSON lines (e.g. a bare JSON answer printed without framing) are
 * ignored by the event scan and land in the raw-stdout fallback untouched.
 *
 * NOT registered anywhere yet (`AkmHarness.resultExtractor` wiring is the
 * follow-up integration task). Exported cleanly for that task to import.
 */

import type { AgentResultExtraction, AgentResultExtractor } from "../../agent/builder-shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** What one JSONL event contributed, if anything. */
interface EventContribution {
  sessionId?: string;
  /** An intermediate/final agent message body. */
  agentMessage?: string;
  /** The harness-designated final answer (task_complete). */
  finalMessage?: string;
}

/** Interpret one parsed JSONL event in either codex event dialect. */
function interpretEvent(event: Record<string, unknown>): EventContribution {
  // Legacy protocol: {"id":..., "msg":{"type": ...}}
  const msg = event.msg;
  if (isRecord(msg)) {
    switch (msg.type) {
      case "session_configured":
        return { sessionId: asNonEmptyString(msg.session_id) };
      case "agent_message":
        return { agentMessage: asNonEmptyString(msg.message) };
      case "task_complete":
        return { finalMessage: asNonEmptyString(msg.last_agent_message) };
      default:
        return {};
    }
  }
  // Newer protocol: flat {"type": "thread.started" | "item.completed" | ...}
  switch (event.type) {
    case "thread.started":
      return { sessionId: asNonEmptyString(event.thread_id) };
    case "item.completed": {
      const item = event.item;
      if (isRecord(item) && item.type === "agent_message") {
        return { agentMessage: asNonEmptyString(item.text) };
      }
      return {};
    }
    default:
      return {};
  }
}

/**
 * Codex result extractor: JSONL event stream (either dialect) → final agent
 * message + opportunistic session id, with a plain-stdout fallback.
 */
export const codexResultExtractor: AgentResultExtractor = (result): AgentResultExtraction => {
  let sessionId = result.sessionId;
  let lastAgentMessage: string | undefined;
  let finalMessage: string | undefined;

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    // Every codex event line is a JSON object; skip banner/noise lines cheaply.
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // not a complete JSON line (e.g. wrapped text) — ignore
    }
    if (!isRecord(parsed)) continue;
    const contribution = interpretEvent(parsed);
    if (contribution.sessionId) sessionId = contribution.sessionId;
    if (contribution.agentMessage) lastAgentMessage = contribution.agentMessage;
    if (contribution.finalMessage) finalMessage = contribution.finalMessage;
  }

  const text = finalMessage ?? lastAgentMessage ?? result.stdout.trim();
  return sessionId === undefined ? { text } : { text, sessionId };
};
