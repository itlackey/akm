import type { InstallAuditReport } from "./install-audit";
import type { InstalledStashEntry, StashSource } from "./registry-types";

export type AkmSearchType = string;
export type SearchSource = "stash" | "registry" | "both";
export type SearchHitSize = "small" | "medium" | "large";

export interface StashSearchHit {
  type: string;
  name: string;
  path: string;
  ref: string;
  origin?: string | null;
  /** Whether this asset is safe to edit in place (false only for cache-managed files) */
  editable?: boolean;
  /** Actionable guidance when editable is false (omitted when editable) */
  editHint?: string;
  description?: string;
  tags?: string[];
  size?: SearchHitSize;
  action?: string;
  score?: number;
  whyMatched?: string[];
  run?: string;
  /** Approximate token count derived from fileSize (fileSize / 4). Helps agents decide whether to load full content. */
  estimatedTokens?: number;
}

export interface RegistrySearchResultHit {
  type: "registry";
  name: string;
  id: string;
  description?: string;
  tags?: string[];
  action?: string;
  score?: number;
  whyMatched?: string[];
  /** Whether this entry was manually reviewed and approved */
  curated?: boolean;
  /** Name of the registry that provided this hit (provenance tracking) */
  registryName?: string;
}

export type SearchHit = StashSearchHit | RegistrySearchResultHit;

export interface SearchResponse {
  schemaVersion: number;
  stashDir: string;
  source: SearchSource;
  hits: SearchHit[];
  registryHits?: RegistrySearchResultHit[];
  tip?: string;
  warnings?: string[];
  /** Timing counters in milliseconds */
  timing?: { totalMs: number; rankMs?: number; embedMs?: number };
}

export interface WorkflowParameter {
  name: string;
  description?: string;
}

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  instructions: string;
  completionCriteria?: string[];
  sequenceIndex?: number;
}

export type WorkflowRunStatus = "active" | "completed" | "blocked" | "failed";
export type WorkflowRunStepStatus = "pending" | "completed" | "blocked" | "failed" | "skipped";

export interface WorkflowRunStepState extends WorkflowStepDefinition {
  status: WorkflowRunStepStatus;
  notes?: string;
  evidence?: Record<string, unknown>;
  completedAt?: string | null;
}

export interface WorkflowRunSummary {
  id: string;
  workflowRef: string;
  workflowEntryId?: number | null;
  workflowTitle: string;
  status: WorkflowRunStatus;
  currentStepId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  params?: Record<string, unknown>;
}

export interface AddResponse {
  schemaVersion: number;
  stashDir: string;
  ref: string;
  /** Present for registry stash installs (npm, github, git) */
  installed?: {
    id: string;
    source: StashSource;
    ref: string;
    artifactUrl: string;
    resolvedVersion?: string;
    resolvedRevision?: string;
    stashRoot: string;
    cacheDir: string;
    extractedDir: string;
    installedAt: string;
    audit?: InstallAuditReport;
  };
  /** Present for local directory adds (routed to stashes config) */
  stashSource?:
    | {
        type: "filesystem";
        path: string;
        name?: string;
        stashRoot: string;
        wiki?: string;
      }
    | {
        type: "website";
        url: string;
        name?: string;
        stashRoot: string;
        wiki?: string;
      };
  config: {
    stashCount: number;
    installedKitCount: number;
  };
  index: {
    mode: "full" | "incremental";
    totalEntries: number;
    directoriesScanned: number;
    directoriesSkipped: number;
    warnings?: string[];
  };
}

export interface StashInstallStatus extends InstalledStashEntry {
  extractedDir: string;
  audit?: InstallAuditReport;
}

export type SourceKind = "local" | "managed" | "remote";

export interface SourceEntry {
  name: string;
  kind: SourceKind;
  wiki?: string;
  path?: string;
  ref?: string;
  provider?: string;
  version?: string;
  updatable: boolean;
  writable: boolean;
  status: { exists: boolean };
}

export interface SourceListResponse {
  schemaVersion: number;
  stashDir: string;
  sources: SourceEntry[];
  totalSources: number;
}

export interface RemoveResponse {
  schemaVersion: number;
  stashDir: string;
  target: string;
  removed: {
    id: string;
    source: StashSource | string;
    ref: string;
    cacheDir: string;
    stashRoot: string;
  };
  config: {
    stashCount: number;
    installedKitCount: number;
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
  source: StashSource;
  ref: string;
  previous: {
    resolvedVersion?: string;
    resolvedRevision?: string;
    cacheDir: string;
  };
  installed: StashInstallStatus;
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
    stashCount: number;
    installedKitCount: number;
  };
  index: {
    mode: "full" | "incremental";
    totalEntries: number;
    directoriesScanned: number;
    directoriesSkipped: number;
  };
}

/**
 * Detail level for show responses.
 *
 * - `"summary"` — returns compact metadata only (no content/template/prompt), under 200 tokens.
 * - `"normal"` and `"full"` — both return the complete show response with full content.
 *   The show function treats all non-"summary" values identically; these variants exist
 *   so callers can forward the detail level to output formatting without translation.
 */
export type ShowDetailLevel = "summary" | "normal" | "full";

export interface ShowResponse {
  schemaVersion?: number;
  type: string;
  name: string;
  path: string;
  content?: string;
  template?: string;
  prompt?: string;
  description?: string;
  tags?: string[];
  /**
   * Tool access policy for agent assets. Mapped from the frontmatter `tools` key.
   * Can be a single tool name, a list of tool names, or a structured policy object
   * (e.g. `{ read: "allow", write: "deny" }`).
   */
  toolPolicy?: string | string[] | Record<string, unknown>;
  modelHint?: string;
  /** For commands: which agent should execute this command (OpenCode convention) */
  agent?: string;
  /** How to run this script (e.g. "bash deploy.sh", "bun run.ts") */
  run?: string;
  /** Setup command to run before execution (e.g. "bun install") */
  setup?: string;
  /** Working directory for execution */
  cwd?: string;
  origin?: string | null;
  action?: string;
  parameters?: string[];
  workflowTitle?: string;
  workflowParameters?: WorkflowParameter[];
  steps?: WorkflowStepDefinition[];
  /** Whether this asset is safe to edit in place (false only for cache-managed files) */
  editable?: boolean;
  /** Actionable guidance when editable is false (omitted when editable) */
  editHint?: string;
  /**
   * Vault-only: list of KEY names defined in the vault (no values).
   * Populated by the `vault-env` renderer; never set for any other type.
   */
  keys?: string[];
  /**
   * Vault-only: start-of-line `#` comment lines from the vault file (with the
   * leading `#` stripped). Inline/trailing comments are deliberately omitted.
   */
  comments?: string[];
}

export type KnowledgeView =
  | { mode: "full" }
  | { mode: "toc" }
  | { mode: "frontmatter" }
  | { mode: "section"; heading: string }
  | { mode: "lines"; start: number; end: number };

// ── Manifest types ──────────────────────────────────────────────────────────

/** Compact entry returned by `akm manifest` for cheap capability discovery. */
export interface ManifestEntry {
  name: string;
  type: string;
  ref: string;
  description?: string;
}

/** Response shape for `akm manifest`. */
export interface ManifestResponse {
  schemaVersion: number;
  entries: ManifestEntry[];
}

export interface UpgradeCheckResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  installMethod: "binary" | "bun" | "npm" | "pnpm" | "unknown";
}

export interface UpgradeResponse {
  currentVersion: string;
  newVersion: string;
  upgraded: boolean;
  installMethod: "binary" | "bun" | "npm" | "pnpm" | "unknown";
  binaryPath?: string;
  checksumVerified?: boolean;
  message?: string;
}

export interface InfoResponse {
  schemaVersion: number;
  version: string;
  assetTypes: string[];
  searchModes: string[];
  semanticSearch: {
    mode: "off" | "auto";
    status: "disabled" | "pending" | "ready-js" | "ready-vec" | "blocked";
    reason?: string;
    message?: string;
  };
  registries: Array<{ url: string; name?: string; provider?: string; enabled?: boolean }>;
  stashProviders: Array<{ type: string; name?: string; path?: string; url?: string; enabled?: boolean }>;
  indexStats: {
    entryCount: number;
    lastBuiltAt: string | null;
    hasEmbeddings: boolean;
    vecAvailable: boolean;
  };
}
