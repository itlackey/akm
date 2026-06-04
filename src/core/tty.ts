// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Terminal-glyph and color gating helpers (#486).
 *
 * Honor the [NO_COLOR](https://no-color.org/) convention — when NO_COLOR is
 * present in the environment (with any value, including empty), the CLI
 * suppresses both ANSI color codes AND decorative emoji glyphs. Emoji often
 * render as garbage in non-Unicode terminals or get logged as literal bytes
 * when output is piped to text aggregators, so we treat them as a subset of
 * "color" decoration.
 *
 * Detection is also automatic on non-TTY stderr (output piped or redirected
 * to a file), where decorative glyphs add nothing.
 */

/**
 * Returns true when decorative glyphs and color codes should be emitted.
 * False when NO_COLOR is set or stderr is not a TTY (unless FORCE_COLOR
 * overrides per the de-facto Node convention).
 */
export function shouldDecorate(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "" && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  return process.stderr.isTTY === true;
}

// Map known decorative emoji to plain ASCII fallbacks. Anything not listed
// is still removed by the catch-all sweep below when decoration is off.
const EMOJI_FALLBACKS: Array<[RegExp, string]> = [
  [/\u{1F44B}\s*/gu, ""], // wave (with trailing space)
  [/✓/g, "[ok]"],
  [/✗/g, "[x]"],
  [/✘/g, "[x]"],
  [/⚠️?/g, "[!]"],
  [/\u{1F4DA}\s*/gu, ""], // books
];

/**
 * If decoration is disabled, replace known emoji with ASCII fallbacks and
 * strip any remaining pictograph code points. If decoration is enabled,
 * return the input unchanged.
 */
export function plainize(text: string): string {
  if (shouldDecorate()) return text;
  let out = text;
  for (const [pattern, repl] of EMOJI_FALLBACKS) {
    out = out.replace(pattern, repl);
  }
  // Catch-all for unmapped pictographs. Future-proof when new emoji are added
  // to call sites without updating the explicit map.
  out = out.replace(/[\u{1F300}-\u{1FAFF}]/gu, "");
  // Collapse runs of whitespace introduced by emoji removal, but preserve
  // intentional leading indentation. Only collapses interior runs.
  out = out.replace(/(\S)[ \t]{2,}/g, "$1 ");
  return out;
}
