// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * The one-time content migration (akm 0.9.0 Chunk 8, WI-8.5d; ref-grammar
 * decision D-R6; plan §3.4). Three filesystem folds that retire the last
 * pre-0.9 on-disk shapes, run as an ADDITIVE journaled step of the
 * `cutover-applied` phase AFTER the state txn commits — best-effort (log, never
 * abort a committed cutover) and idempotent (a second apply is a no-op).
 *
 *  1. **`.stash.json` death.** For each per-directory `.stash.json` sidecar under
 *     the configured stash roots, fold its curated overrides into the matching
 *     file's YAML frontmatter (the sidecar override WON at read time, so it wins
 *     on fold too), then delete the sidecar. Only markdown targets are folded:
 *     the indexer reads curated frontmatter for `.md` files only
 *     ({@link applyCuratedFrontmatter} runs on `ext === ".md"`), and prepending a
 *     `---` block to a shell/script/env asset would corrupt it — non-markdown
 *     entries are counted + logged, never rewritten.
 *  2. **D-R6 reserved-filename conformance.** OKF reserves `index.md`/`log.md` as
 *     bundle structure at every depth (never concept documents). A pre-existing
 *     stash file so named that actually carries akm ASSET frontmatter (a
 *     `description`/`when_to_use`-bearing concept mis-placed under a reserved
 *     name) is renamed to a collision-safe reported name (`index-content.md`,
 *     `log-content.md`, appending `-2`/`-3`/… on collision) so the akm adapter's
 *     new reserved-file exclusion never silently drops it. A structural
 *     `index.md`/`log.md` (no asset frontmatter) is left in place.
 *  3. **`derived_from` backref grammar (Group-C item 2).** A derived memory's
 *     `source: memory:<name>` frontmatter backref — the last deliberately-legacy
 *     ref channel (WI-8.5c survivor) — is rewritten forward to the 0.9.0
 *     `source: memories/<name>` conceptId, matching the flipped producer output.
 *     Idempotent: a value already in `memories/<name>` (or any non-`memory:`
 *     `source`) is left untouched. The index `derived_from` COLUMN needs no fold
 *     — it is regenerable, so the producer flip + a reindex re-key it.
 *
 * PRE-RELEASE EXTENSION NOTE: 0.9.0 is UNRELEASED, so no user has run the cutover
 * yet. Fold #3 was ADDED to this step (not a second migration) after folds #1/#2
 * shipped in-branch — the module's READ behavior (the frozen sidecar reader) is
 * unchanged; only the rewrite/fold set grew. Post-release this file is frozen.
 *
 * This module is migrator-only and imports the frozen sidecar reader
 * ({@link readLegacyStashOverrides}) plus core leaves; it is never on a live
 * indexer path.
 */

import fs from "node:fs";
import path from "node:path";
import type { IndexDocument } from "../../core/adapter/types";
import { mutateFrontmatter, parseFrontmatter } from "../../core/asset/frontmatter";
import { asNonEmptyString } from "../../core/common";
import { warn } from "../../core/warn";
import { legacyStashFilePath, readLegacyStashOverrides } from "./legacy-stash-json";

/** A single D-R6 reserved-filename rename, recorded in the step report. */
export interface ReservedRename {
  /** Absolute path of the mis-named reserved file. */
  readonly from: string;
  /** Absolute path it was renamed to (collision-safe). */
  readonly to: string;
}

/** Per-run counts + the D-R6 rename list, for logging + test assertions. */
export interface ContentMigrationReport {
  /** Directories whose `.stash.json` sidecar was folded then deleted. */
  sidecarsFolded: number;
  /** Curated sidecar entries folded into a markdown file's frontmatter. */
  entriesFolded: number;
  /** Sidecar entries skipped (no `filename`, missing target, or non-markdown). */
  entriesSkipped: number;
  /** D-R6 reserved-file renames performed. */
  reservedRenames: ReservedRename[];
  /**
   * Group-C item 2: derived-memory `source: memory:<name>` frontmatter backrefs
   * rewritten forward to the 0.9.0 `source: memories/<name>` conceptId. A value
   * already in `memories/<name>` (or any non-`memory:` `source`) is not counted.
   */
  sourceBackrefsRewritten: number;
}

/** OKF reserved structural filenames (case-insensitive, any depth). */
const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

/**
 * The sidecar `IndexDocument` fields that {@link applyCuratedFrontmatter} reads
 * back off frontmatter, paired with the frontmatter KEY the indexer expects
 * (two keys are renamed on the way in: `whenToUse`→`when_to_use`,
 * `sourceRefs`→`source_refs`). Fields the indexer never reads off frontmatter
 * (`confidence`/`source`/`fileSize`/`filename`/…) are intentionally absent — the
 * fold preserves only what survives a re-index, so it stays faithful.
 */
const CURATED_FIELD_MAP: ReadonlyArray<readonly [keyof IndexDocument, string]> = [
  ["description", "description"],
  ["tags", "tags"],
  ["aliases", "aliases"],
  ["searchHints", "searchHints"],
  ["usage", "usage"],
  ["examples", "examples"],
  ["run", "run"],
  ["setup", "setup"],
  ["cwd", "cwd"],
  ["quality", "quality"],
  ["category", "category"],
  ["beliefState", "beliefState"],
  ["supersededBy", "supersededBy"],
  ["contradictedBy", "contradictedBy"],
  ["generation", "generation"],
  ["sourceRefs", "source_refs"],
  ["currentBeliefRefs", "currentBeliefRefs"],
  ["captureMode", "captureMode"],
  ["whenToUse", "when_to_use"],
  ["lessonStrength", "lessonStrength"],
  ["evidenceSources", "evidenceSources"],
  ["intent", "intent"],
  ["scope", "scope"],
];

function emptyReport(): ContentMigrationReport {
  return { sidecarsFolded: 0, entriesFolded: 0, entriesSkipped: 0, reservedRenames: [], sourceBackrefsRewritten: 0 };
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Absolute directories under `root` (inclusive), best-effort (unreadable dirs
 * skipped). Dot-directories (`.git`, `.meta`, …) are skipped: the indexer never
 * descends into them, so they hold no items to migrate and no `.stash.json` the
 * live reader would have merged.
 */
function collectDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    out.push(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return out;
}

/**
 * Run the content migration over the configured stash roots. Never throws — a
 * per-file failure is logged and the walk continues (best-effort, cutover
 * already committed).
 */
export function runContentMigration(stashRoots: readonly string[]): ContentMigrationReport {
  const report = emptyReport();
  const seen = new Set<string>();
  for (const root of stashRoots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved) || !safeIsDir(resolved)) continue;
    seen.add(resolved);
    const dirs = collectDirs(resolved);
    for (const dir of dirs) foldSidecarInDir(dir, report);
    for (const dir of dirs) renameReservedConceptsInDir(dir, report);
    for (const dir of dirs) rewriteSourceBackrefsInDir(dir, report);
  }
  return report;
}

/**
 * Group-C item 2: rewrite each markdown file's legacy `source: memory:<name>`
 * derived-memory backref forward to the 0.9.0 `source: memories/<name>`
 * conceptId. Idempotent — a `source` already in `memories/<name>` (or any value
 * that is not a `memory:` backref) is skipped, so a second apply rewrites
 * nothing. Best-effort per file (log + continue on error).
 */
function rewriteSourceBackrefsInDir(dir: string, report: ContentMigrationReport): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
    const filePath = path.join(dir, entry.name);
    try {
      const source = asNonEmptyString(parseFrontmatter(fs.readFileSync(filePath, "utf8")).data.source);
      const rewritten = legacyMemoryBackrefToConceptId(source);
      if (rewritten === undefined) continue; // already conceptId / not a memory backref → no-op
      mutateFrontmatter(filePath, (parsed) => ({ ...parsed.data, source: rewritten }));
      report.sourceBackrefsRewritten++;
    } catch (error) {
      warn(`[akm] content-migration: could not rewrite source backref in ${filePath}: ${errMsg(error)}`);
    }
  }
}

/**
 * Return the `memories/<name>` conceptId for a legacy `memory:<name>` backref,
 * or `undefined` when `value` is absent, already a `memories/<name>` conceptId,
 * or not a `memory:` backref at all. Only the bare legacy spelling the producer
 * ever wrote is rewritten (origin-prefixed values were never produced on
 * `source:` and are left untouched — the tolerant reader still normalises them).
 */
function legacyMemoryBackrefToConceptId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const MEMORY_PREFIX = "memory:";
  if (!trimmed.startsWith(MEMORY_PREFIX)) return undefined;
  return `memories/${trimmed.slice(MEMORY_PREFIX.length)}`;
}

/** Fold + delete one directory's `.stash.json`, if present. */
function foldSidecarInDir(dir: string, report: ContentMigrationReport): void {
  const sidecarPath = legacyStashFilePath(dir);
  if (!fs.existsSync(sidecarPath)) return;
  try {
    const overrides = readLegacyStashOverrides(dir);
    for (const entry of overrides?.entries ?? []) foldEntry(dir, entry, report);
    fs.rmSync(sidecarPath, { force: true });
    report.sidecarsFolded++;
  } catch (error) {
    warn(`[akm] content-migration: could not fold ${sidecarPath}: ${errMsg(error)}`);
  }
}

/** Fold one sidecar entry into its target markdown file's frontmatter. */
function foldEntry(dir: string, entry: IndexDocument, report: ContentMigrationReport): void {
  if (!entry.filename) {
    report.entriesSkipped++;
    return;
  }
  const target = path.join(dir, entry.filename);
  if (!fs.existsSync(target) || path.extname(target).toLowerCase() !== ".md") {
    report.entriesSkipped++;
    return;
  }
  try {
    mutateFrontmatter(target, (parsed) => foldCuratedFields(parsed.data, entry));
    report.entriesFolded++;
  } catch (error) {
    report.entriesSkipped++;
    warn(`[akm] content-migration: could not fold entry into ${target}: ${errMsg(error)}`);
  }
}

/** Merge the sidecar entry's curated fields onto the existing frontmatter (sidecar wins). */
function foldCuratedFields(existing: Record<string, unknown>, entry: IndexDocument): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  const source = entry as unknown as Record<string, unknown>;
  for (const [field, fmKey] of CURATED_FIELD_MAP) {
    const value = source[field as string];
    if (value !== undefined) next[fmKey] = value;
  }
  return next;
}

/** D-R6: rename any mis-named reserved-filename concept in `dir` to a collision-safe name. */
function renameReservedConceptsInDir(dir: string, report: ContentMigrationReport): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !RESERVED_BASENAMES.has(entry.name.toLowerCase())) continue;
    const filePath = path.join(dir, entry.name);
    try {
      if (!carriesAssetFrontmatter(filePath)) continue;
      const target = collisionSafeTarget(dir, entry.name);
      fs.renameSync(filePath, target);
      report.reservedRenames.push({ from: filePath, to: target });
    } catch (error) {
      warn(`[akm] content-migration: could not rename reserved file ${filePath}: ${errMsg(error)}`);
    }
  }
}

/**
 * True when a reserved-name file actually holds akm ASSET frontmatter (a
 * concept mis-placed under a reserved name), keyed on the D-R6 example markers
 * `description` / `when_to_use`. A structural listing/log block (no asset
 * frontmatter, e.g. only the bundle-root `okf_version`) returns false.
 */
function carriesAssetFrontmatter(filePath: string): boolean {
  const parsed = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
  if (parsed.frontmatter === null) return false;
  const data = parsed.data;
  return !!(
    asNonEmptyString(data.description) ||
    asNonEmptyString(data.when_to_use) ||
    asNonEmptyString(data.whenToUse)
  );
}

/** `index.md` → `index-content.md`, then `index-content-2.md`, … on collision. */
function collisionSafeTarget(dir: string, basename: string): string {
  const stem = basename.slice(0, basename.length - ".md".length);
  let candidate = path.join(dir, `${stem}-content.md`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-content-${suffix}.md`);
    suffix++;
  }
  return candidate;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
