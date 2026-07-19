// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import type { AkmConfig } from "../../core/config/config";
import { classifyRefGrammar, parseStoredRef } from "../../migrate/legacy-ref-grammar";

/** Key durable improve state by source without changing filesystem-facing refs. */
export function durableImproveRef(ref: string, sourceName?: string): string {
  // Chunk-5 flip F5e — a new-grammar item_ref (`<bundle>//<conceptId>`) is
  // ALREADY the fully-qualified durable key; never re-parse or re-qualify it.
  // // Chunk-8: drop this guard once the old grammar (and the dual-input
  // window) is gone and every ref reaching here is the new grammar.
  if (classifyRefGrammar(ref) === "bundle") return ref;
  if (!sourceName) return ref;
  const parsed = parseStoredRef(ref);
  // Durable legacy key (Chunk-8 re-key); built inline from the parsed parts.
  const origin = parsed.origin ?? sourceName;
  return `${origin}//${parsed.type}:${parsed.name}`;
}

/** Remove a durable source origin before filesystem/index lookups. */
export function bareImproveRef(ref: string): string {
  // Chunk-5 flip F5e — a new-grammar ref's "bare" form is its conceptId (drop
  // the bundle prefix). // Chunk-8: drop this arm with the old grammar.
  if (classifyRefGrammar(ref) === "bundle") {
    const boundary = ref.indexOf("//");
    return boundary >= 0 ? ref.slice(boundary + 2) : ref;
  }
  const parsed = parseStoredRef(ref);
  return `${parsed.type}:${parsed.name}`;
}

/**
 * Ordered read keys for durable improve state, most-specific first. The
 * Chunk-5 flip F5e writers key salience/outcome by the durable `item_ref`
 * (`<bundle>//<conceptId>`) when the resolved index entry supplies one, and
 * fall back to the pre-flip `type:name` durable/bare spellings otherwise; the
 * reader probes all three so a row written under EITHER grammar is found during
 * the transition window.
 *
 *   1. `itemRef`  — the new-grammar durable key (when the caller resolved one);
 *   2. `durable`  — the pre-flip source-qualified `type:name` key;
 *   3. `bare`     — the pre-source-qualification `type:name` key (legacy stash).
 *
 * // Chunk-8: collapse to `[itemRef]` after the one-time state.db re-key.
 */
export function improveStateReadRefs(
  ref: string,
  sourceName?: string,
  includeLegacyBare = false,
  itemRef?: string,
): string[] {
  const durable = durableImproveRef(ref, sourceName);
  const bare = bareImproveRef(ref);
  const keys: string[] = [];
  if (itemRef !== undefined) keys.push(itemRef);
  if (!keys.includes(durable)) keys.push(durable);
  if (includeLegacyBare && !keys.includes(bare)) keys.push(bare);
  return keys;
}

/**
 * Bare improve state predates source-qualified refs and belongs only to the
 * historical local stash. Named sources at any other root must never inherit it.
 */
export function shouldReadLegacyBareImproveState(
  sourceName: string | undefined,
  sourcePath: string | undefined,
  config: AkmConfig,
): boolean {
  if (!sourceName || !sourcePath) return false;
  if (config.stashDir) return path.resolve(sourcePath) === path.resolve(config.stashDir);
  if (sourceName !== "stash") return false;
  if (!config.defaultWriteTarget) return true;
  if (config.defaultWriteTarget !== "stash") return false;
  const configuredStash = config.sources?.find((source) => source.name === "stash");
  return (
    configuredStash?.type === "filesystem" &&
    typeof configuredStash.path === "string" &&
    path.resolve(configuredStash.path) === path.resolve(sourcePath)
  );
}
