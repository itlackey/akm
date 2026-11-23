// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The recoverable archive of a directory bundle: how `DirectoryAdapterBase`
 * retires, restores, forgets and expires assets.
 *
 * To retire a file, the archive writes a tombstone and then moves the file:
 * `<root>/.akm/memory-cleanup/archive/<stamp>-<concept id>/cleanup.md` records what was
 * retired and why, and the file itself is renamed to
 * `<root>/.akm/memory-cleanup/archive/<stamp>-<concept id>/<originalPath>`. The
 * tombstone is written first so a crash between the two leaves, at worst, a
 * tombstone for a move that did not happen: the file is still where it was, and
 * `restore` of that retirement changes nothing. The format is persisted
 * (proposals record the archive directories); do not change it.
 *
 * The refs a tombstone's note carries (`ref`, `parentRef`, `survivorRef`, `successorRefs`) and the directory name
 * are concept ids: a ref into the bundle's own namespace is written without its `bundle//` (§0.2 N11), another
 * bundle's stays qualified. Tombstones written before that carry qualified refs; {@link qualifiedNote} reads both
 * as qualified, and nothing parses a directory name.
 *
 * A retirement's `handle` is its archive directory, relative to the bundle's
 * root. The `.akm/memory-cleanup/archive` location is the one the memory-cleanup
 * feature has always used (#884): a tombstone is also how a ref to a retired
 * asset is told apart from a ref to nothing (`core/asset/memory-archive.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { makeBundleRef } from "../asset/asset-ref";
import { assembleAsset } from "../asset/asset-serialize";
import { parseFrontmatter } from "../asset/frontmatter";
import { toPosix, writeFileAtomic } from "../common";
import { NotFoundError, UsageError } from "../errors";
import { checkGitPathSafety, isGitBackedStash } from "../git-path-safety";
import { warn } from "../warn";
import type { RetireNote } from "./bundle-adapter";

/** Bundle-relative root the archive lives under. */
export const MEMORY_ARCHIVE_REL = ".akm/memory-cleanup/archive";

/** The one file every archive directory keeps forever: the tombstone. */
const TOMBSTONE_FILENAME = "cleanup.md";

/** The tombstone fields the archive itself writes; everything else in it is the caller's note. */
const MECHANICS_FIELDS = ["schemaVersion", "kind", "originalPath", "archivedPath"];

/**
 * The note fields a tombstone has always written after `originalPath` and `archivedPath` (§0.2 P18: the file is
 * committed into the bundle, so its key order is kept); the rest of the note comes before them.
 */
const TRAILING_NOTE_FIELDS = ["proposalId", "retiredAt", "successorRefs"];

/** One retirement, as its tombstone records it. */
export interface Tombstone {
  /** The archive directory, relative to the bundle root, POSIX. */
  handle: string;
  /** The retired file's path in the bundle, relative to the root, POSIX. */
  originalPath: string;
  /** Where the file was moved to, relative to the bundle root. Absent: the tombstone does not say. */
  archivedPath?: string;
  /** The tombstone's frontmatter. */
  data: Record<string, unknown>;
}

interface TombstoneScan {
  tombstones: Tombstone[];
  originalPaths: Set<string>;
}

/**
 * Scans keyed by bundle root. A lint sweep resolves thousands of refs against
 * a directory that only this module writes, so the scan runs once per root
 * instead of once per missing ref; this module's own writes drop the root's scan.
 */
const scans = new Map<string, TombstoneScan>();

/** @internal Drop the memoized scans: process-global state needs a reset seam for tests (#785). */
export function resetArchiveCache(): void {
  scans.clear();
}

/** Every tombstone under `root`. An unreadable or malformed one is skipped, never thrown: it degrades to "no retirement". */
function scanTombstones(root: string): TombstoneScan {
  const cached = scans.get(root);
  if (cached !== undefined) return cached;

  const scan: TombstoneScan = { tombstones: [], originalPaths: new Set() };
  const archiveRoot = path.join(root, MEMORY_ARCHIVE_REL);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    // No archive directory: nothing was ever retired here.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tombstone = parseTombstone(root, path.join(archiveRoot, entry.name));
    if (!tombstone) continue;
    scan.tombstones.push(tombstone);
    scan.originalPaths.add(tombstone.originalPath);
  }
  scans.set(root, scan);
  return scan;
}

function parseTombstone(root: string, dir: string): Tombstone | undefined {
  let data: Record<string, unknown>;
  try {
    data = parseFrontmatter(fs.readFileSync(path.join(dir, TOMBSTONE_FILENAME), "utf8")).data;
  } catch {
    return undefined;
  }
  const original = data.originalPath;
  if (typeof original !== "string" || original.trim().length === 0) return undefined;
  const archived = data.archivedPath;
  return {
    handle: toPosix(path.relative(root, dir)),
    originalPath: original.trim().replace(/\\/g, "/"),
    ...(typeof archived === "string" ? { archivedPath: archived } : {}),
    data,
  };
}

/** Every tombstone under `root`. */
export function listTombstones(root: string): Tombstone[] {
  return scanTombstones(root).tombstones;
}

/** Every bundle-relative `originalPath` retired under `root`: the paths that used to hold an asset and now hold a tombstone. */
export function archivedOriginalPaths(root: string): Set<string> {
  return scanTombstones(root).originalPaths;
}

/** The note a caller recorded with a retirement: the tombstone without the fields the archive writes. */
export function noteOf(tombstone: Tombstone): RetireNote {
  return Object.fromEntries(Object.entries(tombstone.data).filter(([key]) => !MECHANICS_FIELDS.includes(key)));
}

/** The note fields that hold one ref, and the one that holds a list of them. */
const REF_FIELDS = ["ref", "parentRef", "survivorRef"];
const REF_LIST_FIELD = "successorRefs";

/** `note` with `convert` applied to each ref it holds; anything else, and a field that is not a string, is kept. */
function mapNoteRefs(note: RetireNote, convert: (ref: string) => string): RetireNote {
  const out: Record<string, unknown> = { ...note };
  for (const field of REF_FIELDS) {
    const value = out[field];
    if (typeof value === "string") out[field] = convert(value);
  }
  const list = out[REF_LIST_FIELD];
  if (Array.isArray(list)) out[REF_LIST_FIELD] = list.map((ref) => (typeof ref === "string" ? convert(ref) : ref));
  return out;
}

/** `ref` without the `bundle//` that names the bundle it is in; another bundle's ref is kept (§0.2 N11). */
function localRef(bundle: string, ref: string): string {
  return ref.startsWith(`${bundle}//`) ? ref.slice(bundle.length + 2) : ref;
}

/**
 * The tombstone converter: `note` with each ref qualified by `bundle`. A ref already qualified is read as written
 * (a tombstone from before §0.2 N11 holds only those), and so is one in the retired `<type>:<name>` spelling, which
 * memory cleanup still records and which names no concept id.
 */
export function qualifiedNote(bundle: string, note: RetireNote): RetireNote {
  return mapNoteRefs(note, (ref) => {
    if (ref.includes("//") || /^[a-z-]+:/i.test(ref)) return ref;
    try {
      return makeBundleRef(bundle, ref);
    } catch {
      return ref; // a hand-edited tombstone: never throw from a read
    }
  });
}

/** The tombstone of the retirement `handle` names; refuses a handle that is not an archive directory of `root`. */
export function readTombstone(root: string, handle: string): Tombstone {
  const dir = archiveDirOf(root, handle);
  const tombstone = parseTombstone(root, dir);
  if (!tombstone) throw new NotFoundError(`No retirement "${handle}" in this bundle.`);
  return tombstone;
}

function archiveDirOf(root: string, handle: string): string {
  const dir = path.resolve(root, handle);
  if (path.dirname(dir) !== path.resolve(root, MEMORY_ARCHIVE_REL)) {
    throw new UsageError(`"${handle}" is not a retirement of this bundle.`, "PATH_ESCAPE_VIOLATION");
  }
  return dir;
}

/** What `archiveFile` did. */
export interface ArchiveWrite {
  handle: string;
  /** The archive directory, absolute. */
  archiveDir: string;
  /** Where the file now is, absolute. */
  archivedPath: string;
  /** The tombstone, absolute. */
  auditPath: string;
  /** The retired file's path in the bundle, relative to the root, POSIX. */
  originalPath: string;
  archivedAt: string;
  /** Every file the retirement wrote, moved or removed: the original, the archived copy, the tombstone. */
  changed: string[];
}

/**
 * Retire `file` (inside `root`): write the tombstone (`note` plus where the file was and went), then move the
 * file under the archive. `ref` names the archive directory; `archivedAt` stamps it and the tombstone. Given the
 * `bundle` the root belongs to, a ref into that bundle is written as its concept id (§0.2 N11); a caller with no
 * qualified refs names none.
 */
export function archiveFile(
  root: string,
  file: string,
  { ref, archivedAt, note, bundle }: { ref: string; archivedAt: string; note: RetireNote; bundle?: string },
): ArchiveWrite {
  const originalPath = toPosix(path.relative(root, file));
  const local = (value: string) => (bundle === undefined ? value : localRef(bundle, value));
  const archiveDir = createArchiveDir(root, local(ref), archivedAt);
  const archivedPath = path.join(archiveDir, originalPath);
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });

  const auditPath = path.join(archiveDir, TOMBSTONE_FILENAME);
  const noteFields = Object.entries(bundle === undefined ? note : mapNoteRefs(note, local));
  const tombstone = assembleAsset(
    {
      schemaVersion: 1,
      kind: "memory-cleanup-archive",
      archivedAt,
      ...Object.fromEntries(noteFields.filter(([key]) => !TRAILING_NOTE_FIELDS.includes(key))),
      originalPath,
      archivedPath: toPosix(path.relative(root, archivedPath)),
      ...Object.fromEntries(noteFields.filter(([key]) => TRAILING_NOTE_FIELDS.includes(key))),
    },
    "Archived derived memory for recoverable cleanup.\n",
  );
  // Tombstone first: a file moved with no tombstone is unrecoverable, because
  // nothing else knows the archive directory exists. A crash after this write
  // leaves a tombstone for a move that has not happened, and `restore` of it
  // changes nothing.
  try {
    fs.writeFileSync(auditPath, tombstone, "utf8");
    fs.renameSync(file, archivedPath);
  } finally {
    scans.delete(root);
  }

  return {
    handle: toPosix(path.relative(root, archiveDir)),
    archiveDir,
    archivedPath,
    auditPath,
    originalPath,
    archivedAt,
    changed: [file, archivedPath, auditPath],
  };
}

/**
 * Put a retired file back: rename the archived copy to its original place; when the archived copy has expired,
 * write `fallback` there instead (refused without one). Refuses when both exist, which means something new took
 * the original's place; changes nothing when only the original exists (already restored). The tombstone stays,
 * so a caller can record its decision before `forgetArchive` removes it. Returns the files it changed.
 */
export function restoreArchive(root: string, tombstone: Tombstone, fallback?: string | Buffer): string[] {
  const { originalPath, archivedPath } = tombstone;
  if (archivedPath === undefined) {
    throw new UsageError(
      `The retirement "${tombstone.handle}" does not say where its file went; it cannot be restored.`,
    );
  }
  const original = path.join(root, originalPath);
  const archived = path.join(root, archivedPath);
  const originalExists = fs.existsSync(original);
  const archivedExists = fs.existsSync(archived);

  if (originalExists && archivedExists) {
    throw new UsageError(`${originalPath} already exists (created since retirement); refusing to overwrite it.`);
  }
  if (originalExists) return [];

  fs.mkdirSync(path.dirname(original), { recursive: true });
  if (archivedExists) {
    fs.renameSync(archived, original);
    scans.delete(root);
    return [original, archived];
  }
  if (fallback === undefined) {
    throw new UsageError(
      `${originalPath} was retired and its archived copy is gone; there is nothing to restore it from.`,
    );
  }
  writeFileAtomic(original, fallback, 0o644);
  return [original];
}

/** Remove the archive directory of the retirement `handle` names. Removing one that is gone changes nothing. */
export function forgetArchive(root: string, handle: string): string[] {
  const dir = archiveDirOf(root, handle);
  const changed = listFilesRecursive(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  scans.delete(root);
  return changed;
}

/** What `expireArchive` removed. */
export interface ArchiveExpiry {
  /** Archive directories whose archived files were removed. */
  purgedDirs: number;
  /** Every archived file removed (a retirement may archive more than one, e.g. a `.derived` twin). */
  changed: string[];
}

/**
 * Delete the archived files, never the tombstone, of every retirement whose tombstone `retiredAt` is before
 * `before` AND whose archived files are all git-tracked and clean at the time of the sweep. Git history keeps
 * the bytes (D27); the tombstone, and ref resolution through it, are unaffected.
 *
 * Git-backed bundles only: a bundle with no `.git` of its own has no history to fall back on, so its archive is
 * left untouched (`akm health` reports its size instead; see `health/archive-usage.ts`).
 *
 * `.git` presence is necessary but NOT sufficient: `proposal accept` only commits for a `kind: "git"` write
 * target (`core/write-source.ts` `commitWriteTargetBoundary`), and improve's own auto-sync stages only the paths
 * its own run wrote. A filesystem-kind bundle that merely happens to have a `.git` directory (the owner
 * committing by hand, or an old repo that was never configured as a git source) can carry retirements that were
 * archived but never committed; deleting those would lose the only surviving copy. So every archived file under
 * a directory past grace is checked against `git ls-files` (tracked), `git status --porcelain -uall` (clean), and
 * `git ls-files -v` (verifiable: an assume-unchanged or skip-worktree file hides its own edits from `git
 * status`, so it is never trusted as clean either). A directory with even one untracked, modified or
 * unverifiable file (the tombstone included) is left whole for a later sweep.
 *
 * Each of the three git calls can fail independently (a broken submodule can make `git status` exit nonzero while
 * `git ls-files` succeeds, or git can be missing from `PATH`), and `[]` from a failed call is indistinguishable
 * from a verified-empty one once it is in a set. So the checks are computed ONCE per sweep, `ok` is read first,
 * and any failure purges nothing and warns once.
 *
 * A family-prune archive carries no `retiredAt` in its tombstone, so it is never a candidate here: this sweep
 * only ever touches retirements.
 */
export function expireArchive(root: string, before: Date): ArchiveExpiry {
  const none: ArchiveExpiry = { purgedDirs: 0, changed: [] };
  if (!isGitBackedStash(root)) return none;
  const archiveRoot = path.join(root, MEMORY_ARCHIVE_REL);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    return none; // no archive yet
  }
  const gitSafety = checkGitPathSafety(root, MEMORY_ARCHIVE_REL);
  if (!gitSafety.ok) {
    warn(
      `[improve] archive purge: skipped this sweep — could not determine the archive's git state at ${root} ` +
        "(git status/ls-files failed); nothing was purged.",
    );
    return none;
  }
  const cutoffMs = before.getTime();
  const changed: string[] = [];
  let purgedDirs = 0;
  for (const entry of entries) {
    // `Dirent.isDirectory()` reflects `lstat`, so it is false for a symlink even when the symlink points at a
    // directory: a symlinked `archive/<name>` is skipped here, never followed (N1). Everything below only ever
    // joins path components onto `archiveRoot` through `entry.name`/`readdirSync` results, so a purge can never
    // reach outside `.akm/memory-cleanup/archive/`.
    if (!entry.isDirectory()) continue;
    const dir = path.join(archiveRoot, entry.name);
    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(fs.readFileSync(path.join(dir, TOMBSTONE_FILENAME), "utf8")).data;
    } catch {
      continue; // not a tombstone dir, or unreadable: never guess
    }
    const retiredAt = data.retiredAt;
    if (typeof retiredAt !== "string") continue; // family-prune archive, not a retirement
    const retiredMs = Date.parse(retiredAt);
    if (!Number.isFinite(retiredMs) || retiredMs >= cutoffMs) continue; // exactly at the cutoff is not enough
    const allFiles = listFilesRecursive(dir); // tombstone included: the whole entry must be a clean, committed unit
    if (!allFiles.every((file) => gitSafety.isSafe(toPosix(path.relative(root, file))))) continue; // B1, G10
    let children: string[];
    try {
      children = fs.readdirSync(dir);
    } catch {
      continue;
    }
    let purgedAnyInThisDir = false;
    for (const child of children) {
      if (child === TOMBSTONE_FILENAME) continue;
      const childPath = path.join(dir, child);
      // The archived original path may be nested (`memories/sub/foo.md` under this dir), and the commit boundary
      // tracks FILES, so every leaf under childPath is reported, not the directory.
      const filesUnderChild = listFilesRecursive(childPath);
      try {
        fs.rmSync(childPath, { recursive: true, force: true });
        changed.push(...filesUnderChild);
        purgedAnyInThisDir = purgedAnyInThisDir || filesUnderChild.length > 0;
      } catch {
        // Best-effort: a locked or already-gone entry is skipped, not fatal to the run.
      }
    }
    if (purgedAnyInThisDir) purgedDirs++;
  }
  return { purgedDirs, changed };
}

/** Every file under `target` (itself, if it is a file), for reporting before a recursive delete. */
function listFilesRecursive(target: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return stat.isFile() ? [target] : [];
  let children: string[];
  try {
    children = fs.readdirSync(target);
  } catch {
    return [];
  }
  return children.flatMap((child) => listFilesRecursive(path.join(target, child)));
}

function createArchiveDir(root: string, ref: string, archivedAt: string): string {
  const baseName = `${archivedAt.replace(/[:.]/g, "-")}-${sanitizeRef(ref)}`;
  const archiveRoot = path.join(root, MEMORY_ARCHIVE_REL);
  fs.mkdirSync(archiveRoot, { recursive: true });
  let attempt = 0;
  while (true) {
    const candidate = path.join(archiveRoot, attempt === 0 ? baseName : `${baseName}-${attempt}`);
    if (!fs.existsSync(candidate)) {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    }
    attempt += 1;
  }
}

function sanitizeRef(ref: string): string {
  return ref.replace(/[^a-z0-9._-]+/gi, "-");
}
