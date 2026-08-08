// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { InstalledBundle, InstallKind } from "../registry/types";

export type AkmSearchType = string;
export type SearchSource = "local" | "registry" | "all";
export type SearchHitSize = "small" | "medium" | "large";
export type BeliefFilterMode = "all" | "current" | "historical";

export interface SourceSearchHit {
  type: string;
  name: string;
  path: string;
  ref: string;
  origin?: string | null;
  /** Env-only: key names surfaced in search results (no values). */
  keys?: string[];
  /** Whether AKM policy allows modifying this exact owned file in place. */
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
  /**
   * Non-fatal hit-level warnings surfaced by the indexer or a registry provider
   * (v1 spec §4.2). Optional; absent when there is nothing to surface. Adding
   * a value here MUST NOT change ranking — warnings are informational only.
   */
  warnings?: string[];
  /**
   * Optional asset quality marker (v1 spec §4.2). One of `generated`,
   * `curated`, `proposed`, or any other string the source emits. Surfaced
   * verbatim from the underlying entry. Absent when the entry has no
   * `quality` field.
   */
  quality?: string;
  beliefState?: string;
  currentBeliefRefs?: string[];
  /**
   * Phase 5A / Advantage D5 — derived-memory pointer.
   *
   * When a parent memory has a derived child indexed, the parent's search hit
   * is enriched with `expandTo` set to the child's ref (e.g.
   * `"memory:claude-prefs.derived"`). Clients can fetch the child via
   * `akm show <expandTo>` to retrieve the distilled lesson surface while the
   * parent itself remains the primary retrieval result.
   *
   * Absent when no derived child exists. The accompanying description /
   * searchHints / tags fields on the hit are swapped in from the derived
   * child when this pointer is set.
   */
  expandTo?: string;
  graph?: {
    entities: Array<{ name: string; kind: "matched" | "connected"; confidence?: number }>;
    relations: Array<{ from: string; to: string; type?: string; confidence?: number }>;
  };
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
  /** Name of the registry that provided this hit (provenance tracking) */
  registryName?: string;
  /**
   * Non-fatal hit-level warnings surfaced by the registry provider (v1 spec
   * §4.2). Optional; absent when there is nothing to surface. Adding a value
   * here MUST NOT change ranking — warnings are informational only.
   */
  warnings?: string[];
}

export type SearchHit = SourceSearchHit | RegistrySearchResultHit;

export interface SearchResponse {
  schemaVersion: number;
  bundleDir: string;
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

/**
 * Read-only projection of a workflow step's orchestration declarations for
 * `show` (`summarizeStepOrchestration` in src/workflows/renderer.ts).
 * `fanOut.over` and `route.input` carry raw reference strings from the closed
 * grammar (`params.<name>` / `steps.<id>.output…`, no `${{ }}` delimiters); the
 * full JSON Schema is reduced to a presence flag to keep show output compact.
 *
 * The step's dispatch kind is carried by FIELD PRESENCE, the same way `fanOut`
 * and `route` carry the step kind: `exec` present means the step runs a shell
 * command, and `engine`/`model` are then absent because an exec unit names no
 * engine — it must never be described as running on the workflow's default one.
 */
export interface WorkflowStepOrchestrationSummary {
  engine?: string;
  model?: string;
  timeoutMs?: number | null;
  /**
   * An exec (shell) unit's dispatch. `command` is the argv verbatim — the
   * words that will actually be spawned, never shell-parsed and never clipped,
   * so what `show` prints is what runs. `passEnv`/`inheritEnv` describe the
   * child's environment SCOPE by variable name; no value is ever projected.
   */
  exec?: { command: string[]; cwd?: string; passEnv?: string[]; inheritEnv?: true };
  fanOut?: { over: string; concurrency?: number; reducer?: string };
  hasSchema?: boolean;
  env?: string[];
  route?: { input: string; branches: Array<{ match: string; stepId: string }>; defaultStepId?: string };
}

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  instructions: string;
  completionCriteria?: string[];
  sequenceIndex?: number;
  /** Present only for YAML workflow-program steps that declare orchestration. */
  orchestration?: WorkflowStepOrchestrationSummary;
}

export type WorkflowRunStatus = "active" | "completed" | "blocked" | "failed";
export type WorkflowRunStepStatus = "pending" | "completed" | "blocked" | "failed" | "skipped";

export interface WorkflowRunStepState extends WorkflowStepDefinition {
  status: WorkflowRunStepStatus;
  notes?: string;
  evidence?: Record<string, unknown>;
  /** Summary of work done, captured on completion (#506). */
  summary?: string;
  completedAt?: string | null;
}

export interface WorkflowRunSummary {
  id: string;
  workflowRef: string;
  scopeKey?: string | null;
  workflowEntryId?: number | null;
  workflowTitle: string;
  status: WorkflowRunStatus;
  currentStepId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  params?: Record<string, unknown>;
  /** Agent harness that started the run (e.g. "claude-code", "opencode"), if known. */
  agentHarness?: string | null;
  /** Platform-native session id that owns the run, if known. */
  agentSessionId?: string | null;
  /**
   * Engine run lease (R2 single-driver enforcement): present while an
   * `akm workflow run` invocation holds the run. `until` is the ISO-8601
   * expiry; an expired lease may still be surfaced here (claimable, not live).
   */
  engineLease?: { holder: string; until: string };
  /** Frozen workflow plan format on this row; null for historical rows. */
  planIrVersion?: number | null;
  executionSupport?: "supported" | "unsupported-version" | "missing-plan" | "corrupt-plan";
}

export interface AddResponse {
  schemaVersion: number;
  bundleDir: string;
  ref: string;
  /** Present for registry stash installs (npm, github, git) */
  installed?: {
    id: string;
    source: InstallKind;
    ref: string;
    artifactUrl: string;
    resolvedVersion?: string;
    resolvedRevision?: string;
    stashRoot: string;
    cacheDir: string;
    extractedDir: string;
    installedAt: string;
  };
  /** Present for local directory adds (routed to stashes config) */
  sourceAdded?:
    | {
        type: "filesystem";
        path: string;
        name?: string;
        stashRoot: string;
      }
    | {
        type: "website";
        url: string;
        name?: string;
        stashRoot: string;
      };
  config: {
    sourceCount: number;
  };
  index: {
    mode: "full" | "incremental";
    totalEntries: number;
    directoriesScanned: number;
    directoriesSkipped: number;
    warnings?: string[];
  };
}

export interface SourceInstallStatus extends InstalledBundle {
  extractedDir: string;
}

/** Canonical source provider kinds. */
export type SourceKind = "filesystem" | "git" | "npm" | "website";

export interface SourceDescriptor {
  kind: "path" | "git" | "npm" | "website";
  locator: string;
  maxPages?: number;
}

export interface SourceLock {
  source: InstallKind;
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  integrity?: string;
  localRoot?: string;
  manifestDigest?: string;
  adapterIds?: string[];
  installedAt?: string;
}

export interface SourceComponent {
  name: string;
  root?: string;
  adapter?: string;
  writable?: boolean;
}

export interface SourceEntry {
  name: string;
  kind: SourceKind;
  default: boolean;
  source: SourceDescriptor;
  path?: string;
  ref?: string;
  provider?: string;
  version?: string;
  writable: boolean;
  registryId?: string;
  components: SourceComponent[];
  lock: SourceLock | null;
  itemCount: number;
  byType: Record<string, number>;
  status: { exists: boolean };
}

export interface SourceListResponse {
  schemaVersion: number;
  bundleDir: string;
  defaultBundle: string | null;
  sources: SourceEntry[];
  totalSources: number;
}

export interface RemoveResponse {
  schemaVersion: number;
  bundleDir: string;
  target: string;
  removed: {
    id: string;
    source: string;
    ref: string;
    cacheDir: string;
    stashRoot: string;
  };
  config: {
    sourceCount: number;
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
  source: InstallKind;
  ref: string;
  previous: {
    resolvedVersion?: string;
    resolvedRevision?: string;
    cacheDir: string;
  };
  installed: SourceInstallStatus;
  changed: {
    version: boolean;
    revision: boolean;
    any: boolean;
  };
}

/**
 * A plain (non-registry-managed, i.e. lockless) git/website bundle that this
 * update call freshly synced. Unlike an npm source — which requires a lock to
 * have a resolvable content path, so it is promoted to a registry-managed
 * install on first sync and reported via `processed` like any other managed
 * install — a git/website bundle's content path is deterministic from its
 * locator alone and never needs a lock, so it stays a plain source forever
 * and is reported here instead (R-015 adjacent: previously this success was
 * reported nowhere, rendering as the misleading "nothing to update").
 */
export interface UpdatePlainSyncedItem {
  id: string;
  kind: "git" | "website";
  ref: string;
}

/**
 * A configured source this update call did NOT process, with a human-
 * readable reason. Exists so `akm update --all` accounts for every configured
 * source instead of silently omitting the ones it cannot or does not sync
 * (R-015) — e.g. website sources (`--all` re-crawl not yet implemented) and
 * filesystem sources (no remote to sync).
 */
export interface UpdateSkippedItem {
  id: string;
  kind: SourceKind;
  reason: string;
}

export interface UpdateResponse {
  schemaVersion: number;
  bundleDir: string;
  target?: string;
  all: boolean;
  processed: UpdateResultItem[];
  /** Plain git/npm sources freshly synced by this call (R-015/R-adjacent). Omitted when empty. */
  plainSynced?: UpdatePlainSyncedItem[];
  /** Configured sources this call did not process, with why (R-015). Omitted when empty. */
  skipped?: UpdateSkippedItem[];
  config: {
    sourceCount: number;
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
 * - `"brief"` — returns a reduced metadata-first view without content/template/prompt.
 * - `"summary"` — returns compact metadata only (no content/template/prompt), under 200 tokens.
 * - `"normal"` and `"full"` — both return the complete show response with full content.
 */
export type ShowDetailLevel = "brief" | "summary" | "normal" | "full";

export interface ShowResponse {
  schemaVersion?: number;
  type: string;
  name: string;
  path: string;
  /** Canonical indexed ref for a materialized local asset. */
  ref?: string;
  activeRun?: {
    runId: string;
    stepId: string | null;
    workflowRef: string;
  };
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
  /** Whether AKM policy allows modifying this exact owned file in place. */
  editable?: boolean;
  /** Actionable guidance when editable is false (omitted when editable) */
  editHint?: string;
  /**
   * Env-only: list of KEY names defined in the env file (no values, no
   * comment text — comments can contain commented-out credentials).
   * Populated by the `env-file` renderer; never set for any other type.
   */
  keys?: string[];
  related?: {
    total: number;
    hits: Array<{ ref?: string; path: string; type: string; sharedEntities: string[]; relationCount: number }>;
  };
}

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
  /**
   * Result of the derived-index rebuild after explicit migration preflight and
   * apply. Absent when the upgrade was a no-op.
   */
  postUpgrade?: {
    ok: boolean;
    skipped: boolean;
    exitCode?: number | null;
    message: string;
  };
}

export interface InfoResponse {
  schemaVersion: number;
  version: string;
  /** Primary bundle directory (spec §10.1), same resolution `akm sources list` uses (R-057). */
  bundleDir: string;
  /** Name of the primary bundle from config, or `null` when none is configured (R-057). */
  defaultBundle: string | null;
  assetTypes: string[];
  searchModes: string[];
  semanticSearch: {
    mode: "off" | "auto";
    status: "disabled" | "pending" | "ready-js" | "ready-vec" | "blocked";
    reason?: string;
    message?: string;
  };
  registries: Array<{ url: string; name?: string; provider?: string; enabled?: boolean }>;
  sourceProviders: Array<{ type: string; name?: string; path?: string; url?: string; enabled?: boolean }>;
  indexStats: {
    entryCount: number;
    /** Per-asset-type breakdown of `entryCount`, keyed by asset type (e.g. "skill", "knowledge") (R-057). */
    byType: Record<string, number>;
    lastBuiltAt: string | null;
    hasEmbeddings: boolean;
    vecAvailable: boolean;
  };
}

export interface HealthResponse {
  schemaVersion: 1;
  ok: boolean;
  status: "pass" | "warn" | "fail";
  since: string;
  hardChecks: Array<{
    name: string;
    kind: "deterministic" | "heuristic";
    status: "pass" | "warn" | "fail" | "unknown";
    message: string;
    confidence: "high" | "medium" | "low";
    evidence?: Record<string, unknown>;
  }>;
  advisories: Array<{
    name: string;
    kind: "deterministic" | "heuristic";
    status: "pass" | "warn" | "fail" | "unknown";
    message: string;
    confidence: "high" | "medium" | "low";
    evidence?: Record<string, unknown>;
  }>;
  metrics: {
    taskFailRate: number;
    agentFailureRate: number;
    stuckActiveRuns: number;
    logBackingRate: number;
    probeRoundTripMs: number | null;
  };
  improve: {
    invoked: number;
    completed: number;
    skipped: number;
    skipReasons: Record<string, number>;
    plannedRefs: number;
    actions: {
      reflect: number;
      distill: number;
      distillSkipped: number;
      memoryPrune: number;
      memoryInference: number;
      graphExtraction: number;
      error: number;
    };
    reflectsWithErrorContext: number;
    coverageGapCount: number;
    executionLogCandidateCount: number;
    evalCasesWritten: number;
    deadUrlCount: number;
    memorySummary: {
      eligible: number;
      derived: number;
    };
    memoryCleanup: {
      pruneCandidates: number;
      contradictionCandidates: number;
      beliefStateTransitions: number;
      consolidationCandidates: number;
      archived: number;
      warnings: number;
    };
    consolidation: {
      ran: boolean;
      processed: number;
      durationMs: number;
    };
    memoryInference: {
      ran: boolean;
      writes: number;
      durationMs: number;
    };
    graphExtraction: {
      ran: boolean;
      extractedFiles: number;
      durationMs: number;
    };
  };
  sessionLogAdvisories: Array<{
    topic: string;
    frequency: number;
    source: string;
    isFailurePattern: boolean;
  }>;
}
