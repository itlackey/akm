// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isWithin } from "../core/common";
import { warnOnce } from "../core/warn";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IncludeConfig {
  baseDir: string;
  include: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Key to check in package.json for akm include configuration. */
const INCLUDE_CONFIG_KEYS = ["akm"] as const;

function readPackageJsonAt(dirPath: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(path.join(dirPath, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractIncludeList(pkg: Record<string, unknown> | undefined): string[] | undefined {
  if (!pkg) return undefined;
  for (const key of INCLUDE_CONFIG_KEYS) {
    const config = pkg[key];
    if (typeof config !== "object" || config === null || Array.isArray(config)) continue;
    const { include } = config as Record<string, unknown>;
    if (!Array.isArray(include)) continue;
    const list = include
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Walk up the directory tree from `startDir` to `boundary` (inclusive) looking
 * for a package.json that declares an `akm.include` list.
 * Returns the first config found, or `undefined` if none is found within the
 * boundary.
 */
export function findNearestIncludeConfig(startDir: string, boundary: string): IncludeConfig | undefined {
  let current = path.resolve(startDir);
  const resolvedBoundary = path.resolve(boundary);

  while (isWithin(current, resolvedBoundary)) {
    const pkg = readPackageJsonAt(current);
    const include = extractIncludeList(pkg);
    if (include && include.length > 0) {
      return { baseDir: current, include };
    }
    if (current === resolvedBoundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/**
 * Does `entry` use glob syntax (`*`/`?`)? Everything else is a literal path,
 * resolved and copied exactly as before — this only changes behavior for
 * entries that actually contain a wildcard.
 */
function isIncludeEntryPattern(entry: string): boolean {
  return /[*?]/.test(entry);
}

/**
 * Translate one `akm.include` entry to a regular expression matched against a
 * `/`-joined path relative to `sourceDir`. Supports the subset package.json
 * authors reach for in practice: `*` (any run of characters within one path
 * segment), `?` (one character), and `**` (any run of characters across
 * segments, including none) — e.g. `skills/*` or `skills/**\/*.md`. Not a
 * full glob implementation (no brace expansion, character classes, or
 * negation); those fall through to being treated as a literal, almost
 * certainly non-matching path, same as an ordinary typo would.
 */
export function includeEntryToRegExp(entry: string): RegExp {
  const normalized = entry.split(path.sep).join("/");
  let pattern = "";
  for (let i = 0; i < normalized.length; ) {
    if (normalized.startsWith("**", i)) {
      const consumesSlash = normalized[i + 2] === "/";
      pattern += consumesSlash ? "(?:.*/)?" : ".*";
      i += consumesSlash ? 3 : 2;
      continue;
    }
    const char = normalized[i]!;
    if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${pattern}$`);
}

/** A symlink whose lstat succeeds but whose target does not exist — `copyPath` reports this case with its own specific warning. */
function isBrokenSymlink(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every path under `dir`, `/`-joined and relative to `base`, without following symlinked directories. */
function listAllRelativePaths(dir: string, base: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const absolute = path.join(dir, entry.name);
    out.push(path.relative(base, absolute).split(path.sep).join("/"));
    // `isDirectory()` on a `Dirent` reflects lstat, so a symlinked directory
    // is listed as an entry (and handled by copyPath's own symlink handling)
    // but never recursed into here.
    if (entry.isDirectory()) out.push(...listAllRelativePaths(absolute, base));
  }
  return out;
}

/**
 * Resolve one `akm.include` entry to the absolute candidate paths it names.
 * A literal entry resolves to itself, whether or not it exists on disk — the
 * caller checks that (after re-verifying containment, which needs to see
 * the literal candidate regardless). A pattern entry expands to every
 * existing matching path under `sourceDir`, so matching nothing already
 * naturally comes back as an empty array.
 */
function resolveIncludeEntry(entry: string, sourceDir: string): string[] {
  if (!isIncludeEntryPattern(entry)) return [path.resolve(sourceDir, entry)];
  const pattern = includeEntryToRegExp(entry);
  return listAllRelativePaths(sourceDir, sourceDir)
    .filter((relative) => pattern.test(relative))
    .map((relative) => path.join(sourceDir, relative));
}

/**
 * Copy each glob/path in `includeGlobs` from `sourceDir` to `destDir`.
 *
 * Uses `isWithin()` to prevent path-traversal attacks: any entry that escapes
 * `sourceDir` throws immediately — this is the operator's own config
 * (`akm.include` in a package.json under a source they added), not
 * discovered content, so a deliberate `../` here is treated as the mistake
 * (or attack) it looks like, not skipped.
 *
 * A missing entry, or a pattern that matches nothing, is skipped with a
 * warning instead of failing the whole install — one bad entry in a large
 * `include` list should not leave zero assets installed.
 */
export function copyIncludedPaths(includeGlobs: string[], sourceDir: string, destDir: string): void {
  for (const entry of includeGlobs) {
    const resolvedPaths = resolveIncludeEntry(entry, sourceDir);
    if (resolvedPaths.length === 0) {
      warnOnce(
        `akm-include-missing:${sourceDir}:${entry}`,
        `[akm] Skipping "${entry}" in akm.include: no matching file or directory.`,
      );
      continue;
    }
    for (const resolvedSource of resolvedPaths) {
      if (!isWithin(resolvedSource, sourceDir)) {
        throw new Error(`Path in akm.include escapes the package root: ${entry}`);
      }
      if (!fs.existsSync(resolvedSource) && !isBrokenSymlink(resolvedSource)) {
        warnOnce(
          `akm-include-missing:${sourceDir}:${entry}`,
          `[akm] Skipping "${entry}" in akm.include: no matching file or directory.`,
        );
        continue;
      }
      if (path.basename(resolvedSource) === ".git") continue;
      const relativePath = path.relative(sourceDir, resolvedSource);
      if (!relativePath || relativePath === ".") {
        copyDirectoryContents(sourceDir, destDir, sourceDir);
        continue;
      }
      copyPath(resolvedSource, path.join(destDir, relativePath), sourceDir);
    }
  }
}

// ── Private helpers ─────────────────────────────────────────────────────────

function copyDirectoryContents(sourceDir: string, destinationDir: string, containmentRoot: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    copyPath(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name), containmentRoot);
  }
}

/**
 * Copy one path. A symlink is followed and its TARGET's content copied
 * (never re-materialized as a symlink) rather than refused outright — a
 * published package with, say, `README.md -> docs/README.md` is ordinary,
 * not an attack. The resolved target must still stay within
 * `containmentRoot`: this is the same containment guarantee `isWithin`
 * enforces on every literal `akm.include` entry, just applied to a target we
 * discovered by following a link rather than one the operator typed — a
 * symlink escaping the package (to `/etc/passwd`, say) is skipped with a
 * warning, not copied.
 */
function copyPath(sourcePath: string, destinationPath: string, containmentRoot: string): void {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(sourcePath);
    } catch {
      warnOnce(
        `akm-include-broken-symlink:${sourcePath}`,
        `[akm] Skipping broken symlink in akm.include: ${path.relative(containmentRoot, sourcePath)}`,
      );
      return;
    }
    if (!isWithin(resolved, containmentRoot)) {
      warnOnce(
        `akm-include-symlink-escape:${sourcePath}`,
        `[akm] Skipping symlink in akm.include that points outside the package: ${path.relative(containmentRoot, sourcePath)}`,
      );
      return;
    }
    const resolvedStat = fs.statSync(resolved);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (resolvedStat.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyDirectoryContents(resolved, destinationPath, containmentRoot);
      return;
    }
    fs.copyFileSync(resolved, destinationPath);
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (stat.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    copyDirectoryContents(sourcePath, destinationPath, containmentRoot);
    return;
  }
  fs.copyFileSync(sourcePath, destinationPath);
}
