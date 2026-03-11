import type { AgentikitAssetType } from "./common";
import type { RegistrySource } from "./registry-types";

export type AgentikitSearchType = AgentikitAssetType | "any";
export type SearchUsageMode = "none" | "both" | "item" | "guide";
export type SearchSource = "local" | "registry" | "both";

export interface LocalSearchHit {
  hitSource: "local";
  type: AgentikitAssetType;
  name: string;
  path: string;
  openRef: string;
  /** For installed sources, the registry id */
  registryId?: string;
  /** Whether this asset is safe to edit in place (false only for cache-managed files) */
  editable?: boolean;
  /** Actionable guidance when editable is false (omitted when editable) */
  editHint?: string;
  description?: string;
  tags?: string[];
  score?: number;
  whyMatched?: string[];
  run?: string;
  usage?: string[];
}

export interface RegistrySearchResultHit {
  hitSource: "registry";
  type: "registry";
  name: string;
  path?: string;
  openRef?: string;
  id: string;
  registrySource: RegistrySource;
  ref: string;
  description?: string;
  tags?: string[];
  homepage?: string;
  score?: number;
  whyMatched?: string[];
  run?: string;
  usage?: string[];
  metadata?: Record<string, string>;
  installRef: string;
  installCmd: string;
  /** Whether this entry was manually reviewed and approved */
  curated?: boolean;
}

export type SearchHit = LocalSearchHit | RegistrySearchResultHit;

export interface SearchResponse {
  schemaVersion: number;
  stashDir: string;
  source: SearchSource;
  hits: SearchHit[];
  usageGuide?: Partial<Record<AgentikitAssetType, string[]>>;
  tip?: string;
  warnings?: string[];
  /** Timing counters in milliseconds */
  timing?: { totalMs: number; rankMs?: number; embedMs?: number };
}

export interface AddResponse {
  schemaVersion: number;
  stashDir: string;
  ref: string;
  installed: {
    id: string;
    source: RegistrySource;
    ref: string;
    artifactUrl: string;
    resolvedVersion?: string;
    resolvedRevision?: string;
    stashRoot: string;
    cacheDir: string;
    extractedDir: string;
    installedAt: string;
  };
  config: {
    searchPaths: string[];
    installedRegistryCount: number;
  };
  index: {
    mode: "full" | "incremental";
    totalEntries: number;
    directoriesScanned: number;
    directoriesSkipped: number;
  };
}

export interface RegistryInstallStatus {
  id: string;
  source: RegistrySource;
  ref: string;
  artifactUrl: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  stashRoot: string;
  cacheDir: string;
  extractedDir: string;
  installedAt: string;
}

export interface RegistryListEntry {
  id: string;
  source: RegistrySource;
  ref: string;
  artifactUrl: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  stashRoot: string;
  cacheDir: string;
  installedAt: string;
  status: {
    cacheDirExists: boolean;
    stashRootExists: boolean;
  };
}

export interface ListResponse {
  schemaVersion: number;
  stashDir: string;
  installed: RegistryListEntry[];
  totalInstalled: number;
}

export interface RemoveResponse {
  schemaVersion: number;
  stashDir: string;
  target: string;
  removed: {
    id: string;
    source: RegistrySource;
    ref: string;
    cacheDir: string;
    stashRoot: string;
  };
  config: {
    searchPaths: string[];
    installedRegistryCount: number;
  };
  index: {
    mode: "full" | "incremental";
    totalEntries: number;
    directoriesScanned: number;
    directoriesSkipped: number;
  };
}

export interface UpdateResultItem {
  id: string;
  source: RegistrySource;
  ref: string;
  previous: {
    resolvedVersion?: string;
    resolvedRevision?: string;
    cacheDir: string;
  };
  installed: RegistryInstallStatus;
  changed: {
    version: boolean;
    revision: boolean;
    any: boolean;
  };
}

export interface UpdateResponse {
  schemaVersion: number;
  stashDir: string;
  target?: string;
  all: boolean;
  processed: UpdateResultItem[];
  config: {
    searchPaths: string[];
    installedRegistryCount: number;
  };
  index: {
    mode: "full" | "incremental";
    totalEntries: number;
    directoriesScanned: number;
    directoriesSkipped: number;
  };
}

export interface ShowResponse {
  schemaVersion?: number;
  type: AgentikitAssetType | string;
  name: string;
  path: string;
  content?: string;
  template?: string;
  prompt?: string;
  description?: string;
  /**
   * Tool access policy for agent assets. Mapped from the frontmatter `tools` key.
   * Can be a single tool name, a list of tool names, or a structured policy object
   * (e.g. `{ read: "allow", write: "deny" }`).
   */
  toolPolicy?: string | string[] | Record<string, unknown>;
  modelHint?: unknown;
  /** For commands: which agent should execute this command (OpenCode convention) */
  agent?: string;
  /** How to run this script/tool (e.g. "bash deploy.sh", "bun run.ts") */
  run?: string;
  /** Setup command to run before execution (e.g. "bun install") */
  setup?: string;
  /** Working directory for execution */
  cwd?: string;
  /** For installed sources, the registry id */
  registryId?: string;
  /** Whether this asset is safe to edit in place (false only for cache-managed files) */
  editable?: boolean;
  /** Actionable guidance when editable is false (omitted when editable) */
  editHint?: string;
}

export type KnowledgeView =
  | { mode: "full" }
  | { mode: "toc" }
  | { mode: "frontmatter" }
  | { mode: "section"; heading: string }
  | { mode: "lines"; start: number; end: number };

export interface UpgradeCheckResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  installMethod: "binary" | "npm" | "unknown";
}

export interface UpgradeResponse {
  currentVersion: string;
  newVersion: string;
  upgraded: boolean;
  installMethod: "binary" | "npm" | "unknown";
  binaryPath?: string;
  checksumVerified?: boolean;
  message?: string;
}
