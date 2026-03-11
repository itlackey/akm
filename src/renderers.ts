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
import { SCRIPT_EXTENSIONS } from "./asset-spec";
import { hasErrnoCode } from "./common";
import type { AssetRenderer, RenderContext } from "./file-context";
import { registerRenderer } from "./file-context";
import { parseFrontmatter, toStringOrUndefined } from "./frontmatter";
import type { StashEntry } from "./metadata";
import { extractDescriptionFromComments } from "./metadata";
import { loadStashFile } from "./metadata";
import type { KnowledgeView, LocalSearchHit, ShowResponse } from "./stash-types";
import { extractFrontmatterOnly, extractLineRange, extractSection, formatToc, parseMarkdownToc } from "./markdown";

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
  "Gemfile": "bundle install",
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
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  const lines = content.split(/\r?\n/).slice(0, 50);
  const hints: ExecHints = {};

  for (const line of lines) {
    const trimmed = line.trim();
    // Match lines starting with comment markers: //, #, /*, *, ;, --
    if (!/^(?:\/\/|#|\/?\*|;|--)/.test(trimmed) && !trimmed.startsWith("'")) continue;

    // Strip comment prefix
    const cleaned = trimmed
      .replace(/^(?:\/\/|##?|\/?\*\*?\/?|;|--)\s*/, "")
      .replace(/\*\/\s*$/, "")
      .trim();

    const runMatch = cleaned.match(/^@run\s+(.+)/);
    if (runMatch) hints.run = runMatch[1].trim();

    const setupMatch = cleaned.match(/^@setup\s+(.+)/);
    if (setupMatch) hints.setup = setupMatch[1].trim();

    const cwdMatch = cleaned.match(/^@cwd\s+(.+)/);
    if (cwdMatch) hints.cwd = cwdMatch[1].trim();
  }

  return hints;
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

  // Interpreter from extension
  const interpreter = INTERPRETER_MAP[ext];
  if (interpreter) {
    hints.run = `${interpreter} ${filePath}`;
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
 * Resolve execution hints for a script/tool asset.
 *
 * Resolution order (first non-empty value wins for each field):
 * 1. `.stash.json` fields (`run`/`setup`/`cwd`) take priority
 * 2. Script file header comments (`@run`/`@setup`/`@cwd`) second
 * 3. Auto-detection from extension + dependency files last
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

/**
 * Find the stashDir that contains `filePath`, falling back to the first
 * entry in the array when no prefix match is found.
 */
function findContainingStashDir(stashDirs: string[], filePath: string): string | undefined {
  return stashDirs.find((d) => path.resolve(filePath).startsWith(path.resolve(d) + path.sep)) ?? stashDirs[0];
}

/**
 * Load the matching StashEntry for a file path from the directory's .stash.json.
 */
function findStashEntryForFile(filePath: string): StashEntry | undefined {
  const dir = path.dirname(filePath);
  const stashFile = loadStashFile(dir);
  if (!stashFile) return undefined;
  const fileName = path.basename(filePath);
  return stashFile.entries.find((e) => e.entry === fileName);
}

// ── 1. tool-script ───────────────────────────────────────────────────────────

const toolScriptRenderer: AssetRenderer = {
  name: "tool-script",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const stashDirs = ctx.stashDirs;
    const assetStashDir = findContainingStashDir(stashDirs, ctx.absPath);

    if (!assetStashDir) {
      return { type: "tool", name, path: ctx.absPath, content: ctx.content() };
    }

    const stashEntry = findStashEntryForFile(ctx.absPath);
    const hints = resolveExecHints(stashEntry, ctx.absPath);

    return {
      type: "tool",
      name,
      path: ctx.absPath,
      run: hints.run,
      setup: hints.setup,
      cwd: hints.cwd,
    };
  },

  enrichSearchHit(hit: LocalSearchHit, _stashDir: string): void {
    try {
      const stashEntry = findStashEntryForFile(hit.path);
      const hints = resolveExecHints(stashEntry, hit.path);
      hit.run = hints.run;
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error;
    }
  },

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    if (SCRIPT_EXTENSIONS.has(ctx.ext) && ctx.ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(ctx.absPath);
      if (commentDesc && !entry.description) {
        entry.description = commentDesc;
        entry.source = "comments";
        entry.confidence = 0.7;
      }
    }
  },

  usageGuide: [
    "Use the hit's run command for execution so runtime and working directory stay correct.",
    "Use `akm show <openRef>` to inspect the tool before running it.",
  ],
};

// ── 2. skill-md ──────────────────────────────────────────────────────────────

const skillMdRenderer: AssetRenderer = {
  name: "skill-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    return {
      type: "skill",
      name,
      path: ctx.absPath,
      content: ctx.content(),
    };
  },

  usageGuide: [
    "Read and apply the skill instructions as written, then adapt examples to your current repo state and task.",
    "Use `akm show <openRef>` to read the full SKILL.md for required steps and constraints.",
  ],
};

// ── 3. command-md ────────────────────────────────────────────────────────────

const commandMdRenderer: AssetRenderer = {
  name: "command-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const parsedMd = parseFrontmatter(ctx.content());
    return {
      type: "command",
      name,
      path: ctx.absPath,
      description: toStringOrUndefined(parsedMd.data.description),
      template: parsedMd.content,
      modelHint: parsedMd.data.model,
      agent: toStringOrUndefined(parsedMd.data.agent),
    };
  },

  usageGuide: [
    "Read the .md file, fill $ARGUMENTS placeholders, and run it in the current repo context.",
    "Use `akm show <openRef>` to retrieve the command template body.",
    "When `agent` is specified, dispatch the command to that agent.",
  ],
};

// ── 4. agent-md ──────────────────────────────────────────────────────────────

const agentMdRenderer: AssetRenderer = {
  name: "agent-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const parsedMd = parseFrontmatter(ctx.content());
    return {
      type: "agent",
      name,
      path: ctx.absPath,
      description: toStringOrUndefined(parsedMd.data.description),
      prompt:
        "Dispatching prompt must include the agent's full prompt content verbatim; summaries are non-compliant. \n\n" +
        parsedMd.content,
      toolPolicy: parsedMd.data.tools as ShowResponse["toolPolicy"],
      modelHint: parsedMd.data.model,
    };
  },

  usageGuide: [
    "Read the .md file and dispatch an agent using the content of the file. Use modelHint/toolPolicy when present to run the agent with compatible settings.",
    "Use with `akm show <openRef>` to get the full prompt payload.",
  ],
};

// ── 5. knowledge-md ──────────────────────────────────────────────────────────

const knowledgeMdRenderer: AssetRenderer = {
  name: "knowledge-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const v = (ctx.matchResult.meta?.view as KnowledgeView) ?? { mode: "full" };
    const content = ctx.content();

    switch (v.mode) {
      case "toc": {
        const toc = parseMarkdownToc(content);
        return { type: "knowledge", name, path: ctx.absPath, content: formatToc(toc) };
      }
      case "frontmatter": {
        const fm = extractFrontmatterOnly(content);
        return { type: "knowledge", name, path: ctx.absPath, content: fm ?? "(no frontmatter)" };
      }
      case "section": {
        const section = extractSection(content, v.heading);
        if (!section) {
          return {
            type: "knowledge",
            name,
            path: ctx.absPath,
            content: `Section "${v.heading}" not found in ${name}. Try --view toc to discover available headings.`,
          };
        }
        return { type: "knowledge", name, path: ctx.absPath, content: section.content };
      }
      case "lines": {
        return {
          type: "knowledge",
          name,
          path: ctx.absPath,
          content: extractLineRange(content, v.start, v.end),
        };
      }
      default: {
        return { type: "knowledge", name, path: ctx.absPath, content };
      }
    }
  },

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    try {
      const toc = parseMarkdownToc(ctx.content());
      if (toc.headings.length > 0) entry.toc = toc.headings;
    } catch {
      // Non-fatal: skip TOC if file can't be read
    }
  },

  usageGuide: [
    "Use `akm show <openRef>` to read the document; start with `--view toc` for large files.",
    "Use `--view section` or `--view lines` to load only the part you need.",
  ],
};

// ── 6. script-source ─────────────────────────────────────────────────────────

const scriptSourceRenderer: AssetRenderer = {
  name: "script-source",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const ext = path.extname(ctx.absPath).toLowerCase();

    // For extensions with a known interpreter, show exec hints
    if (INTERPRETER_MAP[ext]) {
      const stashEntry = findStashEntryForFile(ctx.absPath);
      const hints = resolveExecHints(stashEntry, ctx.absPath);

      if (hints.run) {
        return {
          type: "script",
          name,
          path: ctx.absPath,
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
      content: ctx.content(),
    };
  },

  enrichSearchHit(hit: LocalSearchHit, _stashDir: string): void {
    const ext = path.extname(hit.path).toLowerCase();
    if (!INTERPRETER_MAP[ext]) return;

    try {
      const stashEntry = findStashEntryForFile(hit.path);
      const hints = resolveExecHints(stashEntry, hit.path);
      hit.run = hints.run;
    } catch (error: unknown) {
      if (!hasErrnoCode(error, "ENOENT")) throw error;
    }
  },

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    if (ctx.ext !== ".md") {
      const commentDesc = extractDescriptionFromComments(ctx.absPath);
      if (commentDesc && !entry.description) {
        entry.description = commentDesc;
        entry.source = "comments";
        entry.confidence = 0.7;
      }
    }
  },

  usageGuide: [
    "Use the hit's run command for execution when available, or run the script directly with the appropriate interpreter.",
    "Use `akm show <openRef>` to inspect the script before running it.",
  ],
};

// ── Registration ─────────────────────────────────────────────────────────────

/** All built-in renderers. */
const builtinRenderers: AssetRenderer[] = [
  toolScriptRenderer,
  skillMdRenderer,
  commandMdRenderer,
  agentMdRenderer,
  knowledgeMdRenderer,
  scriptSourceRenderer,
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
  toolScriptRenderer,
  skillMdRenderer,
  commandMdRenderer,
  agentMdRenderer,
  knowledgeMdRenderer,
  scriptSourceRenderer,
  INTERPRETER_MAP,
  SETUP_SIGNALS,
};
