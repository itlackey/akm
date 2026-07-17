// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `task` `BundleAdapter` — akm 0.9.0 chunk-2, WI-2.2 (chunk-2
 * anchors.md §A.2 row 5, §B rows "task").
 *
 * ── recognize() — ports the `tasks` dir-hint rule (matchers.ts:90-97) ──
 *
 * Under D2-8 this component's root is `<stash>/tasks` itself, so the
 * dir-hint's `ext === ".yml"` test collapses to a pure extension check —
 * every `.yml` file under this adapter's mount root recognizes (same
 * positional pattern D2-8 established for wiki; `TYPED_DIR_DOC_FILES`'s
 * README exclusion only ever matches `"readme.md"`, never `.yml`, so no
 * analog is needed here).
 *
 * Task files are PLAIN YAML (`<stash>/tasks/<id>.yml`, no `---` frontmatter
 * fence — the file header note on `applyTaskMetadata`, output/renderers.ts
 * :754-763, is explicit about this), so this adapter parses with the
 * generic `yaml` package (mirroring `applyTaskMetadata`'s own `parseYaml`
 * call) rather than `parseFrontmatter` (which is frontmatter-fence-shaped
 * and would silently no-op on a fenceless document).
 *
 * ── Folded metadata contributor: `task-yaml-metadata` → `applyTaskMetadata`
 *    (output/renderers.ts:764-780) — the refined-D2-7 case ──
 *
 * Per the WI-2.2 brief's explicit instruction, this contributor IS folded
 * despite the recognition golden pinning only `{type, specificity,
 * renderer}` for the task fixture (no contributor output) — unlike
 * workflow's deferred contributors (see `workflow-adapter.ts`'s header),
 * `task-yaml-metadata`'s output maps directly onto EXISTING carriable
 * `IndexDocument` fields (`tags`, `searchHints`) with no cycle risk and no
 * disallowed side effect, so folding it is free enrichment even though the
 * golden itself is silent on it (parity with the golden's pinned fields is
 * unaffected either way — this only ADDS fields the golden doesn't assert
 * against).
 *
 * Ported verbatim from `applyTaskMetadata`: `tags` unconditionally gains
 * `"task"`/`"scheduled"` (even for a YAML-parse failure, matching the
 * original's "apply tags before the parse" ordering); `searchHints` gains
 * `schedule:<value>` / `workflow:<value>` / `prompt:<value>` for each
 * non-empty string field present. NOTE: the WI-2.2 brief's own prose
 * paraphrases this contributor as "name/description from the parsed yaml" —
 * re-reading `applyTaskMetadata` at its cited line range shows it does NOT
 * set `entry.description` at all (only `tags`+`searchHints`); this adapter
 * follows the ACTUAL contributor code, not the paraphrase, and that
 * discrepancy is flagged in the WI-2.2 report.
 *
 * ── placeNew() — ports the task `AssetSpec` (asset-spec.ts:169-186) ──
 * `.yml`, strips/adds the extension exactly as the legacy spec does.
 *
 * ── validate() — ports `TaskLinter` (lint/task-linter.ts:22-60) ──
 * Base checks (built from the SAME `{data, content: raw, frontmatter: null}`
 * shape `buildLintContext` constructs for `tasks` in the goldens-lint-output
 * test harness and in `lint/index.ts`'s real per-file loop, so
 * `runBaseValidateChecks`'s frontmatter-shaped checks — unquoted-colon,
 * missing-updated — correctly no-op on plain YAML) plus `invalid-task-yaml`:
 * `schedule` (non-empty string) + `enabled` (boolean) + ≥1 of
 * `prompt`/`workflow`/`command`. Mirrors `TaskLinter`'s own "skip files that
 * failed to parse" short-circuit (`ctx.data` empty → base checks still run,
 * field checks skipped).
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { FileContext } from "../../../indexer/walk/file-context";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent, nonEmptyString, runBaseValidateChecks } from "./shared";

function isTaskFile(file: Pick<FileContext, "ext">): boolean {
  return file.ext === ".yml";
}

/** Port of the task `AssetSpec.toCanonicalName` (asset-spec.ts:176-179). */
function toTaskConceptId(relPath: string): string {
  return relPath.endsWith(".yml") ? relPath.slice(0, -4) : relPath;
}

/** Best-effort plain-YAML parse to a plain object, mirroring `applyTaskMetadata`'s / `TaskLinter`'s own try/catch-to-`{}` pattern. */
function parseTaskYaml(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Non-fatal: malformed YAML — tags still apply (applyTaskMetadata's own
    // ordering), field checks in validate() are skipped (TaskLinter's own
    // "ctx.data empty" short-circuit).
  }
  return {};
}

export const taskAdapter: BundleAdapter = {
  id: "task",
  version: "0.9.0",
  extensions: [".yml"],

  recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
    if (!isTaskFile(file)) return null;
    const conceptId = toTaskConceptId(file.relPath);
    const bundle = c.id;
    const content = file.content();
    const data = parseTaskYaml(content);

    // Port of applyTaskMetadata (output/renderers.ts:764-780).
    const tags = new Set<string>(["task", "scheduled"]);
    const searchHints = new Set<string>();
    const schedule = nonEmptyString(data.schedule);
    if (schedule) searchHints.add(`schedule:${schedule}`);
    const workflow = nonEmptyString(data.workflow);
    if (workflow) searchHints.add(`workflow:${workflow}`);
    const prompt = nonEmptyString(data.prompt);
    if (prompt) searchHints.add(`prompt:${prompt}`);

    return {
      ref: `${bundle}//${conceptId}`,
      bundle,
      component: c.id,
      conceptId,
      path: file.absPath,
      hash: hashContent(content),
      adapterId: "task",
      type: "task",
      name: conceptId,
      tags: Array.from(tags),
      searchHints: searchHints.size > 0 ? Array.from(searchHints) : undefined,
      content,
    };
  },

  async validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    for (const change of changes) {
      if (change.op === "delete") continue;
      const raw = change.after ?? (await ctx.readFile(change.path));
      if (typeof raw !== "string") continue;
      const data = parseTaskYaml(raw);

      diagnostics.push(
        ...(await runBaseValidateChecks(change.path, { data, content: raw, frontmatter: null }, c.root, ctx)),
      );

      // TaskLinter: "Skip files that failed to parse — data will be empty."
      if (Object.keys(data).length === 0) continue;

      const missing: string[] = [];
      if (!("schedule" in data) || typeof data.schedule !== "string" || data.schedule.trim() === "") {
        missing.push("schedule");
      }
      if (!("enabled" in data) || typeof data.enabled !== "boolean") {
        missing.push("enabled (must be a boolean)");
      }
      const hasTarget = "prompt" in data || "workflow" in data || "command" in data;
      if (!hasTarget) missing.push("prompt, workflow, or command");

      if (missing.length > 0) {
        diagnostics.push({
          file: change.path,
          issue: "invalid-task-yaml",
          detail: `missing required fields: ${missing.join(", ")}`,
          fixed: false,
        });
      }
    }
    return diagnostics;
  },

  placeNew(c: BundleComponent, conceptId: string): string {
    const withExt = conceptId.endsWith(".yml") ? conceptId : `${conceptId}.yml`;
    return path.join(c.root, withExt);
  },

  directoryList(): string[] {
    return ["tasks"];
  },

  looksLikeRoot(root: string): boolean {
    return fs.existsSync(path.join(root, "tasks"));
  },
};
