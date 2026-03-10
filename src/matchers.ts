/**
 * Built-in asset matchers for the agentikit file classification system.
 *
 * Four matchers are registered at module load time, each at a different
 * specificity level. Extension and content determine type; directories are
 * optional specificity boosts, not requirements.
 *
 * - `extensionMatcher` (3) -- classifies any file by extension alone.
 *   Ensures every known file type is discoverable regardless of directory.
 * - `directoryMatcher` (10) -- boosts specificity when the first ancestor
 *   directory matches a known type name (e.g. `scripts/`, `agents/`).
 * - `parentDirHintMatcher` (15) -- boosts specificity based on the
 *   immediate parent directory name.
 * - `smartMdMatcher` (20 / 18 / 8 / 5) -- inspects markdown frontmatter
 *   and body content for agent/command signals; falls back to "knowledge"
 *   at specificity 5 when no signals are found. Command signals (`agent`
 *   frontmatter, `$ARGUMENTS`/`$1`-`$3` placeholders) return 18.
 */

import { SCRIPT_EXTENSIONS_BROAD } from "./asset-spec"
import { registerMatcher } from "./file-context"
import type { AssetMatcher, FileContext, MatchResult } from "./file-context"

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
  // SKILL.md is a skill regardless of location
  if (ctx.fileName === "SKILL.md") {
    return { type: "skill", specificity: 3, renderer: "skill-md" }
  }

  // Known script extensions (excluding .md, handled by smartMdMatcher)
  if (SCRIPT_EXTENSIONS_BROAD.has(ctx.ext)) {
    return { type: "script", specificity: 3, renderer: "script-source" }
  }

  return null
}

// ── directoryMatcher (specificity: 10) ──────────────────────────────────────

/**
 * Directory-based matcher that boosts specificity when the first ancestor
 * directory segment from the stash root matches a known type name.
 *
 * Accepts ALL known script extensions in both `tools/` and `scripts/`
 * directories -- the distinction is purely organizational.
 */
export function directoryMatcher(ctx: FileContext): MatchResult | null {
  const topDir = ctx.ancestorDirs[0]
  if (!topDir) return null

  const ext = ctx.ext

  if ((topDir === "tools" || topDir === "scripts") && SCRIPT_EXTENSIONS_BROAD.has(ext)) {
    return { type: "script", specificity: 10, renderer: "script-source" }
  }

  if (topDir === "skills" && ctx.fileName === "SKILL.md") {
    return { type: "skill", specificity: 10, renderer: "skill-md" }
  }

  if (topDir === "commands" && ext === ".md") {
    return { type: "command", specificity: 10, renderer: "command-md" }
  }

  if (topDir === "agents" && ext === ".md") {
    return { type: "agent", specificity: 10, renderer: "agent-md" }
  }

  if (topDir === "knowledge" && ext === ".md") {
    return { type: "knowledge", specificity: 10, renderer: "knowledge-md" }
  }

  return null
}

// ── parentDirHintMatcher (specificity: 15) ──────────────────────────────────

/**
 * Uses the immediate parent directory name as a hint. More specific than
 * the ancestor-based directory matcher because the file might be nested
 * several levels deep, yet its immediate parent can still carry strong
 * naming conventions (e.g. `my-project/agents/planning.md`).
 *
 * Accepts ALL known script extensions in both `tools/` and `scripts/`.
 */
export function parentDirHintMatcher(ctx: FileContext): MatchResult | null {
  const { parentDir, ext, fileName } = ctx

  if ((parentDir === "tools" || parentDir === "scripts") && SCRIPT_EXTENSIONS_BROAD.has(ext)) {
    return { type: "script", specificity: 15, renderer: "script-source" }
  }

  if (parentDir === "skills" && fileName === "SKILL.md") {
    return { type: "skill", specificity: 15, renderer: "skill-md" }
  }

  if (parentDir === "agents" && ext === ".md") {
    return { type: "agent", specificity: 15, renderer: "agent-md" }
  }

  if (parentDir === "commands" && ext === ".md") {
    return { type: "command", specificity: 15, renderer: "command-md" }
  }

  if (parentDir === "knowledge" && ext === ".md") {
    return { type: "knowledge", specificity: 15, renderer: "knowledge-md" }
  }

  return null
}

// ── smartMdMatcher (specificity: 20 / 18 / 8 / 5) ──────────────────────────

/** Pattern that matches OpenCode command placeholders in markdown body. */
const COMMAND_PLACEHOLDER_RE = /\$ARGUMENTS|\$[123]\b/

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
  if (ctx.ext !== ".md") return null

  const fm = ctx.frontmatter()

  if (fm) {
    // Agent-exclusive indicators: toolPolicy or tools
    // These return high specificity (20) to override everything else.
    if ("toolPolicy" in fm || "tools" in fm) {
      return { type: "agent", specificity: 20, renderer: "agent-md" }
    }

    // Command signal: `agent` frontmatter key names a dispatch target.
    // This is an OpenCode convention specific to commands.
    if ("agent" in fm) {
      return { type: "command", specificity: 18, renderer: "command-md" }
    }
  }

  // Command signal: body contains $ARGUMENTS or $1/$2/$3 placeholders.
  // These are definitively command template patterns (OpenCode convention).
  const body = ctx.content()
  if (COMMAND_PLACEHOLDER_RE.test(body)) {
    return { type: "command", specificity: 18, renderer: "command-md" }
  }

  if (fm) {
    // model alone is a weaker agent signal (specificity 8) -- it can appear
    // on commands too (OpenCode convention). Directory hints (10/15) win
    // when the file lives in commands/, but model still classifies an .md
    // as agent when no directory hint is present.
    if ("model" in fm) {
      return { type: "agent", specificity: 8, renderer: "agent-md" }
    }
  }

  // Weak fallback: any .md file is assumed to be knowledge
  return { type: "knowledge", specificity: 5, renderer: "knowledge-md" }
}

// ── Registration ────────────────────────────────────────────────────────────

/** All built-in matchers in registration order (later wins ties). */
const builtinMatchers: AssetMatcher[] = [
  extensionMatcher,
  directoryMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
]

/**
 * Register all built-in matchers with the file-context registry.
 * Called once from the CLI entry point (or ensureBuiltinsRegistered).
 */
export function registerBuiltinMatchers(): void {
  for (const matcher of builtinMatchers) {
    registerMatcher(matcher)
  }
}
