// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `agent-skills` adapter — akm 0.9.0 format-family work item (#46).
 *
 * Recognizes a COLLECTION of standalone SKILL.md packages (like
 * github.com/anthropics/skills): each `<name>/SKILL.md` is one `skill` item
 * whose conceptId is the package DIRECTORY (`<name>`); bundled resources under
 * the package (`<name>/reference/FORMS.md`) are part of the item, not standalone
 * concepts (item-scoped incrementality, spec §4). The SKILL.md codec is shared
 * with claude/opencode as functions (spec §8); this adapter differs in that the
 * package dir sits directly under the component root (no `skills/` prefix) and
 * that `validate` enforces the FULL Agent Skills contract (spec §4.5).
 *
 * RECOGNITION ≠ VALIDATION: an invalid skill (bad name charset, over-long
 * description) is still RECOGNIZED as `type: skill` (the raw invalid `name` is
 * projected so it is inspectable downstream); the violations surface only in
 * `validate` (spec §4.5). This mirrors how `okf` recognizes content and defers
 * leniency to validate.
 *
 * ── validate (spec §4.5, APPROVED codes — maintainer resolution 2026-07) ──
 *
 *   - `skill-name-invalid` — name must be NFKC 1-64 chars matching
 *     `^[a-z0-9]+(-[a-z0-9]+)*$`, carry no reserved word, and equal the parent
 *     dir name.
 *   - `skill-description-too-long` — description must be 1-1024 chars.
 *   - `missing-skill-md` — a package dir with no SKILL.md (edge case; git cannot
 *     commit an empty dir, so it is covered by a directory-level check, not a
 *     fixture).
 *
 * Only `missing-skill-md` is coded elsewhere today; the two field codes are
 * APPROVED-BUT-NOT-YET-CODED and are implemented here. Base checks are NOT run:
 * a SKILL.md carries no `updated` field, so `missing-updated` would fire on
 * every conformant skill and contradict the lint golden.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/agent-skills/` + goldens
 * `tests/fixtures/format-family-goldens/agent-skills/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent, nonEmptyString, readTags } from "./shared";

/** A skills collection is a single-component bundle; its one component is `main`. */
const COMPONENT_ID = "main";
/** The skill manifest basename (the item marker). */
const SKILL_MANIFEST = "SKILL.md";
/** Agent Skills hard limits (spec §4.5). */
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
/** Agent Skills reserved words a name must not contain (real-world source). */
const RESERVED_NAME_WORDS = ["anthropic", "claude"];
/** name charset/shape rule (spec §4.5). */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Upper bound on the bounded `content` FTS field (mirrors okf-adapter). */
const MAX_CONTENT_CHARS = 100_000;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** conceptId + package-dir name for a `<name>/SKILL.md` file, or null when the file is not a skill manifest. */
function skillPackage(relPath: string): { conceptId: string; dirName: string } | null {
  const posix = toPosix(relPath);
  const segs = posix.split("/").filter((s) => s.length > 0);
  // The item marker is a SKILL.md inside a package directory (`<name>/SKILL.md`,
  // possibly nested `<a>/<b>/SKILL.md`); a bare root SKILL.md is not a package.
  if (segs.length < 2 || segs[segs.length - 1] !== SKILL_MANIFEST) return null;
  const conceptId = segs.slice(0, segs.length - 1).join("/");
  const dirName = segs[segs.length - 2];
  return { conceptId, dirName };
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  const pkg = skillPackage(file.relPath);
  if (pkg === null) return null;

  const raw = file.content();
  const parsed = parseFrontmatter(raw);
  const data = parsed.data;
  const body = parsed.content;

  // name is projected RAW so an invalid name is inspectable; fall back to the dir.
  const name = nonEmptyString(data.name) ?? pkg.dirName;
  const description = nonEmptyString(data.description);
  const tags = readTags(data.tags);

  const doc: IndexDocument = {
    ref: `${c.id}//${pkg.conceptId}`,
    bundle: c.id,
    component: COMPONENT_ID,
    conceptId: pkg.conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "agent-skills",
    type: "skill",
    name,
    content: body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body,
  };
  if (description !== undefined) doc.description = description;
  if (tags !== undefined) doc.tags = tags;
  return doc;
}

/** The Agent Skills §4.5 hard-rule checks for one SKILL.md (name + description). */
function skillFieldDiagnostics(relPath: string, dirName: string, data: Record<string, unknown>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const name = typeof data.name === "string" ? data.name.normalize("NFKC") : "";
  const lower = name.toLowerCase();
  const reserved = RESERVED_NAME_WORDS.find((w) => lower.includes(w));
  const nameInvalid =
    name.length < 1 || name.length > NAME_MAX || !NAME_RE.test(name) || reserved !== undefined || name !== dirName;
  if (nameInvalid) {
    diagnostics.push({
      file: relPath,
      issue: "skill-name-invalid",
      detail:
        `skill name '${name}' must match ^[a-z0-9]+(-[a-z0-9]+)*$ (NFKC, 1-${NAME_MAX} chars, ` +
        `no reserved word, == parent dir name '${dirName}') — Agent Skills hard rule (spec §4.5).`,
      fixed: false,
    });
  }

  const description = typeof data.description === "string" ? data.description : "";
  if (description.length > DESCRIPTION_MAX) {
    diagnostics.push({
      file: relPath,
      issue: "skill-description-too-long",
      detail: `skill description is ${description.length} characters; the Agent Skills hard limit is 1-${DESCRIPTION_MAX} (spec §4.5).`,
      fixed: false,
    });
  }
  return diagnostics;
}

async function validate(_c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const seenDirs = new Set<string>();
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;

    const pkg = skillPackage(change.path);
    if (pkg === null) continue;
    if (seenDirs.has(pkg.conceptId)) continue;
    seenDirs.add(pkg.conceptId);

    // missing-skill-md is unreachable here (the change IS a SKILL.md); the empty-dir
    // case is served by {@link directorySkillDiagnostics} for callers that scan dirs.
    diagnostics.push(...skillFieldDiagnostics(toPosix(change.path), pkg.dirName, parseFrontmatter(raw).data));
  }
  return diagnostics;
}

export const agentSkillsAdapter: BundleAdapter = {
  id: "agent-skills",
  version: "0.9.0",
  extensions: [".md"],

  recognize,
  validate,

  /** A skill places to `<name>/SKILL.md`; the conceptId IS the package directory (spec §4.5). */
  placeNew(c: BundleComponent, conceptId: string): string {
    return path.join(c.root, conceptId, SKILL_MANIFEST);
  },

  /** Install-time probe (§1.2): a root that directly contains one or more `<name>/SKILL.md` skill packages. */
  looksLikeRoot(root: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => {
      if (!entry.isDirectory()) return false;
      try {
        return fs.existsSync(path.join(root, entry.name, SKILL_MANIFEST));
      } catch {
        return false;
      }
    });
  },
};
