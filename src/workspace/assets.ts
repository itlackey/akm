// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Assets: search, one asset with its feedback and links, its history, what is related, what improve did with it. */

import path from "node:path";
import { akmRelated } from "../commands/read/related";
import { akmSearch, narrowSourcesToName, normalizeScopeFilters, parseBeliefFilterMode } from "../commands/read/search";
import { akmShowUnified } from "../commands/read/show";
import { parseBundleRef } from "../core/asset/asset-ref";
import { parseMarkdownToc, uniqueHeadingSlugs } from "../core/asset/markdown";
import { markdownLinkTargets } from "../core/asset/markdown-link-targets";
import { loadConfig } from "../core/config/config";
import { resolveRefOwner } from "../core/env-secret-ref";
import { UsageError } from "../core/errors";
import { getDbPath } from "../core/paths";
import { projectView, resolveProject } from "../core/projects";
import type { ScopeFilters } from "../indexer/passes/metadata";
import { resolveReadSources } from "../indexer/read-preflight";
import { countBrowseEntries } from "../indexer/search/db-search";
import { findSourceForPath, resolveSourceEntries } from "../indexer/search/search-source";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getEntryIdByFilePath, getItemRefById } from "../storage/repositories/index-entries-repository";
import { countFeedbackBySignal, listFeedbackEventRows } from "../storage/repositories/metrics-repository";
import { assetImprove } from "./asset-improve";
import { bundleFileLocation, listBundleFiles } from "./bundle-files";
import { readFileRevision, readRecentCommits } from "./git-read";
import { automaticWriteTarget, capSide, clampLimit, DIFF_SIDE_MAX_CHARS, withReadonlyStateDb } from "./readers";

export { searchMisses } from "./misses";

export interface SearchInput {
  q: string;
  type?: string;
  /** One configured bundle; absent means every local bundle, as `akm search` does. */
  bundle?: string;
  belief?: string;
  scope?: ScopeFilters;
  /**
   * A configured project (`akm search --project`): its `from` bundles, `filters` and `prefer` apply where this input does
   * not name that kind itself (a `bundle` replaces `from`, a non-blank `scope` replaces `filters`). Absent: no project,
   * and ordinary Library behavior. The response then carries `project`.
   */
  project?: string;
  limit?: number;
}

/** Browse keeps its contract that blank scope values are omitted (an empty filter value would mean "without the key"). */
function blanksOmitted(scope: ScopeFilters | undefined): ScopeFilters | undefined {
  if (!scope) return undefined;
  const out: ScopeFilters = Object.create(null);
  for (const [key, given] of Object.entries(scope)) {
    const kept = [given ?? []].flat().filter((value) => typeof value === "string" && value.trim());
    if (kept.length > 0) out[key] = kept;
  }
  return out;
}

export async function search(input: SearchInput) {
  const type = input.type || undefined;
  const bundle = input.bundle || undefined;
  const project = input.project?.trim() ? resolveProject(loadConfig(), { project: input.project.trim() }) : undefined;
  const scope = normalizeScopeFilters(blanksOmitted(input.scope));
  const filters = scope && Object.keys(scope).length > 0 ? scope : project?.filters;
  const from = bundle ?? project?.from;
  const result = await akmSearch({
    query: (input.q ?? "").trim(),
    type,
    limit: clampLimit(input.limit, 20),
    // `--from <name>` narrows to one configured bundle; absent means every local bundle, as `akm search` does.
    source: from ?? "local",
    belief: parseBeliefFilterMode(input.belief || "current"),
    filters,
    prefer: project?.prefer,
    readOnly: true,
  });
  return project ? { ...result, project: projectView({ ...project, from, filters }) } : result;
}

/**
 * What a project resolves to, and what its bundles hold: the read bundles it selects (its `from`, else every local
 * bundle), the write bundle, and per bundle how many assets a browse lists (`total`) and how many of those satisfy the
 * project's `filters` (`eligible`), counted over the whole index. `prefer` only orders results; it never changes a count.
 * Counts are `null` where the bundle cannot be read or nothing is indexed.
 */
export function projectOverview(input: { project: string }) {
  const name = (input.project ?? "").trim();
  if (!name) throw new UsageError("A project name is required.", "MISSING_REQUIRED_ARGUMENT");
  const config = loadConfig();
  const project = resolveProject(config, { project: name });
  if (!project) throw new UsageError(`"${name}" selects no project.`, "INVALID_FLAG_VALUE");
  const local = resolveReadSources(undefined, config).sources;
  const selected =
    project.from === undefined
      ? local.map((source) => ({ name: source.registryId ?? source.path, source }))
      : [project.from].flat().map((from) => ({ name: from, source: narrowSourcesToName(local, [from])[0] }));
  const readable = selected.flatMap((bundle) => (bundle.source ? [bundle.source] : []));
  let counts: ReturnType<typeof countBrowseEntries> | undefined;
  const db = readable.length > 0 ? openReadonlyExistingDatabase(getDbPath()) : undefined;
  if (db) {
    try {
      counts = countBrowseEntries(db, readable, project.filters, config.search?.defaultExcludeTypes ?? ["session"]);
    } finally {
      closeDatabase(db);
    }
  }
  const writeName = project.write.bundle ?? automaticWriteTarget(config)?.name ?? null;
  const writeSource = writeName === null ? undefined : local.find((source) => source.registryId === writeName);
  return {
    project: { ...projectView(project), write: project.write },
    fromImplicit: project.from === undefined,
    preferImplicit: config.projects?.[name]?.prefer === undefined,
    // `usable`: the bundle is enabled and accepts writes. Null when no write bundle resolves.
    writeBundle: {
      name: writeName,
      implicit: project.write.bundle === undefined,
      usable: writeName === null ? null : writeSource?.writable === true,
    },
    bundles: selected.map(({ name: bundle, source }) => {
      const entry = Object.hasOwn(config.bundles ?? {}, bundle) ? config.bundles?.[bundle] : undefined;
      const found = source ? counts?.[readable.indexOf(source)] : undefined;
      return {
        name: bundle,
        configured: entry !== undefined,
        enabled: entry === undefined ? false : entry.enabled !== false,
        readable: source !== undefined,
        writable: source?.writable ?? false,
        type: source?.type ?? entry?.type ?? null,
        total: found?.total ?? null,
        eligible: found?.eligible ?? null,
      };
    }),
  };
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

export async function show(input: { ref: string }) {
  const ref = (input.ref ?? "").trim();
  if (!ref) throw new UsageError("An asset ref is required.", "MISSING_REQUIRED_ARGUMENT");
  const type = resolveRefOwner(ref)?.type;
  if (type === "env" || type === "secret") {
    // Values never leave the machine's own files through the UI, whatever the renderers would show.
    return { redacted: true, type, ref, note: "Env and secret values are never shown in the UI." };
  }
  const shown = await akmShowUnified({ ref, readOnly: true });
  const durableRef = shown.path ? durableRefForPath(shown.path) : null;
  const content = shown.content ?? "";
  const headings = parseMarkdownToc(content).headings;
  const slugs = uniqueHeadingSlugs(headings);
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
  return {
    redacted: false,
    durableRef,
    bundle: durableRef ? parseBundleRef(durableRef).bundle : null,
    asset: shown,
    location: shown.path ? bundleFileLocation(shown.path) : null,
    feedback: feedbackFor(durableRef),
    feedbackRequireReason: loadConfig().feedback?.requireReason !== false,
    links,
    headings: headings.map((heading, i) => ({ ...heading, slug: slugs[i] })),
  };
}

export async function history(input: { ref: string; revision?: string; limit?: number }) {
  const selected = await show(input);
  if (selected.redacted || !selected.asset?.path) return { available: false, commits: [] };
  const source = findSourceForPath(selected.asset.path, resolveSourceEntries(undefined, loadConfig()));
  if (!source) return { available: false, commits: [] };
  const file = path.relative(source.path, selected.asset.path).split(path.sep).join("/");
  if (file.startsWith("../") || path.isAbsolute(file)) throw new UsageError("Asset path is outside its bundle.");
  const commits = await readRecentCommits(source.path, clampLimit(input.limit, 30), file);
  const revision = input.revision;
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

export async function related(input: { ref: string; scope?: "all" | "bundle" }) {
  const scope = input.scope ?? "all";
  if (scope !== "all" && scope !== "bundle") throw new UsageError("scope must be all or bundle.");
  const ref = (input.ref ?? "").trim();
  if (!ref) throw new UsageError("An asset ref is required.", "MISSING_REQUIRED_ARGUMENT");
  return akmRelated(ref, scope);
}

/** What improve proposed for one asset, how it was decided, and how the asset has been used since. */
export const improvement = assetImprove;

export function bundleFiles(input: { bundle: string; path?: string; hidden?: boolean }) {
  return listBundleFiles(input.bundle ?? "", input.path ?? "", input.hidden === true);
}
