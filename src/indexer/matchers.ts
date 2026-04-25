/**
 * Built-in asset matchers for the akm file classification system.
 *
 * Five matchers are registered at module load time, each at a different
 * specificity level. Extension and content determine type; directories are
 * optional specificity boosts, not requirements.
 *
 * - `extensionMatcher` (3) -- classifies any file by extension alone.
 *   Ensures every known file type is discoverable regardless of directory.
 * - `directoryMatcher` (10) -- boosts specificity when an ancestor
 *   directory matches a known type name (e.g. `scripts/`, `agents/`).
 * - `parentDirHintMatcher` (15) -- boosts specificity based on the
 *   immediate parent directory name.
 * - `smartMdMatcher` (20 / 18 / 8 / 5) -- inspects markdown frontmatter
 *   and body content for agent/command signals; falls back to "knowledge"
 *   at specificity 5 when no signals are found. Command signals (`agent`
 *   frontmatter, `$ARGUMENTS`/`$1`-`$3` placeholders) return 18.
 * - `wikiMatcher` (20) -- classifies any `.md` under `wikis/<name>/…` as
 *   `wiki`. Registered last so the later-wins tiebreaker beats agent at 20.
 */

import { SCRIPT_EXTENSIONS } from "../core/asset-spec";
import type { AssetMatcher, FileContext, MatchResult } from "./file-context";
import { registerMatcher } from "./file-context";

// ── extensionMatcher (specificity: 3) ────────────────────────────────────────

/**
 * Base-level matcher that classifies files purely by extension.
 *
 * This is the foundation of the classification system: every file with a
 * known extension gets a type, regardless of what directory it lives in.
 * Higher-specificity matchers (directory, content) can override this.
 *
 * .md files are NOT handled here -- smartMdMatcher provides richer
 * classification for markdown via frontmatter inspection.
 */
export function extensionMatcher(ctx: FileContext): MatchResult | null {
  // SKILL.md is a skill regardless of location — high specificity beats
  // smartMdMatcher's knowledge fallback and all directory-based matchers.
  // Exception: files under wikis/<name>/… are always wiki pages; the wiki
  // directory is an authoritative signal that outranks the filename.
  if (ctx.fileName === "SKILL.md" && !ctx.ancestorDirs.includes("wikis")) {
    return { type: "skill", specificity: 25, renderer: "skill-md" };
  }

  // Known script extensions (excluding .md, handled by smartMdMatcher)
  if (SCRIPT_EXTENSIONS.has(ctx.ext)) {
    return { type: "script", specificity: 3, renderer: "script-source" };
  }

  return null;
}

// ── directoryMatcher (specificity: 10) ──────────────────────────────────────

/**
 * Directory-based matcher that boosts specificity when an ancestor
 * directory segment from the stash root matches a known type name.
 *
 * The first matching type-like ancestor wins. This preserves intuitive
 * behavior for nested stash layouts such as `agent-stash/agents/blog/foo.md`
 * while still honoring earlier type roots like `commands/agents/foo.md`.
 */
export function directoryMatcher(ctx: FileContext): MatchResult | null {
  const ext = ctx.ext;

  for (const dir of ctx.ancestorDirs) {
    if (dir === "scripts" && SCRIPT_EXTENSIONS.has(ext)) {
      return { type: "script", specificity: 10, renderer: "script-source" };
    }

    if (dir === "skills" && ctx.fileName === "SKILL.md") {
      return { type: "skill", specificity: 10, renderer: "skill-md" };
    }

    if (dir === "commands" && ext === ".md") {
      return { type: "command", specificity: 10, renderer: "command-md" };
    }

    if (dir === "agents" && ext === ".md") {
      return { type: "agent", specificity: 10, renderer: "agent-md" };
    }

    if (dir === "knowledge" && ext === ".md") {
      return { type: "knowledge", specificity: 10, renderer: "knowledge-md" };
    }

    if (dir === "workflows" && ext === ".md") {
      return { type: "workflow", specificity: 10, renderer: "workflow-md" };
    }

    if (dir === "memories" && ext === ".md") {
      return { type: "memory", specificity: 10, renderer: "memory-md" };
    }

    if (dir === "vaults" && (ctx.fileName === ".env" || ctx.fileName.endsWith(".env"))) {
      return { type: "vault", specificity: 10, renderer: "vault-env" };
    }
  }

  return null;
}

// ── parentDirHintMatcher (specificity: 15) ──────────────────────────────────

/**
 * Uses the immediate parent directory name as a hint. More specific than
 * the ancestor-based directory matcher because the file might be nested
 * several levels deep, yet its immediate parent can still carry strong
 * naming conventions (e.g. `my-project/agents/planning.md`).
 */
export function parentDirHintMatcher(ctx: FileContext): MatchResult | null {
  const { parentDir, ext, fileName } = ctx;

  if (parentDir === "scripts" && SCRIPT_EXTENSIONS.has(ext)) {
    return { type: "script", specificity: 15, renderer: "script-source" };
  }

  if (parentDir === "skills" && fileName === "SKILL.md") {
    return { type: "skill", specificity: 15, renderer: "skill-md" };
  }

  if (parentDir === "agents" && ext === ".md") {
    return { type: "agent", specificity: 15, renderer: "agent-md" };
  }

  if (parentDir === "commands" && ext === ".md") {
    return { type: "command", specificity: 15, renderer: "command-md" };
  }

  if (parentDir === "knowledge" && ext === ".md") {
    return { type: "knowledge", specificity: 15, renderer: "knowledge-md" };
  }

  if (parentDir === "workflows" && ext === ".md") {
    return { type: "workflow", specificity: 15, renderer: "workflow-md" };
  }

  if (parentDir === "memories" && ext === ".md") {
    return { type: "memory", specificity: 15, renderer: "memory-md" };
  }

  if (parentDir === "vaults" && (fileName === ".env" || fileName.endsWith(".env"))) {
    return { type: "vault", specificity: 15, renderer: "vault-env" };
  }

  return null;
}

// ── smartMdMatcher (specificity: 20 / 18 / 8 / 5) ──────────────────────────

/** Pattern that matches OpenCode command placeholders in markdown body. */
const COMMAND_PLACEHOLDER_RE = /\$ARGUMENTS|\$[123]\b/;

/**
 * Content-based matcher for `.md` files. Inspects frontmatter keys and body
 * content to classify markdown as agent, command, or knowledge.
 *
 * Specificity levels:
 *   20 -- agent-exclusive signals (`tools`, `toolPolicy`)
 *   18 -- command content signals (`agent` frontmatter, `$ARGUMENTS`/`$1`-`$3`)
 *    8 -- weak agent signal (`model` alone)
 *    5 -- knowledge fallback (any unclassified `.md`)
 *
 * Command signals at 18 override directory hints (10/15) because the content
 * unambiguously identifies a command template. Agent-exclusive signals at 20
 * still win over command signals when both are present.
 */
export function smartMdMatcher(ctx: FileContext): MatchResult | null {
  if (ctx.ext !== ".md") return null;

  const body = ctx.content();
  const hasWorkflowSignals =
    /^#\s+Workflow:\s+/m.test(body) &&
    /^##\s+Step:\s+/m.test(body) &&
    /^Step ID:\s+/m.test(body) &&
    /^###\s+Instructions\s*$/m.test(body);
  if (hasWorkflowSignals) {
    return { type: "workflow", specificity: 19, renderer: "workflow-md" };
  }

  const fm = ctx.frontmatter();

  if (fm) {
    // Agent-exclusive indicators: toolPolicy or tools
    // These return high specificity (20) to override everything else.
    if ("toolPolicy" in fm || "tools" in fm) {
      return { type: "agent", specificity: 20, renderer: "agent-md" };
    }

    // Command signal: `agent` frontmatter key names a dispatch target.
    // This is an OpenCode convention specific to commands.
    if ("agent" in fm) {
      return { type: "command", specificity: 18, renderer: "command-md" };
    }
  }

  // Command signal: body contains $ARGUMENTS or $1/$2/$3 placeholders.
  // These are definitively command template patterns (OpenCode convention).
  if (COMMAND_PLACEHOLDER_RE.test(body)) {
    return { type: "command", specificity: 18, renderer: "command-md" };
  }

  if (fm) {
    // model alone is a weaker agent signal (specificity 8) -- it can appear
    // on commands too (OpenCode convention). Directory hints (10/15) win
    // when the file lives in commands/, but model still classifies an .md
    // as agent when no directory hint is present.
    if ("model" in fm) {
      return { type: "agent", specificity: 8, renderer: "agent-md" };
    }
  }

  // Weak fallback: any .md file is assumed to be knowledge
  return { type: "knowledge", specificity: 5, renderer: "knowledge-md" };
}

// ── wikiMatcher (specificity: 20) ──────────────────────────────────────────

/**
 * Classify any `.md` file that lives under `wikis/<name>/…` as `wiki`.
 *
 * Registered AFTER `smartMdMatcher` so the registered-later-wins tiebreaker
 * puts wiki ahead of agent at specificity 20. That means a wiki page with
 * agent-style frontmatter (e.g. `tools:`) still classifies as a wiki page,
 * not an agent. That's intentional — the directory is the authoritative
 * signal: files under `wikis/` are wiki content.
 *
 * Requires at least one path segment after `wikis/` (the wiki name) — a
 * stray `.md` at the bare `wikis/` root is not a wiki page.
 */
export function wikiMatcher(ctx: FileContext): MatchResult | null {
  if (ctx.ext !== ".md") return null;
  const idx = ctx.ancestorDirs.indexOf("wikis");
  if (idx < 0) return null;
  if (idx + 1 >= ctx.ancestorDirs.length) return null;
  return { type: "wiki", specificity: 20, renderer: "wiki-md" };
}

// ── Registration ────────────────────────────────────────────────────────────

/** All built-in matchers in registration order (later wins ties). */
const builtinMatchers: AssetMatcher[] = [
  extensionMatcher,
  directoryMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  wikiMatcher,
];

/**
 * Register all built-in matchers with the file-context registry.
 * Called once from the CLI entry point (or ensureBuiltinsRegistered).
 */
export function registerBuiltinMatchers(): void {
  for (const matcher of builtinMatchers) {
    registerMatcher(matcher);
  }
}
