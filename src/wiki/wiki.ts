/**
 * Multi-wiki support for akm (issue #119).
 *
 * A wiki lives at `<stashDir>/wikis/<name>/` and contains:
 *   - `schema.md`          — the rulebook the agent reads first
 *   - `index.md`           — catalog, regenerable (rebuilt by `akm index`)
 *   - `log.md`             — append-only, agent-maintained
 *   - `raw/<slug>.md`      — immutable ingested sources
 *   - `<page>.md`          — wiki pages (optionally nested)
 *
 * Principle: "akm surfaces. The agent writes." akm owns lifecycle, raw-slug
 * generation, structural lint, and `index.md` regeneration. The agent uses
 * its native file tools for every other page operation.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { akmSearch } from "../commands/search";
import { isWithin } from "../core/common";
import { loadUserConfig, saveConfig } from "../core/config";
import { NotFoundError, UsageError } from "../core/errors";
import { parseFrontmatter, parseFrontmatterBlock } from "../core/frontmatter";
import { resolveSourceEntries, type SearchSource } from "../indexer/search-source";
import type { SearchResponse, SourceSearchHit } from "../sources/types";
import { buildIndexMd, buildLogMd, buildSchemaMd } from "../templates/wiki-templates";

// ── Constants ───────────────────────────────────────────────────────────────

export const WIKIS_SUBDIR = "wikis";
export const SCHEMA_MD = "schema.md";
export const INDEX_MD = "index.md";
export const LOG_MD = "log.md";
export const RAW_SUBDIR = "raw";

/** Files at a wiki root that are not pages. */
const WIKI_SPECIAL_FILES: ReadonlySet<string> = new Set([SCHEMA_MD, INDEX_MD, LOG_MD]);

const WIKI_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── Types ───────────────────────────────────────────────────────────────────

export interface WikiSummary {
  name: string;
  path: string;
  description?: string;
  pages: number;
  raws: number;
  lastModified?: string;
}

export interface WikiShowResult {
  name: string;
  ref: string;
  path: string;
  description?: string;
  pages: number;
  raws: number;
  lastModified?: string;
  recentLog: string[];
}

export interface WikiCreateResult {
  name: string;
  ref: string;
  path: string;
  created: string[];
  skipped: string[];
}

export interface WikiRemoveResult {
  name: string;
  path: string;
  removed: string[];
  preservedRaw: boolean;
  rawPath?: string;
  unregistered?: boolean;
}

// ── Validation + resolution ─────────────────────────────────────────────────

export function validateWikiName(name: string): void {
  if (!name) throw new UsageError("Wiki name cannot be empty.");
  if (!WIKI_NAME_RE.test(name)) {
    throw new UsageError(
      `Invalid wiki name "${name}". Use lowercase letters, digits, and hyphens (must start with a lowercase letter or digit).`,
    );
  }
}

export function resolveWikisRoot(stashDir: string): string {
  return path.join(stashDir, WIKIS_SUBDIR);
}

/**
 * Resolve `<stashDir>/wikis/<name>/` with an isWithin guard so a malicious
 * or mistyped name can never escape the wikis root.
 */
export function resolveWikiDir(stashDir: string, name: string): string {
  validateWikiName(name);
  const wikisRoot = resolveWikisRoot(stashDir);
  const dir = path.join(wikisRoot, name);
  if (!isWithin(dir, wikisRoot)) {
    throw new UsageError(`Invalid wiki path for name "${name}".`);
  }
  return dir;
}

/** Parse a wiki name out of a `wiki:<name>/<...>` ref, or return undefined. */
export function extractWikiNameFromRef(ref: string): string | undefined {
  const match = ref.match(/^wiki:([a-z0-9][a-z0-9-]*)(?:\/|$)/);
  return match?.[1];
}

export interface ResolvedWikiSource {
  name: string;
  path: string;
  mode: "stash" | "external";
  source?: SearchSource;
}

function wikiNotFoundMessage(name: string): string {
  return `Wiki not found: ${name}. Run \`akm wiki create ${name}\` to create it or \`akm wiki register ${name} <path-or-repo>\` to register an external wiki.`;
}

function registeredWikiSources(stashDir: string): ResolvedWikiSource[] {
  return resolveSourceEntries(stashDir)
    .filter((source): source is SearchSource & { wikiName: string } => typeof source.wikiName === "string")
    .map((source) => ({
      name: source.wikiName,
      path: source.path,
      mode: "external" as const,
      source,
    }));
}

export function resolveWikiSource(stashDir: string, name: string): ResolvedWikiSource {
  validateWikiName(name);
  const wikiDir = resolveWikiDir(stashDir, name);
  if (fs.existsSync(wikiDir) && isRecognizedStashWiki(wikiDir)) {
    return { name, path: wikiDir, mode: "stash" };
  }
  const external = registeredWikiSources(stashDir).find((source) => source.name === name);
  if (external) return external;
  throw new NotFoundError(wikiNotFoundMessage(name), "STASH_NOT_FOUND");
}

export function ensureWikiNameAvailable(stashDir: string, name: string): void {
  validateWikiName(name);
  const wikiDir = resolveWikiDir(stashDir, name);
  if (fs.existsSync(wikiDir) && isRecognizedStashWiki(wikiDir)) {
    throw new UsageError(`Wiki already exists: ${name}.`, "RESOURCE_ALREADY_EXISTS");
  }
  const external = registeredWikiSources(stashDir).find((source) => source.name === name);
  if (external) {
    throw new UsageError(`Wiki already registered: ${name}.`, "RESOURCE_ALREADY_EXISTS");
  }
}

// ── Scan helpers ────────────────────────────────────────────────────────────

interface WikiFileBuckets {
  pages: string[];
  raws: string[];
  /** Newest mtime across every `.md` in the wiki (pages, raws, schema/index/log). */
  lastModifiedMs?: number;
  /** Newest mtime across pages only — the signal `stale-index` lint uses. */
  pagesLastModifiedMs?: number;
}

/**
 * Walk a wiki directory and bucket files into pages vs raws.
 *
 * "Pages" are any `.md` files under the wiki root EXCEPT `schema.md`,
 * `index.md`, `log.md`, or anything under `raw/`. This matches the set the
 * agent edits, and the set `akm wiki pages` exposes.
 *
 * Returns two mtime signals:
 *   - `lastModifiedMs` — newest across all .md files. Used for the `show` /
 *     `list` "last activity" display, which should reflect any edit.
 *   - `pagesLastModifiedMs` — newest page mtime only. Used by `lintWiki` to
 *     decide `stale-index`: the index tracks pages, so stashing a raw or
 *     editing log.md must NOT flag the index stale.
 */
function scanWikiFiles(wikiDir: string): WikiFileBuckets {
  const pages: string[] = [];
  const raws: string[] = [];
  let lastModifiedMs: number | undefined;
  let pagesLastModifiedMs: number | undefined;

  const stack: Array<{ abs: string; relDirSegs: string[] }> = [{ abs: wikiDir, relDirSegs: [] }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(current.abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push({ abs, relDirSegs: [...current.relDirSegs, entry.name] });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      let mtimeMs: number | undefined;
      try {
        mtimeMs = fs.statSync(abs).mtimeMs;
      } catch {
        /* best-effort */
      }
      if (mtimeMs !== undefined) {
        lastModifiedMs = lastModifiedMs === undefined ? mtimeMs : Math.max(lastModifiedMs, mtimeMs);
      }

      const atRoot = current.relDirSegs.length === 0;
      const firstDir = current.relDirSegs[0];
      if (firstDir === RAW_SUBDIR) {
        raws.push(abs);
      } else if (!(atRoot && WIKI_SPECIAL_FILES.has(entry.name))) {
        // schema.md / index.md / log.md at the wiki root are not pages
        pages.push(abs);
        if (mtimeMs !== undefined) {
          pagesLastModifiedMs = pagesLastModifiedMs === undefined ? mtimeMs : Math.max(pagesLastModifiedMs, mtimeMs);
        }
      }
    }
  }
  return { pages, raws, lastModifiedMs, pagesLastModifiedMs };
}

function hasWikiInfrastructure(wikiDir: string): boolean {
  for (const file of WIKI_SPECIAL_FILES) {
    if (fs.existsSync(path.join(wikiDir, file))) return true;
  }
  return false;
}

function isRecognizedStashWiki(wikiDir: string, buckets?: WikiFileBuckets): boolean {
  const scanned = buckets ?? scanWikiFiles(wikiDir);
  return scanned.pages.length > 0 || hasWikiInfrastructure(wikiDir);
}

function readSchemaDescription(wikiDir: string): string | undefined {
  const schemaPath = path.join(wikiDir, SCHEMA_MD);
  let raw: string;
  try {
    raw = fs.readFileSync(schemaPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = parseFrontmatter(raw);
    const desc = parsed.data.description;
    return typeof desc === "string" && desc.trim().length > 0 ? desc.trim() : undefined;
  } catch {
    return undefined;
  }
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString();
}

// ── List ────────────────────────────────────────────────────────────────────

/**
 * Return summaries for every wiki directly under `<stashDir>/wikis/`.
 *
 * A "wiki" is any directory whose name matches {@link WIKI_NAME_RE}. Anything
 * else (dot-directories, lone files, directories with odd names) is skipped
 * silently so `ls` noise doesn't crash listing.
 */
export function listWikis(stashDir: string): WikiSummary[] {
  const wikisRoot = resolveWikisRoot(stashDir);
  const summaries = new Map<string, WikiSummary>();

  let entries: fs.Dirent[] = [];
  if (fs.existsSync(wikisRoot)) {
    try {
      entries = fs.readdirSync(wikisRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
  }

  const summarize = (name: string, dir: string) => {
    const buckets = scanWikiFiles(dir);
    if (!isRecognizedStashWiki(dir, buckets)) return;
    const summary: WikiSummary = {
      name,
      path: dir,
      pages: buckets.pages.length,
      raws: buckets.raws.length,
    };
    const description = readSchemaDescription(dir);
    if (description) summary.description = description;
    if (buckets.lastModifiedMs !== undefined) summary.lastModified = toIsoDate(buckets.lastModifiedMs);
    summaries.set(name, summary);
  };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!WIKI_NAME_RE.test(entry.name)) continue;
    summarize(entry.name, path.join(wikisRoot, entry.name));
  }

  for (const source of registeredWikiSources(stashDir)) {
    if (summaries.has(source.name)) continue;
    summarize(source.name, source.path);
  }

  return Array.from(summaries.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Show ────────────────────────────────────────────────────────────────────

/**
 * Extract the top N `##` log entries from `log.md`.
 *
 * The log convention (defined by `schema.md` and enforced by nothing) is
 * newest-first: the most recent entry sits at the top of the file, so the
 * first `limit` `##` blocks encountered in file order are the most recent.
 * Agents that append to the bottom instead will have their entries appear
 * at the end of this list.
 *
 * `log.md` is agent-maintained and can be free-form, so `parseFrontmatter`
 * is called defensively: if the frontmatter is malformed we fall back to
 * treating the whole file as body.
 */
function readRecentLog(wikiDir: string, limit = 3): string[] {
  const logPath = path.join(wikiDir, LOG_MD);
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  let body: string;
  try {
    body = parseFrontmatter(raw).content ?? raw;
  } catch {
    body = raw;
  }
  const sections: string[] = [];
  let current: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      if (current && current.length > 0) sections.push(current.join("\n").trim());
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current && current.length > 0) sections.push(current.join("\n").trim());
  // Newest-first convention: the top `limit` `##` blocks are the most recent.
  return sections.slice(0, limit);
}

export function showWikiAtPath(name: string, wikiDir: string): WikiShowResult {
  const buckets = scanWikiFiles(wikiDir);
  const result: WikiShowResult = {
    name,
    ref: `wiki:${name}`,
    path: wikiDir,
    pages: buckets.pages.length,
    raws: buckets.raws.length,
    recentLog: readRecentLog(wikiDir),
  };
  const description = readSchemaDescription(wikiDir);
  if (description) result.description = description;
  if (buckets.lastModifiedMs !== undefined) result.lastModified = toIsoDate(buckets.lastModifiedMs);
  return result;
}

export function showWiki(stashDir: string, name: string): WikiShowResult {
  return showWikiAtPath(name, resolveWikiSource(stashDir, name).path);
}

// ── Create ──────────────────────────────────────────────────────────────────

export function createWiki(stashDir: string, name: string): WikiCreateResult {
  const existing = registeredWikiSources(stashDir).find((source) => source.name === name);
  if (existing) {
    throw new UsageError(`Wiki already registered: ${name}.`, "RESOURCE_ALREADY_EXISTS");
  }
  const wikiDir = resolveWikiDir(stashDir, name);
  fs.mkdirSync(wikiDir, { recursive: true });

  const files: Array<{ relPath: string; content: string }> = [
    { relPath: SCHEMA_MD, content: buildSchemaMd(name) },
    { relPath: INDEX_MD, content: buildIndexMd(name) },
    { relPath: LOG_MD, content: buildLogMd(name) },
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const { relPath, content } of files) {
    const absPath = path.join(wikiDir, relPath);
    if (fs.existsSync(absPath)) {
      skipped.push(absPath);
      continue;
    }
    fs.writeFileSync(absPath, content, "utf8");
    created.push(absPath);
  }

  // Ensure raw/ exists with a .gitkeep so empty wikis survive clean clones.
  // Handle the dir-exists-but-no-.gitkeep case too (partial scaffolds,
  // user-created directories) so the invariant always holds after `create`.
  const rawDir = path.join(wikiDir, RAW_SUBDIR);
  fs.mkdirSync(rawDir, { recursive: true });
  const gitkeepPath = path.join(rawDir, ".gitkeep");
  if (fs.existsSync(gitkeepPath)) {
    skipped.push(gitkeepPath);
  } else {
    fs.writeFileSync(gitkeepPath, "", "utf8");
    created.push(gitkeepPath);
  }

  return { name, ref: `wiki:${name}`, path: wikiDir, created, skipped };
}

// ── Remove ──────────────────────────────────────────────────────────────────

export interface RemoveOptions {
  withSources?: boolean;
}

/**
 * Remove a wiki.
 *
 * Deletes pages + `schema.md` + `index.md` + `log.md` by default. The `raw/`
 * directory is preserved because raw sources are often hand-curated and
 * outlive the wiki pages built from them. Pass `withSources: true` to
 * delete everything including `raw/`.
 *
 * The guard: `wikiDir` must resolve under `<stashDir>/wikis/`. If the wiki
 * directory doesn't exist, throws `NotFoundError` — callers can decide to
 * ignore that (e.g. idempotent cleanup) by catching.
 */
export function removeWiki(stashDir: string, name: string, options: RemoveOptions = {}): WikiRemoveResult {
  validateWikiName(name);
  const wikiDir = resolveWikiDir(stashDir, name);
  const external = registeredWikiSources(stashDir).find((source) => source.name === name);
  const isStashWiki = fs.existsSync(wikiDir) && isRecognizedStashWiki(wikiDir);
  if (!isStashWiki && external) {
    const config = loadUserConfig();
    const filteredSources = (config.sources ?? config.stashes ?? []).filter((entry) => entry.wikiName !== name);
    const installed = (config.installed ?? []).filter((entry) => entry.wikiName !== name);
    saveConfig({
      ...config,
      sources: filteredSources.length > 0 ? filteredSources : undefined,
      stashes: undefined,
      installed: installed.length > 0 ? installed : undefined,
    });
    return {
      name,
      path: wikiDir,
      removed: [],
      preservedRaw: false,
      unregistered: true,
    };
  }
  if (!fs.existsSync(wikiDir) || (!isStashWiki && !options.withSources)) {
    throw new NotFoundError(wikiNotFoundMessage(name), "STASH_NOT_FOUND");
  }
  const wikisRoot = resolveWikisRoot(stashDir);
  if (!isWithin(wikiDir, wikisRoot)) {
    throw new UsageError(`Refusing to remove a path outside the wikis root: ${wikiDir}`, "PATH_ESCAPE_VIOLATION");
  }

  const removed: string[] = [];
  const rawDir = path.join(wikiDir, RAW_SUBDIR);
  const preserveRaw = !options.withSources && fs.existsSync(rawDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wikiDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const abs = path.join(wikiDir, entry.name);
    if (preserveRaw && entry.name === RAW_SUBDIR) continue;
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(abs);
    } catch {
      /* best-effort — entry may have been removed concurrently */
    }
  }

  if (!preserveRaw) {
    // Remove the now-empty wiki directory itself.
    try {
      fs.rmdirSync(wikiDir);
    } catch {
      /* dir may be non-empty (e.g. uncollected dotfiles); leave it */
    }
  }

  const result: WikiRemoveResult = {
    name,
    path: wikiDir,
    removed,
    preservedRaw: preserveRaw,
  };
  if (preserveRaw) result.rawPath = rawDir;
  return result;
}

// ── Pages ───────────────────────────────────────────────────────────────────

export interface WikiPageEntry {
  ref: string;
  name: string;
  path: string;
  description?: string;
  pageKind?: string;
  xrefs?: string[];
  sources?: string[];
}

function pageNameFromPath(wikiDir: string, absPath: string): string {
  const rel = path.relative(wikiDir, absPath).split(path.sep).join("/");
  return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
}

/**
 * Parse the raw frontmatter block with a real YAML parser so list-valued
 * keys (`xrefs:`, `sources:`) round-trip correctly. The project's hand-rolled
 * `parseFrontmatter` deliberately drops YAML lists; for lint + index work we
 * need them, and the `yaml` package is already a runtime dependency.
 */
function parsePageFrontmatterYaml(raw: string): Record<string, unknown> {
  const block = parseFrontmatterBlock(raw);
  if (!block) return {};
  try {
    const value = yamlParse(block.frontmatter);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* malformed YAML — fall through to the lightweight parser */
  }
  try {
    return parseFrontmatter(raw).data;
  } catch {
    return {};
  }
}

function readPageFrontmatter(absPath: string): {
  description?: string;
  pageKind?: string;
  xrefs?: string[];
  sources?: string[];
} {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return {};
  }
  const data = parsePageFrontmatterYaml(raw);
  const out: { description?: string; pageKind?: string; xrefs?: string[]; sources?: string[] } = {};
  if (typeof data.description === "string" && data.description.trim().length > 0) {
    out.description = data.description.trim();
  }
  if (typeof data.pageKind === "string" && data.pageKind.trim().length > 0) {
    out.pageKind = data.pageKind.trim();
  }
  if (Array.isArray(data.xrefs)) {
    const xrefs = data.xrefs.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (xrefs.length > 0) out.xrefs = xrefs;
  }
  if (Array.isArray(data.sources)) {
    const sources = data.sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (sources.length > 0) out.sources = sources;
  }
  return out;
}

/**
 * List the pages in a wiki, excluding `schema.md`, `index.md`, `log.md`, and
 * anything under `raw/`. Each entry carries its ref (`wiki:<name>/<page>`),
 * path, and frontmatter-derived fields for orientation.
 */
export function listPages(stashDir: string, name: string): WikiPageEntry[] {
  const wikiDir = resolveWikiSource(stashDir, name).path;
  const { pages } = scanWikiFiles(wikiDir);
  const result: WikiPageEntry[] = [];
  for (const abs of pages) {
    const pageName = pageNameFromPath(wikiDir, abs);
    const ref = `wiki:${name}/${pageName}`;
    const fm = readPageFrontmatter(abs);
    const entry: WikiPageEntry = { ref, name: pageName, path: abs, ...fm };
    result.push(entry);
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

// ── Scoped search ──────────────────────────────────────────────────────────

export interface WikiSearchInput {
  stashDir: string;
  wikiName: string;
  query: string;
  limit?: number;
}

/**
 * Thin wrapper over the stash-wide search that narrows to one wiki.
 *
 * Uses `akmSearch({ type: "wiki" })` to reuse the full FTS5+boost pipeline,
 * then drops hits that aren't inside `wikis/<name>/`. No parallel scorer.
 *
 * When the index is absent (e.g. fresh stash), `akmSearch` falls back to its
 * substring walker; hits still come through path-filtered here.
 */
export async function searchInWiki(input: WikiSearchInput): Promise<SearchResponse> {
  validateWikiName(input.wikiName);
  const response = await akmSearch({
    query: input.query,
    type: "wiki",
    limit: input.limit,
    source: "stash",
  });
  let wikiDir: string;
  try {
    wikiDir = resolveWikiSource(input.stashDir, input.wikiName).path;
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { ...response, hits: [], registryHits: undefined };
    }
    throw err;
  }
  const rawDir = path.join(wikiDir, RAW_SUBDIR);
  const filtered: SourceSearchHit[] = [];
  for (const hit of response.hits) {
    // hits can be SourceSearchHit or RegistrySearchResultHit (union); filter
    // by path inclusion. Registry hits have no path and are dropped.
    if (hit.type === "registry") continue;
    const stashHit = hit as SourceSearchHit;
    if (!stashHit.path) continue;
    if (!isWithin(stashHit.path, wikiDir)) continue;
    // Exclude infrastructure files: schema.md, index.md, log.md at wiki root
    const basename = path.basename(stashHit.path);
    if (WIKI_SPECIAL_FILES.has(basename) && path.dirname(stashHit.path) === wikiDir) continue;
    // Exclude anything under raw/
    if (isWithin(stashHit.path, rawDir)) continue;
    filtered.push(stashHit);
  }
  return { ...response, hits: filtered, registryHits: undefined };
}

// ── Slug + raw stash ───────────────────────────────────────────────────────

const SLUG_MAX_LENGTH = 64;

/**
 * Turn an arbitrary string into a filesystem-safe wiki slug.
 *
 * - lowercased
 * - leading markdown noise (`#`, `>`, `-`, whitespace) stripped
 * - non-alphanumerics collapsed to `-`
 * - leading/trailing `-` trimmed
 * - capped at {@link SLUG_MAX_LENGTH}
 *
 * Falls back to `note-<base36-ms>` for empty inputs so raw files are never
 * written to a blank name.
 */
export function slugifyForWiki(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/^[#>\-\s]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
  return slug || `note-${Date.now().toString(36)}`;
}

/**
 * Derive a slug hint from the first non-empty line of source content.
 *
 * Used when the caller didn't pass a preferredName. Skips frontmatter.
 * Caps words at 8 so the slug stays manageable.
 */
function deriveQueryFromSource(content: string): string {
  const lines = content.split(/\r?\n/);
  let inFrontmatter = false;
  let closed = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && !closed) {
      if (trimmed === "---") closed = true;
      continue;
    }
    if (!trimmed) continue;
    return trimmed
      .replace(/^#+\s*/, "")
      .split(/\s+/)
      .slice(0, 8)
      .join(" ");
  }
  return "";
}

function pickUniqueRawSlug(rawDir: string, baseSlug: string): string {
  let candidate = baseSlug;
  let n = 0;
  while (fs.existsSync(path.join(rawDir, `${candidate}.md`))) {
    n += 1;
    candidate = `${baseSlug}-${n}`;
  }
  return candidate;
}

function withRawFrontmatter(content: string, slug: string): string {
  // If the source already starts with a YAML frontmatter block, keep it — we
  // don't want to shadow user metadata. The raw location itself is enough to
  // tag the wikiRole for the indexer.
  if (content.startsWith("---")) return content;
  const date = new Date().toISOString().slice(0, 10);
  return `---\nwikiRole: raw\ningestedAt: ${date}\nslug: ${slug}\n---\n\n${content}`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export interface StashRawInput {
  stashDir: string;
  wikiName: string;
  content: string;
  /**
   * Caller-provided name hint. Usually the source filename or a user-supplied
   * `--name`. Used as the base slug when present; falls back to a slug
   * derived from the content's first non-empty line.
   */
  preferredName?: string;
  /**
   * When `true`, the caller explicitly supplied a slug via `--as`. If the
   * derived slug already exists, throw a `UsageError` rather than
   * auto-incrementing. When `false` or `undefined`, the legacy auto-increment
   * behaviour is preserved.
   */
  explicitSlug?: boolean;
}

export interface StashRawResult {
  slug: string;
  path: string;
  wrote: boolean;
  ref: string;
}

/**
 * Copy raw content into `wikis/<name>/raw/<slug>.md`.
 *
 * Invariants this owns (which an agent could get wrong):
 *   1. Raw files never overwrite — collisions get `-1`, `-2`, … suffixes.
 *   2. Path is guaranteed to stay within the wiki's raw/ directory.
 *   3. If the content has no frontmatter, a `wikiRole: raw` block is added.
 *
 * Does not update the log, does not write any wiki pages. That's the agent's
 * job (see `akm wiki ingest <name>` for the workflow).
 */
export function stashRaw(input: StashRawInput): StashRawResult {
  const wikiDir = resolveWikiSource(input.stashDir, input.wikiName).path;
  const rawDir = path.join(wikiDir, RAW_SUBDIR);
  fs.mkdirSync(rawDir, { recursive: true });

  const baseSlug = slugifyForWiki(input.preferredName ?? deriveQueryFromSource(input.content) ?? "source");
  if (input.explicitSlug === true && fs.existsSync(path.join(rawDir, `${baseSlug}.md`))) {
    throw new UsageError(
      `Raw slug "${baseSlug}" already exists in wiki:${input.wikiName}. Pass a different --as or omit --as to auto-increment.`,
    );
  }
  const slug = pickUniqueRawSlug(rawDir, baseSlug);
  const absPath = path.join(rawDir, `${slug}.md`);
  if (!isWithin(absPath, rawDir)) {
    throw new UsageError(`Invalid raw path for slug "${slug}".`);
  }
  fs.writeFileSync(absPath, ensureTrailingNewline(withRawFrontmatter(input.content, slug)), "utf8");
  return {
    slug,
    path: absPath,
    wrote: true,
    ref: `wiki:${input.wikiName}/raw/${slug}`,
  };
}

// ── Lint ────────────────────────────────────────────────────────────────────

export type WikiLintKind =
  | "orphan"
  | "broken-xref"
  | "missing-description"
  | "uncited-raw"
  | "stale-index"
  | "broken-source";

export interface WikiLintFinding {
  kind: WikiLintKind;
  refs: string[];
  message: string;
}

export interface WikiLintReport {
  wiki: string;
  pagesScanned: number;
  rawsScanned: number;
  findings: WikiLintFinding[];
}

/**
 * Deterministic structural lint for a single wiki. No reasoning, no LLM.
 *
 * Checks:
 *   - `orphan`: page has no incoming AND no outgoing xrefs
 *   - `broken-xref`: page xref points at a nonexistent wiki page
 *   - `missing-description`: page frontmatter `description` is empty/missing
 *   - `uncited-raw`: `raw/<slug>.md` not listed in any page's `sources:`
 *   - `stale-index`: `index.md` mtime is older than the newest page mtime
 */
export function lintWiki(stashDir: string, name: string): WikiLintReport {
  const wikiDir = resolveWikiSource(stashDir, name).path;
  const pages = listPages(stashDir, name);
  const { raws, pagesLastModifiedMs } = scanWikiFiles(wikiDir);

  const pageRefs = new Set(pages.map((p) => p.ref));
  const incomingXrefs = new Map<string, number>();
  for (const page of pages) {
    for (const xref of page.xrefs ?? []) {
      incomingXrefs.set(xref, (incomingXrefs.get(xref) ?? 0) + 1);
    }
  }

  const findings: WikiLintFinding[] = [];

  // orphans + missing-description + broken-xref
  for (const page of pages) {
    const outCount = page.xrefs?.length ?? 0;
    const inCount = incomingXrefs.get(page.ref) ?? 0;
    if (outCount === 0 && inCount === 0) {
      findings.push({
        kind: "orphan",
        refs: [page.ref],
        message: `Page ${page.ref} has no incoming or outgoing xrefs.`,
      });
    }
    if (!page.description) {
      findings.push({
        kind: "missing-description",
        refs: [page.ref],
        message: `Page ${page.ref} is missing a frontmatter \`description\`.`,
      });
    }
    for (const xref of page.xrefs ?? []) {
      // Only validate wiki:<this-wiki>/... refs. External refs (other wikis,
      // knowledge:, skill:, etc.) are left alone — a cross-wiki link is a
      // feature, not a defect.
      const target = extractWikiNameFromRef(xref);
      if (target !== name) continue;
      if (!pageRefs.has(xref)) {
        findings.push({
          kind: "broken-xref",
          refs: [page.ref, xref],
          message: `Page ${page.ref} has xref to nonexistent page ${xref}.`,
        });
      }
    }
  }

  // uncited-raw
  const citedRawSlugs = new Set<string>();
  for (const page of pages) {
    for (const src of page.sources ?? []) {
      // accept "raw/<slug>.md" or "raw/<slug>"
      const match = src.match(/^raw\/([^/\s]+?)(?:\.md)?$/);
      if (match) citedRawSlugs.add(match[1]);
    }
  }
  for (const rawPath of raws) {
    const base = path.basename(rawPath, ".md");
    if (!citedRawSlugs.has(base)) {
      findings.push({
        kind: "uncited-raw",
        refs: [`wiki:${name}/raw/${base}`],
        message: `Raw source raw/${base}.md is not cited by any page's sources: frontmatter.`,
      });
    }
  }

  // broken-source: each page's sources: entries must resolve to an existing raw file.
  for (const page of pages) {
    for (const src of page.sources ?? []) {
      const match = src.match(/^raw\/([^/\s]+?)(?:\.md)?$/);
      if (!match) continue; // non-raw source entries are out of scope
      const slug = match[1];
      const rawFilePath = path.join(wikiDir, RAW_SUBDIR, `${slug}.md`);
      if (!fs.existsSync(rawFilePath)) {
        findings.push({
          kind: "broken-source",
          refs: [page.ref],
          message: `Page "${page.ref}" references missing raw source "raw/${slug}".`,
        });
      }
    }
  }

  // stale-index: compare index.md's mtime to the newest PAGE mtime only.
  // Stashing a raw source or appending to log.md must NOT flag the index as
  // stale — the index catalogs pages, not raws or meta files.
  const indexPath = path.join(wikiDir, INDEX_MD);
  try {
    const indexMtimeMs = fs.statSync(indexPath).mtimeMs;
    if (pagesLastModifiedMs !== undefined && pagesLastModifiedMs > indexMtimeMs + 1) {
      // +1 ms fudge factor: when index is regenerated in the same tick as a
      // page, the two stats can tie exactly; don't flag equality.
      findings.push({
        kind: "stale-index",
        refs: [`wiki:${name}/index`],
        message: `index.md is older than the newest page. Run \`akm index\` to regenerate.`,
      });
    }
  } catch {
    // No index.md — report it as a stale/missing index so `akm wiki lint`
    // still gives actionable output without erroring out.
    findings.push({
      kind: "stale-index",
      refs: [`wiki:${name}/index`],
      message: "index.md is missing. Run `akm index` to regenerate.",
    });
  }

  return {
    wiki: name,
    pagesScanned: pages.length,
    rawsScanned: raws.length,
    findings,
  };
}

// ── Index regeneration ─────────────────────────────────────────────────────

/**
 * Rebuild a wiki's `index.md` from its pages' frontmatter.
 *
 * Pages are grouped by `pageKind` (falling back to `uncategorised`) and
 * listed alphabetically inside each group. If the wiki directory doesn't
 * exist or has no pages, a fresh empty template is written.
 *
 * The function is best-effort: it catches all filesystem errors and returns
 * a boolean so callers (the indexer) can keep going even if one wiki is
 * broken. Never throws.
 */
export function regenerateWikiIndex(stashDir: string, name: string): boolean {
  try {
    const wikiDir = resolveWikiDir(stashDir, name);
    if (!fs.existsSync(wikiDir)) return false;
    const pages = listPages(stashDir, name);

    if (pages.length === 0) {
      fs.writeFileSync(path.join(wikiDir, INDEX_MD), buildIndexMd(name), "utf8");
      return true;
    }

    const byKind = new Map<string, WikiPageEntry[]>();
    for (const page of pages) {
      const kind = page.pageKind ?? "uncategorised";
      const group = byKind.get(kind);
      if (group) group.push(page);
      else byKind.set(kind, [page]);
    }

    const kindOrder = Array.from(byKind.keys()).sort((a, b) => {
      if (a === "uncategorised") return 1;
      if (b === "uncategorised") return -1;
      return a.localeCompare(b);
    });

    const lines: string[] = [
      "---",
      `description: Catalog of pages in the ${name} wiki. Regenerated by \`akm index\`.`,
      "wikiRole: index",
      "---",
      "",
      `# ${name} — index`,
      "",
      "_This file is regenerated on every `akm index` run. Manual edits are preserved until the next regeneration, then replaced._",
      "",
    ];

    for (const kind of kindOrder) {
      const group = (byKind.get(kind) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      const heading = kind.charAt(0).toUpperCase() + kind.slice(1);
      lines.push(`## ${heading}`);
      lines.push("");
      for (const page of group) {
        const desc = page.description ? ` — ${page.description}` : "";
        lines.push(`- \`${page.ref}\`${desc}`);
      }
      lines.push("");
    }

    fs.writeFileSync(path.join(wikiDir, INDEX_MD), lines.join("\n"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Regenerate `index.md` for every wiki found under `<stashDir>/wikis/`.
 *
 * Called from `akmIndex()` as a side effect after the FTS rebuild. Never
 * throws; returns the list of wiki names that were regenerated.
 */
export function regenerateAllWikiIndexes(stashDir: string): string[] {
  const wikisRoot = resolveWikisRoot(stashDir);
  if (!fs.existsSync(wikisRoot)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wikisRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const regenerated: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!WIKI_NAME_RE.test(entry.name)) continue;
    if (regenerateWikiIndex(stashDir, entry.name)) regenerated.push(entry.name);
  }
  return regenerated;
}

// ── Ingest workflow printer ────────────────────────────────────────────────

export interface IngestWorkflowResult {
  wiki: string;
  path: string;
  schemaPath: string;
  workflow: string;
}

/**
 * Build a markdown workflow string for ingesting a source into the named
 * wiki. Does NOT perform the ingest — it prints the recipe the agent
 * follows using the other eight verbs plus its native file tools.
 *
 * The workflow is parameterised with the wiki's resolved absolute path and
 * schema location so the agent can jump straight in without any additional
 * lookup. Because the output references the CLI by name (`akm wiki stash`
 * etc.), the printer never drifts from the actual command surface — changing
 * a verb here and in the printer stays colocated.
 */
export function buildIngestWorkflow(stashDir: string, name: string): IngestWorkflowResult {
  const wikiDir = resolveWikiSource(stashDir, name).path;
  const schemaPath = path.join(wikiDir, SCHEMA_MD);
  const workflow = `# Ingest workflow for wiki:${name}

Wiki location: ${wikiDir}
Schema: ${schemaPath}

Follow these steps. akm commands handle the invariants; use your native
Read/Write/Edit tools for page edits.

1. **Read the schema.** Open \`${schemaPath}\`. It defines the voice, page
   kinds, contradiction policy, and any wiki-specific conventions. Do not
   skip this step even on familiar wikis — the schema may have changed.

2. **File the source under \`raw/\`.**
   \`\`\`sh
   akm wiki stash ${name} <path-or-url-to-source>
   # or: cat <source> | akm wiki stash ${name} -
   \`\`\`
   Returns \`{ slug, path, ref }\`. The raw copy is immutable — never edit it.

3. **Find related existing pages.**
   \`\`\`sh
   akm wiki search ${name} "<key terms from the source>"
   \`\`\`
   Read the top hits with \`akm show wiki:${name}/<page>\`. Use
   \`akm show wiki:${name}/<page> toc\` for large pages.

4. **Decide for each candidate.** For each related page:
   - **Append**: add a section or paragraph under the relevant heading.
     Include the raw source in the page's \`sources:\` frontmatter list.
   - **Contradict**: note the tension explicitly; don't silently overwrite.
     Follow the schema's contradiction policy.
   - **Skip**: source doesn't add to this page — move on.

5. **Create new pages for concepts/entities the source introduces.** Each
   new page must have frontmatter with \`description\`, \`pageKind\`,
   \`xrefs\`, and \`sources\`. Cross-reference with related pages both
   directions.

6. **Update xrefs both ways.** If page A now xrefs page B, page B must xref
   page A. \`akm wiki lint ${name}\` will flag violations.

7. **Append to \`log.md\`.** One entry per ingest: date, source slug, one-line
   summary, refs to created/edited pages. Newest at the top.

8. **Regenerate the index + verify.**
   \`\`\`sh
   akm index
   akm wiki lint ${name}
   \`\`\`
   Resolve any lint findings before calling the ingest done.

That's it. \`akm\` never calls an LLM — reasoning is your job; it just owns
the invariants (raw immutability, unique slugs, ref validation, index
regeneration, structural lint).
`;
  return { wiki: name, path: wikiDir, schemaPath, workflow };
}
