// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure FTS5 query-string helpers, extracted from indexer/db/db.ts.
 *
 * These transform a raw user query into an FTS5-safe MATCH expression. They
 * touch no database state, so they are unit-testable with zero DB setup.
 * `parseRefPrefixQuery` is the one non-FTS helper: it decides whether a raw
 * query should bypass FTS entirely (SPEC-4 ref-prefix enumeration).
 */

/**
 * Sanitize a raw user query into an FTS5-safe implicit-AND expression.
 *
 * Allows only characters safe in FTS5 queries: letters, digits, underscores,
 * and whitespace. Everything else (hyphens, dots, quotes, parens, asterisks,
 * colons, carets, @, !, etc.) is replaced with a space so that compound
 * identifiers like "code-review" or "k8s.setup" become AND-joined tokens
 * ("code review", "k8s setup") rather than triggering FTS5 syntax errors.
 */
export function sanitizeFtsQuery(query: string): string {
  let sanitized = query.replace(/[^a-zA-Z0-9_\s]/g, " ");

  // Neutralize the NEAR operator (FTS5 proximity syntax)
  sanitized = sanitized.replace(/\bNEAR\b/g, " ");

  const tokens = sanitized.split(/\s+/).filter((t) => t.length >= 1);

  if (tokens.length === 0) return "";

  // Use implicit AND (space-separated tokens) for precision. FTS5 treats
  // space-separated tokens as an implicit AND, matching only rows that
  // contain ALL terms.
  return tokens.join(" ");
}

/**
 * Build a prefix query from an FTS5 query string by appending `*` to each
 * token that is 3+ characters long. Tokens shorter than 3 characters are
 * kept as-is (no prefix expansion) to avoid overly broad matches.
 *
 * Returns null if no tokens qualify for prefix expansion.
 */
export function buildPrefixQuery(ftsQuery: string): string | null {
  const tokens = ftsQuery.split(/\s+/).filter(Boolean);
  let hasPrefix = false;

  const prefixTokens = tokens.map((t) => {
    if (t.length >= 3) {
      hasPrefix = true;
      return `${t}*`;
    }
    return t;
  });

  if (!hasPrefix) return null;

  return prefixTokens.join(" ");
}

/**
 * SPEC-4 — parse a ref-prefix query (`akm search "<type>:<prefix>/"`).
 *
 * Decides whether a raw query is a typed subtree-enumeration request rather
 * than an ordinary keyword search. Matching is deliberately conservative: the
 * trimmed query must be EXACTLY
 *
 *   - `<known-type>:`           → enumerate the whole type (namePrefix `""`), or
 *   - `<known-type>:<prefix>/`  → enumerate names under `<prefix>/`.
 *
 * The trailing slash is REQUIRED for a non-empty prefix — and is RETAINED in
 * the returned `namePrefix` — so that a plain `entry.name.startsWith(namePrefix)`
 * check gives exact `/`-boundary subtree semantics (`"projecta/"` cannot match
 * a sibling `projectalpha/…` scope). Bare refs like `memory:a/b` therefore
 * stay ordinary searches (resolving one ref is `akm show` territory), and any
 * interior whitespace disqualifies (prose mentioning a ref is still prose).
 *
 * `knownTypes` is passed in by the caller (e.g. `placementTypes()`) to keep
 * this module dependency-free.
 *
 * Returns `null` when the query is not a ref-prefix request.
 */
export function parseRefPrefixQuery(
  query: string,
  knownTypes: readonly string[],
): { type: string; namePrefix: string } | null {
  const trimmed = query.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;

  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;

  const type = trimmed.slice(0, colon);
  if (!knownTypes.includes(type)) return null;

  const rest = trimmed.slice(colon + 1);
  if (rest === "") return { type, namePrefix: "" };
  if (rest.endsWith("/")) return { type, namePrefix: rest };
  return null;
}
