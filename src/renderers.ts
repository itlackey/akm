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
import { hasErrnoCode } from "./common";
import { UsageError } from "./errors";
import type { AssetRenderer, RenderContext } from "./file-context";
import { registerRenderer } from "./file-context";
import { parseFrontmatter, toStringOrUndefined } from "./frontmatter";
import { extractFrontmatterOnly, extractLineRange, extractSection, formatToc, parseMarkdownToc } from "./markdown";
import type { StashEntry } from "./metadata";
import { extractDescriptionFromComments, loadStashFile } from "./metadata";
import type { KnowledgeView, ShowResponse, StashSearchHit } from "./stash-types";
import { listKeys as listVaultKeys } from "./vault";
import { parseWorkflowMarkdown, WorkflowValidationError } from "./workflow-markdown";

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
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  const lines = content.split(/\r?\n/, 50);
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
 * Load the matching StashEntry for a file path from the directory's .stash.json.
 */
function findStashEntryForFile(filePath: string): StashEntry | undefined {
  const dir = path.dirname(filePath);
  const stashFile = loadStashFile(dir);
  if (!stashFile) return undefined;
  const fileName = path.basename(filePath);
  return stashFile.entries.find((e) => e.filename === fileName);
}

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

// ── 1. skill-md ──────────────────────────────────────────────────────────────

const skillMdRenderer: AssetRenderer = {
  name: "skill-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    return {
      type: "skill",
      name,
      path: ctx.absPath,
      action: "Read and follow the instructions below",
      content: ctx.content(),
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
    return {
      type: "command",
      name,
      path: ctx.absPath,
      action: "Fill $ARGUMENTS placeholders in the template, then dispatch",
      description: toStringOrUndefined(parsedMd.data.description),
      template,
      modelHint: typeof parsedMd.data.model === "string" ? parsedMd.data.model : undefined,
      agent: toStringOrUndefined(parsedMd.data.agent),
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
      description: toStringOrUndefined(parsedMd.data.description),
      prompt: parsedMd.content,
      toolPolicy: parsedMd.data.tools as ShowResponse["toolPolicy"],
      modelHint: typeof parsedMd.data.model === "string" ? parsedMd.data.model : undefined,
    };
  },
};

// ── 4. knowledge-md ──────────────────────────────────────────────────────────

const knowledgeMdRenderer: AssetRenderer = {
  name: "knowledge-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const v = (ctx.matchResult.meta?.view as KnowledgeView) ?? { mode: "full" };
    const content = ctx.content();

    switch (v.mode) {
      case "toc": {
        const toc = parseMarkdownToc(content);
        return {
          type: "knowledge",
          name,
          path: ctx.absPath,
          action: "Reference material - read the content below. Use 'toc' view for large documents.",
          content: formatToc(toc),
        };
      }
      case "frontmatter": {
        const fm = extractFrontmatterOnly(content);
        return {
          type: "knowledge",
          name,
          path: ctx.absPath,
          action: "Reference material - read the content below. Use 'toc' view for large documents.",
          content: fm ?? "(no frontmatter)",
        };
      }
      case "section": {
        const section = extractSection(content, v.heading);
        if (!section) {
          return {
            type: "knowledge",
            name,
            path: ctx.absPath,
            action: "Reference material - read the content below. Use 'toc' view for large documents.",
            content: `Section "${v.heading}" not found in ${name}. Try \`akm show <ref> toc\` to discover available headings.`,
          };
        }
        return {
          type: "knowledge",
          name,
          path: ctx.absPath,
          action: "Reference material - read the content below. Use 'toc' view for large documents.",
          content: section.content,
        };
      }
      case "lines": {
        return {
          type: "knowledge",
          name,
          path: ctx.absPath,
          action: "Reference material - read the content below. Use 'toc' view for large documents.",
          content: extractLineRange(content, v.start, v.end),
        };
      }
      default: {
        return {
          type: "knowledge",
          name,
          path: ctx.absPath,
          action: "Reference material - read the content below. Use 'toc' view for large documents.",
          content,
        };
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

const workflowMdRenderer: AssetRenderer = {
  name: "workflow-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const workflow = parseWorkflowForRendering(ctx.content());
    return {
      type: "workflow",
      name,
      path: ctx.absPath,
      action: `Start or resume this workflow with \`akm workflow next workflow:${name}\`.`,
      description: workflow.description,
      workflowTitle: workflow.title,
      parameters: workflow.parameters?.map((parameter) => parameter.name),
      workflowParameters: workflow.parameters,
      steps: workflow.steps,
    };
  },

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    const workflow = parseWorkflowForRendering(ctx.content());
    const hints = new Set<string>(entry.searchHints ?? []);
    hints.add(workflow.title);
    for (const step of workflow.steps) {
      hints.add(step.title);
      hints.add(step.id);
      hints.add(step.instructions);
      for (const criterion of step.completionCriteria ?? []) {
        hints.add(criterion);
      }
    }
    entry.searchHints = Array.from(hints).filter(Boolean);
    if (workflow.parameters?.length) {
      entry.parameters = workflow.parameters.map((parameter) => ({
        name: parameter.name,
        ...(parameter.description ? { description: parameter.description } : {}),
      }));
    }
  },
};

function parseWorkflowForRendering(content: string) {
  try {
    return parseWorkflowMarkdown(content);
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

// ── 7. script-source ─────────────────────────────────────────────────────────

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

  enrichSearchHit(hit: StashSearchHit, _stashDir: string): void {
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
};

// ── 8. vault-env ─────────────────────────────────────────────────────────────

/**
 * Vault renderer. Returns ONLY key names and start-of-line comments — never
 * values. Deliberately omits content/template/prompt so vault values cannot
 * leak through `akm show`.
 */
const vaultEnvRenderer: AssetRenderer = {
  name: "vault-env",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const { keys, comments } = listVaultKeys(ctx.absPath);
    return {
      type: "vault",
      name,
      path: ctx.absPath,
      action:
        'Vault — keys + comments only. Use `eval "$(akm vault load <ref>)"` to load values into the current shell. Values stay on disk and are never written to akm\'s stdout.',
      description: comments.length > 0 ? comments.join("\n") : undefined,
      keys,
      comments,
    };
  },

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    // Re-derive from the file directly to guarantee no value ever transits
    // through any other code path. Caller already short-circuits in
    // generateMetadata{,Flat}, but this is defense in depth.
    const { keys, comments } = listVaultKeys(ctx.absPath);
    if (comments.length > 0 && !entry.description) {
      entry.description = comments.join(" ").slice(0, 500);
      entry.source = "comments";
      entry.confidence = 0.7;
    }
    if (keys.length > 0) {
      entry.searchHints = keys;
    }
    entry.tags = Array.from(new Set([...(entry.tags ?? []), "vault", "secrets"]));
  },
};

// ── Registration ─────────────────────────────────────────────────────────────

/** All built-in renderers. */
const builtinRenderers: AssetRenderer[] = [
  skillMdRenderer,
  commandMdRenderer,
  agentMdRenderer,
  knowledgeMdRenderer,
  memoryMdRenderer,
  workflowMdRenderer,
  scriptSourceRenderer,
  vaultEnvRenderer,
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
  INTERPRETER_MAP,
  knowledgeMdRenderer,
  memoryMdRenderer,
  SETUP_SIGNALS,
  scriptSourceRenderer,
  skillMdRenderer,
  vaultEnvRenderer,
  workflowMdRenderer,
};
