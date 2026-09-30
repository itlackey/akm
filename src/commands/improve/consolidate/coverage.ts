// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The promote pass's coverage gate (#998): before a memory becomes a
 * `knowledge/` proposal, ask whether `knowledge/` already says it.
 *
 * The rule: a memory is covered when at least {@link COVERAGE_MIN_CONTAINMENT}
 * (half) of its distinct {@link COVERAGE_SHINGLE_WORDS}-word shingles appear in
 * one of the knowledge docs nearest to it. It is a containment of the MEMORY in
 * the doc, not a similarity: a long guide that quotes the memory covers it; a
 * memory that quotes a short doc and adds claims of its own does not.
 *
 * Why this rule and this cut. The model never sees `knowledge/`, and the
 * mint-time checks before this one only catch the same slug or the same whole
 * body, so one edit or paraphrase defeats them. The evidence is #998's, from
 * the owner's bundle (run `consolidate-1790666282516`: 327 decided proposals,
 * 103 accepted, 224 rejected, 215 of those as "duplicate of / covered by /
 * overlaps" an existing knowledge doc): the share of a proposal's distinct
 * 5-word shingles found in the best OTHER knowledge doc was >= 0.5 for 122 of
 * the 224 rejected proposals and for none of the 103 accepted ones. 0.5 is the
 * cut that sample supports: no accepted promotion would have been skipped. That
 * sample compared each proposal with EVERY other knowledge doc, so 122 of 224
 * (up to about 54%) is what the rule can take out of review at most, not what
 * this gate achieves: it reads only the {@link PAIR_NEIGHBOR_FETCH_K} nearest
 * knowledge docs (below), and a covering doc that ranks lower goes unseen. The
 * recall over that candidate set is unmeasured. The rest of the rejected
 * proposals (paraphrases, partial overlaps) still reach review: the next cut
 * measured, 0.2 (169 of 224 rejected), would also have skipped 2 of the 103
 * accepted ones, and no cosine cut was measured at all. A wrong skip is a
 * promotion nobody gets to review.
 *
 * Candidates are the memory's {@link PAIR_NEIGHBOR_FETCH_K} nearest knowledge
 * docs in its bundle by stored vector (`getNeighborsByEntryId`, the lookup the
 * pair pass runs, scoped to the bundle's knowledge entries), never a scan of
 * `knowledge/`. There is no similarity floor, only a rank: a guide that quotes
 * the memory is found however far it sits from it by vector, as long as fewer
 * than that many other knowledge docs in the bundle are nearer. With no stored
 * vector (semantic search off, the memory not indexed yet, no index at all)
 * there are no candidates and the gate does nothing: the exact-slug and
 * whole-body checks still run, and nothing throws.
 */

import fs from "node:fs";
import type { Database } from "../../../storage/database";
import { closeDatabase, openExistingDatabase } from "../../../storage/repositories/index-connection";
import { getEntryById, getEntryIdByFilePath } from "../../../storage/repositories/index-entries-repository";
import { getNeighborsByEntryId } from "../../../storage/repositories/index-vec-repository";
import { stripFrontmatterBody } from "../content-hash";
import { PAIR_NEIGHBOR_FETCH_K } from "./pair-pass";

/** Words per shingle. */
export const COVERAGE_SHINGLE_WORDS = 5;
/** Share of a memory's distinct shingles one knowledge doc must hold for the memory to count as covered. */
export const COVERAGE_MIN_CONTAINMENT = 0.5;

const WORD = /[\p{L}\p{N}]+/gu;

/** The distinct lower-cased word n-grams of `text`; empty when it has fewer than {@link COVERAGE_SHINGLE_WORDS} words. */
export function wordShingles(text: string): Set<string> {
  const words = text.toLowerCase().match(WORD) ?? [];
  const shingles = new Set<string>();
  for (let i = 0; i + COVERAGE_SHINGLE_WORDS <= words.length; i++) {
    shingles.add(words.slice(i, i + COVERAGE_SHINGLE_WORDS).join(" "));
  }
  return shingles;
}

/** The share (0..1) of `memory`'s shingles that also occur in `doc`; 0 when the memory has none. */
export function shingleContainment(memory: ReadonlySet<string>, doc: string): number {
  if (memory.size === 0) return 0;
  const docShingles = wordShingles(doc);
  let shared = 0;
  for (const shingle of memory) if (docShingles.has(shingle)) shared++;
  return shared / memory.size;
}

/** A knowledge doc that already holds a memory's text. */
export interface CoveringKnowledge {
  /** The doc's concept id, e.g. `knowledge/akm-proposal-drain-policy`. */
  ref: string;
  /** The share of the memory's shingles found in it (>= {@link COVERAGE_MIN_CONTAINMENT}). */
  containment: number;
}

/** The knowledge doc covering the memory at `filePath` whose body is `body`, if any. */
export type CoveringKnowledgeFinder = (filePath: string, body: string) => CoveringKnowledge | undefined;

/**
 * The best-covering knowledge doc among the {@link PAIR_NEIGHBOR_FETCH_K}
 * knowledge docs in `bundleId` nearest to the memory. `filePath` is the
 * memory's indexed file; a memory the index does not know has no stored vector
 * and so no candidates.
 */
export function findCoveringKnowledge(
  db: Database,
  bundleId: string,
  filePath: string,
  body: string,
): CoveringKnowledge | undefined {
  const shingles = wordShingles(body);
  if (shingles.size === 0) return undefined;
  const entryId = getEntryIdByFilePath(db, filePath);
  if (entryId === undefined) return undefined;
  let best: CoveringKnowledge | undefined;
  for (const hit of getNeighborsByEntryId(db, entryId, PAIR_NEIGHBOR_FETCH_K, { type: "knowledge", bundleId })) {
    const neighbour = getEntryById(db, hit.id);
    if (!neighbour) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(neighbour.filePath, "utf8");
    } catch {
      continue; // the index outlived the file
    }
    const containment = shingleContainment(shingles, stripFrontmatterBody(raw));
    if (containment >= COVERAGE_MIN_CONTAINMENT && (best === undefined || containment > best.containment)) {
      best = { ref: neighbour.conceptId, containment };
    }
  }
  return best;
}

/**
 * The gate for one run, holding its own read handle on `index.db` for the
 * promotions that run emits; `undefined` when there is no bundle or no index
 * to look in. A lookup that throws counts as "not known to be covered".
 */
export function openKnowledgeCoverage(
  bundleId: string | undefined,
): { find: CoveringKnowledgeFinder; close: () => void } | undefined {
  if (!bundleId) return undefined;
  let db: Database;
  try {
    db = openExistingDatabase();
  } catch {
    return undefined;
  }
  return {
    find: (filePath, body) => {
      try {
        return findCoveringKnowledge(db, bundleId, filePath, body);
      } catch {
        return undefined;
      }
    },
    close: () => closeDatabase(db),
  };
}
