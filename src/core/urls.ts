// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\]]+/g;

/**
 * The http(s) URLs in prose, without the punctuation the sentence put after them: a trailing `.`, `,`, `;`, `:`, `!`
 * or `?`, and a trailing `)` when the URL holds no `(` (`(see https://x.io/a)`), while `https://x.io/a_(b)` keeps its own.
 */
export function urlsInText(text: string): string[] {
  return (text.match(URL_IN_TEXT) ?? []).map((url) => {
    let end = url.length;
    while (end > 0) {
      const last = url[end - 1];
      if (last !== undefined && ".,;:!?".includes(last)) end--;
      else if (last === ")" && !url.slice(0, end).includes("(")) end--;
      else break;
    }
    return url.slice(0, end);
  });
}
