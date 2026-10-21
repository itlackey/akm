// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The read-only JSON API behind `akm ui`. Explicit writes live in
 * `proposal-actions.ts` and `workspace-actions.ts`; nothing in this file writes. Every handler calls the function the
 * matching CLI command renders (`akmHealth`, `akmMetrics`, `akmSearch`,
 * `akmShowUnified`, the proposal repository, ...), so the UI and the CLI never
 * disagree and there is no second data layer. Documented in
 * `docs/reference/ui-api.md`.
 *
 * Read-only is enforced here, not hoped for: `state.db` and `index.db` are
 * opened read-only and never created or migrated, search and show run with
 * `readOnly` (no usage events, no index build), and git is only queried.
 */

import fs from "node:fs";
import path from "node:path";
import { parsePositiveIntFlag } from "../../cli/parse-args";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { markdownFragmentSlugs, markdownHeadingSlug, parseMarkdownToc } from "../../core/asset/markdown";
import { markdownLinkTargets } from "../../core/asset/markdown-link-targets";
import { typeNameFromConceptId } from "../../core/asset/resolve-ref";
import { resolveStashDir } from "../../core/common";
import { getConfigValueSource, loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { getConfigPath, getDataDir, getDbPath } from "../../core/paths";
import { getStateDbPath, listPendingStateMigrations } from "../../core/state-db";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import { resolveWriteTarget } from "../../core/write-source";
import { findSourceForPath, resolveSourceEntries } from "../../indexer/search/search-source";
import { type Database, openDatabase } from "../../storage/database";
import { listRecentImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntryIdByFilePath, getItemRefById } from "../../storage/repositories/index-entries-repository";
import { getEmbeddingCount } from "../../storage/repositories/index-vec-repository";
import {
  countFeedbackBySignal,
  listFeedbackEventRows,
  listUsageEventRows,
} from "../../storage/repositories/metrics-repository";
import { listStateProposals } from "../../storage/repositories/proposals-repository";
import { applyReadonlyPragmas } from "../../storage/sqlite-pragmas";
import { pkgVersion } from "../../version";
import { listConfig } from "../config-cli";
import { akmHealth } from "../health";
import { computeAcceptRateBySource } from "../health/accept-rate";
import { akmMetrics } from "../metrics/metrics-cli";
import { isRetireProposal, type Proposal, proposalWaitingSince } from "../proposal/proposal-types";
import { diffLoadedProposal, resolveProposalIdIn } from "../proposal/repository";
import { validateProposal } from "../proposal/validators/proposals";
import { akmSearch, normalizeScopeFilters, parseBeliefFilterMode } from "../read/search";
import { akmShowUnified } from "../read/show";
import { assembleInfo } from "../sources/info";
import { akmListSources } from "../sources/installed-stashes";
import { readBundleGitStatus, readFileRevision, readRecentCommits } from "./git-read";
import { isSecretEnvName, redactForUi } from "./redact";

export interface UiServerInfo {
  startedAt: string;
  host: string;
  port: number;
}

type Query = URLSearchParams;
type Handler = (query: Query, info: UiServerInfo) => unknown | Promise<unknown>;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const IMPROVE_RUNS_SHOWN = 10;
const USAGE_DAYS = 14;
const DAY_MS = 86_400_000;

// ── Parameters ───────────────────────────────────────────────────────────────

function limitParam(query: Query, fallback = DEFAULT_LIST_LIMIT): number {
  const raw = query.get("limit");
  if (raw === null || raw === "") return fallback;
  const parsed = parsePositiveIntFlag(raw, "limit");
  if (parsed === undefined) return fallback;
  return Math.min(parsed, MAX_LIST_LIMIT);
}

function flag(query: Query, name: string): boolean {
  const raw = query.get(name);
  return raw === "1" || raw === "true";
}

// ── Read-only databases ──────────────────────────────────────────────────────

/**
 * Run `fn` against `state.db` opened read-only, or return `fallback` when it
 * does not exist or is behind on migrations (a read-only open must not apply
 * them; `akm health` reports that state). The handle is closed before returning,
 * so no request holds a lock past its own read.
 */
function withReadonlyStateDb<T>(fn: (db: Database) => T, fallback: T): T {
  const dbPath = getStateDbPath();
  if (!fs.existsSync(dbPath) || listPendingStateMigrations(dbPath).length > 0) return fallback;
  const db = openDatabase(dbPath, { readonly: true, create: false });
  try {
    applyReadonlyPragmas(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function tryStashDir(): string | null {
  try {
    return resolveStashDir();
  } catch {
    return null;
  }
}

/** Run each section of a composite response on its own: one failing store degrades one section, not the page. */
async function section<T>(errors: Record<string, string>, name: string, fn: () => T | Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : String(error);
    return null;
  }
}

// ── /api/meta ────────────────────────────────────────────────────────────────

function meta(_query: Query, info: UiServerInfo) {
  return {
    version: pkgVersion,
    runtime: process.versions.bun ? "bun" : "node",
    stashDir: tryStashDir(),
    dataDir: getDataDir(),
    configPath: getConfigPath(),
    stateDbPath: getStateDbPath(),
    indexDbPath: getDbPath(),
    startedAt: info.startedAt,
    host: info.host,
    port: info.port,
  };
}

// ── /api/overview ────────────────────────────────────────────────────────────

/** One persisted improve run, projected to what the overview shows. Tolerant: a row from an older release just has fewer fields. */
function summarizeImproveRun(row: ReturnType<typeof listRecentImproveRuns>[number]) {
  let result: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.result_json);
    if (parsed && typeof parsed === "object") result = parsed as Record<string, unknown>;
  } catch {
    // An unparseable result still has a row worth listing.
  }
  const byProcess: Record<string, { calls: number; failures: number }> = {};
  const usage = result.usageReport as { byProcessEngineModel?: unknown } | undefined;
  for (const entry of Array.isArray(usage?.byProcessEngineModel) ? usage.byProcessEngineModel : []) {
    const { process, calls, failures } = entry as { process?: string; calls?: number; failures?: number };
    if (!process) continue;
    const bucket = byProcess[process] ?? { calls: 0, failures: 0 };
    bucket.calls += calls ?? 0;
    bucket.failures += failures ?? 0;
    byProcess[process] = bucket;
  }
  const started = Date.parse(row.started_at);
  const completed = Date.parse(row.completed_at);
  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ok: row.ok === 1,
    durationMs:
      Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? completed - started : null,
    strategy: row.strategy,
    scope: { mode: row.scope_mode, ...(row.scope_value ? { value: row.scope_value } : {}) },
    modelCalls: {
      total: Object.values(byProcess).reduce((sum, bucket) => sum + bucket.calls, 0),
      failures: Object.values(byProcess).reduce((sum, bucket) => sum + bucket.failures, 0),
      byProcess,
    },
    preRunSync: result.preRunSync ?? null,
    sync: result.sync ?? null,
    triage: result.triage ?? null,
  };
}

/** User-attributed search / curate / show / feedback counts per UTC day for the last {@link USAGE_DAYS} days, oldest first. */
function usageByDay(db: Database, nowMs: number) {
  const days = new Map<string, Record<string, number>>();
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const date = new Date(nowMs - i * DAY_MS).toISOString().slice(0, 10);
    days.set(date, { search: 0, curate: 0, show: 0, feedbackPositive: 0, feedbackNegative: 0 });
  }
  const first = [...days.keys()][0] as string;
  const rows = listUsageEventRows(db, {
    sinceIso: `${first}T00:00:00.000Z`,
    untilIso: new Date(nowMs).toISOString(),
    source: "user",
  });
  for (const row of rows) {
    // `created_at` is `YYYY-MM-DD HH:MM:SS` (UTC).
    const bucket = days.get(row.created_at.slice(0, 10));
    if (!bucket) continue;
    if (row.event_type === "feedback") {
      if (row.signal === "positive") bucket.feedbackPositive = (bucket.feedbackPositive ?? 0) + 1;
      else if (row.signal === "negative") bucket.feedbackNegative = (bucket.feedbackNegative ?? 0) + 1;
    } else if (row.event_type === "search" || row.event_type === "curate" || row.event_type === "show") {
      bucket[row.event_type] = (bucket[row.event_type] ?? 0) + 1;
    }
  }
  return [...days.entries()].map(([date, counts]) => ({ date, ...counts }));
}

async function overview(query: Query) {
  const errors: Record<string, string> = {};
  const since = query.get("since") || "24h";
  // The comparison window is the report window, like `akm health --report`; an absolute `since` has no duration to compare.
  const sinceIsDuration = parseDuration(since, DURATION_UNITS) !== null;

  const health = await section(errors, "health", async () => {
    const base = await akmHealth({
      since,
      groupBy: "run",
      windowCompare: sinceIsDuration ? since : undefined,
      probe: flag(query, "probe"),
      readOnly: true,
    });
    const report = withReadonlyStateDb(
      (db) => ({
        window: since,
        compare: sinceIsDuration ? since : null,
        pendingProposals: listStateProposals(db, { stashDir: tryStashDir() ?? "", status: "pending" }).map(
          ({ ref, source, createdAt }) => ({ ref, source, createdAt }),
        ),
        acceptRateBySource: computeAcceptRateBySource(undefined, { db }),
      }),
      null,
    );
    return { ...base, ...(report ? { report } : {}) };
  });
  const metrics = await section(errors, "metrics", () =>
    akmMetrics({ since: query.get("metricsSince") || "30d", indexSnapshot: false }),
  );
  const stateReads = await section(errors, "state", () =>
    withReadonlyStateDb(
      (db) => ({
        improveRuns: listRecentImproveRuns(db, IMPROVE_RUNS_SHOWN).map(summarizeImproveRun),
        usageByDay: usageByDay(db, Date.now()),
      }),
      null,
    ),
  );
  return {
    health,
    metrics,
    improveRuns: stateReads?.improveRuns ?? [],
    usageByDay: stateReads?.usageByDay ?? [],
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

// ── /api/bundles ─────────────────────────────────────────────────────────────

async function bundles() {
  const config = loadConfig();
  const listing = await akmListSources({ stashDir: tryStashDir() ?? "" });
  const cards = await Promise.all(
    listing.sources.map(async (source) => ({
      name: source.name,
      kind: source.kind,
      default: source.default,
      source: source.source,
      path: source.path ?? null,
      writable: source.writable,
      enabled: config.bundles?.[source.name]?.enabled !== false,
      writableSetting: config.bundles?.[source.name]?.writable,
      components: source.components.map((component) => ({
        ...component,
        configured: !!config.bundles?.[source.name]?.components?.[component.name],
      })),
      settingsSource: configSource(["bundles", source.name]),
      version: source.version ?? null,
      exists: source.status.exists,
      itemCount: source.itemCount,
      byType: source.byType,
      git: source.path ? await readBundleGitStatus(source.path) : null,
    })),
  );

  const info = assembleInfo();
  let embeddingCount: number | null = null;
  try {
    const db = openReadonlyExistingDatabase(getDbPath());
    if (db) {
      try {
        embeddingCount = getEmbeddingCount(db);
      } finally {
        closeDatabase(db);
      }
    }
  } catch {
    // An index without an embeddings table (older layout) has none.
  }
  const entryCount = info.indexStats.entryCount;
  return {
    defaultBundle: config.defaultBundle ?? null,
    defaultWriteTarget: config.defaultWriteTarget ?? null,
    bundles: cards,
    index: {
      entryCount,
      byType: info.indexStats.byType,
      lastBuiltAt: info.indexStats.lastBuiltAt,
      hasEmbeddings: info.indexStats.hasEmbeddings,
      embeddingCount,
      embeddingCoverage: embeddingCount !== null && entryCount > 0 ? Math.min(1, embeddingCount / entryCount) : null,
      semanticSearch: info.semanticSearch,
      ...(info.indexStats.links ? { links: info.indexStats.links } : {}),
      ...(info.indexStats.unavailable ? { unavailable: info.indexStats.unavailable } : {}),
      ...(info.indexStats.unreadable ? { unreadable: info.indexStats.unreadable } : {}),
    },
  };
}

// ── /api/config ──────────────────────────────────────────────────────────────

interface ConfigEntry {
  path: string;
  value: unknown;
  /** `default`, `file` (this install's config.json) or `extends:<ref>`; `null` when the key cannot be traced. */
  source: string | null;
}

/** Flatten to dotted leaf paths. Arrays and empty objects are leaves, matching how config layers merge. */
function configLeaves(value: unknown, prefix: string[], out: Array<{ path: string[]; value: unknown }>): void {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) configLeaves(child, [...prefix, key], out);
    return;
  }
  out.push({ path: prefix, value });
}

function configSource(path: string[]): string | null {
  // `getConfigValueSource` takes a dotted path; a key that contains a dot cannot be told apart from two keys.
  if (path.some((segment) => segment.includes("."))) return null;
  try {
    const source = getConfigValueSource(path.join("."));
    return source === "local" ? "file" : source;
  } catch {
    return null;
  }
}

function config() {
  const effective = redactForUi(listConfig(loadConfig())) as Record<string, unknown>;
  const leaves: Array<{ path: string[]; value: unknown }> = [];
  configLeaves(effective, [], leaves);
  const entries: ConfigEntry[] = leaves.map(({ path, value }) => ({
    path: path.join("."),
    value,
    source: configSource(path),
  }));
  const engines = Object.entries((effective.engines ?? {}) as Record<string, unknown>).map(([name, engine]) => ({
    name,
    ...(engine as Record<string, unknown>),
  }));
  const env = Object.keys(process.env)
    .filter((name) => name.startsWith("AKM_"))
    .sort()
    .map((name) => ({ name, value: isSecretEnvName(name) ? "[redacted]" : (process.env[name] ?? "") }));
  const configPath = getConfigPath();
  return { path: configPath, exists: fs.existsSync(configPath), config: effective, entries, engines, env };
}

// ── /api/proposals ───────────────────────────────────────────────────────────

export function proposalSummary(proposal: Proposal) {
  const retirement = proposal.retirement;
  return {
    id: proposal.id,
    source: proposal.source,
    ref: proposal.ref,
    status: proposal.status,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    waitingSince: proposalWaitingSince(proposal),
    confidence: proposal.confidence ?? null,
    gateDecision: proposal.gateDecision ?? null,
    review: proposal.review ?? null,
    isRetire: isRetireProposal(proposal),
    retirement: retirement
      ? {
          retiredRef: retirement.retiredRef,
          successorRef: retirement.successorRef,
          reason: retirement.reason,
          judgeLabel: retirement.judgeLabel,
          judgeReason: retirement.judgeReason,
          cosine: retirement.cosine,
          onlyInRetired: retirement.onlyInRetired ?? [],
          onlyInSuccessor: retirement.onlyInSuccessor ?? [],
          continuityRisk: retirement.continuityRisk ?? null,
        }
      : null,
  };
}

const RECENT_STATUSES = new Set(["accepted", "rejected", "reverted"]);

function proposals(query: Query) {
  const status = query.get("status") || "pending";
  if (status !== "pending" && status !== "recent") {
    throw new UsageError(`Invalid status "${status}". Expected pending or recent.`, "INVALID_FLAG_VALUE");
  }
  const limit = limitParam(query, 100);
  return withReadonlyStateDb(
    (db) => {
      const all = listStateProposals(db, { stashDir: resolveStashDir() });
      const picked =
        status === "pending"
          ? all
              .filter((p) => p.status === "pending")
              .sort((a, b) => Date.parse(proposalWaitingSince(a)) - Date.parse(proposalWaitingSince(b)))
          : all
              .filter((p) => RECENT_STATUSES.has(p.status))
              .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const bySource: Record<string, number> = {};
      for (const proposal of picked) bySource[proposal.source] = (bySource[proposal.source] ?? 0) + 1;
      return {
        status,
        totalCount: picked.length,
        bySource,
        proposals: picked.slice(0, limit).map(proposalSummary),
      };
    },
    { status, totalCount: 0, bySource: {}, proposals: [] },
  );
}

/** Most characters of either side the detail view returns; a larger file is cut and flagged `truncated`. */
export const DIFF_SIDE_MAX_CHARS = 512 * 1024;

/** True when the proposal's target is an env or secret asset, whose content never leaves the machine's files via the UI. */
function targetsSensitiveAsset(proposal: Proposal): boolean {
  try {
    const type = typeNameFromConceptId(parseBundleRef(proposal.ref).conceptId)?.type;
    return type === "env" || type === "secret";
  } catch {
    return false;
  }
}

function capSide(text: string | null): { text: string | null; truncated: boolean } {
  if (text === null || text.length <= DIFF_SIDE_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, DIFF_SIDE_MAX_CHARS), truncated: true };
}

/**
 * The diff for the detail view: akm's unified text plus both sides, so the client can line them up itself.
 * `before`/`after` come from the same read as `unified` ({@link diffLoadedProposal}); they are `null` for a retire
 * proposal (the file leaves, nothing is proposed) and, with `redacted`, for an env or secret target.
 */
function proposalDiffView(proposal: Proposal) {
  const result = diffLoadedProposal(loadConfig(), proposal);
  const base = { isNew: result.isNew, targetPath: result.targetPath ?? null };
  if (targetsSensitiveAsset(proposal)) {
    return {
      unified: "Env and secret values are never shown in the UI.",
      ...base,
      before: null,
      after: null,
      truncated: false,
      redacted: true,
    };
  }
  if (isRetireProposal(proposal)) {
    return { unified: result.unified, ...base, before: null, after: null, truncated: false, redacted: false };
  }
  const before = capSide(result.existing);
  const after = capSide(result.proposed);
  return {
    unified: result.unified,
    ...base,
    before: before.text,
    after: after.text,
    truncated: before.truncated || after.truncated,
    redacted: false,
  };
}

function proposalDetail(id: string) {
  const detail = withReadonlyStateDb((db) => {
    const proposal = resolveProposalIdIn(db, resolveStashDir(), id);
    let diff: ReturnType<typeof proposalDiffView> | null = null;
    let diffError: string | null = null;
    try {
      diff = proposalDiffView(proposal);
    } catch (error) {
      diffError = error instanceof Error ? error.message : String(error);
    }
    // Content lives in the diff; `backupContent` is "never shown" by contract and the accept intent is internal.
    const { backupContent: _backup, retireAcceptIntent: _intent, payload, changes, ...rest } = proposal;
    return {
      proposal: {
        ...proposalSummary(proposal),
        ...rest,
        payload: { frontmatter: payload.frontmatter ?? null },
        changes: changes.map((change) => ({ op: change.op, path: change.path })),
      },
      validation: validateProposal(proposal),
      diff,
      diffError,
    };
  }, null);
  if (!detail) throw new NotFoundError(`Proposal "${id}" not found: state.db is not available.`, "PROPOSAL_NOT_FOUND");
  return detail;
}

// ── /api/changes ─────────────────────────────────────────────────────────────

async function changes(query: Query) {
  const limit = limitParam(query);
  const target = resolveWriteTarget(loadConfig(), undefined, { requireWritable: false });
  const commits = await readRecentCommits(target.source.path, limit);
  return {
    bundle: target.source.name,
    path: target.source.path,
    git: commits !== null,
    commits: commits ?? [],
  };
}

// ── /api/search and /api/asset ───────────────────────────────────────────────

async function search(query: Query) {
  const type = query.get("type") || undefined;
  const bundle = query.get("bundle") || undefined;
  return akmSearch({
    query: (query.get("q") ?? "").trim(),
    type,
    limit: limitParam(query, 20),
    // `--from <name>` narrows to one configured bundle; absent means every local bundle, as `akm search` does.
    source: bundle ?? "local",
    belief: parseBeliefFilterMode(query.get("belief") || "current"),
    filters: normalizeScopeFilters(
      Object.fromEntries(["user", "agent", "run", "channel"].map((key) => [key, query.get(`scope_${key}`) ?? ""])),
    ),
    readOnly: true,
  });
}

/** The durable `bundle//conceptId` of the indexed asset at `filePath`, the key feedback rows use. */
function durableRefForPath(filePath: string): string | null {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) return null;
  try {
    const id = getEntryIdByFilePath(db, filePath);
    return id === undefined ? null : getItemRefById(db, id);
  } finally {
    closeDatabase(db);
  }
}

function feedbackFor(durableRef: string | null) {
  const empty = { counts: {}, history: [] };
  if (!durableRef) return empty;
  return withReadonlyStateDb((db) => {
    const history = listFeedbackEventRows(db, durableRef, 50).map((row) => {
      let detail: { reason?: unknown; tags?: unknown } = {};
      try {
        detail = row.metadata ? (JSON.parse(row.metadata) as typeof detail) : {};
      } catch {
        // Metadata is optional.
      }
      return {
        // `created_at` is SQLite's `YYYY-MM-DD HH:MM:SS` in UTC.
        at: new Date(`${row.created_at.replace(" ", "T")}Z`).toISOString(),
        signal: row.signal,
        source: row.source,
        ...(typeof detail.reason === "string" ? { reason: detail.reason } : {}),
        ...(Array.isArray(detail.tags) ? { tags: detail.tags } : {}),
      };
    });
    return { counts: countFeedbackBySignal(db, durableRef), history };
  }, empty);
}

async function asset(query: Query) {
  const ref = (query.get("ref") ?? "").trim();
  if (!ref) throw new UsageError("An asset ref is required: /api/asset?ref=<ref>.", "MISSING_REQUIRED_ARGUMENT");
  const parsed = parseBundleRef(ref);
  const type = typeNameFromConceptId(parsed.conceptId)?.type;
  if (type === "env" || type === "secret") {
    // Values never leave the machine's own files through the UI, whatever the renderers would show.
    return { redacted: true, type, ref, note: "Env and secret values are never shown in the UI." };
  }
  const shown = await akmShowUnified({ ref, readOnly: true });
  const durableRef = shown.path ? durableRefForPath(shown.path) : null;
  const content = shown.content ?? "";
  const headings = parseMarkdownToc(content).headings;
  const slugs = markdownFragmentSlugs(content);
  const links: Record<string, string> = {};
  if (shown.path && durableRef) {
    const owner = parseBundleRef(durableRef).bundle;
    const db = openReadonlyExistingDatabase(getDbPath());
    if (db) {
      try {
        for (const raw of markdownLinkTargets(content, false)) {
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
          const [file, fragment] = raw.split("#", 2);
          if (!file?.toLowerCase().endsWith(".md") || file.startsWith("/")) continue;
          let decoded: string;
          try {
            decoded = decodeURIComponent(file);
          } catch {
            continue;
          }
          const id = getEntryIdByFilePath(db, path.resolve(path.dirname(shown.path), decoded));
          const target = id === undefined ? undefined : getItemRefById(db, id);
          if (target && parseBundleRef(target).bundle === owner) links[raw] = target + (fragment ? `#${fragment}` : "");
        }
      } finally {
        closeDatabase(db);
      }
    }
  }
  let slugIndex = 0;
  return {
    redacted: false,
    durableRef,
    bundle: durableRef ? parseBundleRef(durableRef).bundle : null,
    asset: shown,
    feedback: feedbackFor(durableRef),
    feedbackRequireReason: loadConfig().feedback?.requireReason !== false,
    links,
    headings: headings.map((heading) => ({
      ...heading,
      slug: markdownHeadingSlug(heading.text) ? slugs[slugIndex++] : "",
    })),
  };
}

async function assetHistory(query: Query) {
  const selected = await asset(query);
  if (selected.redacted || !selected.asset?.path) return { available: false, commits: [] };
  const source = findSourceForPath(selected.asset.path, resolveSourceEntries(undefined, loadConfig()));
  if (!source) return { available: false, commits: [] };
  const file = path.relative(source.path, selected.asset.path).split(path.sep).join("/");
  if (file.startsWith("../") || path.isAbsolute(file)) throw new UsageError("Asset path is outside its bundle.");
  const commits = await readRecentCommits(source.path, limitParam(query, 30), file);
  const revision = query.get("revision");
  if (revision && !commits?.some((commit) => commit.sha === revision))
    throw new UsageError("Choose a revision from this asset's history.");
  const diff = revision ? await readFileRevision(source.path, file, revision) : null;
  const before = capSide(diff?.before ?? null);
  const after = capSide(diff?.after ?? null);
  return {
    available: commits !== null,
    commits: commits ?? [],
    ...(diff
      ? {
          diff: {
            before: before.text,
            after: after.text,
            unified: diff.unified.slice(0, DIFF_SIDE_MAX_CHARS),
            truncated: before.truncated || after.truncated || diff.unified.length > DIFF_SIDE_MAX_CHARS,
          },
        }
      : {}),
  };
}

// ── Routing ──────────────────────────────────────────────────────────────────

const ROUTES: Record<string, Handler> = {
  "/api/meta": meta,
  "/api/overview": overview,
  "/api/bundles": bundles,
  "/api/config": config,
  "/api/proposals": proposals,
  "/api/changes": changes,
  "/api/search": search,
  "/api/asset": asset,
  "/api/asset/history": assetHistory,
};

const PROPOSAL_ROUTE = /^\/api\/proposals\/([^/]+)$/;

/** What {@link handleApiRequest} returns for a path that is not an API route. */
export const NO_SUCH_ROUTE = Symbol("no-such-route");

/** Dispatch one `/api/...` request; handler errors propagate, an unknown route is {@link NO_SUCH_ROUTE}. */
export async function handleApiRequest(pathname: string, query: Query, info: UiServerInfo): Promise<unknown> {
  const route = ROUTES[pathname];
  if (route) return route(query, info);
  const proposalMatch = PROPOSAL_ROUTE.exec(pathname);
  if (proposalMatch) return proposalDetail(decodeURIComponent(proposalMatch[1] as string));
  return NO_SUCH_ROUTE;
}
