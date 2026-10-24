// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 2 session messages into the session-log contract. The messages come
 * from the embedded OpenCode (`../opencode-sdk/sdk-runner.ts`
 * `readOpencodeSession`), oldest first, in `@opencode/sdk`'s
 * `SessionMessageInfo` shapes.
 *
 * Mapping follows the Codex reader: user and assistant text become events of
 * that role, a tool call becomes `[tool:<name>] <input>` and its outcome a
 * `tool` event `[tool_result] <output>`, so the inline-ref scanner sees shell
 * commands. Reasoning, compaction, synthetic/system and bookkeeping messages
 * are skipped.
 */

import { asRecord } from "../../../core/common";
import { extractInlineRefMentions } from "../../session-logs/inline-refs";
import type { InlineRefMention, SessionEvent } from "../../session-logs/types";

type Json = Record<string, unknown>;
const asObject = asRecord;

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** A tool input as text: a shell command stays a bare command line so inline-ref scanning matches it. */
function toolInputText(input: unknown): string {
  const fields = asObject(input);
  const cmd = fields?.command ?? fields?.cmd;
  if (typeof cmd === "string") return cmd;
  if (typeof input === "string") return input;
  return JSON.stringify(input ?? {}) ?? "";
}

/** Tool output blocks as text: text blocks verbatim, file blocks as a `[file: uri]` marker. */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    const b = asObject(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (b.type === "file" && typeof b.uri === "string") out.push(`[file: ${b.uri}]`);
  }
  return out.join("\n");
}

function structuredErrorText(err: unknown): string {
  const e = asObject(err);
  if (typeof e?.message === "string") return e.message;
  return typeof e?.type === "string" ? e.type : "error";
}

/** One session's events and inline refs, from its messages oldest first. A message that is not an object is skipped. */
export function opencodeMessageEvents(
  messages: readonly unknown[],
  harness: string,
  sessionId: string,
  filePath: string,
): { events: SessionEvent[]; inlineRefs: InlineRefMention[] } {
  const events: SessionEvent[] = [];
  const inlineRefs: InlineRefMention[] = [];
  const push = (role: SessionEvent["role"], text: string, ts: number | undefined) => {
    const trimmed = text.trim();
    if (trimmed.length < 1) return;
    events.push({ harness, text: trimmed, ts, sessionId, role, filePath });
    inlineRefs.push(...extractInlineRefMentions(trimmed, ts));
  };

  for (const message of messages) {
    const data = asObject(message);
    if (!data) continue;
    const ts = asNumber(asObject(data.time)?.created);

    if (data.type === "user") {
      if (typeof data.text === "string") push("user", data.text, ts);
    } else if (data.type === "assistant") {
      const content = Array.isArray(data.content) ? data.content : [];
      const text = content
        .map((c) => asObject(c))
        .filter((c): c is Json => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
      push("assistant", text, ts);
      for (const item of content) {
        const tool = asObject(item);
        if (tool?.type !== "tool") continue;
        const state = asObject(tool.state);
        const name = typeof tool.name === "string" ? tool.name : "tool";
        const toolTime = asObject(tool.time);
        const callTs = asNumber(toolTime?.created) ?? ts;
        push("assistant", `[tool:${name}] ${toolInputText(state?.input)}`, callTs);
        // Streaming/running calls are incomplete history: the call is kept, no result is invented.
        const doneTs = asNumber(toolTime?.completed) ?? callTs;
        if (state?.status === "completed") {
          push("tool", `[tool_result] ${toolContentText(state.content)}`, doneTs);
        } else if (state?.status === "error") {
          const body = toolContentText(state.content) || structuredErrorText(state.error);
          push("tool", `[tool_result] ${body}`, doneTs);
        }
      }
    } else if (data.type === "shell") {
      if (typeof data.command === "string") push("assistant", `[tool:shell] ${data.command}`, ts);
      const out = asObject(data.output)?.output;
      if (typeof out === "string") push("tool", `[tool_result] ${out}`, ts);
    }
  }

  return { events, inlineRefs };
}
