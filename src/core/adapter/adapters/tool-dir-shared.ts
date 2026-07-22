// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared recognition / placement / validation for the two AGENT TOOL-DIRECTORY
 * adapters — `claude` (`.claude`) and `opencode` (`.opencode`) — akm 0.9.0
 * format-family work item (#46). Both translate a foreign tool layout into the
 * open AKM `type` vocabulary (spec §6/§7): a root instruction file
 * (CLAUDE.md / AGENTS.md) → `instruction`, `commands/*.md` → `command`,
 * `agents/*.md` → `agent`, `skills/<name>/SKILL.md` → `skill` (item = the dir).
 * They differ only in three parameters carried on {@link ToolDirLayout}:
 *   - the instruction basename + its concept id,
 *   - the accepted subdir spellings (opencode accepts the SINGULAR
 *     `command/`/`agent/`/`skill/` aliases per open-question-6, claude does not),
 *   - the adapter id + component id.
 *
 * The SKILL.md codec is shared with the `agent-skills` adapter as functions
 * (spec §8): a skill's conceptId is its DIRECTORY, and its `name` is the
 * frontmatter `name` (== the dir name per the Agent Skills §4.5 hard rule).
 *
 * ── D-R6 (reserved files) ──
 *
 * `index.md` / `log.md` are OKF structural files at EVERY depth — never a
 * concept. `classify` excludes them up front so a stray `commands/index.md`
 * never becomes a `command` (mirrors okf/akm/llm-wiki `RESERVED_FILES`).
 *
 * ── validate leniency (spec §6 skill row) ──
 *
 * The tool-dir adapters TOLERATE the tools' native frontmatter (argument-hint,
 * allowed-tools, tools, model, mode, temperature, agent, …) — the strict
 * unknown-frontmatter behavior belongs to `agent-skills`, not here. So `command`
 * / `agent` get a LENIENT name-or-signal check (never the akm `CommandLinter`'s
 * frontmatter `name`+`type` requirement, which these tool files do not carry),
 * `skill` gets the coded `missing-skill-md` directory check
 * ({@link skillDirectoryDiagnostics}), and `instruction` runs the shared base
 * checks (a no-op on a frontmatter-free CLAUDE.md/AGENTS.md). Notably NO base
 * checks run on command/agent/skill: their tool frontmatter carries no `updated`
 * field, so `missing-updated` would fire on every file and contradict the lint
 * golden's clean result.
 *
 * ── Cycle-safety ──
 *
 * Imported only by `claude-adapter.ts` / `opencode-adapter.ts` (themselves
 * imported only by the test-only `adapters/index.ts` barrel), so this leaf can
 * never gain an inbound edge from a cycle participant. It value-imports only
 * pure leaves (`shared`, `akm-lint`, `frontmatter`) plus Node builtins.
 */

import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { skillDirectoryDiagnostics } from "./akm-lint";
import { hashContent, nonEmptyString, readTags, runBaseValidateChecks } from "./shared";

/** OKF reserved structural files (D-R6) — excluded at every depth, case-insensitive. */
const RESERVED_FILES = new Set(["index.md", "log.md"]);
/** Upper bound on the bounded `content` FTS field (mirrors okf-adapter). */
const MAX_CONTENT_CHARS = 100_000;
/** The canonical (plural) subdir spellings writes normalize to (open-question-6). */
const CANONICAL_COMMAND_DIR = "commands";
const CANONICAL_AGENT_DIR = "agents";
const CANONICAL_SKILL_DIR = "skills";
const SKILL_MANIFEST = "SKILL.md";

/** The per-adapter tool-dir parameters. */
export interface ToolDirLayout {
  adapterId: string;
  /** PROVENANCE component id emitted on every doc (".claude" / ".opencode"). */
  componentId: string;
  /** Root instruction basename (CLAUDE.md / AGENTS.md). */
  instructionFile: string;
  /** conceptId for the root instruction file (CLAUDE / AGENTS). */
  instructionConceptId: string;
  /** Accepted `command` subdir spellings (plural canonical + optional singular alias). */
  commandDirs: ReadonlySet<string>;
  /** Accepted `agent` subdir spellings. */
  agentDirs: ReadonlySet<string>;
  /** Accepted `skill` subdir spellings. */
  skillDirs: ReadonlySet<string>;
}

type ToolDirType = "instruction" | "command" | "agent" | "skill";

interface ToolDirClassification {
  type: ToolDirType;
  conceptId: string;
  name: string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function isReserved(base: string): boolean {
  return RESERVED_FILES.has(base.toLowerCase());
}

/** Classify one component-root-relative file into a tool-dir `type` + conceptId, or abstain (null). */
function classify(relPath: string, layout: ToolDirLayout): ToolDirClassification | null {
  const posix = toPosix(relPath);
  const segs = posix.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  const base = segs[segs.length - 1]!;
  if (isReserved(base)) return null;

  // Root instruction file.
  if (segs.length === 1 && base === layout.instructionFile) {
    return { type: "instruction", conceptId: layout.instructionConceptId, name: layout.instructionConceptId };
  }

  const head = segs[0]!;
  const ext = path.extname(base).toLowerCase();

  // skill: <skillDir>/<name>/SKILL.md — the item is the DIRECTORY. Any other
  // file under a skill dir (bundled resources) is part of the item, not a concept.
  if (layout.skillDirs.has(head)) {
    if (segs.length >= 3 && base === SKILL_MANIFEST) {
      return { type: "skill", conceptId: `${segs[0]}/${segs[1]}`, name: segs[1]! };
    }
    return null;
  }
  if (layout.commandDirs.has(head) && ext === ".md" && segs.length >= 2) {
    return { type: "command", conceptId: posix.replace(/\.md$/i, ""), name: base.replace(/\.md$/i, "") };
  }
  if (layout.agentDirs.has(head) && ext === ".md" && segs.length >= 2) {
    return { type: "agent", conceptId: posix.replace(/\.md$/i, ""), name: base.replace(/\.md$/i, "") };
  }
  return null;
}

/** recognize() for a tool-dir adapter: derive the open `type`, project the OKF-shaped fields. */
export function recognizeToolDir(layout: ToolDirLayout, c: BundleComponent, file: FileContext): IndexDocument | null {
  const cls = classify(file.relPath, layout);
  if (cls === null) return null;

  const raw = file.content();
  const parsed = parseFrontmatter(raw);
  const data = parsed.data;
  const body = parsed.content;

  // For a skill, `name` is the frontmatter `name` (== dir name); otherwise the
  // basename-derived concept name.
  const name = cls.type === "skill" ? (nonEmptyString(data.name) ?? cls.name) : cls.name;
  const description = nonEmptyString(data.description);
  const tags = readTags(data.tags);

  const doc: IndexDocument = {
    ref: `${c.id}//${cls.conceptId}`,
    bundle: c.id,
    component: layout.componentId,
    conceptId: cls.conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: layout.adapterId,
    type: cls.type,
    name,
    content: body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) : body,
  };
  if (description !== undefined) doc.description = description;
  if (tags !== undefined) doc.tags = tags;
  return doc;
}

/**
 * placeNew() for a tool-dir adapter (spec §7: "AKM workspace layout IS the tool
 * dir minus the prefix"). Writes NORMALIZE to the canonical plural subdir
 * (open-question-6): a `command/foo` concept still places at `commands/foo.md`.
 * The instruction file is fixed at the component root.
 */
export function placeNewToolDir(layout: ToolDirLayout, c: BundleComponent, conceptId: string): string {
  const posix = toPosix(conceptId);
  if (posix === layout.instructionConceptId) return path.join(c.root, layout.instructionFile);

  const segs = posix.split("/").filter((s) => s.length > 0);
  const head = segs[0];
  const rest = segs.slice(1).join("/");
  if (rest.length > 0) {
    if (layout.skillDirs.has(head!)) return path.join(c.root, CANONICAL_SKILL_DIR, rest, SKILL_MANIFEST);
    if (layout.commandDirs.has(head!)) return path.join(c.root, CANONICAL_COMMAND_DIR, `${rest}.md`);
    if (layout.agentDirs.has(head!)) return path.join(c.root, CANONICAL_AGENT_DIR, `${rest}.md`);
  }
  return path.join(c.root, `${posix}.md`);
}

/** LENIENT command/agent check: a diagnostic only when NEITHER a name/description NOR a type-shaped signal is present. */
function nameOrSignalDiagnostics(
  type: "command" | "agent",
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): Diagnostic[] {
  if (nonEmptyString(data.name) !== undefined || nonEmptyString(data.description) !== undefined) return [];
  // command-shaped body/frontmatter signals (spec §6 command row): $ARGUMENTS / $1 / an `agent` frontmatter key.
  if (
    type === "command" &&
    (/\$ARGUMENTS\b/.test(body) || /\$\d/.test(body) || nonEmptyString(data.agent) !== undefined)
  ) {
    return [];
  }
  return [
    {
      file: relPath,
      issue: "missing-name-or-type",
      detail: `${type} has neither a name/description nor a ${type}-shaped signal`,
      fixed: false,
    },
  ];
}

/** validate() for a tool-dir adapter — see file header for the leniency contract. */
export async function validateToolDir(
  layout: ToolDirLayout,
  c: BundleComponent,
  changes: FileChange[],
  ctx: ValidateContext,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const seenSkillDirs = new Set<string>();
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;

    const relPath = toPosix(change.path);
    // The one coded skill check (missing-skill-md) fires on ANY change under a
    // `skills/<name>/…` package (self-gated + deduped), even a bundled resource —
    // mirrors the akm adapter's per-change SkillLinter.lintDirectory pass.
    diagnostics.push(...(await skillDirectoryDiagnostics(relPath, seenSkillDirs, ctx)));

    const cls = classify(change.path, layout);
    if (cls === null) continue;
    if (cls.type === "instruction") {
      diagnostics.push(...(await runBaseValidateChecks(relPath, parseFrontmatter(raw), c.root, ctx)));
    } else if (cls.type === "command" || cls.type === "agent") {
      const parsed = parseFrontmatter(raw);
      diagnostics.push(...nameOrSignalDiagnostics(cls.type, relPath, parsed.data, parsed.content));
    }
    // skill: covered by skillDirectoryDiagnostics above; no additional per-file check.
  }
  return diagnostics;
}

/** Build the concrete `BundleAdapter` from a layout + a `looksLikeRoot` probe (claude/opencode share everything else). */
export function makeToolDirAdapter(layout: ToolDirLayout, looksLikeRoot: (root: string) => boolean): BundleAdapter {
  return {
    id: layout.adapterId,
    version: "0.9.0",
    extensions: [".md"],
    recognize: (c, file) => recognizeToolDir(layout, c, file),
    validate: (c, changes, ctx) => validateToolDir(layout, c, changes, ctx),
    placeNew: (c, conceptId) => placeNewToolDir(layout, c, conceptId),
    directoryList: () => [CANONICAL_COMMAND_DIR, CANONICAL_AGENT_DIR, CANONICAL_SKILL_DIR],
    looksLikeRoot,
  };
}
