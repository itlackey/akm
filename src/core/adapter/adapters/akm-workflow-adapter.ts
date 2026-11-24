// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-workflow` adapter.
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
import { parseFrontmatter } from "../../asset/frontmatter";
import { toPosix } from "../../common";
import type { NewAsset } from "../bundle-adapter";
import type { FileContext } from "../directory/file-context";
import type { FileChange } from "../file-change";
import { type Bundle, type IndexMetadata, rootOf } from "../types";
import type { FileDiagnostic, FileValidateContext } from "../validate-context";
import { AkmFormatAdapterBase } from "./akm-format";
import { perTypeDiagnostics } from "./akm-lint";
import { createBaseChecker, hashContent, nonEmptyString, parseForValidate, readTags } from "./shared";

/** The authoritative workflow source format. */
const WORKFLOW_EXTS = new Set([".md"]);

/** The workflow a path holds: every Markdown file but a README is one, wherever it sits. Its concept id is the path without `.md`. */
function conceptIdOf(relPath: string): string | null {
  const posix = toPosix(relPath);
  if (!WORKFLOW_EXTS.has(path.posix.extname(posix).toLowerCase()) || isReservedDocFile(path.posix.basename(posix))) {
    return null;
  }
  return posix.replace(/\.md$/i, "");
}

/** `README.md` (case-insensitive) is documentation, never the typed asset — mirrors the akm matcher stack's D-R6 reserved-file exclusion (`TYPED_DIR_DOC_FILES`). */
function isReservedDocFile(fileName: string): boolean {
  return fileName.toLowerCase() === "readme.md";
}

/**
 * Any `.md` file in this bundle IS a workflow (this adapter's entire domain is workflows): its type is the path's,
 * whatever its frontmatter says. A frontmatter `type:` other than `workflow` is reported by `validate`.
 */
function describe(file: FileContext, conceptId: string): IndexMetadata {
  const raw = file.content();
  const name = conceptId.split("/").pop() ?? conceptId;
  const parsed = parseFrontmatter(raw);
  const description = nonEmptyString(parsed.data.description);
  const body = parsed.content;
  const tags = readTags(parsed.data.tags);

  const doc: IndexMetadata = {
    hash: hashContent(raw),
    type: "workflow",
    name,
    content: body,
  };
  if (description !== undefined) doc.description = description;
  if (tags !== undefined) doc.tags = tags;
  return doc;
}

async function validate(c: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
  const diagnostics: FileDiagnostic[] = [];
  const { check, rulesFor } = createBaseChecker(rootOf(c), ctx);
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const ext = path.extname(change.path).toLowerCase();
    if (conceptIdOf(change.path) === null) continue;

    const relPath = toPosix(change.path);
    const parsed = parseForValidate(raw);
    const declared = parsed.data.type;
    if (declared !== undefined && declared !== "workflow") {
      diagnostics.push({
        file: relPath,
        issue: "type-from-content",
        detail: `Its frontmatter says type "${String(declared)}", but every Markdown file of this bundle is a workflow: the type comes from the path. Move the file out of the bundle, or drop the \`type:\`.`,
        fixed: false,
      });
    }
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
 * looksLikeRoot). Once a root is known to be this bundle every `.md` is a
 * workflow; the probe requires an EXPLICIT `type: workflow` — it is
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
  readonly version = "0.10.0";
  override readonly writes = ["workflow"];
  override readonly extensions = [".md"];

  protected identify(relPath: string): string | null {
    return conceptIdOf(relPath);
  }

  protected describe(_b: Bundle, file: FileContext, conceptId: string): IndexMetadata {
    return describe(file, conceptId);
  }

  protected override typeOf(): string {
    return "workflow";
  }

  rendererFor(): string {
    return "workflow-md";
  }

  protected validateFiles(b: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
    return validate(b, changes, ctx);
  }

  /** A standalone workflow bundle keeps its workflows at its root, one Markdown file each. */
  protected override placeFile(b: Bundle, { name }: Pick<NewAsset, "type" | "name">): string {
    return path.join(rootOf(b), `${name}.md`);
  }

  /** At its root: nothing before a workflow's name. */
  override prefixOf(): string {
    return "";
  }

  protected spellings(conceptId: string): string[] {
    return [`${toPosix(conceptId).replace(/\.md$/i, "")}.md`];
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
