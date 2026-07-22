// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared memory-content hashing primitives, extracted from the deleted
 * `dedup.ts` (#617 dedup pre-pass, removed WI-7.3) so `consolidate.ts` /
 * `consolidate/chunking.ts` / `distill.ts` keep a stable, dependency-free home
 * for the case-preserving stripped-body hash they use for the body-embedding
 * cache and (formerly) the fidelity-check body comparison.
 *
 * @module content-hash
 */

import { createHash } from "node:crypto";
import { parseFrontmatter } from "../../core/asset/frontmatter";

/**
 * Strip frontmatter from raw memory content, returning the body text trimmed.
 * Case and whitespace are preserved. Falls back to `raw.trim()` on
 * unparseable frontmatter (consistent with the pre-existing load-time hot
 * guard).
 */
export function stripFrontmatterBody(raw: string): string {
  try {
    return parseFrontmatter(raw).content.trim();
  } catch {
    return raw.trim();
  }
}

/**
 * Hash used for change-detection and the body-embedding cache: case-/
 * whitespace-preserving stripped body. Two memories with the same wording
 * but different casing produce DIFFERENT hashes here, which is intentional —
 * we embed the exact text and cache by its precise content.
 *
 * This is the `content_hash` stored in `body_embeddings`.
 */
export function cacheHash(raw: string): string {
  return createHash("sha256").update(stripFrontmatterBody(raw), "utf8").digest("hex");
}
