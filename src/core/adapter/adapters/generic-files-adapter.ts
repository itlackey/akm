// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `generic-files` adapter — akm 0.9.0 format-family work item (#46).
 *
 * The AKM-native FALLBACK family. Any leftover file is classified by
 * extension:
 *   - a SCRIPT_EXTENSIONS extension → `script` (conceptId KEEPS the extension);
 *   - markdown / plain-text → `document` (conceptId STRIPS the extension);
 *   - everything else → `file` (conceptId keeps the extension).
 * Placement is IDENTITY: `document` appends `.md`, `script`/`file` keep their
 * natural path. Reserved files (`index.md`/`log.md`) are excluded from the
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
import type { FileChange } from "../../file-change";
import { SCRIPT_EXTENSIONS } from "../../recognition-util";
import type { AdapterReadCandidate } from "../directory-adapter";
import { DirectoryAdapterBase } from "../directory-adapter";
import type { Bundle, Diagnostic, IndexDocument, ValidateContext } from "../types";
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

function recognize(c: Bundle, file: FileContext): IndexDocument | null {
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
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "generic-files",
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
  readonly version = "0.9.0";
  // Non-exhaustive HINT: generic-files recognizes ANY file — recognize() is the
  // source of truth (empty extension list would drop the extension-strip hint).
  override readonly extensions = [".md", ".txt"];

  protected recognizeFile(b: Bundle, file: FileContext): IndexDocument | null {
    return recognize(b, file);
  }

  protected validateFiles(b: Bundle, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
    return validateChangesWithBaseChecks(b, changes, ctx);
  }

  protected readCandidates(c: Bundle, conceptId: string): AdapterReadCandidate[] {
    const posix = toPosix(conceptId);
    const extension = path.extname(posix).toLowerCase();
    const documentCandidates = [...DOCUMENT_EXTENSIONS].map((candidateExtension) => ({
      path: path.join(c.root, `${posix}${candidateExtension}`),
      conceptId: posix,
    }));
    return DOCUMENT_EXTENSIONS.has(extension)
      ? documentCandidates
      : [{ path: path.join(c.root, posix), conceptId: posix }, ...documentCandidates];
  }

  /** generic-files is EXPLICIT-CONFIG ONLY — never auto-selected (§1.2), so this never fires. */
  looksLikeRoot(_root: string): boolean {
    return false;
  }
}

export const genericFilesAdapter = new GenericFilesAdapter();
