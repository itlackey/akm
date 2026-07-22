// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-workflow` adapter — akm 0.9.0 format-family work item (#46).
 *
 * A native akm workflow bundle (spec §6/§7). Both workflow forms derive
 * `type: workflow`:
 *   - MARKDOWN (`.md`, ≈ an OKF concept) — the classic linear workflow
 *     (`# Workflow:` / `## Step:` / `Step ID:` / `### Instructions`), detected
 *     by the shared `looksLikeWorkflow` probe so the matcher and parser cannot
 *     drift;
 *   - YAML PROGRAM (`.yaml`/`.yml`, an AKM extension) — `version` + `steps`,
 *     detected by `looksLikeWorkflowProgram`.
 * conceptId strips the recognized workflow extension (`.md`/`.yaml`/`.yml`). A
 * plain `.md` that is NOT workflow-shaped (a README, an OKF reserved listing/log
 * file) is abstained on — the content probe subsumes the D-R6 reserved-file
 * exclusion, so no reserved-basename literal is needed here.
 *
 * ── validate (spec §6 workflow row) ──
 *
 * Reuses the akm adapter's per-type workflow checks (shared base checks +
 * `placeholder-stub` + `invalid-workflow-structure`, markdown only — the YAML
 * program's correctness is `parseWorkflowProgram`'s own result, not a
 * markdown-lint path). Delegates to the SAME `perTypeValidateChecks` /
 * `runBaseValidateChecks` the `akm` adapter uses, so workflow validation has
 * one home.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/akm-workflow/` + goldens
 * `tests/fixtures/format-family-goldens/akm-workflow/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { FileContext } from "../../../indexer/walk/file-context";
import { looksLikeWorkflow } from "../../../workflows/parser";
import { looksLikeWorkflowProgram } from "../../../workflows/program/parser";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { perTypeValidateChecks } from "./akm-lint";
import { hashContent, nonEmptyString, type ParsedForValidate, readTags, runBaseValidateChecks } from "./shared";

/** A native workflow bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** Recognized workflow extensions (matcher parity with recognition-util WORKFLOW_EXTENSIONS). */
const WORKFLOW_EXTS = new Set([".md", ".yaml", ".yml"]);
/** Upper bound on the bounded `content` FTS field (mirrors okf-adapter). */
const MAX_CONTENT_CHARS = 100_000;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Strip a recognized workflow extension from a component-root-relative path → conceptId. */
function conceptIdOf(relPath: string): string {
  return toPosix(relPath).replace(/\.(md|ya?ml)$/i, "");
}

type WorkflowForm = "markdown" | "yaml-program";

/** Which workflow form (if any) `file` is — the recognition gate. */
function workflowForm(ext: string, raw: string): WorkflowForm | null {
  if (ext === ".md") return looksLikeWorkflow(parseFrontmatter(raw).content) ? "markdown" : null;
  if (ext === ".yaml" || ext === ".yml") return looksLikeWorkflowProgram(raw) ? "yaml-program" : null;
  return null;
}

/** The workflow's projected `description` — frontmatter for markdown, the program `description:` for YAML. */
function workflowDescription(form: WorkflowForm, raw: string): string | undefined {
  if (form === "markdown") return nonEmptyString(parseFrontmatter(raw).data.description);
  try {
    const doc = parseYaml(raw);
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      return nonEmptyString((doc as Record<string, unknown>).description);
    }
  } catch {
    // malformed YAML — no description
  }
  return undefined;
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  if (!WORKFLOW_EXTS.has(file.ext)) return null;
  const raw = file.content();
  const form = workflowForm(file.ext, raw);
  if (form === null) return null;

  const conceptId = conceptIdOf(file.relPath);
  const name = conceptId.split("/").pop() ?? conceptId;
  const description = workflowDescription(form, raw);
  const body = form === "markdown" ? parseFrontmatter(raw).content : raw;
  const tags = readTags(parseFrontmatter(raw).data.tags);

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
    content: body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body,
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
    if (!WORKFLOW_EXTS.has(ext) || workflowForm(ext, raw) === null) continue;

    const relPath = toPosix(change.path);
    // Markdown workflows parse via frontmatter; YAML programs are pure YAML (no frontmatter).
    let parsed: ParsedForValidate;
    if (ext === ".md") {
      const p = parseFrontmatter(raw);
      parsed = { data: p.data, content: p.content, frontmatter: p.frontmatter };
    } else {
      parsed = { data: {}, content: raw, frontmatter: null };
    }
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

/** True when a top-level file in `root` is workflow-shaped (used by looksLikeRoot). */
function hasTopLevelWorkflowFile(root: string, entries: fs.Dirent[]): boolean {
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!WORKFLOW_EXTS.has(ext)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, entry.name), "utf8");
    } catch {
      continue;
    }
    if (workflowForm(ext, raw) !== null) return true;
  }
  return false;
}

export const akmWorkflowAdapter: BundleAdapter = {
  id: "akm-workflow",
  version: "0.9.0",
  extensions: [".md", ".yaml", ".yml"],

  recognize,
  validate,

  /** Default markdown placement; an explicit `.yaml`/`.yml`/`.md` conceptId short-circuits to that extension. */
  placeNew(c: BundleComponent, conceptId: string): string {
    const posix = toPosix(conceptId);
    if (/\.(md|ya?ml)$/i.test(posix)) return path.join(c.root, posix);
    return path.join(c.root, `${posix}.md`);
  },

  /** Workflows live anywhere under the component root. */
  directoryList(): string[] {
    return ["."];
  },

  /**
   * Install-time probe (§1.2): a root holding a workflow file at top level — a
   * `.yaml`/`.yml` program (`version` + `steps`) or a workflow-shaped `.md`. The
   * content probe means an okf reserved listing, a wiki `schema.md`, or a README
   * never trips it, so the probe stays disjoint from the other adapters' roots
   * without any structural exclusion.
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
