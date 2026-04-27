import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry, jsonWithByteCap, toErrorMessage } from "../../core/common";
import type { RegistryConfigEntry } from "../../core/config";
import { getRegistryIndexCacheDir } from "../../core/paths";
import { asString } from "../../integrations/github";
import { registerProvider } from "../factory";
import type { ParsedRegistryRef, RegistryAssetEntry, RegistryAssetSearchHit, RegistrySearchHit } from "../types";
import type {
  AssetPreview,
  KitId,
  KitManifest,
  KitResult,
  RegistryProvider,
  RegistryProviderResult,
  RegistryProviderSearchOptions,
  RegistryQuery,
} from "./types";

// ── Constants ───────────────────────────────────────────────────────────────

/** Cache TTL in milliseconds (1 hour). */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Maximum age before cache is considered stale but still usable as fallback (7 days). */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────────────────────

export interface RegistryIndex {
  version: number;
  updatedAt: string;
  stashes: RegistryStashEntry[];
}

export interface RegistryStashEntry {
  id: string;
  name: string;
  description?: string;
  ref: string;
  source: "npm" | "github" | "git" | "local";
  homepage?: string;
  tags?: string[];
  assetTypes?: string[];
  assets?: RegistryAssetEntry[];
  author?: string;
  license?: string;
  latestVersion?: string;
}

// ── Provider class ──────────────────────────────────────────────────────────

class StaticIndexProvider implements RegistryProvider {
  readonly type = "static-index";
  private readonly config: RegistryConfigEntry;

  constructor(config: RegistryConfigEntry) {
    this.config = config;
  }

  async search(options: RegistryProviderSearchOptions): Promise<RegistryProviderResult> {
    const warnings: string[] = [];
    const allKits = await this.loadAllKits(warnings);

    const hits = scoreKits(allKits, options.query, options.limit);

    let assetHits: RegistryAssetSearchHit[] | undefined;
    if (options.includeAssets) {
      const scored = scoreAssets(allKits, options.query, options.limit);
      if (scored.length > 0) assetHits = scored;
    }

    return { hits, assetHits, warnings: warnings.length > 0 ? warnings : undefined };
  }

  // ── v1-spec §3.1 surface ────────────────────────────────────────────────

  async searchKits(q: RegistryQuery): Promise<KitResult[]> {
    const result = await this.search({
      query: q.text,
      limit: q.limit ?? 20,
      includeAssets: false,
    });
    return result.hits.map(hitToKitResult);
  }

  async searchAssets(q: RegistryQuery): Promise<AssetPreview[]> {
    const result = await this.search({
      query: q.text,
      limit: q.limit ?? 20,
      includeAssets: true,
    });
    return (result.assetHits ?? []).map(assetHitToPreview);
  }

  async getKit(id: KitId): Promise<KitManifest | null> {
    const allKits = await this.loadAllKits([]);
    const found = allKits.find(({ stash }) => stash.id === id);
    if (!found) return null;
    const installRef = buildInstallRef(found.stash.source, found.stash.ref);
    return {
      id: found.stash.id,
      installRef,
      assets: found.stash.assets?.map((asset) => ({
        kitId: found.stash.id,
        type: asset.type,
        name: asset.name,
        summary: asset.description,
        cloneRef: installRef,
      })),
    };
  }

  /**
   * Static-index doesn't own a URL prefix — any `ParsedRegistryRef` could
   * theoretically be backed by an entry in some static-index registry. We
   * therefore claim every ref. The orchestrator picks the first matching
   * provider, and `static-index` is registered first by `index.ts`, so this
   * is effectively the default catch-all.
   */
  canHandle(_ref: ParsedRegistryRef): boolean {
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async loadAllKits(warnings: string[]): Promise<Array<{ stash: RegistryStashEntry; registryName?: string }>> {
    const allKits: Array<{ stash: RegistryStashEntry; registryName?: string }> = [];
    try {
      const index = await loadIndex(this.config);
      if (index) {
        const regName = this.config.name;
        for (const stash of index.stashes) {
          allKits.push({ stash, registryName: regName });
        }
      }
    } catch (err) {
      const label = this.config.name ? `${this.config.name} (${this.config.url})` : this.config.url;
      warnings.push(`Registry ${label}: ${toErrorMessage(err)}`);
    }
    return allKits;
  }
}

function hitToKitResult(hit: RegistrySearchHit): KitResult {
  return {
    id: hit.id,
    title: hit.title,
    summary: hit.description,
    installRef: hit.installRef,
    score: hit.score,
  };
}

function assetHitToPreview(hit: RegistryAssetSearchHit): AssetPreview {
  return {
    kitId: hit.stash.id,
    type: hit.assetType,
    name: hit.assetName,
    summary: hit.description,
    cloneRef: hit.action.replace(/^akm add\s+/, ""),
  };
}

// ── Self-register ───────────────────────────────────────────────────────────

registerProvider("static-index", (config) => new StaticIndexProvider(config));

// ── Index loading with cache ────────────────────────────────────────────────

async function loadIndex(entry: RegistryConfigEntry): Promise<RegistryIndex | null> {
  const cachePath = indexCachePath(entry.url);
  const cached = readCachedIndex(cachePath);

  // Fresh cache: return immediately
  if (cached && !isCacheExpired(cached.mtime)) {
    return cached.index;
  }

  // Try to fetch fresh index
  try {
    const response = await fetchWithRetry(entry.url, undefined, { timeout: 10_000 });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    // Cap at 50 MB — registry indexes can grow large but unbounded
    // responses from a compromised server would OOM us.
    const data = await jsonWithByteCap<unknown>(response, 50 * 1024 * 1024);
    const index = parseRegistryIndex(data);
    if (index) {
      writeCachedIndex(cachePath, index);
      return index;
    }
    throw new Error("Invalid registry index format");
  } catch (err) {
    // Fetch failed — use stale cache if available
    if (cached && !isCacheStale(cached.mtime)) {
      return cached.index;
    }
    throw err;
  }
}

// ── Cache helpers (exported for reuse by other providers) ───────────────────

export function indexCachePath(url: string): string {
  const indexDir = getRegistryIndexCacheDir();
  // Deterministic filename from URL
  const slug = url
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return path.join(indexDir, `${slug}.json`);
}

export function readCachedIndex(cachePath: string): { index: RegistryIndex; mtime: number } | null {
  try {
    const stat = fs.statSync(cachePath);
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const index = parseRegistryIndex(raw);
    if (!index) return null;
    return { index, mtime: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function writeCachedIndex(cachePath: string, index: RegistryIndex): void {
  try {
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${cachePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmpPath, JSON.stringify(index), "utf8");
    fs.renameSync(tmpPath, cachePath);
  } catch {
    // Best-effort caching — don't fail the search if we can't write
  }
}

export function isCacheExpired(mtimeMs: number): boolean {
  return Date.now() - mtimeMs > CACHE_TTL_MS;
}

export function isCacheStale(mtimeMs: number): boolean {
  return Date.now() - mtimeMs > CACHE_STALE_MS;
}

// ── Index parsing (exported for reuse) ──────────────────────────────────────

export function parseRegistryIndex(data: unknown): RegistryIndex | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.version !== "number" || obj.version !== 3) return null;
  if (typeof obj.updatedAt !== "string") return null;
  if (!Array.isArray(obj.stashes)) return null;

  const stashes = obj.stashes.flatMap((raw): RegistryStashEntry[] => {
    const stash = parseStashEntry(raw);
    return stash ? [stash] : [];
  });

  return { version: obj.version, updatedAt: obj.updatedAt, stashes };
}

// ── Stash entry parsing ───────────────────────────────────────────────────────

function parseStashEntry(raw: unknown): RegistryStashEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const id = asString(obj.id);
  const name = asString(obj.name);
  const ref = asString(obj.ref);
  const source = asSource(obj.source);
  if (!id || !name || !ref || !source) return null;

  // The legacy registry boolean `curated` is removed in v1. Legacy index JSON
  // containing a `curated` key parses normally; the key is silently ignored
  // (v1 spec §4.2, docs/migration/v1.md).
  return {
    id,
    name,
    ref,
    source,
    description: asString(obj.description),
    homepage: asString(obj.homepage),
    tags: asStringArray(obj.tags),
    assetTypes: asStringArray(obj.assetTypes),
    assets: parseAssets(obj.assets),
    author: asString(obj.author),
    license: asString(obj.license),
    latestVersion: asString(obj.latestVersion),
  };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function scoreKits(
  stashes: Array<{ stash: RegistryStashEntry; registryName?: string }>,
  query: string,
  limit: number,
): RegistrySearchHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored: Array<{ stash: RegistryStashEntry; registryName?: string; score: number }> = [];

  for (const { stash, registryName } of stashes) {
    const score = scoreStash(stash, tokens);
    if (score > 0) {
      scored.push({ stash, registryName, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ stash, registryName, score }) => toSearchHit(stash, score, registryName));
}

function scoreStash(stash: RegistryStashEntry, tokens: string[]): number {
  let score = 0;
  const nameLower = stash.name.toLowerCase();
  const descLower = (stash.description ?? "").toLowerCase();
  const tagsLower = (stash.tags ?? []).map((t) => t.toLowerCase());

  for (const token of tokens) {
    // Exact name match is strongest signal
    if (nameLower === token) {
      score += 1.0;
    } else if (nameLower.includes(token)) {
      score += 0.6;
    }

    // Tag matches are high-signal (curated keywords)
    if (tagsLower.some((tag) => tag === token)) {
      score += 0.5;
    } else if (tagsLower.some((tag) => tag.includes(token))) {
      score += 0.25;
    }

    // Description substring
    if (descLower.includes(token)) {
      score += 0.2;
    }

    // Author match
    if (stash.author?.toLowerCase().includes(token)) {
      score += 0.15;
    }
  }

  // Normalize by token count so multi-word queries don't inflate scores
  return tokens.length > 0 ? score / tokens.length : 0;
}

function toSearchHit(stash: RegistryStashEntry, score: number, registryName?: string): RegistrySearchHit {
  const metadata: Record<string, string> = {};
  if (stash.latestVersion) metadata.version = stash.latestVersion;
  if (stash.author) metadata.author = stash.author;
  if (stash.license) metadata.license = stash.license;
  if (stash.assetTypes?.length) metadata.assetTypes = stash.assetTypes.join(", ");

  return {
    source: stash.source,
    id: stash.id,
    title: stash.name,
    description: stash.description,
    ref: stash.ref,
    installRef: buildInstallRef(stash.source, stash.ref),
    homepage: stash.homepage,
    score: Math.round(score * 1000) / 1000,
    metadata,
    registryName,
  };
}

// ── Asset parsing ───────────────────────────────────────────────────────────

function parseAssets(raw: unknown): RegistryAssetEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw.flatMap((item): RegistryAssetEntry[] => {
    const entry = parseAssetEntry(item);
    return entry ? [entry] : [];
  });
  return parsed.length > 0 ? parsed : undefined;
}

function parseAssetEntry(raw: unknown): RegistryAssetEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const type = asString(obj.type);
  const name = asString(obj.name);
  if (!type || !name) return null;

  return {
    type,
    name,
    description: asString(obj.description),
    tags: asStringArray(obj.tags),
    estimatedTokens: typeof obj.estimatedTokens === "number" ? obj.estimatedTokens : undefined,
  };
}

// ── Asset-level scoring ─────────────────────────────────────────────────────

function scoreAssets(
  stashes: Array<{ stash: RegistryStashEntry; registryName?: string }>,
  query: string,
  limit: number,
): RegistryAssetSearchHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: Array<{ hit: RegistryAssetSearchHit; score: number }> = [];

  for (const { stash, registryName } of stashes) {
    if (!stash.assets || stash.assets.length === 0) continue;

    const installRef = buildInstallRef(stash.source, stash.ref);

    for (const asset of stash.assets) {
      const score = scoreAsset(asset, tokens);
      if (score > 0) {
        scored.push({
          hit: {
            type: "registry-asset",
            assetType: asset.type,
            assetName: asset.name,
            description: asset.description,
            estimatedTokens: asset.estimatedTokens,
            stash: { id: stash.id, name: stash.name },
            registryName,
            action: `akm add ${installRef}`,
            score: Math.round(score * 1000) / 1000,
          },
          score,
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ hit }) => hit);
}

function scoreAsset(asset: RegistryAssetEntry, tokens: string[]): number {
  let score = 0;
  const nameLower = asset.name.toLowerCase();
  const descLower = (asset.description ?? "").toLowerCase();
  const tagsLower = (asset.tags ?? []).map((t) => t.toLowerCase());
  const typeLower = asset.type.toLowerCase();

  for (const token of tokens) {
    if (nameLower === token) {
      score += 1.0;
    } else if (nameLower.includes(token)) {
      score += 0.6;
    }

    if (typeLower === token) {
      score += 0.4;
    } else if (typeLower.includes(token)) {
      score += 0.2;
    }

    if (tagsLower.some((tag) => tag === token)) {
      score += 0.5;
    } else if (tagsLower.some((tag) => tag.includes(token))) {
      score += 0.25;
    }

    if (descLower.includes(token)) {
      score += 0.2;
    }
  }

  return tokens.length > 0 ? score / tokens.length : 0;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function asSource(value: unknown): "npm" | "github" | "git" | "local" | undefined {
  if (value === "npm" || value === "github" || value === "git" || value === "local") return value;
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function buildInstallRef(source: string, ref: string): string {
  switch (source) {
    case "npm":
      return `npm:${ref}`;
    case "git":
      return `git+${ref}`;
    case "local":
      return `file:${ref}`;
    default:
      return `github:${ref}`;
  }
}
