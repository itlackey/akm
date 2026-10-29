// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Marked } from "marked";

// A private instance keeps unrelated consumers' global Marked options out of indexing.
const markdown = new Marked({ gfm: true });

/**
 * Actual document links, in authored order. The tokenizer owns code regions,
 * escapes and nested containers; the adapter still owns its supported syntax
 * and path resolution. In particular, shortcut/collapsed references and wiki
 * links are not new indexed syntax. Inline images retain their existing treatment.
 */
export function markdownLinkTargets(body: string, references: boolean): string[] {
  const tokens = markdown.lexer(body);
  const definitions = new Map<string, string>();
  if (references) {
    markdown.walkTokens(tokens, (token) => {
      if (token.type !== "def") return;
      const definition = /^\s*\[([^\]]+)\]:\s*(\S+)/.exec(token.raw);
      if (definition) definitions.set(definition[1]!.trim().toLowerCase(), definition[2]!);
    });
  }
  const targets: string[] = [];
  markdown.walkTokens(tokens, (token) => {
    if (token.type !== "link" && token.type !== "image") return;
    const inline = /^!?\[[\s\S]*\]\(/.test(token.raw);
    if (inline) {
      // Angle-wrapped destinations were outside the adapters' existing subset.
      const angled = /\]\(\s*<[^>]*>(?:\s+["'(][\s\S]*["')])?\s*\)$/.test(token.raw);
      if (!angled) targets.push(token.href);
      return;
    }
    const reference = references && token.type === "link" ? /^\[[\s\S]*\]\[([^\]]+)\]$/.exec(token.raw) : null;
    const target = reference ? definitions.get(reference[1]!.trim().toLowerCase()) : undefined;
    if (target) targets.push(target);
  });
  return targets;
}
