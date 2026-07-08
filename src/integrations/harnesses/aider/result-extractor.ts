// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Aider CLI result extractor (P2, plan §"The adapter contract" step 3 /
 * §"Structured-output normalization", tier "none").
 *
 * Normalizes one raw {@link AgentRunResult} from a headless
 * `aider --message … --yes-always` run into `{ text, sessionId? }` — the
 * {@link AgentResultExtraction} seam. The engine's shared embedded-JSON
 * extraction (`parseEmbeddedJsonResponse`) + schema-validation /
 * retry-until-valid loop run *after* this; the extractor only strips
 * transport framing.
 *
 * Aider has NO structured output mode (capability matrix: "none — parse
 * output"): stdout is plain terminal text — the model's reply surrounded by
 * Aider's own announcements. A representative capture:
 *
 *   aider v0.85.1
 *   Main model: claude-sonnet-4-6 with diff edit format
 *   Weak model: claude-haiku-4-5
 *   Git repo: .git with 143 files
 *   Repo-map: using 4096 tokens, auto refresh
 *   ────────────────────────────────────────
 *   <the assistant's actual reply, possibly multi-line>
 *   Applied edit to src/foo.py
 *   Commit a1b2c3d fix: handle empty input
 *   Tokens: 4.2k sent, 310 received. Cost: $0.02 message, $0.02 session.
 *
 * Extraction rules:
 *   - text: line-level noise filtering — ANSI escape sequences are stripped
 *     (defensive; the builder always passes `--no-pretty`), then lines
 *     matching Aider's documented banner/status/footer announcements are
 *     dropped and the remainder is trimmed. Filtering is CONSERVATIVE
 *     (anchored prefixes only) so real reply content is never eaten; if
 *     filtering would remove everything, the full trimmed stdout is returned
 *     instead — the downstream embedded-JSON tier always gets a fair input.
 *   - sessionId: NEVER derived from output. Aider has no session model —
 *     context persists in chat-history files (`.aider.chat.history.md`), not
 *     ids — so only a sessionId already attached by the spawn layer is passed
 *     through. akm's `workflow_run_units` is the durable resume source of
 *     truth regardless (plan §"Session, MCP, and identity across harnesses" —
 *     Aider is the plan's named no-session example).
 *
 * NOT registered anywhere: attaching this as `AkmHarness.resultExtractor` on
 * an aider registry entry is the follow-up integration task.
 */

import type { AgentResultExtraction, AgentResultExtractor } from "../../agent/builder-shared";

/**
 * ANSI escape sequences (CSI color/cursor codes). Defensive only: the builder
 * always passes `--no-pretty`, but a user profile may override that.
 * Constructed from a char code so no literal control character appears in
 * source (lint-friendly, same bytes).
 */
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/**
 * Aider's own announcement lines — banner, model/repo configuration echo,
 * chat-history notices, edit/commit/usage reports. All patterns are anchored
 * at line start and match documented phrasings only; anything else is treated
 * as reply content.
 */
const NOISE_LINE_PATTERNS: readonly RegExp[] = [
  /^aider v\d/, // version banner
  /^(Main model|Weak model|Editor model|Model):\s/, // model announcements
  /^Git repo:\s/, // repo detection
  /^Repo-map:\s/, // repo-map status
  /^Added .+ to the chat\.?$/, // file add notices
  /^Restored previous conversation history\.?$/, // chat-history reload notice
  /^Use \/help\b/, // onboarding hint line
  /^Tokens: .+/, // usage/cost footer
  /^Cost: .+/, // standalone cost footer
  /^Applied edit to .+/, // edit application notices
  /^Commit [0-9a-f]{6,}\b/, // auto-commit notices
  /^You can use \/undo\b/, // undo hint after auto-commit
  /^[─━-]{4,}$/, // ── / ━━ / ---- separator rules
];

function isNoiseLine(line: string): boolean {
  return NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Normalize a raw aider run result into `{ text, sessionId? }`.
 * See the module doc for the stdout shape handled.
 */
export const aiderResultExtractor: AgentResultExtractor = (result): AgentResultExtraction => {
  const raw = result.stdout.replace(ANSI_ESCAPE_RE, "").trim();

  const kept = raw
    .split("\n")
    .filter((line) => !isNoiseLine(line.trim()))
    .join("\n")
    .trim();

  // Never return empty text when stdout had content: an all-noise filter
  // outcome means the patterns over-matched for this capture, so fall back to
  // the full trimmed stdout (downstream parsing still gets material).
  const text = kept.length > 0 ? kept : raw;

  // No session model (chat-history files, not ids): only a spawn-layer id
  // passes through; output never supplies one.
  return result.sessionId === undefined ? { text } : { text, sessionId: result.sessionId };
};
