import path from "node:path";
import { toPosix } from "./common";

export interface AssetSpec {
  stashDir: string;
  isRelevantFile: (fileName: string) => boolean;
  toCanonicalName: (typeRoot: string, filePath: string) => string | undefined;
  toAssetPath: (typeRoot: string, name: string) => string;
  /**
   * Optional renderer name to use for this asset type in search results and show.
   * If provided, calling `registerAssetType` will automatically call
   * `registerTypeRenderer(type, rendererName)` in stash-search.ts.
   */
  rendererName?: string;
  /**
   * Optional action builder for this asset type in search results.
   * If provided, calling `registerAssetType` will automatically call
   * `registerActionBuilder(type, actionBuilder)` in stash-search.ts.
   */
  actionBuilder?: (ref: string) => string;
}

const markdownSpec: Omit<AssetSpec, "stashDir"> = {
  isRelevantFile: (fileName) => path.extname(fileName).toLowerCase() === ".md",
  toCanonicalName: (typeRoot, filePath) => {
    const rel = toPosix(path.relative(typeRoot, filePath));
    // Strip .md extension from canonical names (agent:code-reviewer, not agent:code-reviewer.md)
    return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  },
  toAssetPath: (typeRoot, name) => {
    // Accept both with and without .md extension
    const withExt = name.endsWith(".md") ? name : `${name}.md`;
    return path.join(typeRoot, withExt);
  },
};

/** All recognized script extensions for the script asset type */
export const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".ts",
  ".js",
  ".ps1",
  ".cmd",
  ".bat",
  ".py",
  ".rb",
  ".go",
  ".pl",
  ".php",
  ".lua",
  ".r",
  ".swift",
  ".kt",
  ".kts",
]);

const scriptSpec: Omit<AssetSpec, "stashDir"> = {
  isRelevantFile: (fileName) => SCRIPT_EXTENSIONS.has(path.extname(fileName).toLowerCase()),
  toCanonicalName: (typeRoot, filePath) => toPosix(path.relative(typeRoot, filePath)),
  toAssetPath: (typeRoot, name) => path.join(typeRoot, name),
};

const ASSET_SPECS_INTERNAL: Record<string, AssetSpec> = {
  skill: {
    stashDir: "skills",
    isRelevantFile: (fileName) => fileName === "SKILL.md",
    toCanonicalName: (typeRoot, filePath) => {
      const relDir = toPosix(path.dirname(path.relative(typeRoot, filePath)));
      if (!relDir || relDir === ".") return undefined;
      return relDir;
    },
    toAssetPath: (typeRoot, name) => path.join(typeRoot, name, "SKILL.md"),
  },
  command: { stashDir: "commands", ...markdownSpec },
  agent: { stashDir: "agents", ...markdownSpec },
  knowledge: { stashDir: "knowledge", ...markdownSpec },
  script: { stashDir: "scripts", ...scriptSpec },
  memory: { stashDir: "memories", ...markdownSpec },
};

export const ASSET_SPECS: Record<string, AssetSpec> = ASSET_SPECS_INTERNAL;

/**
 * Deferred hooks set by `local-search.ts` at module init time to avoid a
 * circular dependency (asset-spec → local-search → asset-spec).
 *
 * When `registerAssetType` is called with a spec that includes `rendererName`
 * or `actionBuilder`, these hooks are invoked automatically so callers only
 * need a single `registerAssetType(type, spec)` call to fully register a new
 * asset type — no separate `registerTypeRenderer`/`registerActionBuilder` calls
 * are required.
 */
let _registerTypeRenderer: ((type: string, rendererName: string) => void) | undefined;
let _registerActionBuilder: ((type: string, builder: (ref: string) => string) => void) | undefined;

/**
 * Called once by `local-search.ts` during module initialization to wire in the
 * renderer and action-builder registration hooks.
 *
 * @internal — not part of the public extension API; use `registerAssetType` instead.
 */
export function _setAssetTypeHooks(
  rendererHook: (type: string, rendererName: string) => void,
  actionBuilderHook: (type: string, builder: (ref: string) => string) => void,
): void {
  _registerTypeRenderer = rendererHook;
  _registerActionBuilder = actionBuilderHook;
}

/**
 * Register a custom asset type with the Agent-i-Kit asset system.
 *
 * ## Full extension registration API
 *
 * Providing `rendererName` and/or `actionBuilder` in the spec automatically
 * registers the renderer and action builder so that search results and `show`
 * output work out of the box without additional calls.
 *
 * ### Minimal registration (filesystem layout only)
 * ```ts
 * registerAssetType("widget", {
 *   stashDir: "widgets",
 *   isRelevantFile: (f) => f.endsWith(".widget"),
 *   toCanonicalName: (root, fp) => path.basename(fp, ".widget"),
 *   toAssetPath: (root, name) => path.join(root, `${name}.widget`),
 * });
 * ```
 *
 * ### Full registration (filesystem + renderer + action)
 * ```ts
 * registerAssetType("widget", {
 *   stashDir: "widgets",
 *   isRelevantFile: (f) => f.endsWith(".widget"),
 *   toCanonicalName: (root, fp) => path.basename(fp, ".widget"),
 *   toAssetPath: (root, name) => path.join(root, `${name}.widget`),
 *   rendererName: "widget-md",        // registered via registerRenderer() separately
 *   actionBuilder: (ref) => `akm show ${ref} -> use widget`,
 * });
 * ```
 *
 * If `rendererName` or `actionBuilder` is provided but the hooks have not yet
 * been wired (i.e. `local-search.ts` has not been imported), the values are
 * stored in the spec and will take effect once the hooks are set.
 */
export function registerAssetType(type: string, spec: AssetSpec): void {
  ASSET_SPECS_INTERNAL[type] = spec;
  TYPE_DIRS[type] = spec.stashDir;
  ASSET_TYPES = getAssetTypes();

  // Auto-register renderer and action builder if provided in spec
  if (spec.rendererName && _registerTypeRenderer) {
    _registerTypeRenderer(type, spec.rendererName);
  }
  if (spec.actionBuilder && _registerActionBuilder) {
    _registerActionBuilder(type, spec.actionBuilder);
  }
}

export function getAssetTypes(): string[] {
  return Object.keys(ASSET_SPECS_INTERNAL);
}

/** Warning: mutable `let` — stale if captured before `registerAssetType()` calls. Prefer `getAssetTypes()`. */
export let ASSET_TYPES: string[] = getAssetTypes();

export const TYPE_DIRS: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_SPECS_INTERNAL).map(([type, spec]) => [type, spec.stashDir]),
);

export function isRelevantAssetFile(assetType: string, fileName: string): boolean {
  return ASSET_SPECS[assetType]?.isRelevantFile(fileName) ?? false;
}

export function deriveCanonicalAssetName(assetType: string, typeRoot: string, filePath: string): string | undefined {
  return ASSET_SPECS[assetType]?.toCanonicalName(typeRoot, filePath);
}

export function deriveCanonicalAssetNameFromStashRoot(
  assetType: string,
  stashRoot: string,
  filePath: string,
): string | undefined {
  const relPath = toPosix(path.relative(stashRoot, filePath));
  const segments = relPath.split("/").filter(Boolean);
  const firstSegment = segments[0];
  // When the first segment matches the canonical type dir (e.g. "agents"),
  // use it as the type root so canonical names are relative to it.
  // Otherwise fall back to stashRoot — this preserves the full relative path
  // as the canonical name, which is correct for installed kits that live
  // under custom directories (e.g. "tools/agents/svelte-file-editor").
  const typeRoot = firstSegment === TYPE_DIRS[assetType] ? path.join(stashRoot, firstSegment) : stashRoot;
  return deriveCanonicalAssetName(assetType, typeRoot, filePath);
}

export function resolveAssetPathFromName(assetType: string, typeRoot: string, name: string): string {
  const spec = ASSET_SPECS[assetType];
  if (!spec) throw new Error(`Unknown asset type: "${assetType}"`);
  return spec.toAssetPath(typeRoot, name);
}
