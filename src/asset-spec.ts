import path from "node:path";
import type { AgentikitAssetType } from "./common";
import { toPosix } from "./common";

export const SCRIPT_EXTENSIONS = new Set([".sh", ".ts", ".js", ".ps1", ".cmd", ".bat"]);

export interface AssetSpec {
  stashDir: string;
  isRelevantFile: (fileName: string) => boolean;
  toCanonicalName: (typeRoot: string, filePath: string) => string | undefined;
  toAssetPath: (typeRoot: string, name: string) => string;
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

/** Extended set of script extensions for the script asset type */
export const SCRIPT_EXTENSIONS_BROAD = new Set([
  ...SCRIPT_EXTENSIONS,
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
  isRelevantFile: (fileName) => SCRIPT_EXTENSIONS_BROAD.has(path.extname(fileName).toLowerCase()),
  toCanonicalName: (typeRoot, filePath) => toPosix(path.relative(typeRoot, filePath)),
  toAssetPath: (typeRoot, name) => path.join(typeRoot, name),
};

export const ASSET_SPECS: Record<AgentikitAssetType, AssetSpec> = {
  // "tool" is a transparent alias for "script". It uses the same spec
  // (broad script extensions) but retains its own stashDir ("tools") so
  // files in tools/ are still discovered.
  tool: { stashDir: "tools", ...scriptSpec },
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
};

export const ASSET_TYPES = Object.keys(ASSET_SPECS) as AgentikitAssetType[];

export const TYPE_DIRS: Record<AgentikitAssetType, string> = ASSET_TYPES.reduce(
  (acc, type) => {
    acc[type] = ASSET_SPECS[type].stashDir;
    return acc;
  },
  {} as Record<AgentikitAssetType, string>,
);

export function isRelevantAssetFile(assetType: AgentikitAssetType, fileName: string): boolean {
  return ASSET_SPECS[assetType].isRelevantFile(fileName);
}

export function deriveCanonicalAssetName(
  assetType: AgentikitAssetType,
  typeRoot: string,
  filePath: string,
): string | undefined {
  return ASSET_SPECS[assetType].toCanonicalName(typeRoot, filePath);
}

export function resolveAssetPathFromName(assetType: AgentikitAssetType, typeRoot: string, name: string): string {
  return ASSET_SPECS[assetType].toAssetPath(typeRoot, name);
}
