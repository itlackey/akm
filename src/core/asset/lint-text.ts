// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure text rules shared by every lint surface (`akm lint` sweep and adapter
 * `validate`): which absolute paths count as current guidance, and how
 * sentence punctuation is kept out of paths and ref tokens. No filesystem
 * access here; callers decide how existence is probed.
 */

/**
 * A path segment shaped like a run-time filename template rather than a
 * literal reference: `<timestamp>`-style angle brackets, `{stamp}`/`${VAR}`
 * braces, a `YYYYMMDD`/`HHMMSS`-style run of date-format letters, or a glob
 * character. Such a path never exists under its literal spelling.
 */
const PATH_PLACEHOLDER_PATTERN = /[<{]|[*?]|[YMDHS]{4,}/;

/** A line that presents a path as a record of the past or as an illustration, not as guidance to follow. */
const NON_CURRENT_LINE_PATTERN = /\b(?:historical(?:ly)?|previously|formerly|for example|for instance)\b|\be\.g\./i;

/** A heading whose section holds records or illustrations rather than current guidance. */
const NON_CURRENT_HEADING_PATTERN = /^#{1,6}\s.*\b(?:history|changelog|archive|examples?)\b/i;

/** Drop sentence punctuation absorbed at the end of a path or ref token. */
function stripTrailingSentencePunctuation(token: string): string {
  return token.replace(/[.;:!?]+$/, "");
}

/** The `/home/<user>` directory a path lives under, or `undefined` for any other path. */
export function homeRootOf(candidate: string): string | undefined {
  return candidate.match(/^\/home\/[^/]+/)?.[0];
}

/**
 * Absolute paths in `text` presented as current guidance. Paths on lines or in
 * sections that frame them as history or examples, run-time filename
 * templates, and trailing sentence punctuation are all excluded.
 */
export function findCurrentPathReferences(text: string): string[] {
  const pathRe = /(?:\/home\/|\/tmp\/|\/var\/|\/root\/|\/opt\/)[^\s"'`)\]>,\n]+/g;
  const out: string[] = [];
  let inNonCurrentSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) inNonCurrentSection = NON_CURRENT_HEADING_PATTERN.test(line);
    if (inNonCurrentSection || NON_CURRENT_LINE_PATTERN.test(line)) continue;
    for (const match of line.matchAll(pathRe)) {
      const candidate = stripTrailingSentencePunctuation(match[0]);
      if (!PATH_PLACEHOLDER_PATTERN.test(candidate)) out.push(candidate);
    }
  }
  return out;
}
