// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Claude Code CLI result extractor (Codex round-3 finding A; plan §"The adapter
 * contract" step 3 / §"Structured-output normalization", tier "native-json").
 *
 * Normalizes one raw {@link AgentRunResult} from a headless `claude -p` run into
 * `{ text, sessionId? }` — the {@link AgentResultExtraction} seam. The engine's
 * shared schema-validation / retry-until-valid loop runs *after* this; the
 * extractor only strips transport framing.
 *
 * A schema-bearing unit is dispatched with `--output-format json` (see
 * `./agent-builder.ts`), so stdout is Claude Code's documented RESULT ENVELOPE —
 * a single JSON object:
 *
 *   {"type":"result","subtype":"success","is_error":false,
 *    "result":"<final answer>","session_id":"<uuid>","total_cost_usd":…,"usage":…}
 *
 * The final answer the model produced lives in `result` (a string); the
 * harness-native session id in `session_id`, stored opportunistically on the
 * unit row for `claude --resume <id>` (akm never depends on it —
 * `workflow_run_units` stays the source of truth).
 *
 * A SCHEMALESS unit is dispatched WITHOUT `--output-format json`, so stdout is
 * plain text — passed through verbatim (untrimmed) so the schemaless dispatch
 * path is byte-identical to the pre-extractor behaviour. Only a genuine result
 * envelope (a `type: "result"` object, or one carrying both a string `result`
 * and a `session_id`) is unwrapped; anything else degrades to raw pass-through,
 * so a point-release envelope rename fails soft (the engine's embedded-JSON
 * parsing still runs downstream for schema units) rather than hard.
 */

import type { AgentResultExtraction, AgentResultExtractor } from "../../agent/builder-shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
 * Is this parsed object Claude Code's `--output-format json` RESULT ENVELOPE
 * (rather than a bare JSON answer a schema unit produced without the flag)? A
 * genuine envelope declares `type: "result"`, or carries the two envelope-only
 * fields together (a string `result` AND a `session_id`). A bare structured
 * answer — `{"result":"ok"}` — carries neither marker, so it is passed through
 * raw and the engine's schema validator sees the whole object.
 */
function isResultEnvelope(value: Record<string, unknown>): boolean {
  if (value.type === "result") return true;
  return typeof value.result === "string" && asNonEmptyString(value.session_id) !== undefined;
}

/**
 * Normalize a raw claude run result into `{ text, sessionId? }`. See the module
 * doc for the two stdout shapes (JSON result envelope vs plain text).
 */
export const claudeResultExtractor: AgentResultExtractor = (result): AgentResultExtraction => {
  const fallbackSessionId = result.sessionId;
  const raw = result.stdout;
  const trimmed = raw.trim();

  // Only attempt an envelope parse when stdout looks like a single JSON object
  // (`--output-format json`). A plain-text run is passed through UNCHANGED
  // (untrimmed) so schemaless dispatch stays byte-identical to today.
  if (trimmed.startsWith("{")) {
    const whole = result.parsed !== undefined ? result.parsed : tryParseJson(trimmed);
    if (isRecord(whole) && isResultEnvelope(whole)) {
      const text = typeof whole.result === "string" ? whole.result : trimmed;
      const sessionId = asNonEmptyString(whole.session_id) ?? fallbackSessionId;
      return { text, ...(sessionId ? { sessionId } : {}) };
    }
  }

  return { text: raw, ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}) };
};
