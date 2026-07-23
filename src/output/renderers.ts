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
import { parseFrontmatter } from "../core/asset/frontmatter";
import {
  extractFrontmatterOnly,
  extractLineRange,
  extractSection,
  formatToc,
  parseMarkdownToc,
} from "../core/asset/markdown";
import { asNonEmptyString, hasErrnoCode } from "../core/common";
import type { IndexDocument } from "../indexer/passes/metadata";
import { extractCommentMetadata } from "../indexer/passes/metadata";
import type { AssetRenderer, RenderContext } from "../indexer/walk/file-context";
import { registerRenderer } from "../indexer/walk/file-context";
import type { KnowledgeView, ShowResponse, SourceSearchHit } from "../sources/types";
import { buildWorkflowAction, workflowMdRenderer, workflowProgramRenderer } from "../workflows/renderer";

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
export function resolveExecHints(stashEntry: IndexDocument | undefined, filePath: string): ExecHints {
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
    const parameter = match[1]!;
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
      // `tools` is self-declared frontmatter. The provenance CEILING that decides
      // whether this self-declared policy is honoured is applied at the show
      // layer (`akmShowUnified`), which knows whether the source is the operator's
      // own writable stash vs a read-only third-party source (07 P1-D).
      toolPolicy: parsedMd.data.tools as ShowResponse["toolPolicy"],
      modelHint: typeof parsedMd.data.model === "string" ? parsedMd.data.model : undefined,
    };
  },
};

// ── 4. knowledge-md ──────────────────────────────────────────────────────────

const KNOWLEDGE_ACTION = "Reference material - read the content below. Use 'toc' view for large documents.";

const knowledgeMdRenderer: AssetRenderer = {
  name: "knowledge-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const type = "knowledge";
    const name = deriveName(ctx);
    const v = (ctx.matchResult.meta?.view as KnowledgeView) ?? { mode: "full" };
    const content = ctx.content();
    const action = KNOWLEDGE_ACTION;

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
          const notFoundMsg = `Section "${v.heading}" not found in ${name}. Try \`akm show <ref> toc\` to discover available headings.`;
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
 * Env renderer. Returns ONLY key names — never values, and never comment
 * text (comments routinely contain commented-out credentials). Deliberately
 * omits content/template/prompt so env values cannot leak through `akm show`.
 */
const envFileRenderer: AssetRenderer = {
  name: "env-file",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const { keys } = listVaultKeys(ctx.absPath);
    return {
      type: "env",
      name,
      path: ctx.absPath,
      action:
        "Environment — key names only. Use `akm env run <ref> -- <command>` to run with the whole .env injected; prefer `--clean` to minimize inherited parent env. AKM itself does not print values, but child stdout/stderr is not redacted. `akm env export <ref> --out <file>` writes a sourceable script to a file. Never `source` the raw file. Values stay on disk and are never written to akm's stdout.",
      keys,
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
  "Scheduled task — `akm show tasks/<id>` for parsed details, `akm tasks run <id>` to invoke now.";

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

// ── 8. session-md (#561) ─────────────────────────────────────────────────────

/**
 * Renderer for the `session` asset type (#561). A session asset is generated by
 * the `extract` pass and carries `harness`, `started_at`/`ended_at`, `project`,
 * `log_path`, and `access` frontmatter plus an LLM `## Summary` / `## Key topics`
 * body. The renderer surfaces a human-readable one-liner (harness + date +
 * project) and concrete `access` instructions rather than dumping raw
 * frontmatter, so an agent can decide whether to open the raw log.
 */
const sessionMdRenderer: AssetRenderer = {
  name: "session-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const parsed = parseFrontmatter(ctx.content());
    const fm = parsed.data;
    const harness = asNonEmptyString(fm.harness);
    const project = asNonEmptyString(fm.project);
    const startedAt = asNonEmptyString(fm.started_at);
    const endedAt = asNonEmptyString(fm.ended_at);
    const logPath = asNonEmptyString(fm.log_path);
    const access = asNonEmptyString(fm.access);
    const description = asNonEmptyString(fm.description);

    const dateRange = startedAt ? (endedAt ? `${startedAt} – ${endedAt}` : startedAt) : undefined;
    const headerParts = [
      harness ? `harness: ${harness}` : undefined,
      project ? `project: ${project}` : undefined,
      dateRange,
    ].filter((p): p is string => !!p);
    const accessLine = [logPath ? `log: ${logPath}` : undefined, access].filter((p): p is string => !!p).join("\n");
    const action = [
      "Prior agent session — read the summary below.",
      headerParts.length > 0 ? headerParts.join("  ") : undefined,
      accessLine ? `Open the raw log:\n${accessLine}` : undefined,
    ]
      .filter((p): p is string => !!p)
      .join("\n");

    return {
      type: "session",
      name,
      path: ctx.absPath,
      action,
      description,
      content: parsed.content,
    };
  },
};

// ── 9. fact-md ───────────────────────────────────────────────────────────────

/**
 * Renderer for the `fact` asset type. A fact is durable stash-level semantic
 * knowledge (personal/team/project details, coding conventions, stash-meta).
 * It carries `category` (personal|team|project|convention|meta) and an
 * optional `pinned` flag marking it as part of the always-injected core. The
 * renderer surfaces a one-liner (category + pinned marker) so an agent can tell
 * at a glance what kind of fact it is and whether it is core context.
 */
const factMdRenderer: AssetRenderer = {
  name: "fact-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const parsed = parseFrontmatter(ctx.content());
    const fm = parsed.data;
    const category = asNonEmptyString(fm.category);
    const description = asNonEmptyString(fm.description);
    const pinned = fm.pinned === true;
    const headerParts = [
      category ? `category: ${category}` : undefined,
      pinned ? "pinned (core context)" : undefined,
    ].filter((p): p is string => !!p);
    const action = [
      "Durable stash fact — apply it as background context.",
      headerParts.length > 0 ? headerParts.join("  ") : undefined,
    ]
      .filter((p): p is string => !!p)
      .join("\n");

    return {
      type: "fact",
      name,
      path: ctx.absPath,
      action,
      description,
      content: parsed.content,
    };
  },
};

// ── Registration ─────────────────────────────────────────────────────────────

/** All built-in renderers. */
const builtinRenderers: AssetRenderer[] = [
  skillMdRenderer,
  commandMdRenderer,
  agentMdRenderer,
  knowledgeMdRenderer,
  lessonMdRenderer,
  memoryMdRenderer,
  workflowMdRenderer,
  workflowProgramRenderer,
  scriptSourceRenderer,
  envFileRenderer,
  secretFileRenderer,
  taskMdRenderer,
  sessionMdRenderer,
  factMdRenderer,
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
  factMdRenderer,
  INTERPRETER_MAP,
  knowledgeMdRenderer,
  lessonMdRenderer,
  memoryMdRenderer,
  SETUP_SIGNALS,
  scriptSourceRenderer,
  secretFileRenderer,
  skillMdRenderer,
  workflowMdRenderer,
  workflowProgramRenderer,
};
