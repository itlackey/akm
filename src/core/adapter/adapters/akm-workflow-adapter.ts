// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-workflow` adapter — akm 0.9.0 format-family work item (#46).
 *
 * A native akm workflow bundle. AKM Markdown and the strict local GitHub-shaped
 * `.yml` subset are peer source formats. Both compile through the source IR;
 * neither source is rewritten or projected onto the other.
 *
 * ── validate (spec §6 workflow row) ──
 *
 * Reuses the akm adapter's per-type workflow checks (shared base checks +
 * `placeholder-stub` + `invalid-workflow-structure`). Delegates to the SAME
 * `perTypeValidateChecks` / `runBaseValidateChecks` the `akm` adapter uses, so
 * workflow validation has one home.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/akm-workflow/` + goldens
 * `tests/fixtures/format-family-goldens/akm-workflow/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { looksLikeGithubWorkflowSource } from "../../../workflows/compile";
import { parseFrontmatter } from "../../asset/frontmatter";
import { toPosix } from "../../common";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { perTypeValidateChecks, workflowYamlSourceDiagnostics } from "./akm-lint";
import { hashContent, nonEmptyString, type ParsedForValidate, readTags, runBaseValidateChecks } from "./shared";

/** A native workflow bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** The two authoritative workflow source formats. `.yaml` is deliberately not accepted. */
const WORKFLOW_EXTS = new Set([".md", ".yml"]);

/** Strip the recognized workflow extension from a component-root-relative path → conceptId. */
function conceptIdOf(relPath: string): string {
  return toPosix(relPath).replace(/\.(?:md|yml)$/i, "");
}

/** `README.md` (case-insensitive) is documentation, never the typed asset — mirrors the akm matcher stack's D-R6 reserved-file exclusion (`TYPED_DIR_DOC_FILES`). */
function isReservedDocFile(fileName: string): boolean {
  return fileName.toLowerCase() === "readme.md";
}

/**
 * Recognition gate: any `.md` file in this bundle IS a workflow (this
 * adapter's entire domain is workflows — spec §2.5, "residence under
 * workflows/"), UNLESS its frontmatter declares a DIFFERENT non-empty
 * `type:` (an explicit opt-out, e.g. a README-shaped doc that wants to be
 * something else). No content sniffing.
 */
function isWorkflowFile(raw: string): boolean {
  const data = parseFrontmatter(raw).data;
  const type = data.type;
  return type === undefined || type === "workflow";
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
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
    component: COMPONENT_ID,
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

async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const ext = path.extname(change.path).toLowerCase();
    if (!WORKFLOW_EXTS.has(ext) || isReservedDocFile(path.basename(change.path))) continue;

    const relPath = toPosix(change.path);
    if (ext === ".yml") {
      diagnostics.push(...workflowYamlSourceDiagnostics(relPath, raw, relPath, c.root).errors);
      continue;
    }
    if (!isWorkflowFile(raw)) continue;
    const p = parseFrontmatter(raw);
    const parsed: ParsedForValidate = { data: p.data, content: p.content, frontmatter: p.frontmatter };
    diagnostics.push(...(await runBaseValidateChecks(relPath, parsed, c.root, ctx)));
    diagnostics.push(
      ...(await perTypeValidateChecks({
        type: "workflow",
        relPath,
        raw,
        data: parsed.data,
        frontmatter: parsed.frontmatter,
        body: parsed.content,
        ext,
        ctx,
      })),
    );
  }
  return diagnostics;
}

/**
 * True when a top-level file in `root` is workflow-shaped (used by
 * looksLikeRoot). Unlike `isWorkflowFile` (which admits an absent `type:` —
 * the lenient default ONCE a source is already known to be this bundle),
 * this requires an EXPLICIT `type: workflow` — the install-time probe is
 * choosing WHICH adapter owns an unconfigured root among several candidates
 * (spec §1.2), and an incidental `.md` with no frontmatter type at all
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
    if (ext === ".yml" && looksLikeGithubWorkflowSource(raw)) return true;
    if (ext === ".md" && parseFrontmatter(raw).data.type === "workflow") return true;
  }
  return false;
}

export const akmWorkflowAdapter: BundleAdapter = {
  id: "akm-workflow",
  version: "0.9.2",
  extensions: [".md", ".yml"],

  recognize,
  validate,

  readCandidates(c: BundleComponent, conceptId: string) {
    const posix = toPosix(conceptId);
    const canonical = posix.replace(/\.(?:md|yml)$/i, "");
    return /\.(?:md|yml)$/i.test(posix)
      ? [{ path: path.join(c.root, posix), conceptId: canonical }]
      : [
          { path: path.join(c.root, `${posix}.md`), conceptId: canonical },
          { path: path.join(c.root, `${posix}.yml`), conceptId: canonical },
        ];
  },

  /** Markdown remains the default; an explicit `.md`/`.yml` suffix is preserved. */
  placeNew(c: BundleComponent, conceptId: string): string {
    const posix = toPosix(conceptId);
    if (/\.(?:md|yml)$/i.test(posix)) return path.join(c.root, posix);
    return path.join(c.root, `${posix}.md`);
  },

  /** Workflows live anywhere under the component root. */
  directoryList(): string[] {
    return ["."];
  },

  /**
   * Install-time probe (§1.2): a root holding an explicitly typed Markdown
   * workflow or a complete GitHub-shaped YAML workflow at top level.
   */
  looksLikeRoot(root: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    return hasTopLevelWorkflowFile(root, entries);
  },
};
