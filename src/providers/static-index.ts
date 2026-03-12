import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../common";
import type { RegistryConfigEntry } from "../config";
import { getRegistryIndexCacheDir } from "../paths";
import { registerProvider } from "../provider-registry";
import type { RegistryProvider, RegistryProviderResult, RegistryProviderSearchOptions } from "../registry-provider";
import type { RegistryAssetEntry, RegistryAssetSearchHit, RegistrySearchHit } from "../registry-types";

// ── Constants ───────────────────────────────────────────────────────────────

/** Cache TTL in milliseconds (1 hour). */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Maximum age before cache is considered stale but still usable as fallback (7 days). */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────────────────────

export interface RegistryIndex {
  version: number;
  updatedAt: string;
  kits: RegistryKitEntry[];
}

export interface RegistryKitEntry {
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
  /** Whether this entry was manually reviewed and approved */
  curated?: boolean;
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
    const allKits: Array<{ kit: RegistryKitEntry; registryName?: string }> = [];

    try {
      const index = await loadIndex(this.config);
      if (index) {
        const regName = this.config.name;
        for (const kit of index.kits) {
          allKits.push({ kit, registryName: regName });
        }
      }
    } catch (err) {
      const label = this.config.name ? `${this.config.name} (${this.config.url})` : this.config.url;
      warnings.push(`Registry ${label}: ${toErrorMessage(err)}`);
    }

    const hits = scoreKits(allKits, options.query, options.limit);

    let assetHits: RegistryAssetSearchHit[] | undefined;
    if (options.includeAssets) {
      const scored = scoreAssets(allKits, options.query, options.limit);
      if (scored.length > 0) assetHits = scored;
    }

    return { hits, assetHits, warnings: warnings.length > 0 ? warnings : undefined };
  }
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
    const data = (await response.json()) as unknown;
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
    const tmpPath = `${cachePath}.tmp.${process.pid}`;
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

  if (typeof obj.version !== "number" || (obj.version !== 1 && obj.version !== 2)) return null;
  if (typeof obj.updatedAt !== "string") return null;
  if (!Array.isArray(obj.kits)) return null;

  const kits = obj.kits.flatMap((raw): RegistryKitEntry[] => {
    const kit = parseKitEntry(raw);
    return kit ? [kit] : [];
  });

  return { version: obj.version, updatedAt: obj.updatedAt, kits };
}

// ── Kit entry parsing ───────────────────────────────────────────────────────

function parseKitEntry(raw: unknown): RegistryKitEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const id = asString(obj.id);
  const name = asString(obj.name);
  const ref = asString(obj.ref);
  const source = asSource(obj.source);
  if (!id || !name || !ref || !source) return null;

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
    curated: obj.curated === true ? true : undefined,
  };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function scoreKits(
  kits: Array<{ kit: RegistryKitEntry; registryName?: string }>,
  query: string,
  limit: number,
): RegistrySearchHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored: Array<{ kit: RegistryKitEntry; registryName?: string; score: number }> = [];

  for (const { kit, registryName } of kits) {
    const score = scoreKit(kit, tokens);
    if (score > 0) {
      scored.push({ kit, registryName, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ kit, registryName, score }) => toSearchHit(kit, score, registryName));
}

function scoreKit(kit: RegistryKitEntry, tokens: string[]): number {
  let score = 0;
  const nameLower = kit.name.toLowerCase();
  const descLower = (kit.description ?? "").toLowerCase();
  const tagsLower = (kit.tags ?? []).map((t) => t.toLowerCase());

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
    if (kit.author?.toLowerCase().includes(token)) {
      score += 0.15;
    }
  }

  // Normalize by token count so multi-word queries don't inflate scores
  return tokens.length > 0 ? score / tokens.length : 0;
}

function toSearchHit(kit: RegistryKitEntry, score: number, registryName?: string): RegistrySearchHit {
  const metadata: Record<string, string> = {};
  if (kit.latestVersion) metadata.version = kit.latestVersion;
  if (kit.author) metadata.author = kit.author;
  if (kit.license) metadata.license = kit.license;
  if (kit.assetTypes?.length) metadata.assetTypes = kit.assetTypes.join(", ");

  return {
    source: kit.source,
    id: kit.id,
    title: kit.name,
    description: kit.description,
    ref: kit.ref,
    homepage: kit.homepage,
    score: Math.round(score * 1000) / 1000,
    metadata,
    curated: kit.curated,
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
  };
}

// ── Asset-level scoring ─────────────────────────────────────────────────────

function scoreAssets(
  kits: Array<{ kit: RegistryKitEntry; registryName?: string }>,
  query: string,
  limit: number,
): RegistryAssetSearchHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: Array<{ hit: RegistryAssetSearchHit; score: number }> = [];

  for (const { kit, registryName } of kits) {
    if (!kit.assets || kit.assets.length === 0) continue;

    const installRef =
      kit.source === "npm"
        ? `npm:${kit.ref}`
        : kit.source === "git"
          ? `git+${kit.ref}`
          : kit.source === "local"
            ? kit.ref
            : `github:${kit.ref}`;

    for (const asset of kit.assets) {
      const score = scoreAsset(asset, tokens);
      if (score > 0) {
        scored.push({
          hit: {
            type: "registry-asset",
            assetType: asset.type,
            assetName: asset.name,
            description: asset.description,
            kit: { id: kit.id, name: kit.name },
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asSource(value: unknown): "npm" | "github" | "git" | "local" | undefined {
  if (value === "npm" || value === "github" || value === "git" || value === "local") return value;
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
