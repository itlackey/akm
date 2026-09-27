// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure FTS5 query building and ref-query helpers.
 *
 * The lexical channel matches ANY query word: BM25 over an OR of the query's
 * non-stopword tokens. Requiring every word first and relaxing only when that
 * found nothing cost 0.108 nDCG@10 on the retrieval suite
 * (`akm/eval/retrieval/reports/baseline-2026-09-27.md`): one conjunctive match
 * in a long document suppressed every better OR candidate.
 * `parseRefPrefixQuery` is the one non-FTS helper: it decides whether a raw
 * query should bypass FTS entirely (SPEC-4 ref-prefix enumeration).
 */

/** English function words dropped from the lexical query (the retrieval lab's list). */
const STOPWORDS: ReadonlySet<string> = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but
  by can could did do does doing down during each few for from further had has have having he her here hers herself
  him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or
  other our ours out over own same she should so some such than that the their theirs them then there these they this
  those through to too under until up very was we were what when where which while who whom why will with would you
  your yours yourself`.split(/\s+/),
);

const UNICODE_TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * The query's lexical tokens: Unicode letters and numbers (the useful part of
 * FTS5's `unicode61` tokenizer), NFKC-normalized, lowercased and deduplicated,
 * with stopwords removed. A query made only of stopwords keeps all of them, so
 * "how to" still searches for something.
 */
export function ftsQueryTokens(query: string): string[] {
  const tokens = [...new Set(query.normalize("NFKC").toLowerCase().match(UNICODE_TOKEN) ?? [])];
  const content = tokens.filter((token) => !STOPWORDS.has(token));
  return content.length > 0 ? content : tokens;
}

/** FTS5 MATCH expression matching any token. Quoting makes FTS operators ordinary words. */
export function ftsOrMatch(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

/**
 * D4 — parse a conceptId-prefix browse query.
 *
 * Decides whether a raw query is a subtree-enumeration request rather than an
 * ordinary keyword search. Matching is deliberately conservative: the trimmed
 * query must be EXACTLY
 *
 *   - `<conceptId prefix>/`           → that subtree in any bundle,
 *   - `<bundle>//`                    → one bundle entirely,
 *   - `<bundle>//<conceptId prefix>/` → that subtree of that bundle.
 *
 * The trailing slash is REQUIRED — and is RETAINED in `conceptIdPrefix` — so a
 * plain `conceptId.startsWith(conceptIdPrefix)` check gives exact `/`-boundary
 * subtree semantics (`"projecta/"` cannot match a sibling `projectalpha/…`
 * scope). Bare refs like `memories/a/b` therefore stay ordinary searches
 * (resolving one ref is `akm show` territory), and any interior whitespace
 * disqualifies (prose mentioning a ref is still prose).
 *
 * The prefix matches the conceptId — the same string every emitted `ref`
 * carries — so a ref copied out of search output round-trips back in as a
 * prefix. Nothing here consults a type list: enumeration covers every
 * adapter's items uniformly, which the retired `<type>:` grammar could not do.
 *
 * Returns `null` when the query is not a browse request.
 */
export function parseRefPrefixQuery(query: string): { bundle?: string; conceptIdPrefix: string } | null {
  const trimmed = query.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;

  const separator = trimmed.indexOf("//");
  if (separator < 0) {
    return trimmed.endsWith("/") ? { conceptIdPrefix: trimmed } : null;
  }

  const bundle = trimmed.slice(0, separator);
  if (bundle.length === 0) return null;

  const rest = trimmed.slice(separator + 2);
  if (rest === "") return { bundle, conceptIdPrefix: "" };
  if (rest.endsWith("/") && !rest.includes("//")) return { bundle, conceptIdPrefix: rest };
  return null;
}

/**
 * Recognize the retired `<type>:` / `<type>:<prefix>/` browse grammar so the
 * caller can name the replacement spelling rather than letting the query
 * degrade silently into a keyword search — the exact silent failure D4 removes.
 * Shape recognition only; mapping the type to its conceptId root belongs to the
 * caller, which keeps this module dependency-free.
 */
export function parseRetiredTypePrefixQuery(query: string): { type: string; rest: string } | null {
  const trimmed = query.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed) || trimmed.includes("//")) return null;

  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;

  const rest = trimmed.slice(colon + 1);
  if (rest !== "" && !rest.endsWith("/")) return null;
  return { type: trimmed.slice(0, colon), rest };
}
