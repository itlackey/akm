// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SemanticSearchRuntimeStatus } from "../indexer/walk/index-context";
import type { InstalledBundle, InstallKind } from "../registry/types";
import type { ProgramExecCore } from "../workflows/program/schema";

export type AkmSearchType = string;
export type SearchSource = "local" | "registry" | "all";
export type SearchHitSize = "small" | "medium" | "large";
export type BeliefFilterMode = "all" | "current" | "historical";
/** Actual local ranking mode, including a semantic attempt that failed at runtime. */
export type SearchExecutionMode = "semantic" | "keyword" | "fts-fallback";
export type FragmentContextMode = "exact" | "lead";

/** Public provenance for an indexed-safe Markdown fragment selection. */
export interface FragmentProvenance {
  /** Fragment-qualified selector that search chose or show resolved. */
  selectedRef?: string;
  /** Canonical parent asset ref, without a selector. */
  parentRef?: string;
  /** One-based fragment position, matching the number in opaque selectors. */
  fragmentOrdinal?: number;
  fragmentCount?: number;
  /** One-based authored source line bounds from the line-preserving safe projection. */
  startLine?: number;
  endLine?: number;
  previousRef?: string;
  nextRef?: string;
  fragmentChars?: number;
  fragmentEstimatedTokens?: number;
  parentChars?: number;
  parentEstimatedTokens?: number;
}

export interface SourceSearchHit extends FragmentProvenance {
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
  /**
   * Approximate tokens for the content addressed by `ref`: selected-fragment
   * size for fragment refs, otherwise parent file size. See
   * `parentEstimatedTokens` when a fragment hit also needs whole-file cost.
   */
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
  /**
   * Which stage of the progressive AND→OR lexical search ladder produced
   * this hit: `"exact"` (strict AND), `"prefix"` (prefix AND), or
   * `"relaxed"` (OR fallback). Absent when the hit has no FTS component
   * (e.g. a pure-semantic hybrid contribution, or a registry/browse hit
   * that never goes through the lexical ladder).
   */
  matchStage?: "exact" | "prefix" | "relaxed";
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
  /** `fts-fallback` means semantic ranking was attempted but keyword search had to serve the result. */
  searchMode?: SearchExecutionMode;
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
   *
   * The SHARED projection shape (`workflows/program/schema.ts`), not a mirror
   * of it: a field added there must not be able to reach the frozen plan while
   * silently missing from what `show` describes.
   */
  exec?: ProgramExecCore;
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
  /** Present when either peer workflow source projects orchestration for this step. */
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
  /** Agent harness that started the run (e.g. "claude", "opencode"), if known. */
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
  /**
   * Resolved declared `outputs:` (P3b), present only on a completed run
   * whose plan declared any. Absent, never `null` — every pre-existing
   * envelope stays byte-identical (Stable tier).
   */
  outputs?: Record<string, unknown>;
  /** The parent run this run was spawned under (P3b); present only on a child run. */
  parentRunId?: string;
  /** The parent run's unit that spawned this run (P3b); present only on a child run. */
  spawnedByUnitId?: string;
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
  /** The EFFECTIVE adapter — explicitly configured, or auto-detected when not (#908). */
  adapter?: string;
  /** `true` when `adapter` came from auto-detection rather than explicit config (#908). */
  detected?: boolean;
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
 * A plain (non-registry-managed, i.e. lockless) bundle fully reconciled by this
 * update call. Git/website sources hydrate before reconciliation; filesystem
 * sources are reported here only when the non-hydrating scan completed. Npm
 * requires a lock and is reported through `processed` instead.
 */
export interface UpdatePlainSyncedItem {
  id: string;
  kind: "filesystem" | "git" | "website";
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
  /** Machine-readable per-bundle outcome for update --all. */
  status?: "blocked" | "failed" | "skipped";
  /** Stable AkmError code when the bundle was blocked or failed. */
  code?: string;
  reason: string;
}

export interface UpdateResponse {
  schemaVersion: number;
  bundleDir: string;
  target?: string;
  all: boolean;
  processed: UpdateResultItem[];
  /** Plain sources freshly hydrated/reconciled by this call. Omitted when empty. */
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
    /** False when the run preserved LKG rows because at least one source scan was incomplete. */
    scanComplete?: boolean;
    /**
     * Semantic-search state after this update's embedding pass (#954). A
     * managed/plain-source update runs the embedding phase AFTER its atomic
     * content/lock/index/state commit, on its own connection — a failing
     * pass (provider down) still reports the update `processed`/successful,
     * with this field the only sign semantic search fell behind
     * (`"blocked"`), exactly like a plain `akm index` whose embedding phase
     * failed.
     */
    semanticStatus?: "disabled" | SemanticSearchRuntimeStatus;
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

export interface ShowResponse extends FragmentProvenance {
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
  /** Fragment presentation requested by the caller; absent for whole assets. */
  contextMode?: FragmentContextMode;
  /** Effective hard content budget for contextual fragment presentation. */
  contextMaxChars?: number;
  /** True when either lead or selected-fragment bytes were omitted for the budget. */
  contextTruncated?: boolean;
}

export interface UpgradeCheckResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  installMethod: "binary" | "bun" | "npm" | "pnpm" | "package-local" | "unknown";
}

export interface UpgradeResponse {
  currentVersion: string;
  newVersion: string;
  upgraded: boolean;
  installMethod: "binary" | "bun" | "npm" | "pnpm" | "package-local" | "unknown";
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
  /**
   * The `akm-migrate apply` plan run after the install step -- or in its
   * place, when there is nothing to install. Every `akm upgrade` carries one.
   * `failed` means the migrator could not run at all; `error` says why.
   */
  migration?: { status: "current" | "ready" | "blocked" | "failed"; error?: string } & Record<string, unknown>;
}

export interface InfoResponse {
  schemaVersion: number;
  version: string;
  /** Primary bundle directory (spec §10.1), same resolution `akm sources list` uses (R-057). */
  bundleDir: string;
  /** Name of the primary bundle from config, or `null` when none is configured (R-057). */
  defaultBundle: string | null;
  /**
   * Resolved per-platform directories (#951) — XDG on Linux/macOS,
   * APPDATA/LOCALAPPDATA on Windows (see `src/core/paths.ts`) — so a script
   * can read akm's paths with `akm info --format json | jq -r .dataDir`
   * instead of hardcoding `~/.local/share/akm` vs. a container's
   * `/opt/akm/data` and drifting.
   */
  dataDir: string;
  configDir: string;
  cacheDir: string;
  stateDir: string;
  assetTypes: string[];
  searchModes: string[];
  semanticSearch: {
    mode: "off" | "auto";
    /** Read live from the index at call time — never a cached verdict. */
    status: "disabled" | "pending" | "ready-js" | "ready-vec";
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
    /**
     * Set only when the index exists but could not be READ (#791) — carries the
     * path, errno, mode/owner and the running uid. Without it, an unreadable
     * index is indistinguishable from an unbuilt one: both report
     * `entryCount: 0, vecAvailable: false` at exit 0, which is what led a
     * consuming agent to tell its user akm's "vector service is unavailable".
     * Absent on every healthy run, so no existing consumer sees a new key.
     */
    unreadable?: string;
  };
}
