// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `generic-files` adapter.
 *
 * The AKM-native FALLBACK family. Any leftover file is classified by
 * extension:
 *   - a SCRIPT_EXTENSIONS extension → `script` (conceptId KEEPS the extension);
 *   - markdown / plain-text → `document` (conceptId STRIPS the extension);
 *   - everything else → `file` (conceptId keeps the extension).
 * Placement is IDENTITY: `document` appends `.md`, `script`/`file` keep their
 * natural path. Of several documents that spell one concept (`x.md`, `x.txt`) the `.md` wins. Reserved files (`index.md`/`log.md`) are excluded from the
 * catch-all so a structural listing is never indexed as a `document`.
 *
 * EXPLICIT-CONFIG ONLY: `generic-files` is never in the auto-probe order —
 * a user opts in deliberately — so `looksLikeRoot` NEVER fires. It has no
 * type-specific validators (`validate` runs base checks only).
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/generic-files/` + goldens
 * `tests/fixtures/format-family-goldens/generic-files/{recognition,lint,renderer}.json`.
 */

import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import { toPosix } from "../../common";
import { SCRIPT_EXTENSIONS } from "../../recognition-util";
import { DirectoryAdapterBase } from "../directory-adapter";
import type { FileChange } from "../file-change";
import type { Bundle, IndexMetadata } from "../types";
import type { FileDiagnostic, FileValidateContext } from "../validate-context";
import { hashContent, nonEmptyString, RESERVED_FILES, readTags, validateChangesWithBaseChecks } from "./shared";

/** Markdown / plain-text extensions classified as `document`. */
const DOCUMENT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);

type GenericType = "script" | "document" | "file";

function isReserved(base: string): boolean {
  return RESERVED_FILES.has(base.toLowerCase());
}

/** Classify by extension (open-question-5 predicate). */
function classify(ext: string): GenericType {
  if (SCRIPT_EXTENSIONS.has(ext)) return "script";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return "file";
}

/** The concept id of a file: a document's path without its extension, any other file's path as it is. A reserved file is none. */
function conceptIdOf(relPath: string): string | null {
  const posix = toPosix(relPath);
  if (isReserved(posix.split("/").pop() ?? posix)) return null; // D-R6: never index a structural listing
  return classify(path.posix.extname(posix).toLowerCase()) === "document" ? posix.replace(/\.[^./]+$/, "") : posix;
}

function describe(file: FileContext, conceptId: string): IndexMetadata {
  const type = classify(file.ext);
  const name = conceptId.split("/").pop() ?? conceptId;
  const raw = file.content();
  const parsed = parseFrontmatter(raw);
  const body = parsed.content;

  const doc: IndexMetadata = {
    hash: hashContent(raw),
    type,
    name,
    content: body,
  };
  if (type !== "script") doc.ownsPresentation = true;
  const description = nonEmptyString(parsed.data.description);
  if (description !== undefined) doc.description = description;
  const tags = readTags(parsed.data.tags);
  if (tags !== undefined) doc.tags = tags;
  return doc;
}

export class GenericFilesAdapter extends DirectoryAdapterBase {
  readonly id = "generic-files";
  readonly version = "0.10.0";
  // Non-exhaustive HINT: generic-files recognizes ANY file — recognize() is the
  // source of truth (empty extension list would drop the extension-strip hint).
  override readonly extensions = [".md", ".txt"];

  protected identify(relPath: string): string | null {
    return conceptIdOf(relPath);
  }

  protected describe(_b: Bundle, file: FileContext, conceptId: string): IndexMetadata {
    return describe(file, conceptId);
  }

  protected validateFiles(b: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
    return validateChangesWithBaseChecks(b, changes, ctx);
  }

  /** The file as named, then the document spellings, `.md` first. */
  protected spellings(conceptId: string): string[] {
    const posix = toPosix(conceptId);
    const documents = [...DOCUMENT_EXTENSIONS].map((extension) => `${posix}${extension}`);
    return DOCUMENT_EXTENSIONS.has(path.posix.extname(posix).toLowerCase()) ? documents : [posix, ...documents];
  }

  /** generic-files is EXPLICIT-CONFIG ONLY — never auto-selected (§1.2), so this never fires. */
  looksLikeRoot(_root: string): boolean {
    return false;
  }
}

export const genericFilesAdapter = new GenericFilesAdapter();
