// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-workflow` adapter — akm 0.9.0 format-family work item (#46).
 *
 * A native akm workflow bundle: Markdown workflow sources.
 *
 * ── validate ──
 *
 * Reuses the akm adapter's per-type workflow checks (shared base checks +
 * `placeholder-stub` + `invalid-workflow-structure`). Delegates to the SAME
 * `perTypeDiagnostics` / `createBaseChecker` the `akm` adapter uses, so
 * workflow validation has one home.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/akm-workflow/` + goldens
 * `tests/fixtures/format-family-goldens/akm-workflow/{recognition,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import { toPosix } from "../../common";
import type { FileChange } from "../../file-change";
import type { AdapterReadCandidate, NewAsset } from "../bundle-adapter";
import type { Bundle, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { AkmFormatAdapterBase } from "./akm-format";
import { perTypeDiagnostics } from "./akm-lint";
import { createBaseChecker, hashContent, nonEmptyString, parseForValidate, readTags } from "./shared";

/** The authoritative workflow source format. */
const WORKFLOW_EXTS = new Set([".md"]);

/** Strip the recognized workflow extension from a bundle-root-relative path → conceptId. */
function conceptIdOf(relPath: string): string {
  return toPosix(relPath).replace(/\.(?:md|yml)$/i, "");
}

/** `README.md` (case-insensitive) is documentation, never the typed asset — mirrors the akm matcher stack's D-R6 reserved-file exclusion (`TYPED_DIR_DOC_FILES`). */
function isReservedDocFile(fileName: string): boolean {
  return fileName.toLowerCase() === "readme.md";
}

/**
 * Recognition gate: any `.md` file in this bundle IS a workflow (this
 * adapter's entire domain is workflows), UNLESS its frontmatter declares a
 * DIFFERENT non-empty
 * `type:` (an explicit opt-out, e.g. a README-shaped doc that wants to be
 * something else). No content sniffing.
 */
function isWorkflowFile(raw: string): boolean {
  const data = parseFrontmatter(raw).data;
  const type = data.type;
  return type === undefined || type === "workflow";
}

function recognize(c: Bundle, file: FileContext): IndexDocument | null {
  if (!WORKFLOW_EXTS.has(file.ext)) return null;
  if (isReservedDocFile(file.fileName)) return null;
  const raw = file.content();
  if (file.ext === ".md" && !isWorkflowFile(raw)) return null;

  const conceptId = conceptIdOf(file.relPath);
  const name = conceptId.split("/").pop() ?? conceptId;
  const parsed = parseFrontmatter(raw);
  const description = file.ext === ".md" ? nonEmptyString(parsed.data.description) : undefined;
  const body = file.ext === ".md" ? parsed.content : raw;
  const tags = file.ext === ".md" ? readTags(parsed.data.tags) : undefined;

  const doc: IndexDocument = {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "akm-workflow",
    type: "workflow",
    name,
    content: body,
  };
  if (description !== undefined) doc.description = description;
  if (tags !== undefined) doc.tags = tags;
  return doc;
}

async function validate(c: Bundle, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const { check, rulesFor } = createBaseChecker(c.root, ctx);
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const ext = path.extname(change.path).toLowerCase();
    if (!WORKFLOW_EXTS.has(ext) || isReservedDocFile(path.basename(change.path))) continue;

    const relPath = toPosix(change.path);
    if (!isWorkflowFile(raw)) continue;
    const parsed = parseForValidate(raw);
    diagnostics.push(...check(relPath, parsed));
    diagnostics.push(
      ...perTypeDiagnostics(
        {
          type: "workflow",
          relPath,
          raw,
          data: parsed.data,
          frontmatter: parsed.frontmatter,
          body: parsed.content,
          ext,
          rules: rulesFor(relPath),
          derivedSiblingExists: false,
        },
        relPath,
      ),
    );
  }
  return diagnostics;
}

/**
 * True when a top-level file in `root` is workflow-shaped (used by
 * looksLikeRoot). Unlike `isWorkflowFile` (which admits an absent `type:` —
 * the lenient default ONCE a source is already known to be this bundle),
 * this requires an EXPLICIT `type: workflow` — the install-time probe is
 * choosing WHICH adapter owns an unconfigured root among several candidates,
 * and an incidental `.md` with no frontmatter type at all
 * (common in an OKF or llm-wiki bundle) must not misclassify that root as
 * akm-workflow's.
 */
function hasTopLevelWorkflowFile(root: string, entries: fs.Dirent[]): boolean {
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!WORKFLOW_EXTS.has(ext) || isReservedDocFile(entry.name)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, entry.name), "utf8");
    } catch {
      continue;
    }
    if (ext === ".md" && parseFrontmatter(raw).data.type === "workflow") return true;
  }
  return false;
}

export class AkmWorkflowAdapter extends AkmFormatAdapterBase {
  readonly id = "akm-workflow";
  readonly version = "0.9.2";
  override readonly writes = ["workflow"];
  override readonly extensions = [".md"];

  protected recognizeFile(b: Bundle, file: FileContext): IndexDocument | null {
    return recognize(b, file);
  }

  validate(b: Bundle, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
    return validate(b, changes, ctx);
  }

  /** A standalone workflow bundle keeps its workflows at its root, one Markdown file each. */
  protected override placeFile(b: Bundle, { name }: Pick<NewAsset, "type" | "name">): string {
    return path.join(b.root, `${name}.md`);
  }

  readCandidates(c: Bundle, conceptId: string): AdapterReadCandidate[] {
    const posix = toPosix(conceptId);
    const canonical = posix.replace(/\.md$/i, "");
    return /\.md$/i.test(posix)
      ? [{ path: path.join(c.root, posix), conceptId: canonical }]
      : [{ path: path.join(c.root, `${posix}.md`), conceptId: canonical }];
  }

  /** Workflows live anywhere under the bundle root. */
  override directoryList(): string[] {
    return ["."];
  }

  /**
   * Install-time probe (§1.2): a root holding an explicitly typed Markdown
   * workflow at top level.
   */
  looksLikeRoot(root: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    return hasTopLevelWorkflowFile(root, entries);
  }
}

export const akmWorkflowAdapter = new AkmWorkflowAdapter();
