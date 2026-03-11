/**
 * Flexible asset resolution system.
 *
 * Provides a rich FileContext built once per file during walking, plus a
 * matcher/renderer registry that decouples asset classification from rendering.
 */

import fs from "node:fs";
import path from "node:path";
import { toPosix } from "./common";
import { parseFrontmatter } from "./frontmatter";
import type { StashEntry } from "./metadata";
import type { LocalSearchHit, ShowResponse } from "./stash-types";

// ── FileContext ──────────────────────────────────────────────────────────────

/**
 * A rich context object built once per file during walking.
 *
 * Eager fields (absPath, relPath, ext, etc.) are computed up-front from the
 * path alone. Expensive operations (content, frontmatter, stat) are exposed
 * as lazy-loading getters that read from disk on first call and cache the
 * result for subsequent accesses.
 */
export interface FileContext {
  /** Absolute path to the file */
  absPath: string;
  /** Path relative to the stash root (POSIX separators) */
  relPath: string;
  /** File extension including the dot, e.g. ".ts", ".md" */
  ext: string;
  /** File name including extension, e.g. "deploy.sh" */
  fileName: string;
  /** Immediate parent directory name, e.g. "azure" */
  parentDir: string;
  /** Absolute path to the immediate parent directory */
  parentDirAbs: string;
  /**
   * Directory segments from stash root to the file's parent directory.
   * For a relPath of "tools/azure/deploy/run.sh", this would be
   * ["tools", "azure", "deploy"].
   */
  ancestorDirs: string[];
  /** Absolute path to the stash root this file belongs to */
  stashRoot: string;

  /** Reads and caches the file content on first call */
  content: () => string;
  /** Parses frontmatter from content(); returns data or null if none found */
  frontmatter: () => Record<string, unknown> | null;
  /** Returns and caches fs.Stats for the file */
  stat: () => fs.Stats;
}

/**
 * Build a FileContext from a stash root and an absolute file path.
 *
 * Path-derived fields are computed eagerly. The content, frontmatter, and
 * stat getters use lazy caching so the file is only read from disk when
 * (and if) a matcher or renderer actually needs it.
 */
export function buildFileContext(stashRoot: string, absPath: string): FileContext {
  const relPath = toPosix(path.relative(stashRoot, absPath));
  const ext = path.extname(absPath).toLowerCase();
  const fileName = path.basename(absPath);
  const parentDirAbs = path.dirname(absPath);
  const parentDir = path.basename(parentDirAbs);

  // Compute ancestor directory segments from the POSIX relPath's directory portion.
  // For "tools/azure/deploy/run.sh" the dir portion is "tools/azure/deploy"
  // which splits into ["tools", "azure", "deploy"].
  const relDir = toPosix(path.dirname(relPath));
  const ancestorDirs: string[] = relDir === "." ? [] : relDir.split("/").filter((seg) => seg.length > 0);

  // Lazy caches
  let cachedContent: string | undefined;
  let cachedFrontmatter: Record<string, unknown> | null | undefined;
  let frontmatterComputed = false;
  let cachedStat: fs.Stats | undefined;

  return {
    absPath,
    relPath,
    ext,
    fileName,
    parentDir,
    parentDirAbs,
    ancestorDirs,
    stashRoot,

    content(): string {
      if (cachedContent === undefined) {
        cachedContent = fs.readFileSync(absPath, "utf8");
      }
      return cachedContent;
    },

    frontmatter(): Record<string, unknown> | null {
      if (!frontmatterComputed) {
        const raw = this.content();
        const parsed = parseFrontmatter(raw);
        cachedFrontmatter = Object.keys(parsed.data).length > 0 ? parsed.data : null;
        frontmatterComputed = true;
      }
      return cachedFrontmatter!;
    },

    stat(): fs.Stats {
      if (cachedStat === undefined) {
        cachedStat = fs.statSync(absPath);
      }
      return cachedStat;
    },
  };
}

// ── MatchResult / AssetMatcher ───────────────────────────────────────────────

/**
 * Describes the result of a successful asset match.
 */
export interface MatchResult {
  /**
   * Classified asset type.
   * Standard types: "tool", "skill", "agent", "knowledge", "command", "script".
   * Custom types are also allowed.
   */
  type: string;
  /**
   * Match specificity score. Higher values indicate a more specific (and
   * therefore higher-priority) match. When two matchers produce the same
   * specificity, the one registered later wins.
   */
  specificity: number;
  /** Name of the renderer to use for show/search operations */
  renderer: string;
  /** Optional pass-through data forwarded to the renderer */
  meta?: Record<string, unknown>;
}

/**
 * A function that inspects a FileContext and either claims the file by
 * returning a MatchResult, or returns null to abstain.
 */
export type AssetMatcher = (ctx: FileContext) => MatchResult | null;

// ── RenderContext / AssetRenderer ────────────────────────────────────────────

/**
 * Extended FileContext that carries the winning MatchResult and all
 * stash search paths. Passed to AssetRenderer methods.
 */
export interface RenderContext extends FileContext {
  matchResult: MatchResult;
  stashDirs: string[];
}

/**
 * Defines how a particular asset type is presented in show, search, and
 * metadata extraction operations.
 */
export interface AssetRenderer {
  /** Unique renderer name (must match MatchResult.renderer) */
  name: string;
  /** Build the full ShowResponse for the `akm show` command */
  buildShowResponse(ctx: RenderContext): ShowResponse;
  /** Optionally enrich a LocalSearchHit with renderer-specific fields */
  enrichSearchHit?(hit: LocalSearchHit, stashDir: string): void;
  /** Optionally extract/augment metadata for a StashEntry */
  extractMetadata?(entry: StashEntry, ctx: RenderContext): void;
  /** Human-readable usage instructions surfaced to the LLM */
  usageGuide: string[];
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** Ordered list of registered matchers. Later registrations win ties. */
const matchers: AssetMatcher[] = [];

/** Renderer lookup by name. */
const renderers = new Map<string, AssetRenderer>();

let builtinsInitialized = false;

/** Pluggable initializer set via `setBuiltinRegistrar`. */
let builtinRegistrar: (() => void) | null = null;

/**
 * Set the function that registers built-in matchers and renderers.
 *
 * This breaks the static import cycle: `file-context.ts` does not need to
 * import `matchers.ts` or `renderers.ts` at the top level. Instead, a
 * one-time call from outside (e.g. the test file or CLI entry) provides the
 * registration callback.
 *
 * If no registrar is set by the time `ensureBuiltinsRegistered` runs, it
 * falls back to a dynamic `require()` for backward compatibility.
 */
export function setBuiltinRegistrar(fn: () => void): void {
  builtinRegistrar = fn;
}

/**
 * Ensure that built-in matchers and renderers are registered.
 * Called lazily on first use of runMatchers/getRenderer.
 *
 * Uses the registrar set via `setBuiltinRegistrar`, or falls back to
 * a direct import of the registration modules. The dynamic import
 * avoids a static circular dependency between file-context, renderers,
 * and asset-spec.
 */
function ensureBuiltinsRegistered(): void {
  if (builtinsInitialized) return;
  builtinsInitialized = true;
  if (builtinRegistrar) {
    builtinRegistrar();
    return;
  }
  // Lazy inline require avoids a top-level static import cycle.
  // These are only evaluated once and only when no explicit registrar was set.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registerBuiltinMatchers } = require("./matchers") as typeof import("./matchers");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registerBuiltinRenderers } = require("./renderers") as typeof import("./renderers");
  registerBuiltinMatchers();
  registerBuiltinRenderers();
}

/**
 * Register an AssetMatcher.
 *
 * Matchers are evaluated in registration order. When two matchers produce
 * the same specificity score, the one registered later wins.
 */
export function registerMatcher(matcher: AssetMatcher): void {
  matchers.push(matcher);
}

/**
 * Register an AssetRenderer.
 *
 * If a renderer with the same name already exists it is silently replaced.
 */
export function registerRenderer(renderer: AssetRenderer): void {
  renderers.set(renderer.name, renderer);
}

/**
 * Look up a renderer by name.
 */
export function getRenderer(name: string): AssetRenderer | undefined {
  ensureBuiltinsRegistered();
  return renderers.get(name);
}

/**
 * Return all registered renderers (snapshot, safe to iterate).
 */
export function getAllRenderers(): AssetRenderer[] {
  ensureBuiltinsRegistered();
  return Array.from(renderers.values());
}

/**
 * Run every registered matcher against a FileContext and return the
 * highest-specificity result.
 *
 * Resolution rules:
 * 1. Every matcher is invoked; null returns are discarded.
 * 2. Results are ranked by specificity (descending).
 * 3. Ties are broken by registration order: the matcher registered later wins
 *    (this lets user-registered matchers override built-in ones).
 * 4. Returns null when no matcher claims the file.
 */
export function runMatchers(ctx: FileContext): MatchResult | null {
  ensureBuiltinsRegistered();

  // Collect (result, registrationIndex) pairs from all matchers.
  const hits: Array<{ result: MatchResult; index: number }> = [];

  for (let i = 0; i < matchers.length; i++) {
    const result = matchers[i](ctx);
    if (result !== null) {
      hits.push({ result, index: i });
    }
  }

  if (hits.length === 0) return null;

  // Sort by specificity descending, then by registration index descending (later wins ties).
  hits.sort((a, b) => {
    const specDiff = b.result.specificity - a.result.specificity;
    if (specDiff !== 0) return specDiff;
    return b.index - a.index;
  });

  return hits[0].result;
}

/**
 * Build a RenderContext by merging a FileContext with its winning MatchResult
 * and the list of stash search paths.
 */
export function buildRenderContext(ctx: FileContext, match: MatchResult, stashDirs: string[]): RenderContext {
  return {
    ...ctx,
    matchResult: match,
    stashDirs,
  };
}
