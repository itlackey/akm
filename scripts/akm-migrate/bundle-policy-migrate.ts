// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `bundlePolicy` step: policy that lived in a writable bundle's files moves into the bundle's entry in the config.
 *  - An asset's `lint_skip:` frontmatter becomes the entry's `lint.skip` (a rule's files collapse to `<dir>/**` where
 *    every markdown asset of a directory of two or more skips that rule, else exact paths) and the key is stripped.
 *  - The `.gitignore` marker for tracking `env/` and `secrets/` becomes `trackSecrets: true`.
 *  - akm's own `.gitignore` blocks and that marker are removed; every other line stays.
 * A bundle with no entry in the config keeps its files as written. The config is written first (its own backup), then
 * the files under one backup directory per run, so a run cut short is finished by running again.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { mutateConfig, resetConfigCache, loadConfig } from "../../src/core/config/config";
import { getDataDir } from "../../src/core/paths";
import { LINT_SKIPPABLE_RULES } from "../../src/commands/lint/bundle-skip";
import { walkStashFlat } from "../../src/indexer/walk/walker";
import { bundleRoots } from "./bundle-roots";
import { type FileReplacement, replaceFilesWithBackups } from "./migrate/task-files";

export interface BundlePolicySummary {
  schemaVersion: 1;
  /** Files with policy to move or akm-written `.gitignore` lines to remove. */
  changed: number;
  bundles: Array<{
    bundleId: string;
    /** The `lint.skip` entries this run adds to the bundle's config entry. */
    skip: Record<string, string[]>;
    trackSecrets: boolean;
    files: string[];
  }>;
  /** Bundles with policy in their files and no config entry to move it to; their files are left as written. */
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

const ASSET_DIRS = new Set(["agents", "commands", "memories", "skills", "workflows", "lessons", "tasks", "knowledge", "facts"]);

const SECRETS_BLOCK = [
  "# akm: keep secret material out of git by default",
  "# env/ and secrets/ assets hold tokens and keys. They are ignored by default",
  "# so `git push` can never leak them. To version a specific one (e.g. for a",
  "# private-remote backup), un-ignore its path below once you accept the risk.",
  "env/",
  "secrets/",
  "",
];
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

/** `.gitignore` text without akm's secrets block and tracking marker, and whether the marker was there. */
function cleanedGitignore(text: string): { text: string; tracksSecrets: boolean } {
  const lines = text.split("\n");
  const out: string[] = [];
  let tracksSecrets = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line === TRACK_SECRETS_MARKER) {
      tracksSecrets = true;
    } else if (line === SECRETS_BLOCK[0] && SECRETS_BLOCK.every((expected, n) => (lines[i + n] ?? "").replace(/\r$/, "") === expected)) {
      i += SECRETS_BLOCK.length - 1;
    } else {
      out.push(lines[i]!);
    }
  }
  return { text: out.join("\n"), tracksSecrets };
}

/**
 * The globs that cover exactly `skipped` among `assets` (both bundle-relative, `/`-joined): a directory of two or more
 * assets that all skip the rule is one `<dir>/**` (`**` for the bundle), anything else is its own path.
 */
function collapse(skipped: ReadonlySet<string>, assets: readonly string[]): string[] {
  const globs: string[] = [];
  const walk = (dir: string): void => {
    const prefix = dir === "" ? "" : `${dir}/`;
    const under = assets.filter((asset) => asset.startsWith(prefix));
    if (under.length >= 2 && under.every((asset) => skipped.has(asset))) {
      globs.push(dir === "" ? "**" : `${dir}/**`);
      return;
    }
    const children = new Set<string>();
    for (const asset of under) {
      const rest = asset.slice(prefix.length);
      if (rest.includes("/")) children.add(`${prefix}${rest.split("/")[0]}`);
      else if (skipped.has(asset)) globs.push(asset);
    }
    for (const child of [...children].sort()) walk(child);
  };
  walk("");
  return globs;
}

function plan(): { files: FileReplacement[]; bundles: BundlePolicySummary["bundles"]; notes: string[] } {
  resetConfigCache();
  const config = loadConfig();
  const files: FileReplacement[] = [];
  const bundles: BundlePolicySummary["bundles"] = [];
  const notes: string[] = [];
  for (const root of bundleRoots(config).filter((candidate) => candidate.writable)) {
    const edits: Array<{ filePath: string; after: string }> = [];
    const skippedBy = new Map<string, Set<string>>();
    const assets: string[] = [];
    if ((root.adapter ?? "akm") === "akm") {
      for (const file of walkStashFlat(root.root)) {
        const rel = path.relative(root.root, file.absPath).split(path.sep).join("/");
        if (file.ext !== ".md" || !ASSET_DIRS.has(rel.split("/")[0]!) || !fs.lstatSync(file.absPath).isFile()) continue;
        assets.push(rel);
        const raw = fs.readFileSync(file.absPath, "utf8");
        const after = withoutLintSkip(raw);
        if (after === null) continue;
        const value = parseFrontmatter(raw).data.lint_skip;
        for (const rule of (Array.isArray(value) ? value : value == null ? [] : [value]).map((v) => String(v).trim())) {
          if (LINT_SKIPPABLE_RULES.includes(rule)) skippedBy.set(rule, (skippedBy.get(rule) ?? new Set()).add(rel));
        }
        edits.push({ filePath: file.absPath, after });
      }
    }
    let trackSecrets = false;
    const gitignorePath = path.join(root.root, ".gitignore");
    if (fs.existsSync(gitignorePath) && fs.lstatSync(gitignorePath).isFile()) {
      const before = fs.readFileSync(gitignorePath, "utf8");
      const cleaned = cleanedGitignore(before);
      trackSecrets = cleaned.tracksSecrets;
      if (cleaned.text !== before) edits.push({ filePath: gitignorePath, after: cleaned.text });
    }
    if (edits.length === 0) continue;
    if (config.bundles?.[root.bundleId] === undefined) {
      notes.push(`Bundle ${root.bundleId} at ${root.root} has policy in its files and no config entry; left as written.`);
      continue;
    }
    const skip: Record<string, string[]> = {};
    for (const [rule, skipped] of skippedBy) skip[rule] = collapse(skipped, assets);
    bundles.push({ bundleId: root.bundleId, skip, trackSecrets, files: edits.map((edit) => edit.filePath) });
    for (const edit of edits) {
      const before = fs.readFileSync(edit.filePath);
      files.push({ filePath: edit.filePath, before, after: Buffer.from(edit.after, "utf8"), mode: fs.statSync(edit.filePath).mode & 0o777 });
    }
  }
  return { files, bundles, notes };
}

function summarize(planned: ReturnType<typeof plan>): BundlePolicySummary {
  return { schemaVersion: 1, changed: planned.files.length, bundles: planned.bundles, notes: planned.notes };
}

function statusOf(summary: BundlePolicySummary): BundlePolicyMigrationStatus {
  return { schemaVersion: 1, status: summary.changed > 0 ? "ready" : "current", bundlePolicy: summary };
}

/** Read-only: what `apply` would move. */
export function inspectBundlePolicyMigration(): BundlePolicyMigrationStatus {
  return statusOf(summarize(plan()));
}

/** Move the policy into the config, then strip it from the files, under one backup directory for the run. */
export function applyBundlePolicyMigration(): BundlePolicyMigrationStatus {
  const planned = plan();
  const summary = summarize(planned);
  if (summary.changed === 0) return statusOf(summary);
  mutateConfig((current) => {
    const bundles = { ...current.bundles };
    for (const { bundleId, skip, trackSecrets } of planned.bundles) {
      const entry = bundles[bundleId]!;
      const merged = { ...entry.lint?.skip };
      for (const [rule, globs] of Object.entries(skip)) merged[rule] = [...new Set([...(merged[rule] ?? []), ...globs])];
      bundles[bundleId] = {
        ...entry,
        ...(Object.keys(merged).length > 0 ? { lint: { ...entry.lint, skip: merged } } : {}),
        ...(trackSecrets ? { trackSecrets: true } : {}),
      };
    }
    return { ...current, bundles };
  });
  const backupPath = path.join(getDataDir(), "backups", "bundle-policy", `${Date.now()}-${randomUUID()}`);
  const { replaced, conflicts } = replaceFilesWithBackups(planned.files, backupPath);
  return {
    schemaVersion: 1,
    status: conflicts.length > 0 ? "ready" : "current",
    bundlePolicy: { ...summary, changed: replaced.length, applied: replaced.length, backupPath },
  };
}
