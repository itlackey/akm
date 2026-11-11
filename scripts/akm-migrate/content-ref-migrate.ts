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
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { adapterForId } from "../../src/core/adapter/registry";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { getDataDir } from "../../src/core/paths";
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

/**
 * Every asset each bundle's adapter recognizes, by bundle: the refs that exist now. Every bundle counts, as it does
 * for the resolver, so a spelling another adapter's bundle holds is live and never rewritten. `files` are the
 * recognized assets' paths: the only files whose content akm reads for refs.
 */
function bundleDocuments(roots: readonly BundleRoot[]): { bundles: Map<string, string[]>; files: Set<string> } {
  const bundles = new Map<string, string[]>();
  const files = new Set<string>();
  for (const root of roots) {
    const adapterId = root.adapter ?? detectAdapterId(root.root);
    const adapter = adapterForId(adapterId);
    if (!adapter) continue;
    const component = { id: root.bundleId, adapter: adapterId, root: root.root, writable: root.writable };
    const documents = walkStashFlat(root.root).flatMap((file): string[] => {
      const doc = adapter.recognize(component, file);
      if (doc) files.add(file.absPath);
      return doc?.conceptId ? [doc.conceptId] : [];
    });
    bundles.set(root.bundleId, [...(bundles.get(root.bundleId) ?? []), ...documents]);
  }
  return { bundles, files };
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
} {
  resetConfigCache();
  const roots = bundleRoots(loadConfig());
  const documents = bundleDocuments(roots);
  const rewriter: ContentRefRewriter = contentRefRewriter(documents.bundles);
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
  return { files: files.sort((a, b) => a.replacement.filePath.localeCompare(b.replacement.filePath)), shadowed: [...rewriter.shadowed] };
}

function summarize(planned: ReturnType<typeof plan>): ContentRefsSummary {
  return {
    schemaVersion: 1,
    changed: planned.files.length,
    skipped: 0,
    refs: planned.files.reduce((sum, file) => sum + file.refs, 0),
    files: planned.files.map((file) => ({ filePath: file.replacement.filePath, status: "changed", refs: file.refs })),
    shadowed: planned.shadowed,
  };
}

function statusOf(summary: ContentRefsSummary): ContentRefsMigrationStatus {
  return { schemaVersion: 1, status: summary.changed > 0 ? "ready" : "current", assetContentRefs: summary };
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
    if (summary.changed === 0) return statusOf(summary);
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
