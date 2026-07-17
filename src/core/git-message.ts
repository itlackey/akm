// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf util for sanitizing git commit messages.
 *
 * Split out of `core/write-source.ts` so that `sources/providers/git-stash.ts`
 * (which `core/write-source.ts` imports `getCachePaths`/`listGitChangedPaths`/
 * `parseGitRepoUrl`/`saveGitStash` from, via the `sources/providers/git`
 * barrel, by value) does not need to import back into `write-source.ts` just
 * for this helper — that back-edge was a 3-file static-graph cycle
 * (write-source.ts → git.ts → git-stash.ts → write-source.ts; chunk 9 WI-9.8
 * KILL 6 sever). `write-source.ts` re-exports `sanitizeCommitMessage` so
 * existing import sites are unaffected.
 */

/**
 * Maximum length of a sanitized git commit message. Git itself imposes no
 * fixed limit, but message strings come from refs and `--message` flags that
 * can be supplied by users or upstream config. A 4096-char clamp keeps audit
 * trails readable and prevents pathological payloads from bloating the log
 * stream a downstream consumer parses.
 */
const COMMIT_MESSAGE_MAX_LENGTH = 4096;

/**
 * Sanitize a string before passing it as `git commit -m <message>`.
 *
 * Defenses, in order:
 *   1. Strip NUL bytes (`\0`) — git rejects them anyway, but we never want
 *      them in argv.
 *   2. Replace any CR/LF (`\r`, `\n`) and other ASCII control chars with a
 *      single space. This collapses newline-injection attempts that would
 *      otherwise turn a single-line commit subject into a forged trailer
 *      block.
 *   3. Collapse runs of whitespace into a single space and trim.
 *   4. Clamp to {@link COMMIT_MESSAGE_MAX_LENGTH} characters.
 *
 * If the result is empty after sanitization the caller should substitute a
 * default — this helper returns `""` rather than throwing because not every
 * callsite has a sensible "invalid input" exit code, and "empty" is a
 * recoverable signal.
 */
export function sanitizeCommitMessage(input: string): string {
  if (typeof input !== "string") return "";
  // 1. Strip NULs outright.
  let out = input.replace(/\0/g, "");
  // 2. Replace CR/LF + other C0 control characters (0x00-0x1F, 0x7F) with a
  //    space. Tab (0x09) is included intentionally — commit subjects should
  //    be a single visual line.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization
  out = out.replace(/[\x00-\x1F\x7F]/g, " ");
  // 3. Collapse whitespace runs and trim.
  out = out.replace(/\s+/g, " ").trim();
  // 4. Clamp length.
  if (out.length > COMMIT_MESSAGE_MAX_LENGTH) {
    out = out.slice(0, COMMIT_MESSAGE_MAX_LENGTH).trimEnd();
  }
  return out;
}
