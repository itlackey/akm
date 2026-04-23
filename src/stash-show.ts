import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { closeDatabase, openDatabase } from "./db";
import { NotFoundError, UsageError } from "./errors";
import { buildFileContext, buildRenderContext, getRenderer, runMatchers } from "./file-context";
import { parseFrontmatter, toStringOrUndefined } from "./frontmatter";
import { loadStashFile } from "./metadata";
import { resolveSourcesForOrigin } from "./origin-resolve";
import { buildEditHint, findSourceForPath, isEditable, resolveStashSources } from "./search-source";
import { resolveStashProviders } from "./stash-provider-factory";
import { parseAssetRef } from "./stash-ref";
import { resolveAssetPath } from "./stash-resolve";
import type { KnowledgeView, ShowDetailLevel, ShowResponse } from "./stash-types";
import { insertUsageEvent } from "./usage-events";

// Eagerly import stash providers to trigger self-registration
import "./stash-providers/index";

/**
 * Show a wiki root (no page path) — returns the same payload as
 * `akm wiki show <name>`.
 *
 * Called when `parseAssetRef` yields `type === "wiki"` and the name has no
 * `/`, e.g. `wiki:research`.
 */
async function showWikiRoot(stashDir: string, wikiName: string): Promise<ShowResponse> {
  const { showWiki, resolveWikiDir } = await import("./wiki.js");
  const wikiDir = resolveWikiDir(stashDir, wikiName);
  if (!fs.existsSync(wikiDir)) {
    throw new NotFoundError(`Wiki not found: ${wikiName}. Run \`akm wiki create ${wikiName}\` to create it.`);
  }
  const result = showWiki(stashDir, wikiName);
  // Shape the WikiShowResult into a ShowResponse-compatible object.
  // The payload mirrors what `akm wiki show <name>` returns.
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

/**
 * Unified show: tries local FTS5 index first, then remote providers.
 *
 * When `detail` is `"summary"`, the response omits content/template/prompt and
 * returns only compact metadata (name, type, description, tags, parameters).
 */
export async function akmShowUnified(input: {
  ref: string;
  view?: KnowledgeView;
  detail?: ShowDetailLevel;
}): Promise<ShowResponse> {
  const ref = input.ref.trim();

  // 0. Wiki-root shortcut: `wiki:<name>` with no page path routes to the
  //    wiki summary (same payload as `akm wiki show <name>`). Honour
  //    `parsed.origin` by resolving against the matching stash source(s),
  //    falling back to the primary stash when no origin is given.
  {
    const parsed = parseAssetRef(ref);
    if (parsed.type === "wiki" && !parsed.name.includes("/")) {
      const allSources = resolveStashSources();
      const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);
      let lastError: NotFoundError | undefined;
      for (const source of searchSources) {
        try {
          return await showWikiRoot(source.path, parsed.name);
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

  // 1. Try local filesystem first (FTS5 index lookup)
  let localError: Error | undefined;
  try {
    const result = await showLocal(input);
    logShowEvent(ref);
    return result;
  } catch (err) {
    // Only fall through to remote providers on NotFoundError
    if (!(err instanceof NotFoundError)) throw err;
    localError = err;
  }

  // 2. Try remote providers (e.g. OpenViking)
  const config = loadConfig();
  const providers = resolveStashProviders(config).filter((p) => p.type !== "filesystem" && p.canShow(ref));
  for (const provider of providers) {
    try {
      const response = await provider.show(ref, input.view);
      logShowEvent(ref);
      if (input.detail === "summary") {
        return buildSummaryResponse(response);
      }
      return response;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  // Nothing found anywhere — rethrow the original local error with its specific message
  throw localError;
}

/**
 * Fire-and-forget: log a show event to the usage_events table.
 * Never blocks the caller; errors are silently ignored.
 */
function logShowEvent(ref: string, existingDb?: import("bun:sqlite").Database): void {
  try {
    const db = existingDb ?? openDatabase();
    try {
      const parsed = parseAssetRef(ref);
      const safeName = parsed.name.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const row = db
        .prepare("SELECT id FROM entries WHERE entry_key LIKE ? ESCAPE '\\' AND entry_type = ? LIMIT 1")
        .get(`%:${parsed.type}:${safeName}`, parsed.type) as { id: number } | undefined;
      insertUsageEvent(db, {
        event_type: "show",
        entry_ref: ref,
        entry_id: row?.id,
      });
    } finally {
      if (!existingDb) closeDatabase(db);
    }
  } catch {
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
  const parsed = parseAssetRef(input.ref);
  const displayType = parsed.type;
  const config = loadConfig();
  const allSources = resolveStashSources(input.stashDir);
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);

  const allStashDirs = searchSources.map((s) => s.path);

  let assetPath: string | undefined;
  let lastError: Error | undefined;
  for (const dir of allStashDirs) {
    try {
      assetPath = await resolveAssetPath(dir, parsed.type, parsed.name);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!assetPath && parsed.origin && searchSources.length === 0) {
    const installCmd = `akm add ${parsed.origin}`;
    throw new NotFoundError(
      `Stash asset not found for ref: ${displayType}:${parsed.name}. ` +
        `Kit "${parsed.origin}" is not installed. Run: ${installCmd}`,
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

  const source = findSourceForPath(assetPath, allSources);
  const sourceStashDir = source?.path ?? allStashDirs[0];

  if (!sourceStashDir) {
    throw new UsageError(
      `Could not determine stash root for asset: ${displayType}:${parsed.name}. ` +
        "Run `akm init` to create the stash directory, or check `akm stash list` for configured paths.",
    );
  }

  const fileCtx = buildFileContext(sourceStashDir, assetPath);
  const match = await runMatchers(fileCtx);
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

  const renderCtx = buildRenderContext(fileCtx, match, allStashDirs, source?.registryId);
  const response = renderer.buildShowResponse(renderCtx);
  const editable = isEditable(assetPath, config);
  const fullResponse: ShowResponse = {
    ...response,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(assetPath, parsed.type, parsed.name, source?.registryId) } : {}),
  };

  if (input.detail === "summary") {
    return buildSummaryResponse(fullResponse, assetPath);
  }

  return fullResponse;
}

/**
 * Build a compact summary response from a full ShowResponse.
 *
 * Strips content/template/prompt and returns only metadata fields:
 * type, name, path, description, tags, parameters, action.
 * Enriches description and tags from frontmatter or .stash.json when available.
 *
 * Enrichment via frontmatter and .stash.json is only performed when `assetPath`
 * is supplied (local assets). Remote provider responses (e.g. OpenViking) rely
 * on the provider having already populated description and tags.
 *
 * The resulting JSON should be under 200 tokens.
 */
function buildSummaryResponse(full: ShowResponse, assetPath?: string): ShowResponse {
  // Try to enrich metadata from .stash.json if description or tags are missing
  let description = full.description;
  let tags = full.tags;

  if (assetPath) {
    // Try frontmatter extraction from content fields
    const textContent = full.content ?? full.template ?? full.prompt;
    if (textContent && !description) {
      const parsed = parseFrontmatter(textContent);
      description = toStringOrUndefined(parsed.data.description);
    }

    // Try .stash.json for richer metadata (tags especially)
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
