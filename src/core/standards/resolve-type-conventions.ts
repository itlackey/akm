// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolve **per-type SOFT authoring conventions** (#646) — the third and final
 * authoring-guidance layer:
 *
 *   1. HARD rules (validator-rejecting, code-sourced) → `authoringRulesForType()`
 *      (`src/core/authoring-rules.ts`, #645). Never editable; the gate enforces them.
 *   2. General stash standards (cross-type naming/tag conventions) →
 *      `resolveStashStandards()` `category: convention|meta` facts (#642).
 *   3. **Per-type SOFT conventions** (voice, structure, length *preference* for
 *      *this* asset type) → user-editable `facts/conventions/assets/<type>.md`
 *      (THIS module). Augments the built-in `TYPE_HINTS` fallback for display.
 *
 * These facts are **soft only** — advice, not contract. They MUST NOT carry
 * hard, validator-rejecting rules: a user editing or deleting one must never be
 * able to weaken the authoring contract the gate enforces (#645 boundary).
 *
 * Selection is by a `placementTypes()`-validated basename: only
 * `facts/conventions/assets/<known-type>.md` resolves. Read directly from disk
 * (no index rebuild); any missing dir/file, unknown type, or read error degrades
 * to `""` and never throws.
 */

import fs from "node:fs";
import path from "node:path";
import { placementTypes } from "../asset/asset-placement";
import { parseFrontmatter } from "../asset/frontmatter";

/** Sub-path (under the stash root) for per-type SOFT convention facts. */
export const TYPE_CONVENTIONS_SUBDIR = path.join("facts", "conventions", "assets");

/** The `fact:` ref prefix for a per-type convention, e.g. `fact:conventions/assets/skill`. */
export function typeConventionRef(type: string): string {
  return `fact:conventions/assets/${type}`;
}

/**
 * Read the SOFT authoring-convention body for asset type `type`, if a stash
 * owner has authored `facts/conventions/assets/<type>.md`.
 *
 * @returns the trimmed markdown body (frontmatter stripped), or `""` when the
 *          type is unknown, the file is absent, or anything goes wrong.
 */
export function resolveTypeConventions(stashRoot: string, type: string | undefined): string {
  if (!stashRoot || !type) return "";

  // Basename MUST be a known asset type — never resolve an arbitrary file.
  if (!placementTypes().includes(type)) return "";

  const abs = path.join(stashRoot, TYPE_CONVENTIONS_SUBDIR, `${type}.md`);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch {
    return ""; // missing dir/file or read error → degrade to empty
  }

  let body = "";
  try {
    body = parseFrontmatter(raw).content;
  } catch {
    // Malformed frontmatter: fall back to the whole file (parseFrontmatter
    // normally returns whole content as body, but guard defensively).
    body = raw;
  }

  return body.trim();
}
