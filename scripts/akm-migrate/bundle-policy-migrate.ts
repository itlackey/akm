// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `bundlePolicy` step, in writable bundles:
 *  - an asset's `lint_skip:` frontmatter is stripped. Nothing moves into the config: lint skips are the owner's
 *    folder-level globs under the bundle's `lint.skip`.
 *  - a `.gitignore` carrying the old `# akm: intentionally track env and secrets` marker adds
 *    `"tracked-secrets": ["**"]` to the bundle's `lint.skip`. The `.gitignore` itself is never modified.
 * A marker in a bundle with no config entry is reported and left. The config is written first (its own backup), then
 * the files under one backup directory per run, so a run cut short is finished by running again.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { documentStashDirs } from "../../src/core/asset/asset-placement";
import { loadConfig, mutateConfig, resetConfigCache } from "../../src/core/config/config";
import { getDataDir } from "../../src/core/paths";
import { walkStashFlat } from "../../src/indexer/walk/walker";
import { bundleRoots } from "./bundle-roots";
import { type FileReplacement, replaceFilesWithBackups } from "./migrate/task-files";

export interface BundlePolicySummary {
  schemaVersion: 1;
  /** Files whose `lint_skip` is stripped, plus bundles whose config gains a `tracked-secrets` skip. */
  changed: number;
  bundles: Array<{
    bundleId: string;
    /** Assets whose `lint_skip` frontmatter is stripped. */
    stripped: number;
    /** The bundle's config gains `"tracked-secrets": ["**"]` under `lint.skip`. */
    skipTrackedSecrets: boolean;
  }>;
  /** Bundles with the track-secrets marker and no config entry to carry the skip. */
  notes: string[];
  /** Present after a real apply that rewrote at least one file: the run's backup directory. */
  backupPath?: string;
  applied?: number;
}

export interface BundlePolicyMigrationStatus {
  schemaVersion: 1;
  status: "current" | "ready";
  bundlePolicy: BundlePolicySummary;
}

const TRACK_SECRETS_MARKER = "# akm: intentionally track env and secrets";

/** The text without its `lint_skip` key (the key line and the value lines under it), or null when it has none. */
function withoutLintSkip(raw: string): string | null {
  const parts = raw.split(/(\r?\n)/);
  if (parts[0]?.trim() !== "---") return null;
  const closeAt = parts.findIndex((part, i) => i > 0 && part.trim() === "---");
  const at = parts.findIndex((part, i) => i > 0 && i < closeAt && /^lint_skip:(?:[ \t]|$)/.test(part));
  if (closeAt === -1 || at === -1) return null;
  let end = at;
  while (end + 2 < closeAt && /^(?:[ \t]|-[ \t]|\]|$)/.test(parts[end + 2]!)) end += 2;
  parts.splice(at, end - at + 2);
  return parts.join("");
}

function plan(): { files: FileReplacement[]; bundles: BundlePolicySummary["bundles"]; notes: string[] } {
  resetConfigCache();
  const config = loadConfig();
  const files: FileReplacement[] = [];
  const bundles: BundlePolicySummary["bundles"] = [];
  const notes: string[] = [];
  for (const root of bundleRoots(config).filter((candidate) => candidate.writable)) {
    const edits: Array<{ filePath: string; after: string }> = [];
    const assetDirs = new Set(documentStashDirs());
    if ((root.adapter ?? "akm") === "akm") {
      for (const file of walkStashFlat(root.root)) {
        const rel = path.relative(root.root, file.absPath).split(path.sep).join("/");
        if (file.ext !== ".md" || !assetDirs.has(rel.split("/")[0]!) || !fs.lstatSync(file.absPath).isFile()) continue;
        const after = withoutLintSkip(fs.readFileSync(file.absPath, "utf8"));
        if (after !== null) edits.push({ filePath: file.absPath, after });
      }
    }
    const gitignorePath = path.join(root.root, ".gitignore");
    const marked =
      fs.existsSync(gitignorePath) &&
      fs.lstatSync(gitignorePath).isFile() &&
      fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/).includes(TRACK_SECRETS_MARKER);
    const entry = config.bundles?.[root.bundleId];
    const skipTrackedSecrets = marked && entry !== undefined && !entry.lint?.skip?.["tracked-secrets"]?.includes("**");
    if (marked && entry === undefined) {
      notes.push(
        `Bundle ${root.bundleId} at ${root.root} tracks env and secrets on purpose and has no config entry for a lint skip.`,
      );
    }
    if (edits.length === 0 && !skipTrackedSecrets) continue;
    bundles.push({ bundleId: root.bundleId, stripped: edits.length, skipTrackedSecrets });
    for (const edit of edits) {
      const before = fs.readFileSync(edit.filePath);
      files.push({
        filePath: edit.filePath,
        before,
        after: Buffer.from(edit.after, "utf8"),
        mode: fs.statSync(edit.filePath).mode & 0o777,
      });
    }
  }
  return { files, bundles, notes };
}

function summarize(planned: ReturnType<typeof plan>): BundlePolicySummary {
  const skips = planned.bundles.filter((bundle) => bundle.skipTrackedSecrets).length;
  return { schemaVersion: 1, changed: planned.files.length + skips, bundles: planned.bundles, notes: planned.notes };
}

function statusOf(summary: BundlePolicySummary): BundlePolicyMigrationStatus {
  return { schemaVersion: 1, status: summary.changed > 0 ? "ready" : "current", bundlePolicy: summary };
}

/** Read-only: what `apply` would move. */
export function inspectBundlePolicyMigration(): BundlePolicyMigrationStatus {
  return statusOf(summarize(plan()));
}

/** Add the `tracked-secrets` skips to the config, then strip `lint_skip` from the files, under one backup directory for the run. */
export function applyBundlePolicyMigration(): BundlePolicyMigrationStatus {
  const planned = plan();
  const summary = summarize(planned);
  if (summary.changed === 0) return statusOf(summary);
  const skipping = planned.bundles.filter((bundle) => bundle.skipTrackedSecrets);
  if (skipping.length > 0) {
    mutateConfig((current) => {
      const bundles = { ...current.bundles };
      for (const { bundleId } of skipping) {
        const entry = bundles[bundleId]!;
        const skip = { ...entry.lint?.skip };
        skip["tracked-secrets"] = [...new Set([...(skip["tracked-secrets"] ?? []), "**"])];
        bundles[bundleId] = { ...entry, lint: { ...entry.lint, skip } };
      }
      return { ...current, bundles };
    });
  }
  const backupPath =
    planned.files.length > 0
      ? path.join(getDataDir(), "backups", "bundle-policy", `${Date.now()}-${randomUUID()}`)
      : undefined;
  const { replaced, conflicts } = backupPath
    ? replaceFilesWithBackups(planned.files, backupPath)
    : { replaced: [], conflicts: [] };
  return {
    schemaVersion: 1,
    status: conflicts.length > 0 ? "ready" : "current",
    bundlePolicy: { ...summary, applied: replaced.length + skipping.length, ...(backupPath ? { backupPath } : {}) },
  };
}
