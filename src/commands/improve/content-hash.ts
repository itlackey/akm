// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { computeNormalizedContentHash, parseFrontmatter } from "../../core/asset/frontmatter";

/** The markdown body with its frontmatter removed, trimmed (the raw text when it does not parse). */
export function stripFrontmatterBody(raw: string): string {
  try {
    return parseFrontmatter(raw).content.trim();
  } catch {
    return raw.trim();
  }
}

/**
 * The one "is this the same content?" hash for improve and the proposal queue
 * (sha256, hex):
 *  - `raw`: the exact bytes — proposal before/after and judged-content hashes,
 *    session transcripts, cache keys for plain text.
 *  - `body`: the body without frontmatter, case and wording preserved — memory
 *    and knowledge dedup and the body-embedding cache.
 *  - `normalized`: the whole asset minus akm's bookkeeping frontmatter
 *    (`BOOKKEEPING_FRONTMATTER_KEYS`), keys sorted — proposal freshness, so a
 *    salience or inference rewrite of the target never stales a proposal.
 */
export function contentHash(content: string | Uint8Array, mode: "raw" | "body" | "normalized" = "raw"): string {
  if (mode === "raw") return createHash("sha256").update(content).digest("hex");
  const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  return mode === "body" ? contentHash(stripFrontmatterBody(text)) : computeNormalizedContentHash(text);
}
