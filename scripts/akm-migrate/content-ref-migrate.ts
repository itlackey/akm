// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `assetContentRefs` step: a ref that names an asset by its pre-#1432 spelling (`knowledge/WORK/x`, now `WORK/x`)
 * in a writable bundle's text files is rewritten to the new one, under one backup directory per run. The old to new
 * map comes from the files themselves (each recognized asset's ref), so no index is needed. A spelling that
 * is now another file's live ref is left as written and listed ({@link ShadowedRef}). Only a file akm reads as an asset
 * (and a wiki's live `index.md` and `schema.md`, or an `index.md` beside assets) is rewritten (an active reference); frozen corpora, captured results and other fixtures stay byte-for-byte. The pure rewrite is
 * `./migrate/content-ref-planner.ts`.
 *
 * The same old spellings key rows in state.db (usage events, proposals, events, task history, improve ledger, asset
 * salience and outcome). The step re-keys them to the new spelling, so the history of a file outside its type folder
 * stays attached to it. index.db is not converted: it is rebuilt by the next `akm index`, which recomputes
 * scores from the usage events.
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { adapterForId } from "../../src/core/adapter/registry";
import { stashDirFor } from "../../src/core/asset/asset-placement";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { getDataDir } from "../../src/core/paths";
import { getStateDbPath, withStateDb } from "../../src/core/state-db";
import { type Database, openDatabase } from "../../src/storage/database";
import { walkStashFlat } from "../../src/indexer/walk/walker";
import { type BundleRoot, bundleRoots } from "./bundle-roots";
import { type ContentRefRewriter, contentRefRewriter, type ShadowedRef } from "./migrate/content-ref-planner";
import { type FileReplacement, replaceFilesWithBackups } from "./migrate/task-files";

export interface ContentRefFileSummary {
  filePath: string;
  status: "changed" | "skipped";
  /** The old-spelling refs in the file. */
  refs: number;
  reason?: string;
}

export interface ContentRefsSummary {
  schemaVersion: 1;
  /** Files with at least one old-spelling ref. */
  changed: number;
  skipped: number;
  /** Old-spelling refs in those files. */
  refs: number;
  files: ContentRefFileSummary[];
  /** Old spellings another file holds as its live ref: not rewritten, for the user to resolve. */
  shadowed: ShadowedRef[];
  /** state.db rows keyed by an old-spelling ref, which move to the new spelling (kept as they are when none). */
  stateRows: number;
  /** Present after a real apply that rewrote at least one file: the run's backup directory. */
  backupPath?: string;
  /** Present with `backupPath`: how many files were rewritten. */
  applied?: number;
  /** Present when the rewrite left uncommitted edits in a git bundle: what to do about each. */
  reconcile?: string[];
}

export interface ContentRefsMigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready";
  assetContentRefs: ContentRefsSummary;
}

/** The files whose refs are read and rewritten; the rest of a bundle (binaries, databases) is not content. */
const TEXT_EXTENSIONS = new Set([".md", ".yml", ".yaml", ".sh", ".ts", ".js", ".json", ".txt", ".py", ".mjs", ".jsonc", ".toml", ""]);

/**
 * The text files of a root, by the runtime's own walk (git-ignored files and, outside git, dot directories are not
 * content). A link is left alone: it may lead anywhere, and a write would replace it with a file.
 */
function textFiles(root: string): string[] {
  return walkStashFlat(root)
    .filter((file) => TEXT_EXTENSIONS.has(file.ext) && fs.lstatSync(file.absPath).isFile())
    .map((file) => file.absPath);
}

/** An asset's ref before #1432 (`bundle//<type folder>/<path>`) and its ref now (`bundle//<path>`). */
interface StateRefMove {
  readonly from: string;
  readonly to: string;
}

/**
 * Every asset each bundle's adapter recognizes, by bundle: the refs that exist now. Every bundle counts, as it does
 * for the resolver, so a spelling another adapter's bundle holds is live and never rewritten. `moves` are the assets
 * outside their type's folder, whose old ref differs from the new one. `files` are the recognized assets' paths: the
 * only files whose content akm reads for refs.
 */
function bundleDocuments(roots: readonly BundleRoot[]): {
  readonly bundles: Map<string, string[]>;
  readonly moves: StateRefMove[];
  readonly files: Set<string>;
} {
  const bundles = new Map<string, string[]>();
  const files = new Set<string>();
  const found: Array<{ bundleId: string; type: string; conceptId: string }> = [];
  for (const root of roots) {
    const adapterId = root.adapter ?? detectAdapterId(root.root);
    const adapter = adapterForId(adapterId);
    if (!adapter) continue;
    const component = { id: root.bundleId, adapter: adapterId, root: root.root, writable: root.writable };
    const documents = walkStashFlat(root.root).flatMap((file): string[] => {
      const doc = adapter.recognize(component, file);
      if (doc) files.add(file.absPath);
      if (!doc?.conceptId) return [];
      found.push({ bundleId: root.bundleId, type: doc.type, conceptId: doc.conceptId });
      return [doc.conceptId];
    });
    bundles.set(root.bundleId, [...(bundles.get(root.bundleId) ?? []), ...documents]);
  }
  const live = new Map([...bundles].map(([bundleId, refs]) => [bundleId, new Set(refs)]));
  const moves: StateRefMove[] = [];
  for (const { bundleId, type, conceptId } of found) {
    const dir = stashDirFor(type);
    if (dir === undefined || conceptId.startsWith(`${dir}/`)) continue;
    // An old spelling that is another file's live ref keys that file's rows: it is not this one's to take.
    if (live.get(bundleId)?.has(`${dir}/${conceptId}`)) continue;
    moves.push({ from: `${bundleId}//${dir}/${conceptId}`, to: `${bundleId}//${conceptId}` });
  }
  return { bundles, moves, files };
}

/** state.db tables that store a full `bundle//conceptId` ref, with the column that holds it. */
const STATE_REF_COLUMNS = [
  ["usage_events", "entry_ref"],
  ["proposals", "ref"],
  ["events", "ref"],
  ["task_history", "target_ref"],
  ["improve_ledger", "ref"],
  ["asset_salience", "asset_ref"],
  ["asset_outcome", "asset_ref"],
] as const;

/** The state.db rows each table holds under an old ref, read without changing the file. */
function stateRowsToMove(moves: readonly StateRefMove[]): number {
  if (moves.length === 0 || !fs.existsSync(getStateDbPath())) return 0;
  const target = new Map(moves.map((move) => [move.from, move.to]));
  const db: Database = openDatabase(getStateDbPath(), { readonly: true, create: false });
  try {
    let rows = 0;
    for (const [table, column] of STATE_REF_COLUMNS) {
      let held: Array<{ ref: string; n: number }>;
      try {
        held = db.prepare(`SELECT ${column} AS ref, COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL GROUP BY ${column}`).all() as never;
      } catch {
        continue; // a table a pending state migration has not created yet holds nothing to move
      }
      for (const { ref, n } of held) if (target.has(ref)) rows += n;
    }
    return rows;
  } finally {
    db.close();
  }
}

/** Re-key the state.db rows held under old refs. A row already at the new ref is an orphan and gives way. */
function moveStateRows(moves: readonly StateRefMove[]): void {
  if (moves.length === 0 || !fs.existsSync(getStateDbPath())) return;
  withStateDb((db) => {
    db.transaction(() => {
      for (const [table, column] of STATE_REF_COLUMNS) {
        // A usage event is also linked to the index row of its old ref by `entry_id`; the index drops that row (and
        // the events linked to it) when it re-keys. Unlinked, the event is relinked to the new row by ref.
        const unlink = table === "usage_events" ? ", entry_id = NULL" : "";
        const update = db.prepare(`UPDATE OR REPLACE ${table} SET ${column} = ?${unlink} WHERE ${column} = ?`);
        for (const move of moves) update.run(move.to, move.from);
      }
    })();
  });
}

/**
 * The live structural files akm agents read but the adapter does not index: a wiki's `index.md` and `schema.md`
 * (a llm-wiki bundle's `schema.md` is at its root), and an `index.md` beside a recognized asset. `log.md` is history,
 * and nothing under `raw/` (ingested source) or a frozen capture is touched.
 */
function isStructuralFile(root: string, adapterId: string, filePath: string, assetDirs: ReadonlySet<string>): boolean {
  const segments = path.relative(root, filePath).split(path.sep);
  if (segments.slice(0, -1).includes("raw")) return false;
  const name = segments[segments.length - 1]!.toLowerCase();
  const atWikiRoot = segments.length >= 3 && segments[segments.length - 3] === "wikis";
  if (name === "schema.md") return atWikiRoot || (adapterId === "llm-wiki" && segments.length === 1);
  return name === "index.md" && (atWikiRoot || assetDirs.has(path.dirname(filePath)));
}

/** The git checkout each file belongs to, when it has one (a bundle root may be a subdirectory of a checkout). */
function gitReconcile(filePaths: readonly string[], backupPath: string): string[] {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...env } = process.env;
  const topOf = new Map<string, string | undefined>();
  const byRoot = new Map<string, string[]>();
  for (const filePath of filePaths) {
    const real = fs.realpathSync(filePath);
    const dir = path.dirname(real);
    if (!topOf.has(dir)) {
      const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env });
      topOf.set(dir, top.status === 0 ? top.stdout.trim() : undefined);
    }
    const gitRoot = topOf.get(dir);
    if (gitRoot !== undefined) byRoot.set(gitRoot, [...(byRoot.get(gitRoot) ?? []), path.relative(gitRoot, real)]);
  }
  return [...byRoot].map(([gitRoot, paths]) => {
    const quoted = paths.map((file) => JSON.stringify(file)).join(" ");
    return `${gitRoot} is a git checkout with uncommitted migration edits (${paths.join(", ")}); review them with \`git -C ${gitRoot} status\` and \`git -C ${gitRoot} diff\` (a rewritten untracked file does not show in diff), then commit them or restore the originals with \`git -C ${gitRoot} restore ${quoted}\` (for an untracked file, copy it back from ${backupPath}); \`akm bundle update\` refuses an update that would overwrite them.`;
  });
}

interface PlannedFile {
  readonly replacement: FileReplacement;
  readonly refs: number;
}

function plan(): {
  readonly files: PlannedFile[];
  readonly shadowed: ShadowedRef[];
  readonly moves: StateRefMove[];
} {
  resetConfigCache();
  const roots = bundleRoots(loadConfig());
  const documents = bundleDocuments(roots);
  const { bundles, moves } = documents;
  const rewriter: ContentRefRewriter = contentRefRewriter(bundles);
  const files: PlannedFile[] = [];
  const seen = new Set<string>();
  const assetDirs = new Set([...documents.files].map((file) => path.dirname(file)));
  for (const root of roots.filter((candidate) => candidate.writable)) {
    const adapterId = root.adapter ?? detectAdapterId(root.root);
    for (const filePath of textFiles(root.root)) {
      if (seen.has(filePath) || !(documents.files.has(filePath) || isStructuralFile(root.root, adapterId, filePath, assetDirs))) continue;
      seen.add(filePath);
      const before = fs.readFileSync(filePath);
      const text = before.toString("utf8");
      // A file that is not valid UTF-8 would be damaged by the write back.
      if (!Buffer.from(text, "utf8").equals(before)) continue;
      const { text: rewritten, count } = rewriter.rewrite(text);
      if (count === 0) continue;
      files.push({
        replacement: { filePath, before, after: Buffer.from(rewritten, "utf8"), mode: fs.statSync(filePath).mode & 0o777 },
        refs: count,
      });
    }
  }
  return { files: files.sort((a, b) => a.replacement.filePath.localeCompare(b.replacement.filePath)), shadowed: [...rewriter.shadowed], moves };
}

function summarize(planned: ReturnType<typeof plan>): ContentRefsSummary {
  return {
    schemaVersion: 1,
    changed: planned.files.length,
    skipped: 0,
    refs: planned.files.reduce((sum, file) => sum + file.refs, 0),
    files: planned.files.map((file) => ({ filePath: file.replacement.filePath, status: "changed", refs: file.refs })),
    shadowed: planned.shadowed,
    stateRows: stateRowsToMove(planned.moves),
  };
}

function statusOf(summary: ContentRefsSummary): ContentRefsMigrationStatus {
  return { schemaVersion: 1, status: summary.changed > 0 || summary.stateRows > 0 ? "ready" : "current", assetContentRefs: summary };
}

/** Read-only: what `apply` would rewrite. */
export function inspectContentRefsMigration(): ContentRefsMigrationStatus {
  return statusOf(summarize(plan()));
}

/** Rewrite every old-spelling ref found in a writable bundle, under one backup directory for the run. */
export function applyContentRefsMigration(): ContentRefsMigrationStatus {
  return withConfigLock(() => {
    const planned = plan();
    const summary = summarize(planned);
    moveStateRows(planned.moves);
    if (summary.changed === 0) return { schemaVersion: 1, status: "current", assetContentRefs: summary };
    const backupPath = path.join(getDataDir(), "backups", "asset-content-refs", `${Date.now()}-${randomUUID()}`);
    const { replaced, conflicts } = replaceFilesWithBackups(
      planned.files.map((file) => file.replacement),
      backupPath,
    );
    // A file that changed since it was planned was left as it is; the report says so, and a run again plans it afresh.
    const files = summary.files.map((file): ContentRefFileSummary =>
      conflicts.includes(file.filePath)
        ? { ...file, status: "skipped", reason: "it changed after it was planned, so it was left as it is; run again to plan it afresh" }
        : file,
    );
    const reconcile = gitReconcile(replaced, backupPath);
    return {
      schemaVersion: 1,
      status: conflicts.length > 0 ? "ready" : "current",
      assetContentRefs: {
        ...summary,
        files,
        changed: replaced.length,
        skipped: conflicts.length,
        applied: replaced.length,
        backupPath,
        ...(reconcile.length > 0 ? { reconcile } : {}),
      },
    };
  });
}
