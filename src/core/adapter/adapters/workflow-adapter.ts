// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `workflow` `BundleAdapter` — akm 0.9.0 chunk-2, WI-2.2 (chunk-2
 * anchors.md §A.2 row 4, §B rows "workflow", §C.3 "workflow's two forms").
 *
 * ONE adapter, TWO on-disk forms, TWO recognize paths, TWO renderers, ONE
 * linter (anchors §C.3):
 *
 *   - Form A — classic linear markdown (`.md`), parsed by `parseWorkflow`
 *     (`workflows/parser.ts`), rendered by `workflow-md`.
 *   - Form B — YAML workflow *program* (`.yaml`/`.yml`, redesign addendum
 *     R1), parsed by `parseWorkflowProgram` (`workflows/program/parser.ts`),
 *     rendered by `workflow-program-yaml`.
 *
 * ── recognize() — both forms, D2-8 root-relative translation ──
 *
 * Under D2-8 this component's root is `<stash>/workflows` itself, so a
 * recognized file's `relPath` never contains a `"workflows"` segment to look
 * for (the wiki adapter's header documents the identical translation).
 *
 * Form A (`.md`): PURE POSITIONAL, matching the legacy `workflows` dir-hint
 * rule (`matchDirectoryHint`'s `DIR_TYPE_MAP` "workflows" entry,
 * matchers.ts:62-66, `ext === ".md"` ONLY — no body check) and the D2-8
 * precedent every other dir-scoped adapter follows (wiki/task/script). The
 * recognition is: `ext === ".md"` AND NOT `isTypedDirDocFile` (README
 * exclusion). It DOES NOT gate on `looksLikeWorkflow`.
 *
 * WHY positional, not content-gated (a correctness point, reviewed by Opus
 * against matchers.ts at HEAD): in the LEGACY whole-stash walk, `runMatchers`
 * arbitrated ACROSS types by specificity, so `classifyBySmartMd`'s
 * `looksLikeWorkflow` body probe (specificity 19) mattered as a way to claim
 * workflow-shaped `.md` files sitting OUTSIDE `workflows/` and to win ties.
 * But the `workflows` dir-hint alone (specificity 10/15, pure `ext === ".md"`)
 * ALREADY classifies EVERY non-README `.md` under `workflows/` as type
 * `workflow` — a plain, non-workflow-shaped `.md` in `workflows/` is type
 * `workflow` in the legacy system via the dir-hint, NOT unrecognized.
 * Gating recognize() on `looksLikeWorkflow` would therefore UNDER-recognize
 * relative to legacy (silently dropping such files), and would make workflow
 * the lone content-gated exception among positional dir-scoped adapters. Under
 * D2-8's mount-based routing the component root already scopes this adapter to
 * `workflows/` (no per-file cross-type competition — that arbitration is
 * REPLACED by mounting), so the dir-hint floor is exactly the faithful,
 * consistent behavior. `README.md` is excluded the same way
 * `isTypedDirDocFile` excludes it upstream (a local copy — the matchers.ts
 * helper is private, not exported).
 *
 * Form B (`.yaml`/`.yml`): `classifyByWorkflowProgram` (matchers.ts:245-252)
 * checks the dir-hint FIRST (`parentDir === "workflows"` specificity 15, or
 * an ancestor named `workflows` specificity 10 — NEITHER reads file content)
 * and only falls back to the `looksLikeWorkflowProgram` content probe
 * (specificity 19) for a file positioned OUTSIDE `workflows/`. Under D2-8's
 * mount, every file this adapter ever sees is by definition "under
 * `workflows/`" (that IS the component root), so the dir-hint branches
 * ALWAYS fire and the content-probe fallback is dead code here — this
 * adapter therefore does NOT port `looksLikeWorkflowProgram` at all (unlike
 * Form A, no conjunction is needed: the golden's own captured specificity
 * for the program fixture, 15, confirms the dir-hint path — not the
 * content-probe path — is what won). Recognition collapses to the
 * extension check alone, matching wiki's/D2-8's pure-positional pattern.
 *
 * ── THE RENDERER WRINKLE (flagged prominently, see `../types.ts`'s
 *    `IndexDocument.rendererName` doc comment for the full mechanism) ──
 *
 * `TYPE_PRESENTATION.rendererName` (`core/type-presentation.ts`, WI-2.1) is
 * per-TYPE — one name per `KnownType` — but `workflow` needs TWO renderer
 * names, one per FORM. `TYPE_PRESENTATION.workflow.rendererName` is set to
 * `"workflow-md"` (this WI, mirroring `asset-spec.ts`'s `workflow` entry,
 * which carries the SAME type-level default and lets `workflowProgramMatcher`
 * override it per-file). This adapter's `recognize()` sets the NEW additive
 * `IndexDocument.rendererName` field directly on each returned document
 * (`"workflow-md"` for Form A, `WORKFLOW_PROGRAM_RENDERER_NAME` for Form B)
 * — the `BundleAdapter`-shaped translation of the exact same per-file-
 * override mechanism `workflowProgramMatcher` already uses in the legacy
 * system (it names its renderer directly on its own `MatchResult` rather
 * than going through the type-keyed `rendererNameFor` lookup). This is the
 * SMALLEST mechanism that preserves both renderer names: one optional,
 * additive field on the artifact that is already per-file granularity,
 * consulted by nothing that predates this WI. `workflow-program-yaml`'s
 * renderer identity is NEVER silently dropped — see `../types.ts` and the
 * parity test's explicit renderer-identity assertions.
 *
 * ── placeNew() — ports `workflowSpec.toAssetPath` (asset-spec.ts:37-61) ──
 *
 * The ONE placement spec that legitimately touches disk: explicit extension
 * wins; else probe `WORKFLOW_EXTENSIONS` candidates via `fs.existsSync` in
 * priority order (`.md` first); else fall back to `.md`. Ported verbatim,
 * `typeRoot` = `c.root`.
 *
 * ── validate() — ports `WorkflowLinter` (lint/workflow-linter.ts:19-87),
 *    Form A (`.md`) ONLY ──
 *
 * Base checks + `placeholder-stub` (emitted as a read-only `Diagnostic`,
 * `fixed: false` — the legacy linter DELETES the file on `--fix`, but
 * `validate()` MUST NOT write the filesystem, `bundle-adapter.ts:96-97` /
 * D2-3) + `invalid-workflow-structure` via `parseWorkflow`.
 *
 * Form B (`.yaml`/`.yml`) changes are DELIBERATELY SKIPPED — no diagnostics
 * are produced for them. This reproduces today's actual production
 * reachability (anchors §C.3 / the lint golden's own module doc: "YAML
 * programs are correctness-checked via `parseWorkflowProgram`, NOT a lint
 * path — `WorkflowLinter` never sees `.yaml` files in production because
 * `collectMarkdownFiles` filters `.md` only, and calling
 * `WorkflowLinter.lint()` on YAML bytes would misapply a markdown-shaped
 * linter to non-markdown content"). The lint golden's `perType.
 * workflowProgramYaml` entry is NOT `Diagnostic`/`LintIssue`-shaped at all
 * (`{correctnessCheck: "parseWorkflowProgram", result}` instead of
 * `{issues}`) — there is no `Diagnostic[]` shape to reproduce for this form,
 * and inventing one (e.g. running base checks against YAML bytes) would be
 * NEW validation the golden does not pin (D2-3: "don't add validation where
 * none exists today"). FLAGGED for maintainer per anchors §E.2's explicit
 * ambiguity ("does `validate()` being newly REQUIRED silently fix this
 * reachability gap, or is that a behavior change needing its own sign-off"):
 * this WI resolves it by NOT fixing the gap — Form B stays exactly as
 * unreached by structural lint as it is today.
 *
 * ── Metadata contributors (§B.2 rows 10/11 — NOT in the "9") ──
 *
 * `workflow-document-metadata` / `workflow-program-metadata`
 * (workflows/renderer.ts:129-153,155-183) are DEFERRED, not folded, applying
 * the refined-D2-7 test from the WI-2.1 ledger ("fold ONLY contributors
 * whose output has a carriable `IndexDocument` field AND that the
 * recognition golden actually pins"): the recognition golden's workflow
 * entries (`recognition/all-types.json`) pin only `{type, specificity,
 * renderer}` for both fixture files — no contributor output. Additionally,
 * `workflow-document-metadata` calls `cacheWorkflowDocument` (a
 * `workflow_documents` DB cache write — `workflows/runtime/document-cache.ts`,
 * an EXISTING cycle-ratchet-baseline participant), a side effect entirely
 * inappropriate for a pure, read-only `recognize()`; and both contributors'
 * richest output (`entry.parameters`) has no `IndexDocument` field to land
 * in at all. Deferred for three independent reasons, not oversight: no
 * golden pin, a disallowed side effect, and no carrying field.
 *
 * The baseline `description`/`tags`/`updated` population below (matching
 * every WI-2.1 adapter's pattern) is NOT a "contributor fold" — it is the
 * same generic OKF-field population skill/wiki/script already do
 * unconditionally, independent of D2-7.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseWorkflow } from "../../../workflows/parser";
import { WORKFLOW_PROGRAM_RENDERER_NAME } from "../../../workflows/program/project";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import { WORKFLOW_EXTENSIONS } from "../../recognition-util";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent, nonEmptyString, readTags, runBaseValidateChecks } from "./shared";

// Copied from matchers.ts's private TYPED_DIR_DOC_FILES/isTypedDirDocFile
// (not exported — matchers.ts:125-129) — same cycle-avoidance/no-private-
// import rationale as shared.ts's other ports. Only "readme.md" is a member
// today, so this is a no-op for the .yaml/.yml form (kept for fidelity to
// the ported predicate, not because it ever fires there).
const TYPED_DIR_DOC_FILES = new Set(["readme.md"]);
function isTypedDirDocFile(fileName: string): boolean {
  return TYPED_DIR_DOC_FILES.has(fileName.toLowerCase());
}

// Copied from matchers.ts's private WORKFLOW_PROGRAM_EXTENSIONS (:229, not
// exported).
const WORKFLOW_PROGRAM_EXTENSIONS = new Set([".yaml", ".yml"]);

const PLACEHOLDER_STRINGS = ["Describe what this workflow accomplishes", "Example Workflow"];

function isWorkflowMdFile(file: Pick<FileContext, "ext" | "fileName">): boolean {
  // Pure positional dir-hint (matchers.ts:62-66, ext === ".md" only), README
  // excluded — see the file header for why this is NOT gated on
  // looksLikeWorkflow.
  if (file.ext !== ".md") return false;
  if (isTypedDirDocFile(file.fileName)) return false;
  return true;
}

function isWorkflowProgramFile(file: Pick<FileContext, "ext" | "fileName">): boolean {
  if (!WORKFLOW_PROGRAM_EXTENSIONS.has(file.ext)) return false;
  if (isTypedDirDocFile(file.fileName)) return false;
  return true;
}

/** Port of `workflowSpec.toCanonicalName` (asset-spec.ts:40-46). */
function toWorkflowConceptId(relPath: string): string {
  const lower = relPath.toLowerCase();
  for (const ext of WORKFLOW_EXTENSIONS) {
    if (lower.endsWith(ext)) return relPath.slice(0, -ext.length);
  }
  return relPath;
}

/**
 * Best-effort top-level `description:` read for a YAML workflow program —
 * the generic OKF-description population every adapter does for its native
 * frontmatter/data shape (NOT the deferred `workflow-program-metadata`
 * contributor, which additionally builds searchHints/parameters and is out
 * of scope per the file header).
 */
function readYamlDescription(raw: string): string | undefined {
  try {
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return nonEmptyString((parsed as Record<string, unknown>).description);
    }
  } catch {
    // Non-fatal: malformed YAML still recognizes as type workflow;
    // structural errors surface via validate(), not recognize().
  }
  return undefined;
}

function checkPlaceholderStub(body: string): string | null {
  for (const placeholder of PLACEHOLDER_STRINGS) {
    if (body.includes(placeholder)) return placeholder;
  }
  return null;
}

export const workflowAdapter: BundleAdapter = {
  id: "workflow",
  version: "0.9.0",
  extensions: [".md", ".yaml", ".yml"],

  recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
    const isMdForm = isWorkflowMdFile(file);
    const isProgramForm = !isMdForm && isWorkflowProgramFile(file);
    if (!isMdForm && !isProgramForm) return null;

    const conceptId = toWorkflowConceptId(file.relPath);
    const bundle = c.id;
    const content = file.content();

    if (isMdForm) {
      const parsed = parseFrontmatter(content);
      return {
        ref: `${bundle}//${conceptId}`,
        bundle,
        component: c.id,
        conceptId,
        path: file.absPath,
        hash: hashContent(content),
        adapterId: "workflow",
        type: "workflow",
        name: conceptId,
        description: nonEmptyString(parsed.data.description),
        tags: readTags(parsed.data.tags),
        updated: nonEmptyString(parsed.data.updated),
        content: parsed.content,
        rendererName: "workflow-md",
      };
    }

    // Program form (.yaml/.yml) — plain YAML, no frontmatter fence.
    return {
      ref: `${bundle}//${conceptId}`,
      bundle,
      component: c.id,
      conceptId,
      path: file.absPath,
      hash: hashContent(content),
      adapterId: "workflow",
      type: "workflow",
      name: conceptId,
      description: readYamlDescription(content),
      content,
      rendererName: WORKFLOW_PROGRAM_RENDERER_NAME,
    };
  },

  async validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    for (const change of changes) {
      if (change.op === "delete") continue;
      // Form B (.yaml/.yml): deliberately no diagnostics — see file header
      // ("validate() — Form A ONLY").
      if (path.posix.extname(change.path).toLowerCase() !== ".md") continue;
      const raw = change.after ?? (await ctx.readFile(change.path));
      if (typeof raw !== "string") continue;
      const parsed = parseFrontmatter(raw);
      diagnostics.push(...(await runBaseValidateChecks(change.path, parsed, c.root, ctx)));

      const placeholderMatch = checkPlaceholderStub(parsed.content);
      if (placeholderMatch) {
        diagnostics.push({
          file: change.path,
          issue: "placeholder-stub",
          detail: `placeholder text: "${placeholderMatch}"`,
          fixed: false,
        });
      }

      const result = parseWorkflow(raw, { path: change.path });
      if (!result.ok) {
        for (const err of result.errors) {
          diagnostics.push({
            file: change.path,
            issue: "invalid-workflow-structure",
            detail: err.message,
            fixed: false,
          });
        }
      }
    }
    return diagnostics;
  },

  placeNew(c: BundleComponent, conceptId: string): string {
    // Port of workflowSpec.toAssetPath (asset-spec.ts:47-60) — the one
    // placement spec that legitimately touches disk.
    const lower = conceptId.toLowerCase();
    for (const ext of WORKFLOW_EXTENSIONS) {
      if (lower.endsWith(ext)) return path.join(c.root, conceptId);
    }
    for (const ext of WORKFLOW_EXTENSIONS) {
      const candidate = path.join(c.root, `${conceptId}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(c.root, `${conceptId}.md`);
  },

  directoryList(): string[] {
    return ["workflows"];
  },

  looksLikeRoot(root: string): boolean {
    return fs.existsSync(path.join(root, "workflows"));
  },
};
