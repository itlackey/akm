// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in asset matchers for the akm file classification system.
 *
 * Each private `classifyBy*` function encapsulates the classification logic for
 * one heuristic. The public `*Matcher` exports compose those facts into the
 * `MatchResult` shape expected by the rest of the indexer.
 */

import { SCRIPT_EXTENSIONS } from "../../core/recognition-util";
import { presentationFor } from "../../core/type-presentation";
import type { FileContext, MatchResult } from "./file-context";

/** What a matcher may use: the path fields of a file, never its content. */
export type PathFileContext = Omit<FileContext, "content" | "bytes" | "frontmatter" | "stat">;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MatchFact {
  type: string;
  specificity: number;
  meta?: Record<string, unknown>;
}

interface DirTypeRule {
  dir: string;
  type: MatchFact["type"];
  test: (ext: string, fileName: string) => boolean;
}

// ---------------------------------------------------------------------------
// Private data
// ---------------------------------------------------------------------------

const DIR_TYPE_MAP: DirTypeRule[] = [
  {
    dir: "scripts",
    type: "script",
    test: (ext) => SCRIPT_EXTENSIONS.has(ext),
  },
  {
    dir: "commands",
    type: "command",
    test: (ext) => ext === ".md",
  },
  {
    dir: "agents",
    type: "agent",
    test: (ext) => ext === ".md",
  },
  {
    dir: "knowledge",
    type: "knowledge",
    test: (ext) => ext === ".md",
  },
  {
    // R-045 / Q-18 second half (owner ruling 11) — stash-resident `instruction`
    // assets live under `instructions/`, mirroring the `knowledge` rule. This
    // is a walker discovery rule for FILES ON DISK under a stash's
    // `instructions/` dir; it is unrelated to the adapter-emitted root
    // CLAUDE.md/AGENTS.md instruction docs (`tool-dir-shared.ts`), which are
    // synthesized by format-family adapters, carry `ownsPresentation: true`,
    // and never pass through this matcher at all.
    dir: "instructions",
    type: "instruction",
    test: (ext) => ext === ".md",
  },
  {
    dir: "rules",
    type: "rule",
    test: (ext) => ext === ".md",
  },
  {
    dir: "workflows",
    type: "workflow",
    test: (ext) => ext === ".md" || ext === ".yml",
  },
  {
    dir: "memories",
    type: "memory",
    test: (ext) => ext === ".md",
  },
  {
    dir: "lessons",
    type: "lesson",
    test: (ext) => ext === ".md",
  },
  {
    dir: "env",
    type: "env",
    test: (_, fileName) => fileName === ".env" || fileName.endsWith(".env"),
  },
  {
    dir: "secrets",
    type: "secret",
    // Any regular file under secrets/ is a secret value, except the lock and
    // sensitive-marker sidecars. The whole file is the value (no extension or
    // body parsing — see the secret-file renderer + indexer guards).
    test: (_, fileName) => !fileName.endsWith(".lock") && !fileName.endsWith(".sensitive"),
  },
  {
    dir: "tasks",
    type: "task",
    // Tasks migrated from `.md` to `.yml` in 0.8.0 (commit 031c659f updated
    // the placement specs, renderers, and the task-linter, but missed this
    // matcher — tasks/*.yml were unrecognized until this fix).
    test: (ext) => ext === ".yml",
  },
  {
    // #561 — agent session assets live under `sessions/<harness>/<id>.md`.
    // classifyByDirectory walks every ancestor dir, so a nested file still
    // matches the `sessions` rule. Without this entry the file falls through
    // to classifyByLooseMarkdown and is typed `knowledge`.
    dir: "sessions",
    type: "session",
    test: (ext) => ext === ".md",
  },
  {
    // Durable stash-level facts live under `facts/<category>/<name>.md`.
    // classifyByDirectory walks every ancestor dir, so nested category
    // subdirs still match. Without this entry a fact file would fall through
    // to classifyByLooseMarkdown and be typed `knowledge`.
    dir: "facts",
    type: "fact",
    test: (ext) => ext === ".md",
  },
];

/** Any other Markdown file is knowledge: a type is the path's, never the frontmatter's or the body's. */
const KNOWLEDGE_FACT = { type: "knowledge", specificity: 5 } as const satisfies MatchFact;

// Files that should never be treated as the typed asset for the surrounding
// directory (e.g. `workflows/README.md` is documentation, not a workflow).
// Lower-cased and matched case-insensitively against `ctx.fileName`. They are
// still indexable — falling through to `classifyByLooseMarkdown` routes
// them to the generic `knowledge` type.
const TYPED_DIR_DOC_FILES = new Set(["readme.md"]);

function isTypedDirDocFile(fileName: string): boolean {
  return TYPED_DIR_DOC_FILES.has(fileName.toLowerCase());
}

function isNestedSkillResource(ctx: PathFileContext): boolean {
  return ctx.ancestorDirs[0] === "skills" && ctx.ancestorDirs.length > 1 && ctx.fileName !== "SKILL.md";
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function matchDirectoryHint(dirName: string, ctx: PathFileContext, specificity: number): MatchFact | null {
  if (dirName === "skills" && ctx.fileName === "SKILL.md") {
    return { type: "skill", specificity };
  }

  for (const rule of DIR_TYPE_MAP) {
    // `rules/` is the bundle's top-level folder only; a `rules` folder deeper down is whatever its parent says.
    if (rule.dir === "rules" && ctx.ancestorDirs[0] !== "rules") continue;
    if (rule.dir === dirName && rule.test(ctx.ext, ctx.fileName)) {
      // Skip `README.md` (case-insensitive) so `workflows/README.md`,
      // `agents/README.md`, etc. are not parsed as the typed asset and don't
      // trip the workflow/agent metadata validators. They still get indexed
      // as `knowledge` via the loose-Markdown matcher.
      if (isTypedDirDocFile(ctx.fileName)) return null;
      return { type: rule.type, specificity };
    }
  }

  return null;
}

function classifyByExtension(ctx: PathFileContext): MatchFact | null {
  if (ctx.fileName === "SKILL.md") {
    return { type: "skill", specificity: 25 };
  }

  if (SCRIPT_EXTENSIONS.has(ctx.ext)) {
    return { type: "script", specificity: 3 };
  }

  return null;
}

function classifyByDirectory(ctx: PathFileContext): MatchFact | null {
  if (isNestedSkillResource(ctx)) return null;
  for (const dir of ctx.ancestorDirs) {
    const result = matchDirectoryHint(dir, ctx, 10);
    if (result) return result;
  }
  return null;
}

function classifyByParentDirHint(ctx: PathFileContext): MatchFact | null {
  const { parentDir, ext, fileName } = ctx;

  if (isNestedSkillResource(ctx)) return null;

  if (parentDir === "skills" && (fileName === "SKILL.md" || ext === ".md")) {
    return { type: "skill", specificity: 15 };
  }

  return matchDirectoryHint(parentDir, ctx, 15);
}

/**
 * The type a file's location declares, from the same directory rules the
 * indexer applies: parent-directory hint (specificity 15) over the outermost
 * typed ancestor (10), each honouring the rule's extension predicate, the
 * `README.md` documentation exception and nested skill resources. `undefined`
 * when no directory rule claims the file. Path fields only; no bytes are read.
 */
export function declaredTypeForPath(ctx: PathFileContext): string | undefined {
  // In the skills tree, a package name is not a competing type declaration.
  if (ctx.ancestorDirs[0] === "skills" && ctx.ancestorDirs.length > 1 && ctx.fileName === "SKILL.md") {
    return "skill";
  }
  return (classifyByParentDirHint(ctx) ?? classifyByDirectory(ctx))?.type;
}

function classifyByLooseMarkdown(ctx: PathFileContext): MatchFact | null {
  if (ctx.ext !== ".md") return null;
  // A file under secrets/ is a secret value, whatever its extension: the directory matcher types it.
  if (ctx.ancestorDirs.includes("secrets")) return null;
  return KNOWLEDGE_FACT;
}

// ---------------------------------------------------------------------------
// Adapter: MatchFact → MatchResult
// ---------------------------------------------------------------------------

function toMatchResult(ctx: PathFileContext, classify: (ctx: PathFileContext) => MatchFact | null): MatchResult | null {
  const fact = classify(ctx);
  return fact ? matchResultForFact(fact) : null;
}

function matchResultForFact(fact: MatchFact): MatchResult | null {
  // Renderer name resolved via TYPE_PRESENTATION (core leaf), so matchers.ts
  // carries no edge into the taxonomy SCC (chunk-3 cutover enabler).
  // TYPE_PRESENTATION.renderer is the single source of truth for renderer names.
  const renderer = presentationFor(fact.type).renderer;
  if (!renderer) return null;
  return {
    type: fact.type,
    specificity: fact.specificity,
    renderer,
    ...(fact.meta ? { meta: fact.meta } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public matchers (API unchanged)
// ---------------------------------------------------------------------------

export function extensionMatcher(ctx: PathFileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByExtension);
}

export function directoryMatcher(ctx: PathFileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByDirectory);
}

export function parentDirHintMatcher(ctx: PathFileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByParentDirHint);
}

export function looseMarkdownMatcher(ctx: PathFileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByLooseMarkdown);
}

// The four matcher functions above are consumed directly by the akm adapter's
// synchronous `recognizeMatch()` (`core/adapter/adapters/akm-adapter.ts`, which
// holds the same registration-order array for tie-breaking). The chunk-3 cutover
// removed the file-context matcher registry, so there is no `registerBuiltinMatchers`
// glue any more — recognition is adapter-driven, not registry-driven.
