// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pinned-fact context assembly (fact asset type, phase 2).
 *
 * The `fact` type (see docs/design/fact-asset-type.md) stores durable
 * stash-level semantic knowledge. Facts marked `pinned: true` form the small
 * always-injected "core" — the handful of high-signal facts an agent should
 * always have in context (personal identity, team conventions, the
 * "constitution"). Everything else stays on "disk" and is reached via normal
 * `akm search` / `akm curate` just-in-time retrieval.
 *
 * This module collects the pinned core from the index and assembles it into a
 * compact markdown block that the `akm agent` dispatch prepends to the agent's
 * system prompt. The pure assembly + parse helpers are exported so they can be
 * unit-tested without a database.
 */

import fs from "node:fs";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { asNonEmptyString } from "../../core/common";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../../indexer/db/db";
import type { Database } from "../../storage/database";

/** A single pinned fact, ready to render into the context block. */
export interface PinnedFact {
  /** Canonical ref, e.g. `fact:team/tool-stack`. */
  ref: string;
  /** Canonical name, e.g. `team/tool-stack`. */
  name: string;
  /** `category` frontmatter (personal|team|project|convention|meta). */
  category?: string;
  /** `description` frontmatter, if present. */
  description?: string;
  /** Markdown body (frontmatter stripped, trimmed). */
  body: string;
}

/**
 * Fact `status` values that EXCLUDE a fact from the always-injected core.
 * Durable facts go stale; rather than delete them, an author can mark a fact
 * `status: stale` (or `superseded`) and it drops out of the pinned context
 * while remaining searchable. (Design note phase 2 — staleness handling.)
 */
const EXCLUDED_STATUSES = new Set(["stale", "superseded", "archived"]);

/**
 * Parse a single fact file into a {@link PinnedFact}, or return `null` when the
 * fact is NOT part of the pinned core: not `pinned: true`, or carrying an
 * excluded `status`. Pure — takes the raw file content so it is unit-testable
 * without touching disk.
 */
export function parsePinnedFact(name: string, raw: string): PinnedFact | null {
  const parsed = parseFrontmatter(raw);
  const fm = parsed.data;
  if (fm.pinned !== true) return null;
  const status = asNonEmptyString(fm.status)?.toLowerCase();
  if (status && EXCLUDED_STATUSES.has(status)) return null;
  const body = parsed.content.trim();
  return {
    ref: `fact:${name}`,
    name,
    ...(asNonEmptyString(fm.category) ? { category: asNonEmptyString(fm.category) } : {}),
    ...(asNonEmptyString(fm.description) ? { description: asNonEmptyString(fm.description) } : {}),
    body,
  };
}

/**
 * Render a list of pinned facts into a compact markdown context block, grouped
 * by category. Returns `""` for an empty list so callers can treat "no facts"
 * uniformly. Pure.
 */
export function buildPinnedFactsBlock(facts: PinnedFact[]): string {
  if (facts.length === 0) return "";

  // Stable order: by category then name, so the block is deterministic.
  const sorted = [...facts].sort((a, b) => {
    const ca = a.category ?? "";
    const cb = b.category ?? "";
    if (ca !== cb) return ca.localeCompare(cb);
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [
    "## Stash facts",
    "",
    "Durable, authoritative facts about this user / team / project. Treat them as background context and follow any conventions they state.",
    "",
  ];
  let lastCategory: string | undefined;
  for (const fact of sorted) {
    const category = fact.category ?? "general";
    if (category !== lastCategory) {
      lines.push(`### ${category}`, "");
      lastCategory = category;
    }
    const heading = fact.description ? `${fact.name} — ${fact.description}` : fact.name;
    lines.push(`- **${heading}**`);
    if (fact.body) {
      // Indent the body two spaces so it reads as part of the bullet.
      for (const bodyLine of fact.body.split("\n")) {
        lines.push(bodyLine.length > 0 ? `  ${bodyLine}` : "");
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Collect the pinned core from the index. Opens the existing index DB (unless
 * one is injected for tests), reads every `fact` entry whose `pinned` search
 * hint is set, then parses each file from disk. Fails soft: any error (missing
 * index, unreadable file) yields an empty list rather than throwing, so callers
 * on the hot path (agent dispatch) are never broken by fact collection.
 */
export function collectPinnedFacts(injectedDb?: Database): PinnedFact[] {
  let db: Database | undefined;
  let ownsDb = false;
  try {
    db = injectedDb ?? openExistingDatabase();
    ownsDb = injectedDb === undefined;
  } catch {
    return [];
  }

  try {
    const entries = getAllEntries(db, "fact");
    const facts: PinnedFact[] = [];
    for (const row of entries) {
      // Fast pre-filter on the indexed `pinned` search hint so we only read
      // files for facts that are actually part of the core.
      if (!row.entry.searchHints?.includes("pinned")) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(row.filePath, "utf8");
      } catch {
        continue;
      }
      const fact = parsePinnedFact(row.entry.name, raw);
      if (fact) facts.push(fact);
    }
    return facts;
  } catch {
    return [];
  } finally {
    if (ownsDb && db) closeDatabase(db);
  }
}

/**
 * Convenience for the agent-dispatch seam: collect the pinned core and return
 * the assembled markdown block, or `undefined` when there are no pinned facts.
 */
export function buildPinnedFactsContext(injectedDb?: Database): string | undefined {
  const facts = collectPinnedFacts(injectedDb);
  if (facts.length === 0) return undefined;
  return buildPinnedFactsBlock(facts);
}
