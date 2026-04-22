import path from "node:path";
import { registerActionBuilder, registerTypeRenderer } from "./asset-registry";
import { toPosix } from "./common";
import { buildWorkflowAction } from "./renderers";

export interface AssetSpec {
  stashDir: string;
  isRelevantFile: (fileName: string) => boolean;
  toCanonicalName: (typeRoot: string, filePath: string) => string | undefined;
  toAssetPath: (typeRoot: string, name: string) => string;
  /**
   * Optional renderer name to use for this asset type in search results and show.
   * If provided, calling `registerAssetType` will automatically populate
   * `TYPE_TO_RENDERER` in the asset-registry singleton.
   */
  rendererName?: string;
  /**
   * Optional action builder for this asset type in search results.
   * If provided, calling `registerAssetType` will automatically populate
   * `ACTION_BUILDERS` in the asset-registry singleton.
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
  workflow: {
    stashDir: "workflows",
    ...markdownSpec,
    rendererName: "workflow-md",
    actionBuilder: (ref) => buildWorkflowAction(ref),
  },
  script: { stashDir: "scripts", ...scriptSpec },
  memory: { stashDir: "memories", ...markdownSpec },
  vault: {
    stashDir: "vaults",
    isRelevantFile: (fileName) => fileName === ".env" || fileName.endsWith(".env"),
    toCanonicalName: (typeRoot, filePath) => {
      const rel = toPosix(path.relative(typeRoot, filePath));
      const fileName = path.basename(rel);
      // Treat ".env" as the "default" vault; "<name>.env" → "<name>"
      if (fileName === ".env") {
        const dir = path.dirname(rel);
        return dir === "." || dir === "" ? "default" : `${dir}/default`;
      }
      const stripped = rel.endsWith(".env") ? rel.slice(0, -4) : rel;
      return stripped;
    },
    toAssetPath: (typeRoot, name) => {
      if (name === "default") return path.join(typeRoot, ".env");
      return path.join(typeRoot, name.endsWith(".env") ? name : `${name}.env`);
    },
    rendererName: "vault-env",
    actionBuilder: (ref) =>
      `akm vault list ${ref} -> see key names; eval "$(akm vault load ${ref})" -> load values into the current shell (values never echoed)`,
  },
};

export const ASSET_SPECS: Record<string, AssetSpec> = ASSET_SPECS_INTERNAL;

/**
 * Register a custom asset type with the akm asset system.
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
 * Renderer and action builder registration is handled directly via the
 * `asset-registry` singleton — no deferred hooks or import-order concerns.
 */
export function registerAssetType(type: string, spec: AssetSpec): void {
  ASSET_SPECS_INTERNAL[type] = spec;
  TYPE_DIRS[type] = spec.stashDir;
  ASSET_TYPES.length = 0;
  ASSET_TYPES.push(...getAssetTypes());

  // Auto-register renderer and action builder if provided in spec
  if (spec.rendererName) {
    registerTypeRenderer(type, spec.rendererName);
  }
  if (spec.actionBuilder) {
    registerActionBuilder(type, spec.actionBuilder);
  }
}

export function getAssetTypes(): string[] {
  return Object.keys(ASSET_SPECS_INTERNAL);
}

/** Warning: mutable array — stale if captured before `registerAssetType()` calls. Prefer `getAssetTypes()`. */
export const ASSET_TYPES: string[] = getAssetTypes();

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
