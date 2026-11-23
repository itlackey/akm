// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What akm says about text before it is saved at a path of a bundle: the findings `akm lint` reports for the file, and
 * whether akm could still read the asset (its frontmatter parses, a workflow or task validates). The bundle's adapter
 * recognizes the text as it would the saved file; nothing in the bundle is written.
 */

import path from "node:path";
import { parseDocument } from "yaml";
import { lintDocumentText } from "../commands/lint";
import { protectedTypeOf } from "../core/adapter/directory/place-rules";
import { normalizeAkmMarkdown } from "../core/asset/akm-markdown";
import { documentStashDirFor } from "../core/asset/asset-placement";
import { parseFrontmatterBlock } from "../core/asset/frontmatter";
import { adapterWrites } from "../core/assets/gate";
import { recognizeContent, typeOfContent } from "../core/assets/type";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { folderBlocker } from "./file-actions";

/** The line of a frontmatter YAML error in the file (the block starts on line 2), when the YAML parser gives one. */
function frontmatterErrorLine(content: string): number | undefined {
  const block = parseFrontmatterBlock(content);
  const line = block ? parseDocument(block.frontmatter).errors[0]?.linePos?.[0]?.line : undefined;
  return line === undefined ? undefined : line + 1;
}

/** Why akm could not read the asset this text would be, or null when it could. */
function unreadableReason(
  recognized: ReturnType<typeof recognizeContent>,
  relative: string,
  content: string,
  taskFinding: string | undefined,
): { reason: string; line?: number } | null {
  if (recognized === null) return null;
  if (relative.toLowerCase().endsWith(".md")) {
    try {
      normalizeAkmMarkdown(content, recognized.type);
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error), line: frontmatterErrorLine(content) };
    }
  }
  if (taskFinding !== undefined) return { reason: taskFinding };
  return recognized.dropped === undefined ? null : { reason: recognized.dropped };
}

/** The akm bundle named `bundle`, and `path` as a path inside it that akm checks (not a protected or managed place). */
export function akmBundleFile(input: { bundle: string; path: string; content: string }, anyAdapter = false) {
  const bundle = typeof input.bundle === "string" ? input.bundle.trim() : "";
  const relative = typeof input.path === "string" ? input.path.trim().replaceAll("\\", "/") : "";
  if (!bundle || !relative) throw new UsageError("Choose a bundle and a path inside it.", "MISSING_REQUIRED_ARGUMENT");
  if (typeof input.content !== "string" || input.content.includes("\0")) throw new UsageError("content must be text.");
  if (path.posix.isAbsolute(relative) || relative.split("/").some((segment) => segment === ".." || segment === ""))
    throw new UsageError("Use a path inside the bundle.");
  const config = loadConfig();
  const source = resolveSourceEntries(undefined, config).find(
    (entry) => entry.registryId === bundle && !entry.unresolved,
  );
  if (!source) throw new UsageError(`Bundle "${bundle}" is disabled or unavailable.`);
  // An akm bundle: its adapter holds knowledge as files of its own, so the indexer's recognition applies to any text.
  const isAkm = adapterWrites(bundle, "knowledge");
  if (!anyAdapter && !isAkm) throw new UsageError(`akm checks the files of akm bundles; "${bundle}" is not one.`);
  const blocked =
    folderBlocker(path.posix.dirname(relative)) ??
    (protectedTypeOf(relative) ? "Env and secret files are checked in the protected-file view." : null);
  if (blocked !== null) throw new UsageError(blocked);
  return { bundle, relative, source, config, isAkm };
}

/** The type akm gives a file at `relative` holding `content` in `bundle`, or null when it is no asset. */
export function typeOfText(bundle: string, relative: string, content: string): string | null {
  return typeOfContent(bundle, relative, content);
}

/** The findings and readability for `content` as the text of `relative` in `bundle`. */
export async function check(input: { bundle: string; path: string; content: string }) {
  const { bundle, relative, source, config } = akmBundleFile(input);
  const recognized = recognizeContent(bundle, relative, input.content);
  const type = recognized?.type ?? null;
  const subdir = type === null ? undefined : documentStashDirFor(type);
  const found = subdir
    ? lintDocumentText({ root: source.path, relPath: relative, subdir, content: input.content, config })
    : { flagged: [], warnings: [] };
  const task = found.flagged.find((finding) => finding.issue === "invalid-task-yaml");
  const unreadable = unreadableReason(recognized, relative, input.content, task?.detail);
  return {
    bundle,
    path: relative,
    type,
    findings: found.flagged,
    warnings: found.warnings,
    readable: unreadable === null,
    ...(unreadable === null ? {} : { unreadable }),
  };
}
