// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Flexible asset resolution system.
 *
 * Provides a rich FileContext built once per file during walking, plus a
 * matcher/renderer registry that decouples asset classification from rendering.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../asset/frontmatter";
import { toPosix } from "../../common";
import type { AssetEntry } from "../bundle-adapter";
import type { FileContext } from "../types";

export type { FileContext, MatchResult } from "../types";

// ── FileContext ──────────────────────────────────────────────────────────────

/**
 * Build a FileContext from a stash root and an absolute file path.
 *
 * Path-derived fields are computed eagerly. The content, frontmatter, and
 * stat getters use lazy caching so the file is only read from disk when
 * (and if) a matcher or renderer actually needs it.
 */
export function buildFileContext(stashRoot: string, absPath: string): FileContext {
  const relPath = toPosix(path.relative(stashRoot, absPath));
  const ext = path.extname(absPath).toLowerCase();
  const fileName = path.basename(absPath);
  const parentDirAbs = path.dirname(absPath);
  const parentDir = path.basename(parentDirAbs);

  // Compute ancestor directory segments from the POSIX relPath's directory portion.
  // For "scripts/azure/deploy/run.sh" the dir portion is "scripts/azure/deploy"
  // which splits into ["scripts", "azure", "deploy"].
  const relDir = toPosix(path.dirname(relPath));
  const ancestorDirs: string[] = relDir === "." ? [] : relDir.split("/").filter((seg) => seg.length > 0);

  // Lazy caches
  let cachedContent: string | undefined;
  let cachedBytes: Buffer | undefined;
  let cachedFrontmatter: Record<string, unknown> | null | undefined;
  let frontmatterComputed = false;
  let cachedStat: fs.Stats | undefined;

  return {
    absPath,
    file: absPath,
    relPath,
    key: relPath,
    ext,
    fileName,
    parentDir,
    parentDirAbs,
    ancestorDirs,
    stashRoot,

    content(): string {
      if (cachedContent === undefined) {
        cachedContent = fs.readFileSync(absPath, "utf8");
      }
      return cachedContent;
    },

    bytes(): Buffer {
      if (cachedBytes === undefined) {
        cachedBytes = fs.readFileSync(absPath);
      }
      return cachedBytes;
    },

    frontmatter(): Record<string, unknown> | null {
      if (!frontmatterComputed) {
        const raw = this.content();
        const parsed = parseFrontmatter(raw);
        cachedFrontmatter = Object.keys(parsed.data).length > 0 ? parsed.data : null;
        frontmatterComputed = true;
      }
      return cachedFrontmatter ?? null;
    },

    stat(): fs.Stats {
      if (cachedStat === undefined) {
        cachedStat = fs.statSync(absPath);
      }
      return cachedStat;
    },

    modified(): Date {
      return this.stat().mtime;
    },

    mode(): number {
      return this.stat().mode & 0o777;
    },
  };
}

// ── MatchResult ───────────────────────────────────────────────

/**
 * The `FileContext` of an entry a bundle's adapter lists. A directory entry is one already. Any other entry has no
 * file: its path fields are the ones the index keys it under (`<root>/<relPath>`), and its content is the entry's.
 */
export function fileContextOfEntry(root: string, entry: AssetEntry): FileContext {
  if ("absPath" in entry) return entry as FileContext;
  return {
    ...buildFileContext(root, path.join(root, entry.key)),
    content: () => entry.content(),
    bytes: () => entry.bytes(),
    frontmatter: () => entry.frontmatter(),
    ...(entry.locator !== undefined ? { locator: entry.locator } : {}),
  };
}
