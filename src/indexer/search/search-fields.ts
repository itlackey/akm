// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-field search text extraction for FTS5 indexing.
 *
 * Extracted from indexer.ts to break the circular dependency:
 *   db.ts -> indexer.ts -> db.ts
 *
 * This module imports only from metadata.ts (for the IndexDocument type),
 * so it can be safely imported by both db.ts and indexer.ts.
 */

import type { IndexDocument } from "../passes/metadata";

/**
 * Return per-field search text for multi-column FTS5 indexing.
 *
 * Fields:
 *  - name: entry name with hyphens/underscores replaced by spaces
 *  - description: entry description
 *  - tags: tags + aliases joined
 *  - hints: searchHints + examples + usage + intent fields
 *  - content: TOC headings + parameters + the config-gated body opening
 *    (lowest-weight catch-all)
 */
// NOTE (R5): the collapse detector's frozen canary queries are built from the
// same surface this function indexes (name tokens / tags / description) and
// scored via FTS against it. Changing what buildSearchFields includes shifts
// the detector's recall baseline for ALL existing canary sets — coordinate
// with src/commands/improve/collapse-detector.ts (buildCanaryQuery) and expect
// operators to re-mint via `akm improve canary --refresh` after such a change.
export function buildSearchFields(entry: IndexDocument): {
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
  if (entry.whenToUse) hintParts.push(entry.whenToUse);
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
  // Stash-organization conventions (SPEC-8): the self-situating body opening
  // (captured by the metadata pass only when `index.indexBodyOpening` is on)
  // folds into the lowest-weight catch-all column — never name/description/
  // tags/hints — so orientation prose is retrievable without outranking
  // structured-field matches. The fold is unconditional on the entry field:
  // `rebuildFts` rebuilds FTS rows from stored entry_json and must reproduce
  // the same fields without re-reading config.
  if (entry.bodyOpening) contentParts.push(entry.bodyOpening);
  const content = contentParts.join(" ").toLowerCase();

  return { name, description, tags, hints, content };
}

/**
 * Build a single concatenated search text string for an entry.
 * Used for the `search_text` column in the entries table (backward compat)
 * and for generating embedding text.
 */
export function buildSearchText(entry: IndexDocument): string {
  const fields = buildSearchFields(entry);
  return [fields.name, fields.description, fields.tags, fields.hints, fields.content]
    .filter((s) => s.length > 0)
    .join(" ");
}
