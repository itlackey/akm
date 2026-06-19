// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #627 — getRelatedSessions helper.
 *
 * Finds session assets related to a seed by SHARED TAGS / GRAPH ENTITIES —
 * NEVER embedding similarity. Modeled on recombine.ts buildRelatednessClusters:
 * two sessions relate when they share at least one *topic* tag or graph entity;
 * two textually near-identical sessions with no shared topic signal do NOT
 * relate. This makes the helper a pure query-layer relatedness lookup that
 * makes NO network / embedding calls.
 *
 * The generic base tags every session asset carries (`session` + the harness
 * id, see session-asset.ts) are IGNORED for relatedness — otherwise every
 * session would trivially relate to every other. Callers should therefore seed
 * with derived topic tags, but the helper defensively strips the generic base
 * tags from candidate sessions too.
 *
 * Relatedness source:
 *   - `"tags"`  — score by count of (seedTags ∩ session tags).
 *   - `"graph"` — score by count of (seedEntities ∩ session graph entities);
 *                 falls open to tag relatedness when the graph table is empty.
 *   - `"both"`  — sum of the tag + entity overlap.
 */

import { makeAssetRef } from "../../core/asset/asset-ref";
import type { AkmAssetType } from "../../core/common";
import {
  closeDatabase,
  type DbIndexedEntry,
  getAllEntries,
  getEntitiesByEntryIds,
  openExistingDatabase,
} from "../../indexer/db/db";
import type { Database } from "../../storage/database";

/** Generic base tags every session asset carries — never a relatedness signal. */
const GENERIC_SESSION_TAGS = new Set(["session"]);

export interface RelatedSession {
  /** Canonical asset ref, e.g. `session:claude/sess-aaa`. */
  ref: string;
  /** Entry name (`<harness>/<id>`). */
  name: string;
  /** Number of shared relatedness signals (tags + entities). */
  sharedCount: number;
}

export interface GetRelatedSessionsOptions {
  /** Seed topic tags to match against candidate session tags. */
  seedTags?: string[];
  /** Seed graph entity_norm values to match against candidate session entities. */
  seedEntities?: string[];
  /** Index DB handle. When absent, the existing index DB is opened and closed internally. */
  db?: Database;
  /** Minimum shared-signal count required to be considered related. Default 1. */
  minShared?: number;
  /** Maximum number of related sessions to return. Default 5. */
  limit?: number;
  /** Which relatedness signals to use. Default "tags". */
  relatednessSource?: "tags" | "graph" | "both";
  /** Refs to exclude from results (notably the seed session itself). */
  excludeRefs?: string[];
}

/**
 * Build the set of topic tags for a session entry, excluding generic base tags
 * (`session`) and the harness segment of the entry name (the harness id is the
 * first path component of `<harness>/<id>` and is also carried as a base tag).
 */
function topicTagsForSession(entry: DbIndexedEntry): Set<string> {
  const harness = entry.entry.name.split("/")[0];
  const result = new Set<string>();
  for (const tag of entry.entry.tags ?? []) {
    if (GENERIC_SESSION_TAGS.has(tag)) continue;
    if (harness && tag === harness) continue;
    result.add(tag);
  }
  return result;
}

/**
 * Find session assets related to a seed by shared tags / graph entities.
 * Relatedness is signal-based, NOT embedding similarity.
 */
export function getRelatedSessions(opts: GetRelatedSessionsOptions): RelatedSession[] {
  const seedTags = (opts.seedTags ?? [])
    .filter((t) => !GENERIC_SESSION_TAGS.has(t))
    .map((t) => t.trim())
    .filter(Boolean);
  const seedEntities = (opts.seedEntities ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const minShared = opts.minShared ?? 1;
  const limit = opts.limit ?? 5;
  const relatednessSource = opts.relatednessSource ?? "tags";
  const excludeRefs = new Set(opts.excludeRefs ?? []);

  // Empty seed input → nothing to relate to.
  if (seedTags.length === 0 && seedEntities.length === 0) return [];

  const seedTagSet = new Set(seedTags);
  const seedEntitySet = new Set(seedEntities);

  let db = opts.db;
  let ownsDb = false;
  if (!db) {
    db = openExistingDatabase();
    ownsDb = true;
  }

  try {
    const sessions = getAllEntries(db, "session");

    // Resolve graph entities for the candidate sessions when requested. Fail
    // open to tag relatedness when the graph table is empty (no rows).
    let entityByEntryId: Map<number, string[]> | undefined;
    const wantGraph = relatednessSource === "graph" || relatednessSource === "both";
    if (wantGraph) {
      try {
        entityByEntryId = getEntitiesByEntryIds(
          db,
          sessions.map((s) => s.id),
        );
      } catch {
        entityByEntryId = undefined;
      }
    }
    const hasEntities = !!entityByEntryId && entityByEntryId.size > 0;

    // Effective signal selection. "graph" with no entities falls open to tags.
    const useTags = relatednessSource === "tags" || relatednessSource === "both" || (wantGraph && !hasEntities);
    const useGraph = wantGraph && hasEntities;

    const scored: RelatedSession[] = [];
    for (const session of sessions) {
      const ref = makeAssetRef(session.entry.type as AkmAssetType, session.entry.name);
      if (excludeRefs.has(ref)) continue;

      let sharedCount = 0;
      if (useTags && seedTagSet.size > 0) {
        for (const tag of topicTagsForSession(session)) {
          if (seedTagSet.has(tag)) sharedCount += 1;
        }
      }
      if (useGraph && seedEntitySet.size > 0 && entityByEntryId) {
        for (const ent of entityByEntryId.get(session.id) ?? []) {
          if (seedEntitySet.has(ent)) sharedCount += 1;
        }
      }

      if (sharedCount >= minShared) {
        scored.push({ ref, name: session.entry.name, sharedCount });
      }
    }

    // Rank by shared-signal count desc, then ref for a deterministic tiebreak.
    scored.sort((a, b) => b.sharedCount - a.sharedCount || a.ref.localeCompare(b.ref));
    return scored.slice(0, Math.max(0, limit));
  } finally {
    if (ownsDb && db) closeDatabase(db);
  }
}
