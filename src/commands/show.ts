/**
 * `akm show` — entry point.
 *
 * Spec §6.2:
 *
 *   show(ref) → indexer.lookup(ref) → readFile(entry.filePath)
 *
 * The richer presentation logic (matchers, renderers, wiki-root handling,
 * edit-hints, summary-detail truncation) lives below in this file. The flow:
 *
 *   1. Special-case wiki-root refs (`wiki:<name>` with no page path).
 *   2. Ask `indexer.lookup(ref)` for the row in the FTS index.
 *   3. Fall back to the on-disk type-dir resolver only when the index has
 *      no matching row — covers the "indexed yet?" gap when the user has
 *      just added a file and not run `akm index`.
 *   4. Render the file via the matcher/renderer pipeline.
 *
 * Step (2) is the v1 spec change: reading is the indexer's job. Step (3) is a
 * pragmatic safety net (NOT remote provider fallback, which the spec
 * forbids — "Show: Local FTS5 index only. No remote provider fallback.").
 */

import fs from "node:fs";
import path from "node:path";
import { type AssetRef, parseAssetRef } from "../core/asset-ref";
import { loadConfig } from "../core/config";
import { NotFoundError, UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { parseFrontmatter, toStringOrUndefined } from "../core/frontmatter";
import { closeDatabase, findEntryIdByRef, openDatabase } from "../indexer/db";
import { buildFileContext, buildRenderContext, getRenderer, runMatchers } from "../indexer/file-context";
import { lookup } from "../indexer/indexer";
import { loadStashFile, type StashEntryScope } from "../indexer/metadata";
import { buildEditHint, findSourceForPath, isEditable, resolveSourceEntries } from "../indexer/search-source";
import { insertUsageEvent } from "../indexer/usage-events";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
// Eagerly import source providers to trigger self-registration.
import "../sources/providers/index";
import { resolveAssetPath } from "../sources/resolve";
import type { KnowledgeView, ShowDetailLevel, ShowResponse } from "../sources/types";

/**
 * Show a wiki root (no page path) — returns the same payload as
 * `akm wiki show <name>`.
 */
async function showWikiRoot(stashDir: string, wikiName: string): Promise<ShowResponse> {
  const { showWiki } = await import("../wiki/wiki.js");
  const result = showWiki(stashDir, wikiName);
  return {
    type: "wiki",
    name: result.ref,
    path: result.path,
    ...(result.description ? { description: result.description } : {}),
    origin: null,
    editable: false,
    pages: result.pages,
    raws: result.raws,
    ...(result.lastModified ? { lastModified: result.lastModified } : {}),
    recentLog: result.recentLog,
  } as unknown as ShowResponse;
}

async function showWikiRootForSource(
  stashDir: string,
  source: { path: string; wikiName?: string },
  wikiName: string,
): Promise<ShowResponse> {
  const { showWikiAtPath } = await import("../wiki/wiki.js");
  if (source.wikiName === wikiName) {
    const result = showWikiAtPath(wikiName, source.path);
    return {
      type: "wiki",
      name: result.ref,
      path: result.path,
      ...(result.description ? { description: result.description } : {}),
      origin: null,
      editable: false,
      pages: result.pages,
      raws: result.raws,
      ...(result.lastModified ? { lastModified: result.lastModified } : {}),
      recentLog: result.recentLog,
    } as unknown as ShowResponse;
  }
  return showWikiRoot(stashDir, wikiName);
}

function resolveRegisteredWikiAssetPath(wikiRoot: string, wikiName: string, assetName: string): string {
  const pageName = assetName === wikiName ? "" : assetName.slice(wikiName.length + 1);
  if (!pageName) {
    throw new NotFoundError(`Wiki page not found: wiki:${assetName}`);
  }
  const candidate = path.resolve(wikiRoot, `${pageName}.md`);
  const resolvedRoot = fs.realpathSync(wikiRoot);
  if (!candidate.startsWith(resolvedRoot + path.sep)) {
    throw new UsageError("Ref resolves outside the stash root.", "PATH_ESCAPE_VIOLATION");
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new NotFoundError(`Stash asset not found for ref: wiki:${assetName}`);
  }
  const realTarget = fs.realpathSync(candidate);
  if (!realTarget.startsWith(resolvedRoot + path.sep)) {
    throw new UsageError("Ref resolves outside the stash root.", "PATH_ESCAPE_VIOLATION");
  }
  return realTarget;
}

/**
 * Unified show: queries the local FTS5 index, then falls back to on-disk
 * type-dir resolution if the index has no row. Spec §6.2; no remote provider
 * fallback.
 *
 * When `detail` is `"brief"` or `"summary"`, the response omits
 * content/template/prompt and returns compact metadata.
 */
export async function akmShowUnified(input: {
  ref: string;
  view?: KnowledgeView;
  detail?: ShowDetailLevel;
  /**
   * Optional scope filter. When supplied, the resolved asset's frontmatter
   * `scope_user`/`scope_agent`/`scope_run`/`scope_channel` keys must match
   * every supplied filter value. A mismatch (or no scope on disk) raises a
   * {@link NotFoundError} so callers can distinguish "asset exists but is
   * out of scope" from "asset truly absent" via the standard error envelope.
   */
  scope?: StashEntryScope;
}): Promise<ShowResponse> {
  const ref = input.ref.trim();

  // 0. Wiki-root shortcut: `wiki:<name>` with no page path routes to the
  //    wiki summary (same payload as `akm wiki show <name>`). Honour
  //    `parsed.origin` by resolving against the matching stash source(s),
  //    falling back to the primary stash when no origin is given.
  {
    const parsed = parseAssetRef(ref);
    if (parsed.type === "wiki" && !parsed.name.includes("/")) {
      const allSources = resolveSourceEntries();
      const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);
      let lastError: NotFoundError | undefined;
      for (const source of searchSources) {
        try {
          return await showWikiRootForSource(allSources[0]?.path ?? source.path, source, parsed.name);
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
          lastError = err;
        }
      }
      throw (
        lastError ??
        new NotFoundError(`Wiki not found: ${parsed.name}. Run \`akm wiki create ${parsed.name}\` to create it.`)
      );
    }
  }

  // Try local filesystem (FTS5 index lookup, then on-disk fallback)
  const result = await showLocal(input);
  // Scope filter narrows resolution: if --scope was supplied, the asset's
  // frontmatter scope must satisfy every supplied key. We re-read the file
  // (cheap — already on the show hot path) so we don't have to thread scope
  // through the renderer chain just for one verification step.
  if (input.scope && hasAnyScopeKey(input.scope) && result.path) {
    enforceScopeOrThrow(result.path, ref, input.scope);
  }
  logShowEvent(ref);
  return result;
}

function hasAnyScopeKey(scope: StashEntryScope): boolean {
  return Boolean(scope.user || scope.agent || scope.run || scope.channel);
}

/**
 * Read the asset file's frontmatter and verify its `scope_*` keys satisfy
 * every supplied filter. Throws a {@link NotFoundError} on mismatch so the
 * caller surfaces a uniform "not found in this scope" envelope rather than
 * leaking out-of-scope content.
 */
function enforceScopeOrThrow(filePath: string, ref: string, scope: StashEntryScope): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    // The file path was just resolved by the indexer/disk-walk — a read
    // failure here means the on-disk state moved out from under us. Treat
    // that as "not found in this scope" so the caller does not learn the
    // file's prior contents.
    throw new NotFoundError(`Asset not found for scope filter: ${ref}`);
  }
  const fm = parseFrontmatter(raw).data;
  const expected: Array<[keyof StashEntryScope, string | undefined]> = [
    ["user", scope.user],
    ["agent", scope.agent],
    ["run", scope.run],
    ["channel", scope.channel],
  ];
  for (const [key, expectedValue] of expected) {
    if (expectedValue === undefined) continue;
    const actual = toStringOrUndefined(fm[`scope_${key}`]);
    if (actual !== expectedValue) {
      throw new NotFoundError(`Asset "${ref}" exists but is out of scope (expected scope_${key}="${expectedValue}").`);
    }
  }
}

function logShowEvent(ref: string, existingDb?: import("bun:sqlite").Database): void {
  // Emit a structured event to events.jsonl so workflow-trace consumers
  // detect akm show invocations without relying on stdout scraping.
  const parsed = parseAssetRef(ref);
  appendEvent({ eventType: "show", ref, metadata: { type: parsed.type, name: parsed.name } });

  try {
    const db = existingDb ?? openDatabase();
    try {
      insertUsageEvent(db, {
        event_type: "show",
        entry_ref: ref,
        entry_id: findEntryIdByRef(db, ref),
      });
    } finally {
      if (!existingDb) closeDatabase(db);
    }
  } catch {
    /* fire-and-forget */
  }
}

/**
 * Resolve an asset path to a file via:
 *   1. `indexer.lookup(ref)` — the spec's primary path (§6.2).
 *   2. On-disk type-dir traversal — fallback for files not yet indexed.
 *
 * Returns `undefined` if neither path finds a match.
 */
async function resolvePathViaIndexThenDisk(
  parsed: AssetRef,
  searchSourceDirs: string[],
): Promise<{ assetPath: string; lastError?: Error } | undefined> {
  // Step 1: indexer
  try {
    const entry = await lookup(parsed);
    if (entry) {
      return { assetPath: entry.filePath };
    }
  } catch (err) {
    // Index unavailable (e.g. DB doesn't exist yet) — fall back to disk walk.
    if (!(err instanceof NotFoundError)) {
      // continue to disk fallback
    }
  }

  // Step 2: on-disk type-dir traversal
  let lastError: Error | undefined;
  for (const dir of searchSourceDirs) {
    try {
      const assetPath = await resolveAssetPath(dir, parsed.type, parsed.name);
      return { assetPath, lastError };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  return lastError ? { assetPath: "", lastError } : undefined;
}

/** @internal Use akmShowUnified() for all external callers. */
export async function showLocal(input: {
  ref: string;
  view?: KnowledgeView;
  detail?: ShowDetailLevel;
  stashDir?: string;
}): Promise<ShowResponse> {
  const parsed = parseAssetRef(input.ref);
  const displayType = parsed.type;
  const config = loadConfig();
  const allSources = resolveSourceEntries(input.stashDir);
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);

  const allSourceDirs = searchSources.map((s) => s.path);

  let assetPath: string | undefined;
  const matchedSource =
    parsed.type === "wiki" ? searchSources.find((source) => parsed.name.startsWith(`${source.wikiName}/`)) : undefined;
  let lastError: Error | undefined;
  if (parsed.type === "wiki" && matchedSource?.wikiName) {
    try {
      assetPath = resolveRegisteredWikiAssetPath(matchedSource.path, matchedSource.wikiName, parsed.name);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (!assetPath) {
    const resolved = await resolvePathViaIndexThenDisk(parsed, allSourceDirs);
    if (resolved?.assetPath) {
      assetPath = resolved.assetPath;
    } else if (resolved?.lastError) {
      lastError = resolved.lastError;
    }
  }

  if (!assetPath && parsed.origin && searchSources.length === 0) {
    const installCmd = `akm add ${parsed.origin}`;
    throw new NotFoundError(
      `Stash asset not found for ref: ${displayType}:${parsed.name}. ` +
        `Stash "${parsed.origin}" is not installed. Run: ${installCmd}`,
    );
  }

  if (!assetPath) {
    throw (
      lastError ??
      new NotFoundError(
        `Stash asset not found for ref: ${displayType}:${parsed.name}. ` +
          "Check the name with `akm search` or verify the asset exists in your stash.",
      )
    );
  }

  const source = matchedSource ?? findSourceForPath(assetPath, allSources);
  const sourceStashDir = source?.path ?? allSourceDirs[0];

  if (!sourceStashDir) {
    throw new UsageError(
      `Could not determine stash root for asset: ${displayType}:${parsed.name}. ` +
        "Run `akm init` to create the stash directory, or check `akm stash list` for configured paths.",
    );
  }

  const fileCtx = buildFileContext(sourceStashDir, assetPath);
  const forcedWikiMatch =
    parsed.type === "wiki" && source?.wikiName && parsed.name.startsWith(`${source.wikiName}/`)
      ? { type: "wiki", specificity: 20, renderer: "wiki-md", meta: {} }
      : undefined;
  const match = forcedWikiMatch ?? (await runMatchers(fileCtx));
  if (!match) {
    throw new UsageError(
      `Could not display asset "${displayType}:${parsed.name}" — unsupported file type or unrecognized layout`,
    );
  }

  match.meta = { ...match.meta, name: parsed.name, view: input.view };
  const renderer = await getRenderer(match.renderer);
  if (!renderer) {
    throw new UsageError(`Renderer "${match.renderer}" not found for asset: ${displayType}:${parsed.name}`);
  }

  const renderCtx = buildRenderContext(fileCtx, match, allSourceDirs, source?.registryId);
  const response = renderer.buildShowResponse(renderCtx);
  const editable = isEditable(assetPath, config);
  const fullResponse: ShowResponse = {
    ...response,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(assetPath, parsed.type, parsed.name, source?.registryId) } : {}),
  };

  if (input.detail === "brief") {
    return buildBriefResponse(fullResponse, assetPath);
  }

  if (input.detail === "summary") {
    return buildSummaryResponse(fullResponse, assetPath);
  }

  return fullResponse;
}

/**
 * Minimal `show`: ref → indexer lookup → file contents. Used by callers that
 * just need the raw file (e.g. clone, write-source) and don't want the full
 * renderer graph. Spec §6.2's literal flow.
 */
export async function showByRef(ref: string): Promise<{ filePath: string; body: string }> {
  const parsed = parseAssetRef(ref);
  const entry = await lookup(parsed);
  if (!entry) {
    throw new NotFoundError(`Asset not found for ref: ${parsed.type}:${parsed.name}`);
  }
  const body = await fs.promises.readFile(entry.filePath, "utf8");
  return { filePath: entry.filePath, body };
}

/**
 * Build a reduced brief response from a full ShowResponse.
 *
 * Keeps routing/identification fields while omitting content/template/prompt.
 */
function buildBriefResponse(full: ShowResponse, assetPath?: string): ShowResponse {
  const summary = buildSummaryResponse(full, assetPath);
  return {
    type: summary.type,
    name: summary.name,
    path: summary.path,
    ...(summary.description ? { description: summary.description } : {}),
    ...(summary.action ? { action: summary.action } : {}),
    ...(summary.run ? { run: summary.run } : {}),
    ...(summary.origin !== undefined ? { origin: summary.origin } : {}),
    ...(full.editable !== undefined ? { editable: full.editable } : {}),
  };
}

/**
 * Build a compact summary response from a full ShowResponse.
 *
 * Strips content/template/prompt and returns only metadata fields:
 * type, name, path, description, tags, parameters, action.
 * Enriches description and tags from frontmatter or .stash.json when available.
 *
 * The resulting JSON should be under 200 tokens.
 */
function buildSummaryResponse(full: ShowResponse, assetPath?: string): ShowResponse {
  let description = full.description;
  let tags = full.tags;

  if (assetPath) {
    const textContent = full.content ?? full.template ?? full.prompt;
    if (textContent && !description) {
      const parsed = parseFrontmatter(textContent);
      description = toStringOrUndefined(parsed.data.description);
    }

    const dir = path.dirname(assetPath);
    const stashFile = loadStashFile(dir);
    if (stashFile) {
      const fileName = path.basename(assetPath);
      const entry = stashFile.entries.find((e) => e.filename === fileName);
      if (entry) {
        if (!description && entry.description) {
          description = entry.description;
        }
        if (!tags && entry.tags) {
          tags = entry.tags;
        }
      }
    }
  }

  const summary: ShowResponse = {
    type: full.type,
    name: full.name,
    path: full.path,
    ...(description ? { description } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(full.parameters ? { parameters: full.parameters } : {}),
    ...(full.workflowTitle ? { workflowTitle: full.workflowTitle } : {}),
    ...(full.action ? { action: full.action } : {}),
    ...(full.run ? { run: full.run } : {}),
    ...(full.origin !== undefined ? { origin: full.origin } : {}),
  };

  return summary;
}
