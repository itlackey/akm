/**
 * Per-field search text extraction for FTS5 indexing.
 *
 * Extracted from indexer.ts to break the circular dependency:
 *   db.ts -> indexer.ts -> db.ts
 *
 * This module imports only from metadata.ts (for the StashEntry type),
 * so it can be safely imported by both db.ts and indexer.ts.
 */

import type { StashEntry } from "./metadata";

/**
 * Return per-field search text for multi-column FTS5 indexing.
 *
 * Fields:
 *  - name: entry name with hyphens/underscores replaced by spaces
 *  - description: entry description
 *  - tags: tags + aliases joined
 *  - hints: searchHints + examples + usage + intent fields
 *  - content: TOC headings (lowest-weight catch-all)
 */
export function buildSearchFields(entry: StashEntry): {
  name: string;
  description: string;
  tags: string;
  hints: string;
  content: string;
} {
  const name = entry.name.replace(/[-_]/g, " ").toLowerCase();

  const description = (entry.description ?? "").toLowerCase();

  const tagParts: string[] = [];
  if (entry.tags) tagParts.push(entry.tags.join(" "));
  if (entry.aliases) tagParts.push(entry.aliases.join(" "));
  const tags = tagParts.join(" ").toLowerCase();

  const hintParts: string[] = [];
  if (entry.searchHints) hintParts.push(entry.searchHints.join(" "));
  if (entry.examples) hintParts.push(entry.examples.join(" "));
  if (entry.usage) hintParts.push(entry.usage.join(" "));
  if (entry.intent) {
    if (entry.intent.when) hintParts.push(entry.intent.when);
    if (entry.intent.input) hintParts.push(entry.intent.input);
    if (entry.intent.output) hintParts.push(entry.intent.output);
  }
  if (entry.xrefs) hintParts.push(entry.xrefs.join(" "));
  if (entry.pageKind) hintParts.push(entry.pageKind);
  const hints = hintParts.join(" ").toLowerCase();

  const contentParts: string[] = [];
  if (entry.toc) {
    contentParts.push(entry.toc.map((h) => h.text).join(" "));
  }
  if (entry.parameters) {
    for (const param of entry.parameters) {
      contentParts.push(param.name);
      if (param.description) contentParts.push(param.description);
    }
  }
  const content = contentParts.join(" ").toLowerCase();

  return { name, description, tags, hints, content };
}

/**
 * Build a single concatenated search text string for an entry.
 * Used for the `search_text` column in the entries table (backward compat)
 * and for generating embedding text.
 */
export function buildSearchText(entry: StashEntry): string {
  const fields = buildSearchFields(entry);
  return [fields.name, fields.description, fields.tags, fields.hints, fields.content]
    .filter((s) => s.length > 0)
    .join(" ");
}
