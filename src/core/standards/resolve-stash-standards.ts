// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolve the stash-authoring "standards" context (Feature B of the standards
 * plan): gather the bodies of `fact` assets whose `category` frontmatter is
 * `convention` or `meta` so naming / tag / frontmatter conventions are surfaced
 * to the agent when it creates or edits a non-wiki asset.
 *
 * Selection is by **frontmatter `category`**, never by path — flat
 * (`facts/x.md`) and nested (`facts/conventions/x.md`) layouts resolve
 * identically. The MVP does no parsing of fenced blocks, no rule objects, and
 * no warnings: it concatenates the selected facts' bodies in stable enumeration
 * order, each preceded by a one-line `# <ref>` provenance header. Returns `""`
 * when no matching facts exist.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../asset/frontmatter";

/** `category` values that mark a fact as an authoring standard. */
const STANDARD_CATEGORIES = new Set(["convention", "meta"]);

/** Directory (under the stash root) where `fact` assets live. */
const FACTS_SUBDIR = "facts";

/**
 * Per-type SOFT convention facts (`facts/conventions/assets/<type>.md`, #646)
 * are surfaced **type-scoped** through `resolveTypeConventions`, so they must
 * NOT leak into this un-type-scoped general layer (authoring a `command` must
 * not pull the `skill` convention). Excluded by relative path (POSIX form).
 */
const TYPE_CONVENTIONS_REL = "conventions/assets/";

/**
 * Recursively collect `.md` files under `dir` in stable (sorted) enumeration
 * order. Returns absolute paths. Missing dir → `[]`.
 */
function collectMarkdownFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Derive a fact ref (`fact:conventions/naming`) from an absolute markdown path
 * relative to the facts root. Mirrors the canonical-name derivation in
 * `asset-spec.ts` (POSIX separators, `.md` stripped).
 */
function toFactRef(factsRoot: string, absPath: string): string {
  const rel = path.relative(factsRoot, absPath).split(path.sep).join("/");
  const name = rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  return `fact:${name}`;
}

export function resolveStashStandards(stashRoot: string): string {
  const factsRoot = path.join(stashRoot, FACTS_SUBDIR);
  const sections: string[] = [];

  for (const absPath of collectMarkdownFiles(factsRoot)) {
    // Per-type SOFT conventions are delivered type-scoped (#646); skip them
    // here so they never leak un-type-scoped into every authoring flow.
    const relPosix = path.relative(factsRoot, absPath).split(path.sep).join("/");
    if (relPosix.startsWith(TYPE_CONVENTIONS_REL)) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    let category = "";
    let body = "";
    try {
      const parsed = parseFrontmatter(raw);
      category = typeof parsed.data.category === "string" ? parsed.data.category.trim() : "";
      body = parsed.content;
    } catch {
      continue;
    }

    if (!STANDARD_CATEGORIES.has(category)) continue;

    const trimmed = body.trim();
    if (!trimmed) continue; // skip stub facts with frontmatter but no body

    sections.push(`# ${toFactRef(factsRoot, absPath)}\n${trimmed}`);
  }

  return sections.join("\n\n");
}
