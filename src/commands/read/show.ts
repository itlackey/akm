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
import path from "node:path";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { recognizeMatch } from "../../core/adapter/recognize-match";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { extractSection, markdownFragmentSlugs } from "../../core/asset/markdown";
import {
  buildMarkdownLeadContext,
  fragmentForSelector,
  MARKDOWN_FRAGMENT_CONTEXT_DEFAULT_MAX_CHARS,
} from "../../core/asset/markdown-fragments";
import { displayRef, typeNameFromConceptId } from "../../core/asset/resolve-ref";
import { META_DIR, type MetaRef, parseMetaRef, readMetaFile } from "../../core/asset/stash-meta";
import { asNonEmptyString, isWithin } from "../../core/common";
import { getIndexPassConfig, loadConfig } from "../../core/config/config";
import { NotFoundError, rethrowIfDataDirUnreadable, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { SCRIPT_EXTENSIONS } from "../../core/recognition-util";
import { presentationFor } from "../../core/type-presentation";
import { warn, warnOnce } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { hasGraphData } from "../../indexer/db/graph-db";
import { listRelatedPathsForFile } from "../../indexer/graph/graph-boost";
import { extractGraphForSingleFile } from "../../indexer/graph/graph-extraction";
import { lookupBundleRef, lookupBundleRefWithResolution } from "../../indexer/indexer";
import type { StashEntryScope } from "../../indexer/passes/metadata";
import { projectMarkdownFragmentContent } from "../../indexer/passes/metadata";
import { ensurePrimaryIndexForRead, resolveReadSources } from "../../indexer/read-preflight";
import {
  buildEditHint,
  findSourceForPath,
  isEditable,
  resolveSourceEntries,
  type SearchSource,
} from "../../indexer/search/search-source";
import { recentShowCount, recordShowUsage } from "../../indexer/usage/show-usage";
import type { UsageEventSource } from "../../indexer/usage/usage-events";
import {
  buildFileContext,
  buildRenderContext,
  type FileContext,
  getRenderer,
  type MatchResult,
} from "../../indexer/walk/file-context";
import { resolveIndexPassExecution } from "../../llm/index-passes";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { resolveStorageLocations } from "../../storage/locations";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
import { getIndexedMarkdownFragment } from "../../storage/repositories/index-fts-repository";
import { computeBodyHash } from "../../storage/repositories/index-llm-cache-repository";
// Eagerly import source providers to trigger self-registration.
import "../../sources/providers/index";
import type { FragmentContextMode, ShowDetailLevel, ShowResponse } from "../../sources/types";
import { getCurrentWorkflowScopeKey } from "../../workflows/authoring/scope-key";
import { buildWorkflowAction } from "../../workflows/renderer";
import { getActiveWorkflowRun } from "../../workflows/runtime/runs";

/**
 * Unified show: queries the local FTS5 index, then reads that row's file path.
 * A physical owner can arbitrate collisions during lookup, but show never
 * renders an asset without an indexed row. Spec §6.2; no provider or disk
 * fallback.
 *
 * When `detail` is `"brief"` or `"summary"`, the response omits
 * content/template/prompt and returns compact metadata.
 */
export async function akmShowUnified(input: {
  ref: string;
  detail?: ShowDetailLevel;
  /** Opt-in indexed-safe presentation for a selected Markdown fragment. */
  contextMode?: FragmentContextMode;
  /** Hard character budget for contextual fragment presentation. */
  maxContextChars?: number;
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
  /** Internal nested reads can render without recording a second user consumption row. */
  skipLogging?: boolean;
}): Promise<ShowResponse> {
  const ref = input.ref.trim();
  validateFragmentContextRequest(input);

  // 0a. Stash `.meta/` convention: `[origin//]meta[:name]` direct-reads a
  //     human-authored orientation doc from the stash's `.meta/` directory.
  //     These files are not indexed (the walker skips dot-dirs), so they are
  //     resolved here before the index lookup; meta docs are not asset refs.
  {
    const metaRef = parseMetaRef(ref);
    if (metaRef) return showStashMeta(metaRef);
  }

  // Env/secret bodies have no safe fragment surface, and a fragment cannot
  // widen what the env/secret renderers expose: both always omit the body
  // (env — key names only; secret — never rendered), fragment or not. Warn
  // and ignore the fragment rather than refusing the whole show.
  warnSensitiveFragmentUnsupported(parseBundleRef(ref));

  // An opaque fragment selector is an indexed revision handle. Do not refresh
  // it away between search and show if disk changed concurrently; the stored
  // safe substrate below is its source of truth. Friendly heading selectors
  // intentionally retain the normal source-live read behavior.
  const parsedRef = parseBundleRef(ref);
  if (!parsedRef.fragment?.startsWith("akm-fragment-")) {
    const { primarySource } = resolveReadSources();
    await ensurePrimaryIndexForRead(primarySource);
  }

  // Try local filesystem (FTS5 index lookup)
  const result = await showLocal(input);
  // Scope filter narrows resolution: if a scope filter was supplied, the
  // asset's frontmatter scope must satisfy every supplied key. We re-read the
  // file (cheap — already on the show hot path) so we don't have to thread
  // scope through the renderer chain just for one verification step.
  if (input.scope && hasAnyScopeKey(input.scope) && result.path) {
    enforceScopeOrThrow(result.path, ref, input.scope);
  }
  // Count prior shows of this ref before logging the current one.
  if (!input.skipLogging) {
    const consumedRef = result.ref ?? makeBundleRef(undefined, parseBundleRef(ref).conceptId);
    const priorShowCount = recentShowCount(consumedRef);
    recordShowUsage(consumedRef, result.type, result.name, input.eventSource, result.path);
    if (priorShowCount >= 2) {
      // Agent has shown this same asset 3+ times — inject a loop-break hint.
      (result as unknown as Record<string, unknown>).showLoopWarning = priorShowCount + 1;
    }
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
        `Run: akm bundle add ${metaRef.origin}`,
    );
  }

  const config = loadConfig();
  for (const source of sources) {
    const metaFile = readMetaFile(source.path, metaRef.name);
    if (!metaFile) continue;
    const editable = isEditable(metaFile.path, config, allSources);
    appendEvent({ eventType: "show", ref: `meta:${metaRef.name}`, metadata: { type: "meta", name: metaRef.name } });
    return {
      type: "meta",
      name: metaRef.name,
      path: metaFile.path,
      ref: `meta:${metaRef.name}`,
      content: metaFile.content,
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

function validateFragmentContextRequest(input: {
  ref: string;
  contextMode?: FragmentContextMode;
  maxContextChars?: number;
}): void {
  const mode = input.contextMode ?? "exact";
  if (mode !== "exact" && mode !== "lead") {
    throw new UsageError(`Invalid --context value: "${String(mode)}". Expected exact or lead.`, "INVALID_FLAG_VALUE");
  }
  if (
    input.maxContextChars !== undefined &&
    (!Number.isSafeInteger(input.maxContextChars) || input.maxContextChars <= 0)
  ) {
    throw new UsageError("Fragment context budget must be a positive safe integer.", "INVALID_FLAG_VALUE");
  }
  if (mode !== "lead" && input.maxContextChars !== undefined) {
    throw new UsageError("--max-chars and --max-tokens require --context lead.", "INVALID_FLAG_VALUE");
  }
  if (mode !== "lead") return;
  if (parseMetaRef(input.ref)) {
    throw new UsageError("--context lead requires an indexed Markdown asset fragment.", "INVALID_FLAG_VALUE");
  }
  const parsed = parseBundleRef(input.ref);
  if (!parsed.fragment) {
    throw new UsageError("--context lead requires a fragment-qualified ref.", "INVALID_FLAG_VALUE");
  }
  const type = typeNameFromConceptId(parsed.conceptId)?.type;
  if (type === "env" || type === "secret") {
    throw new UsageError(`--context lead is unavailable for sensitive ${type} assets.`, "INVALID_FLAG_VALUE");
  }
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

/** @internal Use akmShowUnified() for all external callers. */
export async function showLocal(input: {
  ref: string;
  detail?: ShowDetailLevel;
  stashDir?: string;
  contextMode?: FragmentContextMode;
  maxContextChars?: number;
}): Promise<ShowResponse> {
  validateFragmentContextRequest(input);
  const parsed = parseBundleRef(input.ref);
  warnSensitiveFragmentUnsupported(parsed);
  const assetParts = typeNameFromConceptId(parsed.conceptId);
  const config = loadConfig();
  const allSources = resolveSourceEntries(input.stashDir);
  const searchSources = resolveSourcesForOrigin(parsed.bundle, allSources);

  const allSourceDirs = searchSources.map((s) => s.path);

  const resolution = await lookupBundleRefWithResolution(parsed);
  if (resolution.indexError !== undefined) throw resolution.indexError;
  const indexedEntry = resolution.entry;
  const assetPath = indexedEntry?.filePath;

  if (!indexedEntry && parsed.bundle && searchSources.length === 0) {
    const installCmd = `akm bundle add ${parsed.bundle}`;
    throw new NotFoundError(
      `Stash asset not found for ref: ${makeBundleRef(parsed.bundle, parsed.conceptId)}. ` +
        `Stash "${parsed.bundle}" is not installed. Run: ${installCmd}`,
    );
  }

  if (!indexedEntry && !resolution.owner) {
    const unrecognized = findUnrecognizedScriptSource(assetParts, searchSources);
    if (unrecognized) {
      const displayExtension = unrecognized.extension || "no extension";
      warn(
        `Script ref "${makeBundleRef(parsed.bundle, parsed.conceptId)}" has extension "${displayExtension}", which is outside the recognized set used for indexing (${[...SCRIPT_EXTENSIONS].join(", ")}); showing it as plain text.`,
      );
      const fileCtx = buildFileContext(unrecognized.sourceRoot, unrecognized.path);
      const renderer = await getRenderer("script-source");
      if (renderer) {
        const match: MatchResult = { type: "script", specificity: 0, renderer: "script-source" };
        const renderCtx = buildRenderContext(fileCtx, match, allSourceDirs);
        const response = renderer.buildShowResponse(renderCtx);
        response.name = assetParts?.name ?? response.name;
        return response;
      }
    }
  }

  if (!indexedEntry || !assetPath) {
    throw new NotFoundError(
      `Stash asset not found for ref: ${makeBundleRef(parsed.bundle, parsed.conceptId)}. ` +
        "Check the name with `akm search` or verify the asset exists in your stash.",
    );
  }

  try {
    fs.accessSync(assetPath, fs.constants.R_OK);
  } catch (error) {
    throwIndexedPathNotFound(error, input.ref);
  }

  const source = findSourceForPath(assetPath, allSources);
  const sourceStashDir = source?.path ?? allSourceDirs[0];

  if (!sourceStashDir) {
    throw new UsageError(
      `Could not determine stash root for asset: ${makeBundleRef(parsed.bundle, parsed.conceptId)}. ` +
        "Run `akm bundle create` to create the stash directory, or check `akm bundle list` for configured paths.",
    );
  }

  const fileCtx = buildFileContext(sourceStashDir, assetPath);
  const presentedName = indexedEntry.name;
  const opaqueFragmentSelector = parsed.fragment?.startsWith("akm-fragment-") === true;
  // Friendly heading selectors retain the source-live exact response contract.
  // Only resolve the indexed-safe revision when the selector itself is opaque,
  // or when the caller explicitly opts into indexed-safe contextual output.
  const indexedFragment =
    parsed.fragment && (opaqueFragmentSelector || input.contextMode === "lead")
      ? withIndexDb((db) => getIndexedMarkdownFragment(db, indexedEntry.itemRef, parsed.fragment!))
      : undefined;
  const indexedFragmentContent = opaqueFragmentSelector ? indexedFragment?.content : undefined;
  const indexedRenderer = rendererForIndexedEntry(indexedEntry, fileCtx);
  let response: ShowResponse;
  try {
    if (indexedRenderer === null) {
      response = buildIndexedProjectionResponse(indexedEntry, assetPath, parsed.fragment, indexedFragmentContent);
    } else {
      const match =
        typeof indexedRenderer === "string" ? indexedMatch(indexedEntry, indexedRenderer) : recognizeMatch(fileCtx);
      if (!match) {
        throw new UsageError(
          `Could not display asset "${makeBundleRef(parsed.bundle, parsed.conceptId)}" — unsupported file type or unrecognized layout`,
        );
      }

      match.meta = { ...match.meta, name: presentedName };
      const renderer = await getRenderer(match.renderer);
      if (!renderer) {
        throw new UsageError(
          `Renderer "${match.renderer}" not found for asset: ${makeBundleRef(parsed.bundle, parsed.conceptId)}`,
        );
      }

      const renderBundle = indexedEntry.bundleId;
      const renderDefaultBundle =
        config.defaultBundle ?? (source?.path === allSources[0]?.path ? renderBundle : undefined);
      const renderCtx = buildRenderContext(fileCtx, match, allSourceDirs, renderBundle, renderDefaultBundle);
      response = renderer.buildShowResponse(renderCtx);
      if (parsed.fragment !== undefined) {
        if (!match.renderer.endsWith("-md")) {
          warn(
            `Fragment "#${parsed.fragment}" was ignored: ${makeBundleRef(parsed.bundle, parsed.conceptId)} is not a Markdown document, so heading fragments do not apply. Showing the whole asset.`,
          );
        } else {
          applyMarkdownFragment(response, fileCtx.content(), parsed.fragment, presentedName, indexedFragmentContent);
        }
      }
    }
  } catch (error) {
    throwIndexedPathNotFound(error, input.ref);
  }
  response.type = indexedEntry.type;
  response.name = indexedEntry.name;
  const isPrimaryStash = source !== undefined && source.path === allSources[0]?.path;
  const canonicalRef = displayRef(
    {
      type: indexedEntry.type,
      name: presentedName,
      conceptId: indexedEntry.conceptId,
      bundleId: indexedEntry.bundleId,
    },
    config.defaultBundle ?? (isPrimaryStash ? indexedEntry.bundleId : undefined),
  );
  if (parsed.fragment && indexedFragment) {
    const selectedFragmentId = indexedFragment.fragments[indexedFragment.ordinal]!.fragmentId;
    const selectedRef = `${canonicalRef}#${selectedFragmentId}`;
    const parentEstimatedTokens =
      typeof indexedEntry.document?.fileSize === "number"
        ? Math.round(indexedEntry.document.fileSize / 4)
        : Math.round(indexedFragment.parentChars / 4);
    Object.assign(response, {
      selectedRef,
      parentRef: canonicalRef,
      fragmentOrdinal: indexedFragment.ordinal + 1,
      fragmentCount: indexedFragment.count,
      startLine: indexedFragment.startLine,
      endLine: indexedFragment.endLine,
      ...(indexedFragment.previousFragmentId
        ? { previousRef: `${canonicalRef}#${indexedFragment.previousFragmentId}` }
        : {}),
      ...(indexedFragment.nextFragmentId ? { nextRef: `${canonicalRef}#${indexedFragment.nextFragmentId}` } : {}),
      fragmentChars: indexedFragment.fragmentChars,
      fragmentEstimatedTokens: Math.round(indexedFragment.fragmentChars / 4),
      parentChars: indexedFragment.parentChars,
      parentEstimatedTokens,
      contextMode: input.contextMode ?? "exact",
      contextTruncated: false,
    } satisfies Partial<ShowResponse>);

    if (input.contextMode === "lead") {
      const contextMaxChars = input.maxContextChars ?? MARKDOWN_FRAGMENT_CONTEXT_DEFAULT_MAX_CHARS;
      const contextual = buildMarkdownLeadContext(indexedFragment.fragments, indexedFragment.ordinal, contextMaxChars);
      applyMarkdownResponsePayload(response, contextual.content);
      response.contextMaxChars = contextMaxChars;
      response.contextTruncated = contextual.truncated;
    }
  } else if (input.contextMode === "lead") {
    throw new NotFoundError(`Indexed-safe fragment context is unavailable for ${input.ref}.`);
  }
  if (response.type === "workflow") response.action = buildWorkflowAction(canonicalRef);
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
  if (response.toolPolicy !== undefined && !isPrimaryStash) {
    delete (response as { toolPolicy?: unknown }).toolPolicy;
  }
  const editable = isEditable(assetPath, config, allSources);
  const fullResponse: ShowResponse = {
    ...response,
    ref: canonicalRef,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(canonicalRef) } : {}),
    related: (() => {
      try {
        return withIndexDb((db) => {
          const related = listRelatedPathsForFile(sourceStashDir, assetPath, 5, db);
          return { total: related.length, hits: related };
        });
      } catch (err) {
        rethrowIfTestIsolationError(err);
        rethrowIfDataDirUnreadable(err);
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
 * Warn and ignore body fragments for namespaces whose authored bytes are
 * sensitive. `warnOnce`-keyed on the exact ref: `akmShowUnified` calls this
 * before delegating to `showLocal`, which calls it again as its own
 * defense-in-depth for callers that use `showLocal` directly — a single
 * request must not print the same warning twice.
 */
function warnSensitiveFragmentUnsupported(ref: BundleRef): void {
  if (ref.fragment === undefined) return;
  const type = typeNameFromConceptId(ref.conceptId)?.type;
  if (type !== "env" && type !== "secret") return;
  warnOnce(
    `sensitive-fragment:${makeBundleRef(ref.bundle, ref.conceptId)}#${ref.fragment}`,
    `Fragment "#${ref.fragment}" was ignored: sensitive ${type} assets do not expose body fragments. Showing ${makeBundleRef(ref.bundle, ref.conceptId)} in full.`,
  );
}

/**
 * Return the unsupported extension only when the exact canonical AKM script
 * path exists as a contained regular file. Physical owner arbitration runs
 * first; this is a diagnostic for its miss, never an alternate owner or
 * runnable-file classifier. No authored bytes are read.
 */
interface UnrecognizedScriptSource {
  extension: string;
  path: string;
  sourceRoot: string;
}

function findUnrecognizedScriptSource(
  assetParts: ReturnType<typeof typeNameFromConceptId>,
  sources: readonly SearchSource[],
): UnrecognizedScriptSource | undefined {
  if (assetParts?.type !== "script") return undefined;
  const extension = path.extname(assetParts.name);
  if (SCRIPT_EXTENSIONS.has(extension.toLowerCase())) return undefined;

  const scriptDir = stashDirFor("script");
  if (!scriptDir) return undefined;
  for (const source of sources) {
    try {
      if ((source.adapterId ?? detectAdapterId(source.path)) !== "akm") continue;
      const sourceRoot = path.resolve(source.path);
      const candidate = path.resolve(assetPathForName("script", path.join(sourceRoot, scriptDir), assetParts.name));
      if (!isWithin(candidate, sourceRoot)) continue;
      const authoredStat = fs.lstatSync(candidate);
      if (!authoredStat.isFile() && !authoredStat.isSymbolicLink()) continue;
      const realRoot = fs.realpathSync(sourceRoot);
      const realCandidate = fs.realpathSync(candidate);
      if (!isWithin(realCandidate, realRoot) || !fs.statSync(realCandidate).isFile()) continue;
      return { extension, path: realCandidate, sourceRoot: realRoot };
    } catch {
      // Missing, unreadable, dangling, or otherwise unsafe paths remain normal
      // not-found misses; this diagnostic never widens physical ownership.
    }
  }
  return undefined;
}

/**
 * #624-P3 — opt-in inline graph extraction for `akm show`. Best-effort and
 * timeout-bounded: never throws, never hangs, never mutates the response.
 *
 * Preconditions (caller already checked the flag): a model must be configured
 * (model-available guard via {@link resolveIndexPassExecution}) and the asset
 * must be ungraphed ({@link hasGraphData}). Extraction races a 30s timeout so
 * `show` cannot block on a slow provider; any timeout/error/missing-model path
 * is swallowed and `show` returns its already-assembled response unchanged.
 */
async function maybeExtractGraphInline(
  config: ReturnType<typeof loadConfig>,
  sourceStashDir: string,
  assetPath: string,
): Promise<void> {
  try {
    // Resolve readiness and the symbolic runner once. The inline dispatch must
    // consume this same snapshot even if models.json changes while show runs.
    const graphExecution = resolveIndexPassExecution("graph", config);
    if (!graphExecution.runner) return;
    const emittedNoticeKeys = new Set<string>();
    const reportNotices = (notices: readonly Readonly<LoweringNotice>[]): void => {
      for (const notice of notices) {
        const key = JSON.stringify(notice);
        if (emittedNoticeKeys.has(key)) continue;
        emittedNoticeKeys.add(key);
        const field = typeof notice.field === "string" ? ` field=${notice.field}` : "";
        warn(`[akm] lazy graph extraction notice ${notice.code} adapter=${notice.adapter}${field}: ${notice.message}`);
      }
    };
    reportNotices(graphExecution.notices);

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
      await Promise.race([
        extractGraphForSingleFile(db, sourceStashDir, assetPath, bodyHash, {
          config,
          llmRunner: graphExecution.runner,
          onNotices: reportNotices,
        }),
        timeout,
      ]);
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
  const parsed = parseBundleRef(ref);
  if (parsed.fragment !== undefined) {
    warn(`Fragment "#${parsed.fragment}" was ignored by raw show: ${ref}. Returning the whole file.`);
  }
  const entry = await lookupBundleRef(parsed);
  if (!entry) {
    throw new NotFoundError(`Asset not found for ref: ${makeBundleRef(parsed.bundle, parsed.conceptId)}`);
  }
  let body: string;
  try {
    body = await fs.promises.readFile(entry.filePath, "utf8");
  } catch (error) {
    throwIndexedPathNotFound(error, ref);
  }
  return { filePath: entry.filePath, body };
}

function throwIndexedPathNotFound(error: unknown, ref: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
    throw new NotFoundError(
      `The indexed file for ${ref} is missing or unreadable. The search index may be stale.`,
      "ASSET_NOT_FOUND",
      "Run `akm index` to reconcile indexed paths, then retry `akm show`.",
    );
  }
  throw error;
}

type IndexedEntry = NonNullable<Awaited<ReturnType<typeof lookupBundleRef>>>;

/** `null` selects adapter-owned projection; a string selects a core renderer. */
function rendererForIndexedEntry(entry: IndexedEntry, _file: FileContext): string | null | undefined {
  if (entry.document?.ownsPresentation === true) return null;
  switch (entry.adapterId) {
    case null:
    case undefined:
    case "akm":
      return undefined;
    case "akm-workflow":
      return "workflow-md";
    default:
      return presentationFor(entry.type).renderer;
  }
}

function indexedMatch(entry: IndexedEntry, renderer: string): MatchResult {
  return { type: entry.type, specificity: Number.MAX_SAFE_INTEGER, renderer, meta: { name: entry.name } };
}

function buildIndexedProjectionResponse(
  entry: IndexedEntry,
  assetPath: string,
  fragment: string | undefined,
  indexedFragmentContent?: string,
): ShowResponse {
  const isMarkdown = path.extname(assetPath).toLowerCase() === ".md";
  if (fragment !== undefined && !isMarkdown) {
    warn(
      `Fragment "#${fragment}" was ignored: ${entry.conceptId} is not a Markdown document, so heading fragments do not apply. Showing the whole asset.`,
    );
  }
  const raw = fs.readFileSync(assetPath, "utf8");
  const parsed = parseFrontmatter(raw);
  const content =
    fragment !== undefined && isMarkdown
      ? (indexedFragmentContent ?? requireMarkdownSection(raw, fragment, entry.name).content)
      : parsed.content;
  const description = entry.document?.description ?? asNonEmptyString(parsed.data.description);
  const tags =
    entry.document?.tags ??
    (Array.isArray(parsed.data.tags)
      ? parsed.data.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
      : undefined);
  return {
    type: entry.type,
    name: entry.name,
    path: assetPath,
    action: "Read the content below.",
    content,
    ...(description ? { description } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
  };
}

function applyMarkdownFragment(
  response: ShowResponse,
  raw: string,
  fragment: string,
  name: string,
  indexedFragmentContent?: string,
): void {
  const section = indexedFragmentContent ?? requireMarkdownSection(raw, fragment, name).content;
  if (response.template !== undefined) response.template = section;
  else if (response.prompt !== undefined) response.prompt = section;
  else response.content = section;
}

function applyMarkdownResponsePayload(response: ShowResponse, content: string): void {
  if (response.template !== undefined) response.template = content;
  else if (response.prompt !== undefined) response.prompt = content;
  else response.content = content;
}

function requireMarkdownSection(
  content: string,
  fragment: string,
  name: string,
): { content: string; startLine: number; endLine: number } {
  const section = extractSection(content, fragment);
  if (section) return section;
  const indexed = projectMarkdownFragmentContent(content);
  const safeFragment = indexed ? fragmentForSelector(indexed, fragment) : undefined;
  if (safeFragment) {
    return { content: safeFragment.text, startLine: safeFragment.startLine, endLine: safeFragment.endLine };
  }
  const available = markdownFragmentSlugs(content);
  throw new NotFoundError(
    `Fragment "#${fragment}" not found in ${name}.` +
      (available.length > 0 ? ` Available fragments: ${available.map((slug) => `#${slug}`).join(", ")}.` : ""),
  );
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
    ...(summary.ref ? { ref: summary.ref } : {}),
    ...(summary.description ? { description: summary.description } : {}),
    ...(summary.action ? { action: summary.action } : {}),
    ...(summary.run ? { run: summary.run } : {}),
    ...(summary.origin !== undefined ? { origin: summary.origin } : {}),
    ...(full.editable !== undefined ? { editable: full.editable } : {}),
    ...(full.editHint ? { editHint: full.editHint } : {}),
    ...fragmentResponseProjection(full),
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
    ...(full.ref ? { ref: full.ref } : {}),
    ...(description ? { description } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(full.parameters ? { parameters: full.parameters } : {}),
    ...(full.workflowTitle ? { workflowTitle: full.workflowTitle } : {}),
    ...(full.action ? { action: full.action } : {}),
    ...(full.run ? { run: full.run } : {}),
    ...(full.origin !== undefined ? { origin: full.origin } : {}),
    ...(full.editable !== undefined ? { editable: full.editable } : {}),
    ...(full.editHint ? { editHint: full.editHint } : {}),
    ...fragmentResponseProjection(full),
  };

  return summary;
}

function fragmentResponseProjection(full: ShowResponse): Partial<ShowResponse> {
  if (!full.selectedRef) return {};
  return {
    selectedRef: full.selectedRef,
    parentRef: full.parentRef,
    fragmentOrdinal: full.fragmentOrdinal,
    fragmentCount: full.fragmentCount,
    startLine: full.startLine,
    endLine: full.endLine,
    previousRef: full.previousRef,
    nextRef: full.nextRef,
    fragmentChars: full.fragmentChars,
    fragmentEstimatedTokens: full.fragmentEstimatedTokens,
    parentChars: full.parentChars,
    parentEstimatedTokens: full.parentEstimatedTokens,
    contextMode: full.contextMode,
    contextMaxChars: full.contextMaxChars,
    contextTruncated: full.contextTruncated,
  };
}
