// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm show` — entry point.
 *
 * Spec §6.2:
 *
 *   show(ref) → indexer.lookup(ref) → readFile(entry.filePath)
 *
 * The richer presentation logic (matchers, renderers, edit-hints,
 * summary-detail truncation) lives below in this file. The flow:
 *
 *   1. Auto-index when stale so the index is current.
 *   2. Ask `indexer.lookup(ref)` for the row in the FTS index.
 *   3. Render the file via the matcher/renderer pipeline.
 */

import fs from "node:fs";
import { type CittyArgsDefinitionForScan, findCittyTopLevelCommandIndex } from "../../cli/parse-args";
import { recognizeMatch } from "../../core/adapter/recognize-match";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { displayRef, parseQualifiedRefInput } from "../../core/asset/resolve-ref";
import { META_DIR, type MetaRef, parseMetaRef, resolveMetaFilePath } from "../../core/asset/stash-meta";
import { asNonEmptyString } from "../../core/common";
import { getIndexPassConfig, loadConfig } from "../../core/config/config";
import { NotFoundError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent, readEvents } from "../../core/events";
import { withStateDbTelemetry } from "../../core/state-db";
import { hasGraphData } from "../../indexer/db/graph-db";
import { listRelatedPathsForFile } from "../../indexer/graph/graph-boost";
import { extractGraphForSingleFile } from "../../indexer/graph/graph-extraction";
import { lookup } from "../../indexer/indexer";
import type { StashEntryScope } from "../../indexer/passes/metadata";
import { ensurePrimaryIndexForRead, resolveReadSources } from "../../indexer/read-preflight";
import { buildEditHint, findSourceForPath, isEditable, resolveSourceEntries } from "../../indexer/search/search-source";
import { insertUsageEvent, type UsageEventSource } from "../../indexer/usage/usage-events";
import { buildFileContext, buildRenderContext, getRenderer } from "../../indexer/walk/file-context";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import { resolveIndexPassLLM } from "../../llm/index-passes";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { resolveStorageLocations } from "../../storage/locations";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
import {
  findEntryIdByRef,
  getEntryIdByFilePath,
  getItemRefById,
} from "../../storage/repositories/index-entries-repository";
import { computeBodyHash } from "../../storage/repositories/index-llm-cache-repository";
// Eagerly import source providers to trigger self-registration.
import "../../sources/providers/index";
import type { KnowledgeView, ShowDetailLevel, ShowResponse } from "../../sources/types";
import { getCurrentWorkflowScopeKey } from "../../workflows/authoring/scope-key";
import { getActiveWorkflowRun } from "../../workflows/runtime/runs";

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
  /**
   * Event source for usage logging. Defaults to `"user"`. Set to
   * `"improve"` when called from improve's reflect/distill agents
   * so events can be filtered out of user-facing history.
   */
  eventSource?: UsageEventSource;
}): Promise<ShowResponse> {
  const ref = input.ref.trim();

  // 0a. Stash `.meta/` convention: `[origin//]meta[:name]` direct-reads a
  //     human-authored orientation doc from the stash's `.meta/` directory.
  //     These files are not indexed (the walker skips dot-dirs), so they are
  //     resolved here before the index lookup and the `type:name` parser,
  //     which would otherwise reject the non-asset-type `meta`.
  {
    const metaRef = parseMetaRef(ref);
    if (metaRef) return showStashMeta(metaRef);
  }

  // Auto-index when stale so the index is current before lookup.
  const { primarySource } = resolveReadSources();
  await ensurePrimaryIndexForRead(primarySource);

  // Try local filesystem (FTS5 index lookup)
  const result = await showLocal(input);
  // Scope filter narrows resolution: if --scope was supplied, the asset's
  // frontmatter scope must satisfy every supplied key. We re-read the file
  // (cheap — already on the show hot path) so we don't have to thread scope
  // through the renderer chain just for one verification step.
  if (input.scope && hasAnyScopeKey(input.scope) && result.path) {
    enforceScopeOrThrow(result.path, ref, input.scope);
  }
  // Count prior shows of this ref before logging the current one.
  const priorShowCount = recentShowCount(ref);
  logShowEvent(ref, input.eventSource, result.path, result.origin);
  if (priorShowCount >= 2) {
    // Agent has shown this same asset 3+ times — inject a loop-break hint.
    (result as unknown as Record<string, unknown>).showLoopWarning = priorShowCount + 1;
  }
  return result;
}

/**
 * Resolve a stash `.meta/` doc and return it as a lightweight ShowResponse.
 *
 * With no origin the working stash (and other configured sources, in order)
 * is searched and the first hit wins. With an origin the lookup is narrowed
 * to that stash; an uninstalled origin yields an actionable "not installed"
 * error. The file is read directly from disk — `.meta/` is never indexed.
 */
async function showStashMeta(metaRef: MetaRef): Promise<ShowResponse> {
  const allSources = resolveSourceEntries();
  const sources = resolveSourcesForOrigin(metaRef.origin, allSources);

  if (metaRef.origin && sources.length === 0) {
    throw new NotFoundError(
      `Stash "${metaRef.origin}" is not installed, so its ${META_DIR}/ docs are unavailable. ` +
        `Run: akm add ${metaRef.origin}`,
    );
  }

  const config = loadConfig();
  for (const source of sources) {
    const filePath = resolveMetaFilePath(source.path, metaRef.name);
    if (!filePath) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const editable = isEditable(filePath, config);
    appendEvent({ eventType: "show", ref: `meta:${metaRef.name}`, metadata: { type: "meta", name: metaRef.name } });
    return {
      type: "meta",
      name: metaRef.name,
      path: filePath,
      content,
      origin: source.registryId ?? null,
      editable,
    } as ShowResponse;
  }

  throw new NotFoundError(
    `No ${META_DIR}/${metaRef.name} doc found${metaRef.origin ? ` in "${metaRef.origin}"` : ""}. ` +
      `Stash maintainers can create ${META_DIR}/${metaRef.name}.md to describe this stash ` +
      `(purpose, key assets, conventions, maintainer).`,
  );
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
    const actual = asNonEmptyString(fm[`scope_${key}`]);
    if (actual !== expectedValue) {
      throw new NotFoundError(`Asset "${ref}" exists but is out of scope (expected scope_${key}="${expectedValue}").`);
    }
  }
}

/**
 * Count how many times `ref` has been shown in the current session by reading
 * recent events. Returns the count BEFORE the current invocation.
 */
function recentShowCount(ref: string): number {
  try {
    const { events } = readEvents({
      type: "show",
      ref,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    return events.length;
  } catch {
    return 0;
  }
}

function logShowEvent(
  ref: string,
  eventSource: UsageEventSource = "user",
  filePath?: string,
  origin?: string | null,
): void {
  // Emit a structured event to events.jsonl so workflow-trace consumers
  // detect akm show invocations without relying on stdout scraping.
  const parsed = parseQualifiedRefInput(ref);
  // New-grammar display ref: also the lookup key below, which `findEntryIdByRef`
  // resolves against `item_ref`.
  const eventRef = displayRef({ type: parsed.type, name: parsed.name, bundleId: parsed.origin ?? origin ?? undefined });
  appendEvent({ eventType: "show", ref: eventRef, metadata: { type: parsed.type, name: parsed.name } });

  // Detect if this show is a selection from a recent search result.
  try {
    // D7: bound the query to the last 60 s so we never scan unbounded history
    const { events: recentSearches } = readEvents({
      type: "search",
      since: new Date(Date.now() - 60_000).toISOString(),
    });
    const cutoffMs = Date.now() - 60_000;
    const matchingSearch = [...recentSearches].reverse().find((e) => {
      if (!e.ts || new Date(e.ts).getTime() < cutoffMs) return false;
      const refs = (e.metadata?.resultRefs as string[] | undefined) ?? [];
      return refs.includes(ref);
    });
    if (matchingSearch) {
      appendEvent({
        eventType: "select",
        ref,
        metadata: {
          query: matchingSearch.metadata?.query as string | undefined,
          searchTs: matchingSearch.ts,
          rankPosition: ((matchingSearch.metadata?.resultRefs as string[] | undefined) ?? []).indexOf(ref),
        },
      });
    }
  } catch {
    /* fire-and-forget — select is best-effort */
  }

  try {
    withIndexDb(
      (db) => {
        const entryId = filePath ? getEntryIdByFilePath(db, filePath) : findEntryIdByRef(db, eventRef);
        // The DURABLE usage-event key is the resolved entry's fully-qualified
        // `item_ref`; the new-grammar `eventRef` is the fallback for an
        // unresolved / not-yet-indexed show. entry_id/item_ref resolve from
        // index.db (`db`); the usage_events write lands in state.db (WI-8.3).
        const entryRef = (entryId !== undefined ? getItemRefById(db, entryId) : null) ?? eventRef;
        withStateDbTelemetry((stateDb) => {
          insertUsageEvent(stateDb, {
            event_type: "show",
            entry_ref: entryRef,
            entry_id: entryId,
            source: eventSource,
          });
        }, TELEMETRY_BUSY_TIMEOUT_MS);
      },
      { busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    /* fire-and-forget */
  }
}

/** @internal Use akmShowUnified() for all external callers. */
export async function showLocal(input: {
  ref: string;
  view?: KnowledgeView;
  detail?: ShowDetailLevel;
  stashDir?: string;
}): Promise<ShowResponse> {
  const parsed = parseQualifiedRefInput(input.ref);
  const displayType = parsed.type;
  const config = loadConfig();
  const allSources = resolveSourceEntries(input.stashDir);
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);

  const allSourceDirs = searchSources.map((s) => s.path);

  const resolvedAssetPath = await resolveAssetPath(parsed, {
    stashDir: input.stashDir,
    mode: "index-first",
  });
  const assetPath = resolvedAssetPath ?? undefined;

  if (!assetPath && parsed.origin && searchSources.length === 0) {
    const installCmd = `akm add ${parsed.origin}`;
    throw new NotFoundError(
      `Stash asset not found for ref: ${displayType}:${parsed.name}. ` +
        `Stash "${parsed.origin}" is not installed. Run: ${installCmd}`,
    );
  }

  if (!assetPath) {
    throw new NotFoundError(
      `Stash asset not found for ref: ${displayType}:${parsed.name}. ` +
        "Check the name with `akm search` or verify the asset exists in your stash.",
    );
  }

  const source = findSourceForPath(assetPath, allSources);
  const sourceStashDir = source?.path ?? allSourceDirs[0];

  if (!sourceStashDir) {
    throw new UsageError(
      `Could not determine stash root for asset: ${displayType}:${parsed.name}. ` +
        "Run `akm init` to create the stash directory, or check `akm stash list` for configured paths.",
    );
  }

  const fileCtx = buildFileContext(sourceStashDir, assetPath);
  const match = recognizeMatch(fileCtx);
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
  // 07 P1-D: provenance-aware toolPolicy CEILING. An agent's self-declared
  // `tools` frontmatter is honoured ONLY for the operator's own PRIMARY stash —
  // the assets they authored. Every other source is content pulled from
  // elsewhere and must not name its own tool grant: registry-installed packs, a
  // configured secondary source, and even a git source the operator marked
  // `--writable` to contribute edits upstream (writability is "can I push", not
  // "do I trust this content to grant itself tools"). Drop the policy so dispatch
  // falls back to the parent/default grant. Keys off primary-stash identity —
  // `allSources[0]` is always the primary (search-source.ts) — not a
  // name-derived registryId or the orthogonal `writable` bit. `source` undefined
  // (unresolved path) also fails closed.
  const isPrimaryStash = source !== undefined && source.path === allSources[0]?.path;
  if (response.toolPolicy !== undefined && !isPrimaryStash) {
    delete (response as { toolPolicy?: unknown }).toolPolicy;
  }
  const editable = isEditable(assetPath, config);
  const fullResponse: ShowResponse = {
    ...response,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(assetPath, parsed.type, parsed.name, source?.registryId) } : {}),
    related: (() => {
      try {
        return withIndexDb((db) => {
          const related = listRelatedPathsForFile(sourceStashDir, assetPath, 5, db);
          return { total: related.length, hits: related };
        });
      } catch (err) {
        rethrowIfTestIsolationError(err);
        return { total: 0, hits: [] };
      }
    })(),
  };

  const activeRun = await getActiveWorkflowRun(getCurrentWorkflowScopeKey());
  if (activeRun) {
    (fullResponse as unknown as Record<string, unknown>).activeRun = activeRun;
  }

  // #624-P3: opt-in inline graph extraction. Default OFF — when the flag is
  // unset this whole block is skipped (no hasGraphData check, no LLM call), so
  // behavior is byte-identical to today. When ON, it extracts graph data for an
  // ungraphed asset, but ONLY when a model is configured (model-available
  // guard) and ALWAYS bounded by a 30s timeout so `show` can never hang. Any
  // timeout/model-unavailable/error path returns the response unchanged.
  if (getIndexPassConfig(config.index, "graph")?.lazyGraphExtraction === true) {
    await maybeExtractGraphInline(config, sourceStashDir, assetPath);
  }

  if (input.detail === "brief") {
    return buildBriefResponse(fullResponse, assetPath);
  }

  if (input.detail === "summary") {
    return buildSummaryResponse(fullResponse, assetPath);
  }

  return fullResponse;
}

/**
 * #624-P3 — opt-in inline graph extraction for `akm show`. Best-effort and
 * timeout-bounded: never throws, never hangs, never mutates the response.
 *
 * Preconditions (caller already checked the flag): a model must be configured
 * (model-available guard via {@link resolveIndexPassLLM}) and the asset must be
 * ungraphed ({@link hasGraphData}). Extraction races a 30s timeout so `show`
 * cannot block on a slow provider; any timeout/error/missing-model path is
 * swallowed and `show` returns its already-assembled response unchanged.
 */
async function maybeExtractGraphInline(
  config: ReturnType<typeof loadConfig>,
  sourceStashDir: string,
  assetPath: string,
): Promise<void> {
  try {
    // Model-available guard — no provider configured ⇒ silent skip, no LLM call.
    if (!resolveIndexPassLLM("graph", config)) return;

    let alreadyGraphed = false;
    let bodyHash: string | undefined;
    try {
      const raw = fs.readFileSync(assetPath, "utf8");
      bodyHash = computeBodyHash(parseFrontmatter(raw).content.trim());
    } catch {
      return; // file gone/unreadable ⇒ nothing to extract
    }

    withIndexDb(
      (db) => {
        alreadyGraphed = hasGraphData(db, sourceStashDir, assetPath);
      },
      { busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS },
    );
    if (alreadyGraphed) return;

    // Open the db for the async extraction ourselves: `withIndexDb` is
    // synchronous and would close the connection the instant the async fn
    // returns its Promise (before extraction completes). Close it explicitly
    // after the race settles instead.
    const db = openExistingDatabase(resolveStorageLocations().indexDb);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 30_000);
    });
    try {
      await Promise.race([extractGraphForSingleFile(db, sourceStashDir, assetPath, bodyHash, { config }), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      closeDatabase(db);
    }
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // Any other failure: silently return the unchanged show response.
  }
}

/**
 * Minimal `show`: ref → indexer lookup → file contents. Used by callers that
 * just need the raw file (e.g. clone, write-source) and don't want the full
 * renderer graph. Spec §6.2's literal flow.
 */
export async function showByRef(ref: string): Promise<{ filePath: string; body: string }> {
  const parsed = parseQualifiedRefInput(ref);
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
 * Enriches description and tags from rendered content when available.
 *
 * The resulting JSON should be under 200 tokens.
 */
function buildSummaryResponse(full: ShowResponse, assetPath?: string): ShowResponse {
  let description = full.description;
  const tags = full.tags;

  if (assetPath) {
    const textContent = full.content ?? full.template ?? full.prompt;
    if (textContent && !description) {
      const parsed = parseFrontmatter(textContent);
      description = asNonEmptyString(parsed.data.description);
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

// ── argv normalisation ───────────────────────────────────────────────────────

const SHOW_VIEW_MODES = new Set(["toc", "frontmatter", "full", "section", "lines"]);

const SHOW_ARGV_TOP_LEVEL_ARGS = {
  format: { type: "string" },
  output: { type: "string" },
  detail: { type: "string" },
  shape: { type: "string" },
  quiet: { type: "boolean", alias: "q" },
  verbose: { type: "boolean" },
} satisfies CittyArgsDefinitionForScan;

/**
 * Normalize argv so positional view-mode arguments after the asset ref
 * are rewritten into internal flags that citty can parse.
 *
 * Converts:
 *   akm show knowledge:guide.md toc          → akm show knowledge:guide.md --akmView toc
 *   akm show knowledge:guide.md section Auth → akm show knowledge:guide.md --akmView section --akmHeading Auth
 *   akm show knowledge:guide.md lines 1 50   → akm show knowledge:guide.md --akmView lines --akmStart 1 --akmEnd 50
 *
 * Legacy `--view` is intentionally unsupported.
 * Returns a new array; the input is never modified.
 */
export function normalizeShowArgv(argv: string[]): string[] {
  const rawArgs = argv.slice(2);
  const commandIndex = findCittyTopLevelCommandIndex(rawArgs, SHOW_ARGV_TOP_LEVEL_ARGS);
  if (commandIndex < 0 || rawArgs[commandIndex] !== "show") return argv;

  const commandArgs = rawArgs.slice(commandIndex + 1);
  if (
    commandArgs.includes("--view") ||
    commandArgs.includes("--heading") ||
    commandArgs.includes("--start") ||
    commandArgs.includes("--end")
  ) {
    throw new UsageError(
      'Legacy show flags are no longer supported. Use positional syntax like `akm show knowledge:guide toc` or `akm show knowledge:guide section "Auth"`.',
    );
  }

  // Separate global flags from positional/show-specific args
  const prefix = [...argv.slice(0, 2), ...rawArgs.slice(0, commandIndex + 1)];
  const rest = commandArgs;

  const globalFlags: string[] = [];
  const showArgs: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--quiet" || arg === "-q" || arg === "--verbose") {
      globalFlags.push(arg);
      continue;
    }
    if (arg.startsWith("--format=") || arg.startsWith("--detail=") || arg.startsWith("--shape=")) {
      globalFlags.push(arg);
      continue;
    }
    if (arg === "--format" || arg === "--detail" || arg === "--shape") {
      globalFlags.push(arg);
      if (rest[i + 1] !== undefined) {
        globalFlags.push(rest[i + 1]);
        i++;
      }
      continue;
    }
    showArgs.push(arg);
  }

  // showArgs[0] = ref, showArgs[1] = potential view mode, showArgs[2..] = view params
  const ref = showArgs[0];
  const viewMode = showArgs[1];

  if (!ref || !viewMode || !SHOW_VIEW_MODES.has(viewMode)) {
    return argv;
  }

  const result = [...prefix, ref, "--akmView", viewMode];

  if (viewMode === "section") {
    // Next arg is the heading name; pass empty string when missing so the
    // show handler can produce a clear "section not found" error.
    const heading = showArgs[2] ?? "";
    result.push("--akmHeading", heading);
  } else if (viewMode === "lines") {
    // Next two args are start and end
    const start = showArgs[2];
    const end = showArgs[3];
    if (start) result.push("--akmStart", start);
    if (end) result.push("--akmEnd", end);
  }

  result.push(...globalFlags);
  return result;
}
