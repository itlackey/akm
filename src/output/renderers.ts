// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in asset renderers.
 *
 * Each renderer implements the show/search/metadata behavior for its asset
 * type via the AssetRenderer interface from ./file-context. Renderers are
 * registered at module-load time so that importing this module is sufficient
 * to make them available.
 */

import fs from "node:fs";
import path from "node:path";
import { listKeys as listVaultKeys } from "../commands/env/env";
import {
  extractFrontmatterOnly,
  extractLineRange,
  extractSection,
  formatToc,
  parseMarkdownToc,
} from "../core/asset/markdown";
import { asNonEmptyString, hasErrnoCode } from "../core/common";
import { parseFrontmatter } from "../core/frontmatter";
import type { StashEntry } from "../indexer/passes/metadata";
import { extractCommentMetadata, extractDescriptionFromComments } from "../indexer/passes/metadata";
import { registerMetadataContributor } from "../indexer/passes/metadata-contributors";
import type { AssetRenderer, RenderContext } from "../indexer/walk/file-context";
import { registerRenderer } from "../indexer/walk/file-context";
import type { KnowledgeView, ShowResponse, SourceSearchHit } from "../sources/types";
import { buildWorkflowAction, workflowMdRenderer } from "../workflows/renderer";

// ── ExecHints types ──────────────────────────────────────────────────────────

export interface ExecHints {
  run?: string;
  setup?: string;
  cwd?: string;
}

// ── Interpreter auto-detection map ───────────────────────────────────────────

const INTERPRETER_MAP: Record<string, string> = {
  ".sh": "bash",
  ".ts": "bun",
  ".js": "bun",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go run",
  ".ps1": "powershell -File",
  ".cmd": "cmd /c",
  ".bat": "cmd /c",
  ".pl": "perl",
  ".php": "php",
  ".lua": "lua",
  ".r": "Rscript",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
};

// ── Setup signal map ─────────────────────────────────────────────────────────

const SETUP_SIGNALS: Record<string, string> = {
  "package.json": "bun install",
  "requirements.txt": "pip install -r requirements.txt",
  Gemfile: "bundle install",
  "go.mod": "go mod download",
};

// ── Comment tag extraction ───────────────────────────────────────────────────

/**
 * Extract `@run`, `@setup`, `@cwd` tags from script file header comments.
 *
 * Scans the first 50 lines of the file for comment lines containing
 * `@run <value>`, `@setup <value>`, or `@cwd <value>`.
 */
export function extractCommentTags(filePath: string): ExecHints {
  const metadata = extractCommentMetadata(filePath);
  return {
    run: metadata?.run,
    setup: metadata?.setup,
    cwd: metadata?.cwd,
  };
}

// ── Auto-detection ───────────────────────────────────────────────────────────

/**
 * Auto-detect execution hints from the file extension and nearby files.
 *
 * 1. Maps the file extension to an interpreter via INTERPRETER_MAP.
 * 2. Scans the file's directory for dependency signal files (package.json,
 *    requirements.txt, etc.) to suggest a setup command.
 */
export function detectExecHints(filePath: string): ExecHints {
  const ext = path.extname(filePath).toLowerCase();
  const hints: ExecHints = {};

  // Interpreter from extension — use basename so the run command is portable
  // relative to the stash root (callers set cwd to the file's directory).
  const interpreter = INTERPRETER_MAP[ext];
  if (interpreter) {
    hints.run = `${interpreter} ${path.basename(filePath)}`;
  }

  // Setup from nearby dependency files
  const dir = path.dirname(filePath);
  try {
    for (const [file, cmd] of Object.entries(SETUP_SIGNALS)) {
      if (fs.existsSync(path.join(dir, file))) {
        hints.setup = cmd;
        hints.cwd = dir;
        break;
      }
    }
  } catch {
    // Non-fatal: skip setup detection on FS errors
  }

  return hints;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve execution hints for a script asset.
 *
 * Resolution order (first non-empty value wins for each field):
 * 1. Indexed entry metadata (`run`/`setup`/`cwd`) when supplied by the caller
 * 2. Script file header comments (`@run`/`@setup`/`@cwd`)
 * 3. Auto-detection from extension + dependency files
 */
export function resolveExecHints(stashEntry: StashEntry | undefined, filePath: string): ExecHints {
  const stashHints: ExecHints = {
    run: stashEntry?.run,
    setup: stashEntry?.setup,
    cwd: stashEntry?.cwd,
  };

  const commentHints = extractCommentTags(filePath);
  const autoHints = detectExecHints(filePath);

  return {
    run: stashHints.run || commentHints.run || autoHints.run,
    setup: stashHints.setup || commentHints.setup || autoHints.setup,
    cwd: stashHints.cwd || commentHints.cwd || autoHints.cwd,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a display name from the RenderContext.
 *
 * Prefers `matchResult.meta.name` when present; otherwise falls back to the
 * POSIX-style relative path stripped of its extension.
 */
function deriveName(ctx: RenderContext): string {
  const metaName = ctx.matchResult.meta?.name;
  if (typeof metaName === "string" && metaName) return metaName;

  // Strip the extension from the relPath for a reasonable fallback.
  const ext = path.extname(ctx.relPath);
  return ext ? ctx.relPath.slice(0, -ext.length) : ctx.relPath;
}

export { buildWorkflowAction };

function extractParameters(template: string): string[] | undefined {
  const parameters: string[] = [];

  if (/\$ARGUMENTS\b/i.test(template)) {
    parameters.push("ARGUMENTS");
  }

  for (const match of template.matchAll(/\$([1-9])/g)) {
    const parameter = `$${match[1]}`;
    if (!parameters.includes(parameter)) {
      parameters.push(parameter);
    }
  }

  for (const match of template.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) {
    const parameter = match[1];
    if (!parameters.includes(parameter)) {
      parameters.push(parameter);
    }
  }

  return parameters.length > 0 ? parameters : undefined;
}

function readFrontmatterTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  return tags.length > 0 ? tags : undefined;
}

// ── 1. skill-md ──────────────────────────────────────────────────────────────

const skillMdRenderer: AssetRenderer = {
  name: "skill-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const parsed = parseFrontmatter(ctx.content());
    const tags = readFrontmatterTags(parsed.data.tags);
    return {
      type: "skill",
      name,
      path: ctx.absPath,
      action: "Read and follow the instructions below",
      description: asNonEmptyString(parsed.data.description),
      ...(tags ? { tags } : {}),
      content: parsed.content,
    };
  },
};

// ── 2. command-md ────────────────────────────────────────────────────────────

const commandMdRenderer: AssetRenderer = {
  name: "command-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const parsedMd = parseFrontmatter(ctx.content());
    const template = parsedMd.content;
    const tags = readFrontmatterTags(parsedMd.data.tags);
    return {
      type: "command",
      name,
      path: ctx.absPath,
      action: "Fill $ARGUMENTS placeholders in the template, then dispatch",
      description: asNonEmptyString(parsedMd.data.description),
      ...(tags ? { tags } : {}),
      template,
      modelHint: typeof parsedMd.data.model === "string" ? parsedMd.data.model : undefined,
      agent: asNonEmptyString(parsedMd.data.agent),
      parameters: extractParameters(template),
    };
  },
};

// ── 3. agent-md ──────────────────────────────────────────────────────────────

const agentMdRenderer: AssetRenderer = {
  name: "agent-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const parsedMd = parseFrontmatter(ctx.content());
    return {
      type: "agent",
      name,
      path: ctx.absPath,
      action: "Dispatch using the prompt below verbatim. Use modelHint and toolPolicy if present.",
      description: asNonEmptyString(parsedMd.data.description),
      prompt: parsedMd.content,
      toolPolicy: parsedMd.data.tools as ShowResponse["toolPolicy"],
      modelHint: typeof parsedMd.data.model === "string" ? parsedMd.data.model : undefined,
    };
  },
};

// ── 4. knowledge-md / wiki-md shared helper ───────────────────────────────────

const KNOWLEDGE_ACTION = "Reference material - read the content below. Use 'toc' view for large documents.";
const WIKI_PAGE_ACTION = "Wiki page — read below. Use 'toc' to scan, 'section <heading>' for depth.";

/**
 * Shared implementation for knowledge-md and wiki-md `buildShowResponse`.
 *
 * Both renderers handle the same set of view modes (toc, frontmatter, section,
 * lines, full). The only differences are the `type` discriminant and the
 * section-not-found message. Extracting this helper eliminates ~90 lines of
 * byte-for-byte duplication.
 */
function buildMarkdownViewResponse(ctx: RenderContext, type: "knowledge" | "wiki", action: string): ShowResponse {
  const name = deriveName(ctx);
  const v = (ctx.matchResult.meta?.view as KnowledgeView) ?? { mode: "full" };
  const content = ctx.content();

  switch (v.mode) {
    case "toc": {
      const toc = parseMarkdownToc(content);
      return { type, name, path: ctx.absPath, action, content: formatToc(toc) };
    }
    case "frontmatter": {
      const fm = extractFrontmatterOnly(content);
      return { type, name, path: ctx.absPath, action, content: fm ?? "(no frontmatter)" };
    }
    case "section": {
      const section = extractSection(content, v.heading);
      if (!section) {
        const notFoundMsg =
          type === "wiki"
            ? `Section "${v.heading}" not found in ${name}. Try \`akm show wiki:${name} toc\` to discover available headings.`
            : `Section "${v.heading}" not found in ${name}. Try \`akm show <ref> toc\` to discover available headings.`;
        return { type, name, path: ctx.absPath, action, content: notFoundMsg };
      }
      return { type, name, path: ctx.absPath, action, content: section.content };
    }
    case "lines": {
      return { type, name, path: ctx.absPath, action, content: extractLineRange(content, v.start, v.end) };
    }
    default: {
      return { type, name, path: ctx.absPath, action, content };
    }
  }
}

// ── 4. knowledge-md ──────────────────────────────────────────────────────────

const knowledgeMdRenderer: AssetRenderer = {
  name: "knowledge-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    return buildMarkdownViewResponse(ctx, "knowledge", KNOWLEDGE_ACTION);
  },
};

// ── 4b. wiki-md ──────────────────────────────────────────────────────────────

const wikiMdRenderer: AssetRenderer = {
  name: "wiki-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    return buildMarkdownViewResponse(ctx, "wiki", WIKI_PAGE_ACTION);
  },
};

// ── 4c. lesson-md ────────────────────────────────────────────────────────────

/**
 * Renderer for the `lesson` asset type (v1 spec §13).
 *
 * Lessons are markdown files with required `description` and `when_to_use`
 * frontmatter. The renderer projects both fields explicitly so consumers can
 * decide whether to apply a lesson without reading the full body. Lint
 * (see `src/core/lesson-lint.ts`) is the contract enforcer; the renderer is
 * intentionally tolerant — a lesson missing required fields will still render
 * its body so the user has something to work with while they fix the file.
 */
const lessonMdRenderer: AssetRenderer = {
  name: "lesson-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const parsed = parseFrontmatter(ctx.content());
    const description = asNonEmptyString(parsed.data.description);
    const whenToUse = asNonEmptyString(parsed.data.when_to_use);
    const action = whenToUse
      ? `Apply this lesson when: ${whenToUse}`
      : "Apply this lesson when its `when_to_use` trigger matches the current task.";
    return {
      type: "lesson",
      name,
      path: ctx.absPath,
      action,
      description,
      content: parsed.content,
    };
  },
};

// ── 5. memory-md ─────────────────────────────────────────────────────────────

const memoryMdRenderer: AssetRenderer = {
  name: "memory-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    return {
      type: "memory",
      name,
      path: ctx.absPath,
      action: "Recall context — read the content below",
      content: ctx.content(),
    };
  },
};

// ── 6. workflow-md ───────────────────────────────────────────────────────────
// Defined in src/workflows/renderer.ts and imported above.

// ── 7. script-source ─────────────────────────────────────────────────────────

const scriptSourceRenderer: AssetRenderer = {
  name: "script-source",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const ext = path.extname(ctx.absPath).toLowerCase();

    // For extensions with a known interpreter, show exec hints
    if (INTERPRETER_MAP[ext]) {
      const hints = resolveExecHints(undefined, ctx.absPath);

      if (hints.run) {
        return {
          type: "script",
          name,
          path: ctx.absPath,
          action: "Execute the run command below",
          run: hints.run,
          setup: hints.setup,
          cwd: hints.cwd,
        };
      }
    }

    // For other extensions or when no hints are available, show file content
    return {
      type: "script",
      name,
      path: ctx.absPath,
      action: "Review the script source below",
      content: ctx.content(),
    };
  },

  enrichSearchHit(hit: SourceSearchHit, _stashDir: string): void {
    const ext = path.extname(hit.path).toLowerCase();
    if (!INTERPRETER_MAP[ext]) return;

    try {
      const hints = resolveExecHints(undefined, hit.path);
      hit.run = hints.run;
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error;
    }
  },
};

// ── 8. env-file ───────────────────────────────────────────────────────────────

/**
 * Env renderer. Returns ONLY key names and start-of-line comments — never
 * values. Deliberately omits content/template/prompt so env values cannot leak
 * through `akm show`.
 */
const envFileRenderer: AssetRenderer = {
  name: "env-file",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const { keys, comments } = listVaultKeys(ctx.absPath);
    return {
      type: "env",
      name,
      path: ctx.absPath,
      action:
        "Environment — keys + comments only. Use `akm env run <ref> -- <command>` to run with the whole .env injected (the safe path — values never reach stdout). `akm env export <ref> --out <file>` writes a sourceable script to a file. Never `source` the raw file. Values stay on disk and are never written to akm's stdout.",
      description: comments.length > 0 ? comments.join("\n") : undefined,
      keys,
      comments,
    };
  },

  enrichSearchHit(hit: SourceSearchHit, _stashDir: string): void {
    const { keys } = listVaultKeys(hit.path);
    if (keys.length > 0) hit.keys = keys;
  },
};

// ── 9. secret-file ─────────────────────────────────────────────────────────────

/**
 * Secret renderer. The ENTIRE file is the secret value, so this surfaces ONLY
 * the name + path + a usage hint — never content/template/prompt/keys. There
 * is no `enrichSearchHit`: secrets are discoverable by name alone.
 */
const secretFileRenderer: AssetRenderer = {
  name: "secret-file",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    return {
      type: "secret",
      name,
      path: ctx.absPath,
      action:
        "Secret — name only; the file contents are the value and are never written to akm's stdout. Use `akm secret path <ref>` for the file path, or `akm secret run <ref> <VAR> -- <command>` to run with the value injected into $VAR.",
    };
  },
};

// ── 7. task-md ───────────────────────────────────────────────────────────────

const TASK_PAGE_ACTION =
  "Scheduled task — `akm tasks show <id>` for parsed details, `akm tasks run <id>` to invoke now.";

const taskMdRenderer: AssetRenderer = {
  name: "task-yaml",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    return {
      type: "task",
      name,
      path: ctx.absPath,
      action: TASK_PAGE_ACTION,
      content: ctx.content(),
    };
  },
};

function applyTocMetadata(entry: StashEntry, ctx: RenderContext): void {
  try {
    const toc = parseMarkdownToc(ctx.content());
    if (toc.headings.length > 0) entry.toc = toc.headings;
  } catch {
    // Non-fatal: skip TOC if file can't be read
  }
}

/**
 * Parse frontmatter, apply description (if not already set) and merge tags
 * into `entry`. Returns the raw frontmatter data object so callers can access
 * type-specific fields without re-parsing.
 */
function applyFrontmatterDescriptionAndTags(entry: StashEntry, ctx: RenderContext): Record<string, unknown> {
  const parsed = parseFrontmatter(ctx.content());
  const fm = parsed.data;
  const desc = asNonEmptyString(fm.description);
  if (desc && !entry.description) {
    entry.description = desc;
    entry.source = "frontmatter";
    entry.confidence = 0.9;
  }
  if (Array.isArray(fm.tags) && fm.tags.length > 0) {
    const fmTags = fm.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (fmTags.length > 0) {
      entry.tags = Array.from(new Set([...(entry.tags ?? []), ...fmTags]));
    }
  }
  return fm;
}

function applyLessonMetadata(entry: StashEntry, ctx: RenderContext): void {
  try {
    const fm = applyFrontmatterDescriptionAndTags(entry, ctx);
    const whenToUse = asNonEmptyString(fm.when_to_use);
    if (whenToUse) {
      const hints = new Set<string>(entry.searchHints ?? []);
      hints.add(`when_to_use:${whenToUse}`);
      entry.searchHints = Array.from(hints).filter(Boolean);
    }
  } catch {
    // Non-fatal: skip metadata extraction on parse error
  }
}
function applyMemoryMetadata(entry: StashEntry, ctx: RenderContext): void {
  try {
    const fm = applyFrontmatterDescriptionAndTags(entry, ctx);
    const hints = new Set<string>(entry.searchHints ?? []);
    const source = asNonEmptyString(fm.source);
    if (source) hints.add(source);
    const fmObservedAt = asNonEmptyString(fm.observed_at);
    if (fmObservedAt) {
      hints.add(`observed_at:${fmObservedAt}`);
    } else {
      try {
        const isoDate = ctx.stat().mtime.toISOString().slice(0, 10);
        hints.add(`observed_at:${isoDate}`);
      } catch {
        // Non-fatal: skip mtime fallback on stat error
      }
    }
    const expires = asNonEmptyString(fm.expires);
    if (expires) hints.add(`expires:${expires}`);
    if (fm.subjective === true) hints.add("subjective");
    if (hints.size > 0) {
      entry.searchHints = Array.from(hints).filter(Boolean);
    }
  } catch {
    // Non-fatal: skip metadata extraction on error
  }
}
function applyScriptMetadata(entry: StashEntry, ctx: RenderContext): void {
  if (ctx.ext === ".md") return;
  const commentDesc = extractDescriptionFromComments(ctx.absPath);
  if (commentDesc && !entry.description) {
    entry.description = commentDesc;
    entry.source = "comments";
    entry.confidence = 0.7;
  }
}

function applyEnvMetadata(entry: StashEntry, ctx: RenderContext): void {
  const { keys, comments } = listVaultKeys(ctx.absPath);
  if (comments.length > 0 && !entry.description) {
    entry.description = comments.join(" ").slice(0, 500);
    entry.source = "comments";
    entry.confidence = 0.7;
  }
  if (keys.length > 0) {
    entry.searchHints = keys;
  }
  entry.tags = Array.from(new Set([...(entry.tags ?? []), "env", "secrets"]));
}

/**
 * Secret metadata: tags only. Must NEVER read the file body — the whole file
 * is the value, so the entry is built from the filename alone (name-only).
 */
function applySecretMetadata(entry: StashEntry, _ctx: RenderContext): void {
  entry.tags = Array.from(new Set([...(entry.tags ?? []), "secret", "sensitive"]));
}

function applyTaskMetadata(entry: StashEntry, ctx: RenderContext): void {
  try {
    const fm = applyFrontmatterDescriptionAndTags(entry, ctx);
    entry.tags = Array.from(new Set([...(entry.tags ?? []), "task", "scheduled"]));
    const hints = new Set<string>(entry.searchHints ?? []);
    const schedule = asNonEmptyString(fm.schedule);
    if (schedule) hints.add(`schedule:${schedule}`);
    const workflow = asNonEmptyString(fm.workflow);
    if (workflow) hints.add(`workflow:${workflow}`);
    const prompt = asNonEmptyString(fm.prompt);
    if (prompt) hints.add(`prompt:${prompt}`);
    if (hints.size > 0) entry.searchHints = Array.from(hints).filter(Boolean);
  } catch {
    // Non-fatal: skip metadata extraction on error
  }
}
registerMetadataContributor({
  name: "toc-metadata",
  appliesTo: ({ rendererName }) => rendererName === "knowledge-md" || rendererName === "wiki-md",
  contribute: (entry, ctx) => applyTocMetadata(entry, ctx.renderContext),
});
registerMetadataContributor({
  name: "lesson-frontmatter-metadata",
  appliesTo: ({ rendererName }) => rendererName === "lesson-md",
  contribute: (entry, ctx) => applyLessonMetadata(entry, ctx.renderContext),
});

registerMetadataContributor({
  name: "memory-frontmatter-metadata",
  appliesTo: ({ rendererName }) => rendererName === "memory-md",
  contribute: (entry, ctx) => applyMemoryMetadata(entry, ctx.renderContext),
});

registerMetadataContributor({
  name: "script-comment-metadata",
  appliesTo: ({ rendererName }) => rendererName === "script-source",
  contribute: (entry, ctx) => applyScriptMetadata(entry, ctx.renderContext),
});

registerMetadataContributor({
  name: "env-file-metadata",
  appliesTo: ({ rendererName }) => rendererName === "env-file",
  contribute: (entry, ctx) => applyEnvMetadata(entry, ctx.renderContext),
});

registerMetadataContributor({
  name: "secret-file-metadata",
  appliesTo: ({ rendererName }) => rendererName === "secret-file",
  contribute: (entry, ctx) => applySecretMetadata(entry, ctx.renderContext),
});

registerMetadataContributor({
  name: "task-yaml-metadata",
  appliesTo: ({ rendererName }) => rendererName === "task-yaml",
  contribute: (entry, ctx) => applyTaskMetadata(entry, ctx.renderContext),
});

// ── Registration ─────────────────────────────────────────────────────────────

/** All built-in renderers. */
const builtinRenderers: AssetRenderer[] = [
  skillMdRenderer,
  commandMdRenderer,
  agentMdRenderer,
  knowledgeMdRenderer,
  wikiMdRenderer,
  lessonMdRenderer,
  memoryMdRenderer,
  workflowMdRenderer,
  scriptSourceRenderer,
  envFileRenderer,
  secretFileRenderer,
  taskMdRenderer,
];

/**
 * Register all built-in renderers with the file-context registry.
 * Called once from the CLI entry point (or ensureBuiltinsRegistered).
 */
export function registerBuiltinRenderers(): void {
  for (const renderer of builtinRenderers) {
    registerRenderer(renderer);
  }
}

// ── Named exports for testing ────────────────────────────────────────────────

export {
  agentMdRenderer,
  commandMdRenderer,
  envFileRenderer,
  INTERPRETER_MAP,
  knowledgeMdRenderer,
  lessonMdRenderer,
  memoryMdRenderer,
  SETUP_SIGNALS,
  scriptSourceRenderer,
  secretFileRenderer,
  skillMdRenderer,
  wikiMdRenderer,
  workflowMdRenderer,
};
