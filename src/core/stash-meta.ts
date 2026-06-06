// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stash `.meta/` convention.
 *
 * A stash may carry an optional, human-authored `.meta/` directory at its
 * root holding orientation docs for the stash as a whole: purpose, key
 * assets, conventions, maintainer info. Because `.meta/` is a dot-directory,
 * the indexer's walker already skips it (see `src/indexer/walker.ts`), so
 * these files never pollute the search corpus. They are surfaced on demand
 * via `akm show [<origin>//]meta[:<name>]`, which direct-reads the file
 * rather than going through the index.
 *
 * This is deliberately a *convention* enabled by a thin resolver: stash
 * owners extend it by dropping new files (`.meta/about.md`, `.meta/license`,
 * `.meta/conventions.md`) with zero further code changes.
 */

import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./errors";

/** Root-relative directory holding a stash's meta docs. */
export const META_DIR = ".meta";

/** Default meta doc shown when no name is given (`akm show <ref>//meta`). */
export const META_DEFAULT_NAME = "index";

export interface MetaRef {
  /** Origin (stash id) the meta doc belongs to, or undefined for the working stash. */
  origin?: string;
  /** Meta doc name without extension, e.g. `index`, `about`, `license`. */
  name: string;
}

/**
 * Parse a `meta` show target. Returns `null` when `ref` is not a meta ref so
 * callers can fall through to normal asset resolution.
 *
 * Accepted shapes (the leading `[origin//]` is optional):
 *   - `meta`            → { name: "index" }
 *   - `meta:about`      → { name: "about" }
 *   - `local//meta`     → { origin: "local", name: "index" }
 *   - `github:o/r//meta:conventions` → { origin: "github:o/r", name: "conventions" }
 */
export function parseMetaRef(ref: string): MetaRef | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  let origin: string | undefined;
  let body = trimmed;
  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    origin = trimmed.slice(0, boundary) || undefined;
    body = trimmed.slice(boundary + 2);
  }

  if (body === "meta") return { origin, name: META_DEFAULT_NAME };
  if (body.startsWith("meta:")) {
    const name = body.slice("meta:".length).trim();
    return { origin, name: name || META_DEFAULT_NAME };
  }
  return null;
}

/**
 * Reject meta names that would escape the `.meta/` directory. Mirrors the
 * traversal guards in `parseAssetRef`'s `validateName`.
 */
function assertSafeMetaName(name: string): void {
  if (name.includes("\0")) {
    throw new UsageError("Null byte in meta name.", "PATH_ESCAPE_VIOLATION");
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new UsageError("Windows drive path in meta name.", "PATH_ESCAPE_VIOLATION");
  }
  const normalized = path.posix.normalize(name.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new UsageError("Path traversal in meta name.", "PATH_ESCAPE_VIOLATION");
  }
  if (normalized.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new UsageError("Meta name cannot contain relative path segments.", "PATH_ESCAPE_VIOLATION");
  }
}

/**
 * Candidate filenames for a meta doc, in resolution order. Markdown is
 * preferred so `meta:about` resolves `.meta/about.md` ahead of `.meta/about`,
 * while names that already carry an extension (`license.txt`) are tried
 * verbatim first.
 */
function metaCandidates(name: string): string[] {
  if (path.posix.extname(name)) return [name, `${name}.md`];
  return [`${name}.md`, name];
}

/**
 * Resolve a meta doc to an absolute file path under `<sourceRoot>/.meta/`,
 * or `null` when no candidate file exists. Guards against path traversal
 * both before and after resolution (symlink containment).
 */
export function resolveMetaFilePath(sourceRoot: string, name: string): string | null {
  assertSafeMetaName(name);
  const metaRoot = path.resolve(sourceRoot, META_DIR);
  for (const candidate of metaCandidates(name)) {
    const resolved = path.resolve(metaRoot, candidate);
    if (resolved !== metaRoot && !resolved.startsWith(metaRoot + path.sep)) {
      throw new UsageError("Meta ref resolves outside the stash .meta directory.", "PATH_ESCAPE_VIOLATION");
    }
    if (isRegularFile(resolved)) return resolved;
  }
  return null;
}

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
