// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `consolidation_judged` table — the judged-state
 * cache that lets the consolidate pass skip memories whose content is unchanged
 * since they were last judged (#581). Extracted verbatim from core/state-db.ts —
 * queries unchanged, only relocated behind the repository boundary. Re-exported
 * by core/state-db.ts so existing importers resolve.
 *
 * @module consolidation-repository
 */

import type { Database } from "../database";

/**
 * One row of the consolidation judged-state cache. Keyed by the `memory:<name>`
 * ref; records the content hash the memory had the last time the consolidate
 * LLM judged it, so an unchanged memory can be skipped on the next run.
 */
export interface ConsolidationJudgedRow {
  /** `memory:<name>` ref. */
  entry_key: string;
  /** sha256 of the frontmatter-stripped, trimmed body at judge time. */
  content_hash: string;
  /** ISO-8601 UTC — when this memory was last judged. */
  judged_at: string;
  /** Coarse outcome of the last judge — observability only. */
  outcome: "actioned" | "no_action";
}

/**
 * Bulk-fetch the judged-state cache for a set of entry keys in one query.
 * Returns a Map keyed by entry_key so the consolidate pool-selection loop can
 * do O(1) "has this memory been judged at this content hash?" lookups.
 * Empty input → empty map (no query issued).
 */
export function getConsolidationJudgedMap(
  db: Database,
  entryKeys: readonly string[],
): Map<string, ConsolidationJudgedRow> {
  const out = new Map<string, ConsolidationJudgedRow>();
  if (entryKeys.length === 0) return out;
  // SQLite has a ~999 param ceiling; chunk if a caller ever exceeds that.
  const CHUNK = 500;
  for (let i = 0; i < entryKeys.length; i += CHUNK) {
    const chunk = entryKeys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM consolidation_judged WHERE entry_key IN (${placeholders})`)
      .all(...chunk) as ConsolidationJudgedRow[];
    for (const row of rows) out.set(row.entry_key, row);
  }
  return out;
}

/**
 * Record (or update) the judged state for one memory. INSERT-OR-REPLACE so the
 * row always reflects the most recent judge of that entry_key. Called once per
 * memory the consolidate LLM saw in a successfully-judged chunk.
 */
export function upsertConsolidationJudged(
  db: Database,
  input: {
    entryKey: string;
    contentHash: string;
    judgedAt: string;
    outcome: ConsolidationJudgedRow["outcome"];
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO consolidation_judged
      (entry_key, content_hash, judged_at, outcome)
    VALUES (?, ?, ?, ?)
  `).run(input.entryKey, input.contentHash, input.judgedAt, input.outcome);
}
