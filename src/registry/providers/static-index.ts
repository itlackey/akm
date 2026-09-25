// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { RegistryConfigEntry } from "../../core/config/config";
import { NotFoundError } from "../../core/errors";
import {
  formatRegistryCredentialWarning,
  formatRegistryError,
  formatRegistryLabel,
  hasRegistryUrlCredentials,
} from "../../core/registry-url";
import { warnOnce } from "../../core/warn";
import { asString } from "../../integrations/github";
import { fetchCachedJson } from "../../storage/repositories/registry-index-cache-repository";
import { registerRegistryProvider } from "../factory";
import { fetchRegistryJson } from "../network";
import { buildInstallRef } from "../resolve";
import type { InstallKind, RegistryAssetEntry, RegistryAssetSearchHit, RegistrySearchHit } from "../types";
import type { RegistryProvider, RegistryProviderResult, RegistryProviderSearchOptions } from "./types";

// ── Constants ───────────────────────────────────────────────────────────────

/** Cache TTL in milliseconds (1 hour). */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Index format versions this reader was written against; both use the same `stashes[]` wire format. */
const KNOWN_INDEX_VERSIONS = new Set([2, 3]);

// ── Types ───────────────────────────────────────────────────────────────────

export interface RegistryIndex {
  /** Format version as published. Any value is read; an unknown one is warned about once. */
  version?: number;
  updatedAt?: string;
  stashes: RegistryBundleEntry[];
}

export interface RegistryBundleEntry {
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
    if (hasRegistryUrlCredentials(this.config.url)) {
      return { hits: [], warnings: [formatRegistryCredentialWarning(this.config)] };
    }
    const warnings: string[] = [];
    const bundles = await this.loadBundles(warnings);

    const hits = scoreBundles(bundles, options.query, options.limit);

    let assetHits: RegistryAssetSearchHit[] | undefined;
    if (options.includeAssets) {
      const scored = scoreAssets(bundles, options.query, options.limit);
      if (scored.length > 0) assetHits = scored;
    }

    return { hits, assetHits, warnings: warnings.length > 0 ? warnings : undefined };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async loadBundles(warnings: string[]): Promise<Array<{ stash: RegistryBundleEntry; registryName?: string }>> {
    const bundles: Array<{ stash: RegistryBundleEntry; registryName?: string }> = [];
    try {
      const index = await loadIndex(this.config);
      if (index) {
        if (!KNOWN_INDEX_VERSIONS.has(index.version ?? Number.NaN)) {
          warnOnce(
            `registry-index-version:${this.config.url}`,
            `Registry ${formatRegistryLabel(this.config)}: index version ${index.version ?? "(missing)"} is not one this akm was written against (2 or 3); reading the entries it can.`,
          );
        }
        const regName = this.config.name;
        for (const stash of index.stashes) {
          if (stash.source === "git") {
            warnings.push(
              `Registry ${formatRegistryLabel(this.config)}: ignored ${stash.id} because registry-provided git transport refs are not installable`,
            );
            continue;
          }
          bundles.push({ stash, registryName: regName });
        }
      }
    } catch (err) {
      warnings.push(`Registry ${formatRegistryLabel(this.config)}: ${formatRegistryError(err)}`);
    }
    return bundles;
  }
}

// ── Self-register ───────────────────────────────────────────────────────────

registerRegistryProvider("static-index", (config) => new StaticIndexProvider(config));

// ── Index loading with cache ────────────────────────────────────────────────

async function loadIndex(entry: RegistryConfigEntry): Promise<RegistryIndex | null> {
  return fetchCachedJson<RegistryIndex>({
    cacheKey: entry.url,
    ttlMs: CACHE_TTL_MS,
    // Both the fresh hit and the stale fallback parse identically; a corrupt
    // cache row lets JSON.parse throw out of the load.
    parseCache: (json) => parseRegistryIndex(JSON.parse(json) as unknown) ?? undefined,
    fetchFresh: async () => {
      // Registry indexes can grow large; 50 MB is the cap on what one is
      // allowed to send.
      const data = await fetchRegistryJson<unknown>(entry.url, { timeoutMs: 10_000, maxBytes: 50 * 1024 * 1024 });
      const index = parseRegistryIndex(data);
      if (!index) {
        throw new NotFoundError(
          `Registry index at ${formatRegistryLabel(entry)} has no stashes array`,
          "REGISTRY_RESPONSE_INVALID",
        );
      }
      return { value: index, cacheJson: JSON.stringify(index) };
    },
  });
}

// ── Index parsing (exported for reuse) ──────────────────────────────────────

/**
 * Read whatever the index carries: the only requirement is a `stashes` array.
 * Entries that lack an id, name, ref or known source are skipped; `version`
 * and `updatedAt` are carried through as published.
 */
export function parseRegistryIndex(data: unknown): RegistryIndex | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.stashes)) return null;

  const stashes = obj.stashes.flatMap((raw): RegistryBundleEntry[] => {
    const stash = parseBundleEntry(raw);
    return stash ? [stash] : [];
  });

  return {
    version: typeof obj.version === "number" ? obj.version : undefined,
    updatedAt: asString(obj.updatedAt),
    stashes,
  };
}

// ── Stash entry parsing ───────────────────────────────────────────────────────

function parseBundleEntry(raw: unknown): RegistryBundleEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const id = asString(obj.id);
  const name = asString(obj.name);
  const ref = asString(obj.ref);
  const source = asSource(obj.source);
  if (!id || !name || !ref || !source) return null;

  // Some published indexes include `curated`; it is intentionally ignored.
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

function scoreBundles(
  stashes: Array<{ stash: RegistryBundleEntry; registryName?: string }>,
  query: string,
  limit: number,
): RegistrySearchHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored: Array<{ stash: RegistryBundleEntry; registryName?: string; score: number }> = [];

  for (const { stash, registryName } of stashes) {
    const score = scoreStash(stash, tokens);
    if (score > 0) {
      scored.push({ stash, registryName, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ stash, registryName, score }) => toSearchHit(stash, score, registryName));
}

function scoreStash(stash: RegistryBundleEntry, tokens: string[]): number {
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

function toSearchHit(stash: RegistryBundleEntry, score: number, registryName?: string): RegistrySearchHit {
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
    installRef: buildInstallRef(stash.source, stash.ref, "registry"),
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
  stashes: Array<{ stash: RegistryBundleEntry; registryName?: string }>,
  query: string,
  limit: number,
): RegistryAssetSearchHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: Array<{ hit: RegistryAssetSearchHit; score: number }> = [];

  for (const { stash, registryName } of stashes) {
    if (!stash.assets || stash.assets.length === 0) continue;

    const installRef = buildInstallRef(stash.source, stash.ref, "registry");

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
            action: `akm bundle add ${installRef}`,
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

function asSource(value: unknown): InstallKind | undefined {
  if (value === "npm" || value === "github" || value === "git" || value === "local") return value;
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === "string");
  return filtered.length > 0 ? filtered : undefined;
}
