// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `generic-files` adapter — akm 0.9.0 format-family work item (#46).
 *
 * The AKM-native FALLBACK family (spec §7). Any leftover file is classified by
 * extension (open-question-5, RESOLVED — maintainer 2026-07):
 *   - a SCRIPT_EXTENSIONS extension → `script` (conceptId KEEPS the extension);
 *   - markdown / plain-text → `document` (conceptId STRIPS the extension);
 *   - everything else → `file` (conceptId keeps the extension).
 * Placement is IDENTITY: `document` appends `.md`, `script`/`file` keep their
 * natural path. D-R6 reserved files (`index.md`/`log.md`) are excluded from the
 * catch-all so a structural listing is never indexed as a `document`.
 *
 * EXPLICIT-CONFIG ONLY: `generic-files` is never in the §1.2 auto-probe order —
 * a user opts in deliberately — so `looksLikeRoot` NEVER fires. It has no
 * type-specific validators (`validate` runs base checks only).
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/generic-files/` + goldens
 * `tests/fixtures/format-family-goldens/generic-files/{recognition,placement,lint,renderer}.json`.
 */

import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import { SCRIPT_EXTENSIONS } from "../../recognition-util";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent, nonEmptyString, readTags, runBaseValidateChecks } from "./shared";

/** A generic-files bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** Markdown / plain-text extensions classified as `document`. */
const DOCUMENT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);
/** OKF reserved structural files (D-R6) — excluded from the catch-all, case-insensitive. */
const RESERVED_FILES = new Set(["index.md", "log.md"]);
/** Upper bound on the bounded `content` FTS field (mirrors okf-adapter). */
const MAX_CONTENT_CHARS = 100_000;

type GenericType = "script" | "document" | "file";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function isReserved(base: string): boolean {
  return RESERVED_FILES.has(base.toLowerCase());
}

/** Classify by extension (open-question-5 predicate). */
function classify(ext: string): GenericType {
  if (SCRIPT_EXTENSIONS.has(ext)) return "script";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return "file";
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  const posix = toPosix(file.relPath);
  const base = posix.split("/").pop() ?? posix;
  if (isReserved(base)) return null; // D-R6: never index a structural listing

  const type = classify(file.ext);
  // document strips its extension; script/file keep the natural path.
  const conceptId = type === "document" ? posix.replace(/\.[^./]+$/, "") : posix;
  const name = conceptId.split("/").pop() ?? conceptId;
  const raw = file.content();
  const parsed = parseFrontmatter(raw);
  const body = parsed.content;

  const doc: IndexDocument = {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: COMPONENT_ID,
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "generic-files",
    type,
    name,
    content: body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body,
  };
  const description = nonEmptyString(parsed.data.description);
  if (description !== undefined) doc.description = description;
  const tags = readTags(parsed.data.tags);
  if (tags !== undefined) doc.tags = tags;
  return doc;
}

async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    // No type-specific validators — base checks only (spec §6 script/document/file rows).
    diagnostics.push(...(await runBaseValidateChecks(toPosix(change.path), parseFrontmatter(raw), c.root, ctx)));
  }
  return diagnostics;
}

export const genericFilesAdapter: BundleAdapter = {
  id: "generic-files",
  version: "0.9.0",
  // Non-exhaustive HINT: generic-files recognizes ANY file — recognize() is the
  // source of truth (empty extension list would drop the extension-strip hint).
  extensions: [".md", ".txt"],

  recognize,
  validate,

  /**
   * IDENTITY placement (open-question-5): a conceptId that carries an extension
   * (`script`/`file`) places to itself; an extension-less conceptId (a
   * `document`) appends `.md`.
   */
  placeNew(c: BundleComponent, conceptId: string): string {
    const posix = toPosix(conceptId);
    const hasExt = path.extname(posix) !== "";
    return path.join(c.root, hasExt ? posix : `${posix}.md`);
  },

  /** generic-files is EXPLICIT-CONFIG ONLY — never auto-selected (§1.2), so this never fires. */
  looksLikeRoot(): boolean {
    return false;
  },
};
