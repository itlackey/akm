// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `assetContentRefs` step: a ref that names an asset by its pre-#1432 spelling (`knowledge/WORK/x`, now `WORK/x`)
 * in a writable bundle's text files is rewritten to the new one, under one backup directory per run. The old to new
 * map comes from the files themselves (`refForFile` of each recognized asset), so no index is needed. A spelling that
 * is now another file's live ref is left as written and listed ({@link ShadowedRef}). The pure rewrite is
 * `./migrate/content-ref-planner.ts`.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../src/core/adapter/adapters/akm-adapter";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { withConfigLock } from "../../src/core/config/config-io";
import { getDataDir } from "../../src/core/paths";
import { walkStashFlat } from "../../src/indexer/walk/walker";
import { type BundleRoot, bundleRoots } from "./bundle-roots";
import { type ContentRefRewriter, contentRefRewriter, type RefDocument, type ShadowedRef } from "./migrate/content-ref-planner";
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
}

export interface ContentRefsMigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready";
  assetContentRefs: ContentRefsSummary;
}

/** The files whose refs are read and rewritten; the rest of a bundle (binaries, databases, VCS and dependency trees) is not content. */
const TEXT_EXTENSIONS = new Set([".md", ".yml", ".yaml", ".sh", ".ts", ".js", ".json", ".txt", ".py", ".mjs", ".jsonc", ".toml", ""]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "worktrees"]);

function textFiles(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) textFiles(file, out);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(file);
    }
  }
  return out;
}

/** Every asset the `akm` adapter recognizes in each `akm` bundle, by bundle: the refs that exist now. */
function bundleDocuments(roots: readonly BundleRoot[]): Map<string, RefDocument[]> {
  const bundles = new Map<string, RefDocument[]>();
  for (const root of roots) {
    if ((root.adapter ?? detectAdapterId(root.root)) !== "akm") continue;
    const component = { id: root.bundleId, adapter: "akm", root: root.root, writable: root.writable };
    const documents = walkStashFlat(root.root).flatMap((file): RefDocument[] => {
      const doc = akmAdapter.recognize(component, file);
      return doc?.conceptId ? [{ type: doc.type, ref: doc.conceptId }] : [];
    });
    bundles.set(root.bundleId, documents);
  }
  return bundles;
}

interface PlannedFile {
  readonly replacement: FileReplacement;
  readonly refs: number;
}

function plan(): { readonly files: PlannedFile[]; readonly shadowed: ShadowedRef[] } {
  resetConfigCache();
  const roots = bundleRoots(loadConfig());
  const rewriter: ContentRefRewriter = contentRefRewriter(bundleDocuments(roots));
  const files: PlannedFile[] = [];
  const seen = new Set<string>();
  for (const root of roots.filter((candidate) => candidate.writable)) {
    for (const filePath of textFiles(root.root)) {
      if (seen.has(filePath)) continue;
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
      },
    };
  });
}
