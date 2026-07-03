// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure FTS5 query-string helpers, extracted from indexer/db/db.ts.
 *
 * These transform a raw user query into an FTS5-safe MATCH expression. They
 * touch no database state, so they are unit-testable with zero DB setup.
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
