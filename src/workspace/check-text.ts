// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What akm says about text before it is saved at a path of a bundle: the findings `akm lint` reports for the file, and
 * whether akm could still read the asset (its frontmatter parses, a workflow or task validates). The text is written
 * to a scratch copy of the path so the indexer's own recognition runs on it; nothing in the bundle is read or written.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { lintDocumentText } from "../commands/lint";
import { classifyAkmFile } from "../core/adapter/adapters/akm-adapter";
import { detectAdapterId } from "../core/adapter/detect-adapter";
import { adapterForId } from "../core/adapter/registry";
import { normalizeAkmMarkdown } from "../core/asset/akm-markdown";
import { documentStashDirFor } from "../core/asset/asset-placement";
import { parseFrontmatterBlock } from "../core/asset/frontmatter";
import { isWithin } from "../core/common";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { drainDirDocuments } from "../indexer/scan/drain-dir";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { buildFileContext } from "../indexer/walk/file-context";
import { protectedTypeOf } from "./bundle-files";
import { folderBlocker } from "./file-actions";

/** The line of a frontmatter YAML error in the file (the block starts on line 2), when the YAML parser gives one. */
function frontmatterErrorLine(content: string): number | undefined {
  const block = parseFrontmatterBlock(content);
  const line = block ? parseDocument(block.frontmatter).errors[0]?.linePos?.[0]?.line : undefined;
  return line === undefined ? undefined : line + 1;
}

/** Why akm could not read the asset this text would be, or null when it could. */
function unreadableReason(
  type: string | null,
  relative: string,
  content: string,
  scratchRoot: string,
  bundle: string,
  taskFinding: string | undefined,
): { reason: string; line?: number } | null {
  if (type === null) return null;
  if (relative.toLowerCase().endsWith(".md")) {
    try {
      normalizeAkmMarkdown(content, type);
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error), line: frontmatterErrorLine(content) };
    }
  }
  if (taskFinding !== undefined) return { reason: taskFinding };
  const component = { id: bundle, adapter: "akm", root: scratchRoot, writable: true };
  const file = buildFileContext(scratchRoot, path.join(scratchRoot, relative));
  const adapter = adapterForId("akm");
  const drained = adapter ? drainDirDocuments(adapter, component, [file]) : undefined;
  if (drained === undefined || drained.entries.length > 0) return null;
  return { reason: drained.warnings[0] ?? "akm does not index a file here." };
}

/** The findings and readability for `content` as the text of `relative` in `bundle`. */
export async function check(input: { bundle: string; path: string; content: string }) {
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
  if ((source.adapterId ?? detectAdapterId(source.path)) !== "akm")
    throw new UsageError(`akm checks the files of akm bundles; "${bundle}" is not one.`);
  const blocked =
    folderBlocker(path.posix.dirname(relative)) ??
    (protectedTypeOf(relative) ? "Env and secret files are checked in the protected-file view." : null);
  if (blocked !== null) throw new UsageError(blocked);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "akm-check-"));
  try {
    const scratchFile = path.join(scratch, relative);
    if (!isWithin(scratchFile, scratch)) throw new UsageError("Use a path inside the bundle.");
    fs.mkdirSync(path.dirname(scratchFile), { recursive: true });
    fs.writeFileSync(scratchFile, input.content);
    const type = classifyAkmFile(scratch, buildFileContext(scratch, scratchFile))?.match.type ?? null;
    const subdir = type === null ? undefined : documentStashDirFor(type);
    const found = subdir
      ? lintDocumentText({ root: source.path, relPath: relative, subdir, content: input.content, config })
      : { flagged: [], warnings: [] };
    const task = found.flagged.find((finding) => finding.issue === "invalid-task-yaml");
    const unreadable = unreadableReason(type, relative, input.content, scratch, bundle, task?.detail);
    return {
      bundle,
      path: relative,
      type,
      findings: found.flagged,
      warnings: found.warnings,
      readable: unreadable === null,
      ...(unreadable === null ? {} : { unreadable }),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
