// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `skill` `BundleAdapter` — akm 0.9.0 chunk-2, WI-2.1 (chunk-2 anchors.md
 * §A.2 row 1, §B rows "skill").
 *
 * Does NOT implement the §4.5 Agent Skills contract (name-format/description-
 * length/compatibility/metadata validation) — that is WI-2.5, isolated new
 * feature work per D2-5. This adapter ports ONLY today's recognition/
 * placement/lint behavior.
 *
 * ── recognize() — ports 3 matcher branches (matchers.ts, chunk-2 anchors §B.1) ──
 *   - `classifyByExtension` (matchers.ts:154-157): `fileName === "SKILL.md"`
 *     and NOT nested under a `wikis/` ancestor — the file's own highest-
 *     specificity (25) claim, and the only one that fires for this WI's
 *     fixture.
 *   - `classifyByParentDirHint`'s skill special-case (matchers.ts:177-178,
 *     specificity 15): immediate parent dir literally named `skills`, AND
 *     either `SKILL.md` OR any other `.md` file (so e.g. a bundled
 *     `skills/<name>/reference.md` also recognizes as type `skill`).
 *   - `matchDirectoryHint`'s skill special-case (matchers.ts:135-138,
 *     specificity 10), reached via `classifyByDirectory`'s ancestor walk:
 *     any ANCESTOR dir literally named `skills` (not just the immediate
 *     parent), still requiring `fileName === "SKILL.md"`.
 * The old model picked the highest-specificity match across ALL matchers
 * (cross-type arbitration via `runMatchers`); the new `BundleComponent`
 * model binds one adapter to one root ("no per-file competition",
 * `types.ts`'s `BundleComponent.id` doc comment), so this adapter's
 * `recognize` only needs to answer "is this MY type" — the three branches
 * are tried in the old specificity order (25 > 15 > 10) and the first match
 * wins, which is behaviorally equivalent for any file only skill's own
 * rules could ever claim.
 *
 * ── placeNew() — ports the ONE dir-entry `toAssetPath` (asset-spec.ts:84-93) ──
 *   `<componentRoot>/<conceptId>/SKILL.md` — the multi-file skill bundle form.
 *
 * ── validate() — ports SkillLinter (lint/skill-linter.ts:24-50) ──
 *   Base checks (`shared.ts#runBaseValidateChecks`) plus `missing-skill-md`,
 *   ported from `SkillLinter.lintDirectory` (skill-linter.ts:31-45): the
 *   original is a DIRECTORY-level check (`AssetLinter.lintDirectory`, called
 *   once per subdirectory before the per-file loop) with no analog on
 *   `BundleAdapter` (no directory-scoped validate hook exists). Ported here
 *   as a per-CHANGE check: for every changed file's containing directory
 *   (deduplicated so multiple changes in the same skill dir produce at most
 *   one `missing-skill-md` diagnostic, matching the original's once-per-
 *   directory cardinality), verify a sibling `SKILL.md` exists via
 *   `ctx.readFile` (read-only — no `fs` access, per `bundle-adapter.ts`'s
 *   "MUST NOT read the live filesystem" constraint on `validate`).
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent, nonEmptyString, readTags, runBaseValidateChecks } from "./shared";

function isSkillFile(file: Pick<FileContext, "fileName" | "ext" | "parentDir" | "ancestorDirs">): boolean {
  // classifyByExtension (matchers.ts:154-157), specificity 25.
  if (file.fileName === "SKILL.md" && !file.ancestorDirs.includes("wikis")) return true;
  // classifyByParentDirHint skill special-case (matchers.ts:177-178), specificity 15.
  if (file.parentDir === "skills" && (file.fileName === "SKILL.md" || file.ext === ".md")) return true;
  // matchDirectoryHint skill special-case (matchers.ts:135-138), specificity 10.
  if (file.ancestorDirs.includes("skills") && file.fileName === "SKILL.md") return true;
  return false;
}

async function checkMissingSkillMd(changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const checkedDirs = new Set<string>();
  for (const change of changes) {
    const dir = path.posix.dirname(change.path);
    if (dir === "." || checkedDirs.has(dir)) continue;
    checkedDirs.add(dir);
    const skillMdPath = `${dir}/SKILL.md`;
    const thisChangeIsSkillMd = change.path === skillMdPath && change.op !== "delete";
    const exists = thisChangeIsSkillMd || (await ctx.readFile(skillMdPath)) !== null;
    if (!exists) {
      diagnostics.push({ file: dir, issue: "missing-skill-md", detail: `no SKILL.md in ${dir}/`, fixed: false });
    }
  }
  return diagnostics;
}

export const skillAdapter: BundleAdapter = {
  id: "skill",
  version: "0.9.0",
  extensions: [".md"],

  recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
    if (!isSkillFile(file)) return null;
    // toCanonicalName (asset-spec.ts:87-91): the containing directory name;
    // a SKILL.md sitting directly at the component root (no subdirectory)
    // has no valid canonical name and is not recognized as a placeable item.
    const relDir = path.posix.dirname(file.relPath);
    if (relDir === ".") return null;
    const conceptId = relDir;
    const bundle = c.id;
    const content = file.content();
    const parsed = parseFrontmatter(content);
    return {
      ref: `${bundle}//${conceptId}`,
      bundle,
      component: c.id,
      conceptId,
      path: file.absPath,
      hash: hashContent(content),
      adapterId: "skill",
      type: "skill",
      name: conceptId,
      description: nonEmptyString(parsed.data.description),
      tags: readTags(parsed.data.tags),
      updated: nonEmptyString(parsed.data.updated),
      content: parsed.content,
    };
  },

  async validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    for (const change of changes) {
      if (change.op === "delete") continue;
      const raw = change.after ?? (await ctx.readFile(change.path));
      if (typeof raw !== "string") continue;
      const parsed = parseFrontmatter(raw);
      diagnostics.push(...(await runBaseValidateChecks(change.path, parsed, c.root, ctx)));
    }
    diagnostics.push(...(await checkMissingSkillMd(changes, ctx)));
    return diagnostics;
  },

  placeNew(c: BundleComponent, conceptId: string): string {
    return path.join(c.root, conceptId, "SKILL.md");
  },

  directoryList(): string[] {
    return ["skills"];
  },

  looksLikeRoot(root: string): boolean {
    return fs.existsSync(path.join(root, "skills"));
  },
};
