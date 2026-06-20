// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Knowledge-command helpers extracted from `src/cli.ts`.
 *
 * Covers the shared pipeline for reading, naming, and writing markdown assets
 * (knowledge and memory) from the CLI. Extracted to keep the CLI entry point
 * focused on command definitions and routing.
 */

import fs from "node:fs";
import path from "node:path";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../../core/asset/asset-create";
import { resolveAssetPathFromName, TYPE_DIRS } from "../../core/asset/asset-spec";
import { isHttpUrl, isWithin, tryReadStdinText } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import {
  commitWriteTargetBoundary,
  formatRefForMessage,
  resolveWriteTarget,
  writeAssetToSource,
} from "../../core/write-source";
import { fetchWebsiteMarkdownSnapshot } from "../../sources/website-ingest";

const MAX_CAPTURED_ASSET_SLUG_LENGTH = 64;

// ── Asset-name normalisation ─────────────────────────────────────────────────

/**
 * Validate and normalise a markdown asset name supplied by the user.
 *
 * Strips the `.md` extension, rejects empty names, and guards against path
 * traversal (`..` segments). The `fallback` is used when `name` is undefined.
 */
export function normalizeMarkdownAssetName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? fallback)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "");
  if (!trimmed) throw new UsageError("Asset name cannot be empty.");
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new UsageError("Asset name must be a relative path without '.' or '..' segments.");
  }
  return trimmed;
}

// `--path`/`--name` create semantics are shared across all asset-creating
// commands; re-exported here so existing `./knowledge` importers keep working.
export { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath };

function slugifyAssetName(value: string, fallbackPrefix: string): string {
  const slug = value
    .toLowerCase()
    .replace(/^[#>\-\s]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CAPTURED_ASSET_SLUG_LENGTH);
  return slug || `${fallbackPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Derive a slug-style asset name from `content` and an optional `preferred`
 * hint (e.g. a URL-derived page title or the source filename stem).
 */
export function inferAssetName(content: string, fallbackPrefix: string, preferred?: string): string {
  const firstNonEmptyLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const basis = preferred?.trim() || firstNonEmptyLine || fallbackPrefix;
  return slugifyAssetName(basis, fallbackPrefix);
}

// ── Content reading ──────────────────────────────────────────────────────────

/**
 * Read knowledge content from a local file path or stdin (`"-"`).
 *
 * Returns the raw text and an optional `preferredName` derived from the
 * source filename stem (used as a slug fallback when no `--name` flag was
 * supplied).
 */
export function readKnowledgeContent(source: string): { content: string; preferredName?: string } {
  if (source === "-") {
    const content = tryReadStdinText();
    if (!content?.trim()) {
      throw new UsageError("No stdin content received. Pipe a document into stdin or pass a file path.");
    }
    return { content };
  }

  const resolvedSource = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedSource);
  } catch {
    throw new UsageError(`Knowledge source not found: "${source}". Pass a readable file path or "-" for stdin.`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`Knowledge source must be a file: "${source}".`);
  }
  return {
    content: fs.readFileSync(resolvedSource, "utf8"),
    preferredName: path.basename(resolvedSource, path.extname(resolvedSource)),
  };
}

/**
 * Read knowledge content from a local path, stdin (`"-"`), or a remote URL.
 *
 * URLs are fetched via `fetchWebsiteMarkdownSnapshot`; local sources delegate
 * to `readKnowledgeContent`.
 */
export async function readKnowledgeInput(source: string): Promise<{ content: string; preferredName?: string }> {
  if (!isHttpUrl(source)) return readKnowledgeContent(source);
  const snapshot = await fetchWebsiteMarkdownSnapshot(source);
  return { content: snapshot.content, preferredName: snapshot.preferredName };
}

// ── Asset writing ────────────────────────────────────────────────────────────

/**
 * Write a markdown asset (knowledge or memory) to the resolved write target.
 *
 * Resolves the write target via the v1 precedence chain (`--target` →
 * `defaultWriteTarget` → working stash), validates the path is within the
 * type root, enforces `--force` semantics, and delegates the actual write
 * to `writeAssetToSource`.
 */
export async function writeMarkdownAsset(options: {
  type: "knowledge" | "memory" | "fact";
  content: string;
  name?: string;
  fallbackPrefix: string;
  preferredName?: string;
  force?: boolean;
  /** Optional explicit `--target` override naming a configured source. */
  target?: string;
  /**
   * Optional `--path`: a relative directory under the type root in which to
   * place the asset. The filename still comes from `name` (or the content
   * slug). e.g. `path: "personal/projects"` → `memories/personal/projects/<name>.md`.
   */
  path?: string;
}): Promise<{ ref: string; path: string; stashDir: string }> {
  const cfg = loadConfig();
  const target = resolveWriteTarget(cfg, options.target);
  const { source, config } = target;

  const typeRoot = path.join(source.path, TYPE_DIRS[options.type] ?? options.type);
  // `--name` is the flat asset name; `--path` is the subdirectory under the
  // type root. Combine them into the nested name the path resolver expects.
  const subPath = normalizeCreateSubPath(options.path);
  const baseName = normalizeMarkdownAssetName(
    options.name,
    inferAssetName(options.content, options.fallbackPrefix, options.preferredName),
  );
  const normalizedName = combineCreatePath(subPath, baseName);
  // Pre-flight: existence + force semantics. The helper itself overwrites
  // unconditionally; the CLI surfaces a friendlier UsageError before any
  // disk activity when --force is absent.
  const assetPath = resolveAssetPathFromName(options.type, typeRoot, normalizedName);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved ${options.type} path escapes the stash: "${normalizedName}"`);
  }
  if (fs.existsSync(assetPath) && !options.force) {
    const label = `${options.type.charAt(0).toUpperCase()}${options.type.slice(1)}`;
    throw new UsageError(
      `${label} "${normalizedName}" already exists. Re-run with --force to overwrite it.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }

  const ref = { type: options.type, name: normalizedName };
  const result = await writeAssetToSource(source, config, ref, options.content);
  // 0.9.0 (issue #507): single batch commit at the write boundary for git
  // targets. No-op for filesystem/primary-stash targets.
  commitWriteTargetBoundary(target, `Update ${formatRefForMessage(ref)}`);
  return {
    ref: result.ref,
    path: result.path,
    stashDir: source.path,
  };
}
