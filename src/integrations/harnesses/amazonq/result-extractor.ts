// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Amazon Q Developer CLI result extractor (P2, plan §"The adapter contract"
 * step 3 / §"Structured-output normalization", tier "none").
 *
 * Normalizes one raw {@link AgentRunResult} from a headless
 * `q chat --no-interactive` run into `{ text, sessionId? }` — the
 * {@link AgentResultExtraction} seam. Q has NO documented structured output
 * (no JSON/JSONL mode; capability matrix: *(none documented)*), so unlike the
 * codex/copilot/pi extractors there is no event stream to walk: the entire
 * job here is stripping *terminal* framing from plain-text stdout so the
 * engine's downstream embedded-JSON parse (`parseEmbeddedJsonResponse`) and
 * the shared schema-validation / retry-until-valid loop get clean material.
 *
 * What `q chat` actually writes to a captured stdout (it styles output even
 * when piped):
 *   - ANSI SGR/cursor sequences (colors, bold, erase-line) around the answer;
 *   - OSC sequences (window title, hyperlinks) terminated by BEL or ST;
 *   - carriage-return spinner frames ("⠋ Thinking..." redrawn in place) — on
 *     a real terminal each `\r` overwrites the line, so in captured output
 *     only the content after the LAST `\r` of a line is what the user would
 *     have seen;
 *   - a leading "> " response marker on the first answer line.
 *
 * Extraction rules, in order:
 *   1. Resolve `\r` overwrites per line (keep the final frame), drop ANSI/OSC
 *      sequences, drop the leading "> " marker line-prefix on the first
 *      non-empty line, trim.
 *   2. A spawn-layer `result.parsed` string (profile `parseOutput: "json"`
 *      where the whole answer WAS bare JSON that parsed to a string) is used
 *      verbatim; any other parsed shape is ignored — Q documents no JSON
 *      envelope, so guessing keys would be invention.
 *   3. Embedded JSON is left INTACT inside the text — extraction of the JSON
 *      value out of prose is the engine's job, shared across all tier-"none"
 *      harnesses (plan: "akm injects the schema into the prompt, extracts
 *      embedded JSON from stdout").
 *   4. sessionId: Q never prints one — its `--resume` is directory-scoped and
 *      takes no id — so only a sessionId the spawn layer already attached is
 *      passed through. akm never depends on it (plan §"Session, MCP, and
 *      identity across harnesses").
 *
 * NOT registered anywhere: attaching this as `AkmHarness.resultExtractor` on
 * an amazonq registry entry is the follow-up integration task.
 */

import type { AgentResultExtraction, AgentResultExtractor } from "../../agent/builder-shared";

const ESC = "\u001B";
const BEL = "\u0007";

/**
 * Matches ANSI CSI sequences (colors, cursor movement, erase-line) and OSC
 * sequences (title, hyperlink) terminated by BEL or ST. Built via the RegExp
 * constructor so the control characters live in named string constants
 * instead of regex-literal escapes.
 */
const ANSI_SEQUENCE = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]` + `|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);

/**
 * Resolve carriage-return overwrites within one physical line: a terminal
 * would redraw from column 0 at each `\r`, so only the segment after the last
 * `\r` survives (spinner frames like "⠋ Thinking..." disappear exactly as
 * they do on screen). A trailing bare `\r` (CRLF line endings) is handled by
 * splitting on `\r?\n` before this runs.
 */
function resolveCarriageReturns(line: string): string {
  const lastCr = line.lastIndexOf("\r");
  return lastCr === -1 ? line : line.slice(lastCr + 1);
}

/** Strip terminal framing from raw captured stdout. See module doc, rule 1. */
export function stripTerminalFraming(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => resolveCarriageReturns(line).replace(ANSI_SEQUENCE, ""));
  // Drop Q's "> " response marker from the first non-empty line only — deeper
  // occurrences may be legitimate content (markdown blockquotes).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    if (line.startsWith("> ")) lines[i] = line.slice(2);
    break;
  }
  return lines.join("\n").trim();
}

/**
 * Normalize a raw Amazon Q run result into `{ text, sessionId? }`.
 * See the module doc for the rules.
 */
export const amazonqResultExtractor: AgentResultExtractor = (result): AgentResultExtraction => {
  const sessionId = result.sessionId;
  // Rule 2: a pre-parsed whole-stdout JSON *string* is the answer itself.
  const text = typeof result.parsed === "string" ? result.parsed.trim() : stripTerminalFraming(result.stdout);
  return { text, ...(sessionId ? { sessionId } : {}) };
};
