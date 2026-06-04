// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Extract inline `akm remember "..."` and `akm feedback <ref> --note "..."`
 * invocations from a chunk of session text. Used by session-log harnesses to
 * record what the agent already preserved so the extractor LLM can skip
 * content the agent judged worth saving on its own.
 *
 * Detects shell-style invocations across the variants observed in real
 * Claude Code / opencode session logs:
 *   - `akm remember "body text"`
 *   - `akm remember 'body text'`
 *   - `akm feedback knowledge:foo --positive --note "bar"`
 *   - `akm feedback skill:x --negative -n "missed something"`
 *
 * Heuristic, not a shell parser: matches the common shapes and skips edge
 * cases (heredocs, multi-line strings, escaped quotes). False negatives are
 * fine — the extractor still works, it just sees one more "candidate" the
 * agent already covered. False positives are worse, so we err strict.
 */

import type { InlineRefMention } from "./types";

const REMEMBER_RE = /\bakm\s+remember\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
const FEEDBACK_RE =
  /\bakm\s+feedback\s+(\S+)(?:\s+--[a-z-]+)*\s+(?:--note|-n)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;

export function extractInlineRefMentions(text: string, ts?: number): InlineRefMention[] {
  if (!text || text.length < 10) return [];
  const out: InlineRefMention[] = [];
  REMEMBER_RE.lastIndex = 0;
  for (const m of text.matchAll(REMEMBER_RE)) {
    const body = m[1] ?? m[2] ?? "";
    if (!body.trim()) continue;
    out.push({
      kind: "remember",
      text: body,
      ...(ts !== undefined ? { ts } : {}),
    });
  }
  FEEDBACK_RE.lastIndex = 0;
  for (const m of text.matchAll(FEEDBACK_RE)) {
    const ref = m[1] ?? "";
    const note = m[2] ?? m[3] ?? "";
    if (!ref) continue;
    out.push({
      kind: "feedback",
      ref,
      text: note,
      ...(ts !== undefined ? { ts } : {}),
    });
  }
  return out;
}
