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

import { defaultRendererRegistry } from "../../core/asset/asset-registry";
import { SCRIPT_EXTENSIONS } from "../../core/asset/asset-spec";
import { looksLikeWorkflow } from "../../workflows/parser";
import { looksLikeWorkflowProgram } from "../../workflows/program/parser";
import { WORKFLOW_PROGRAM_RENDERER_NAME } from "../../workflows/program/project";
import type { AssetMatcher, FileContext, MatchResult } from "./file-context";
import { registerMatcher } from "./file-context";

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
    dir: "workflows",
    type: "workflow",
    test: (ext) => ext === ".md",
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
    // asset-spec, asset-registry, renderers, and the task-linter, but missed
    // this matcher — tasks/*.yml were unrecognized until this fix).
    test: (ext) => ext === ".yml",
  },
  {
    // #561 — agent session assets live under `sessions/<harness>/<id>.md`.
    // classifyByDirectory walks every ancestor dir, so a nested file still
    // matches the `sessions` rule. Without this entry the file falls through
    // to classifyBySmartMd and is mistyped as `knowledge`.
    dir: "sessions",
    type: "session",
    test: (ext) => ext === ".md",
  },
  {
    // Durable stash-level facts live under `facts/<category>/<name>.md`.
    // classifyByDirectory walks every ancestor dir, so nested category
    // subdirs still match. Without this entry a fact file would fall through
    // to classifyBySmartMd and be mistyped as `knowledge`.
    dir: "facts",
    type: "fact",
    test: (ext) => ext === ".md",
  },
];

const COMMAND_PLACEHOLDER_RE = /\$ARGUMENTS|\$[123]\b/;

// Files that should never be treated as the typed asset for the surrounding
// directory (e.g. `workflows/README.md` is documentation, not a workflow).
// Lower-cased and matched case-insensitively against `ctx.fileName`. They are
// still indexable — falling through to `classifyBySmartMd` typically routes
// them to the generic `knowledge` type.
const TYPED_DIR_DOC_FILES = new Set(["readme.md"]);

function isTypedDirDocFile(fileName: string): boolean {
  return TYPED_DIR_DOC_FILES.has(fileName.toLowerCase());
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function matchDirectoryHint(dirName: string, ctx: FileContext, specificity: number): MatchFact | null {
  if (dirName === "skills" && ctx.fileName === "SKILL.md") {
    return { type: "skill", specificity };
  }

  for (const rule of DIR_TYPE_MAP) {
    if (rule.dir === dirName && rule.test(ctx.ext, ctx.fileName)) {
      // Skip `README.md` (case-insensitive) so `workflows/README.md`,
      // `agents/README.md`, etc. are not parsed as the typed asset and don't
      // trip the workflow/agent metadata validators. They still get indexed
      // as `knowledge` via the smart-md matcher.
      if (isTypedDirDocFile(ctx.fileName)) return null;
      return { type: rule.type, specificity };
    }
  }

  return null;
}

function classifyByExtension(ctx: FileContext): MatchFact | null {
  if (ctx.fileName === "SKILL.md" && !ctx.ancestorDirs.includes("wikis")) {
    return { type: "skill", specificity: 25 };
  }

  if (SCRIPT_EXTENSIONS.has(ctx.ext)) {
    return { type: "script", specificity: 3 };
  }

  return null;
}

function classifyByDirectory(ctx: FileContext): MatchFact | null {
  for (const dir of ctx.ancestorDirs) {
    const result = matchDirectoryHint(dir, ctx, 10);
    if (result) return result;
  }
  return null;
}

function classifyByParentDirHint(ctx: FileContext): MatchFact | null {
  const { parentDir, ext, fileName } = ctx;

  if (parentDir === "skills" && (fileName === "SKILL.md" || ext === ".md")) {
    return { type: "skill", specificity: 15 };
  }

  return matchDirectoryHint(parentDir, ctx, 15);
}

function classifyBySmartMd(ctx: FileContext): MatchFact | null {
  if (ctx.ext !== ".md") return null;

  // Never read the body of a file under secrets/ — the whole file is the
  // secret value. The directory matcher classifies it as `secret` without
  // touching content; bailing here keeps classifyBySmartMd from calling
  // ctx.content()/frontmatter() on secret material.
  if (ctx.ancestorDirs.includes("secrets")) return null;

  // README.md is documentation, never a workflow/agent/command even when the
  // body shape would otherwise classify (e.g. step-list inside a project
  // README under workflows/). Fall straight through to `knowledge`.
  if (isTypedDirDocFile(ctx.fileName)) {
    return { type: "knowledge", specificity: 5 };
  }

  const body = ctx.content();
  if (looksLikeWorkflow(body)) {
    return { type: "workflow", specificity: 19 };
  }

  const fm = ctx.frontmatter();

  if (fm) {
    if ("toolPolicy" in fm || "tools" in fm) {
      return { type: "agent", specificity: 20 };
    }

    if ("agent" in fm) {
      return { type: "command", specificity: 18 };
    }
  }

  if (COMMAND_PLACEHOLDER_RE.test(body)) {
    return { type: "command", specificity: 18 };
  }

  if (fm && "model" in fm) {
    return { type: "agent", specificity: 8 };
  }

  return { type: "knowledge", specificity: 5 };
}

/** YAML workflow *programs* (redesign addendum, R1): `.yaml`/`.yml` files. */
const WORKFLOW_PROGRAM_EXTENSIONS = new Set([".yaml", ".yml"]);

/**
 * Classify YAML workflow programs. Two claims, mirroring the markdown rules:
 *
 *   - any `.yaml`/`.yml` under a `workflows/` dir (the directory rule —
 *     specificity 15 when `workflows` is the immediate parent, 10 for a
 *     deeper ancestor, same ladder as `matchDirectoryHint`);
 *   - anywhere else, a content probe via `looksLikeWorkflowProgram`
 *     (`version: 1` + `steps:` at column 0) at specificity 19, the same
 *     level as `classifyBySmartMd`'s `looksLikeWorkflow` claim.
 *
 * The fact does NOT go through `toMatchResult` — the workflow TYPE maps to
 * the markdown renderer by default, so this classifier names the
 * `workflow-program-yaml` renderer on its result directly.
 */
function classifyByWorkflowProgram(ctx: FileContext): MatchFact | null {
  if (!WORKFLOW_PROGRAM_EXTENSIONS.has(ctx.ext)) return null;
  if (isTypedDirDocFile(ctx.fileName)) return null;
  if (ctx.parentDir === "workflows") return { type: "workflow", specificity: 15 };
  if (ctx.ancestorDirs.includes("workflows")) return { type: "workflow", specificity: 10 };
  if (looksLikeWorkflowProgram(ctx.content())) return { type: "workflow", specificity: 19 };
  return null;
}

function classifyByWiki(ctx: FileContext): MatchFact | null {
  if (ctx.ext !== ".md") return null;
  const idx = ctx.ancestorDirs.indexOf("wikis");
  if (idx < 0) return null;
  if (idx + 1 >= ctx.ancestorDirs.length) return null;
  return { type: "wiki", specificity: 20 };
}

// ---------------------------------------------------------------------------
// Adapter: MatchFact → MatchResult
// ---------------------------------------------------------------------------

function toMatchResult(ctx: FileContext, classify: (ctx: FileContext) => MatchFact | null): MatchResult | null {
  const fact = classify(ctx);
  if (!fact) return null;
  const renderer = defaultRendererRegistry.rendererNameFor(fact.type);
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

export function extensionMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByExtension);
}

export function directoryMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByDirectory);
}

export function parentDirHintMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByParentDirHint);
}

export function smartMdMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyBySmartMd);
}

export function wikiMatcher(ctx: FileContext): MatchResult | null {
  return toMatchResult(ctx, classifyByWiki);
}

export function workflowProgramMatcher(ctx: FileContext): MatchResult | null {
  const fact = classifyByWorkflowProgram(ctx);
  if (!fact) return null;
  // Named directly (not via rendererNameFor) — see classifyByWorkflowProgram.
  return { type: fact.type, specificity: fact.specificity, renderer: WORKFLOW_PROGRAM_RENDERER_NAME };
}

const builtinMatchers: AssetMatcher[] = [
  extensionMatcher,
  directoryMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  wikiMatcher,
  workflowProgramMatcher,
];

export function registerBuiltinMatchers(): void {
  for (const matcher of builtinMatchers) {
    registerMatcher(matcher);
  }
}
