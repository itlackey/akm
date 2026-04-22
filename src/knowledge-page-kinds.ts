/**
 * Knowledge-wiki page taxonomy.
 *
 * The defaults mirror Karpathy's LLM Wiki pattern (entities, concepts,
 * questions, notes). Users may introduce additional kinds at any time —
 * either by writing `pageKind: <whatever>` in a page's frontmatter, or by
 * declaring them under `knowledge.pageKinds` in config so the LLM prompt
 * and the generated `index.md` treat them as first-class categories.
 *
 * Validation throughout the codebase accepts any non-empty string as a
 * `pageKind`; this list is guidance, not a constraint.
 */

import type { AkmConfig } from "./config";

export const DEFAULT_PAGE_KINDS: readonly string[] = ["entity", "concept", "question", "note"];

/**
 * Resolve the active page-kind taxonomy: defaults + any additions from
 * config. Order is preserved and duplicates are removed case-insensitively.
 */
export function resolvePageKinds(config?: AkmConfig, additional?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  };
  for (const k of DEFAULT_PAGE_KINDS) push(k);
  for (const k of config?.knowledge?.pageKinds ?? []) push(k);
  for (const k of additional ?? []) push(k);
  return result;
}

/**
 * Capitalize a pageKind for use as an `index.md` section heading.
 * Examples: `entity` → `Entities`, `decision-record` → `Decision Records`.
 */
export function pageKindHeading(kind: string): string {
  const pretty = kind
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  if (!pretty) return kind;
  // English-naive pluralization: most kinds end in a consonant; `y` → `ies`.
  if (/y$/i.test(pretty) && !/[aeiou]y$/i.test(pretty)) {
    return `${pretty.slice(0, -1)}ies`;
  }
  if (/s$/i.test(pretty)) return pretty;
  return `${pretty}s`;
}
