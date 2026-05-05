/**
 * Build the v2 JSON registry index consumed by the `static-index` registry
 * provider. This module emits artifacts that conform to the v2 schema; the
 * schema itself is the input contract owned by `src/registry/providers/static-index.ts`
 * (see v1 architecture spec §3.3 — "the v2 JSON index schema belongs to
 * static-index"). When the schema changes, both the parser in `static-index.ts`
 * and the JSON Schema in `docs/technical/registry-index.schema.json` must be
 * updated together with this builder.
 */

import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry, jsonWithByteCap } from "../core/common";
import { getCacheDir } from "../core/paths";
import { generateMetadataFlat, loadStashFile, type StashEntry } from "../indexer/metadata";
import { walkStashFlat } from "../indexer/walker";
import { asRecord, asString, GITHUB_API_BASE, githubHeaders } from "../integrations/github";
import { copyIncludedPaths, findNearestIncludeConfig } from "../sources/include";
import { detectStashRoot } from "../sources/providers/provider-utils";
import { extractTarGzSecure } from "../sources/providers/tar-utils";
import { parseRegistryIndex, type RegistryIndex, type RegistryStashEntry } from "./providers/static-index";

const DEFAULT_NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const REQUIRED_KEYWORDS = ["akm-stash"];
const GITHUB_TOPICS = ["akm-stash"];
const EXCLUDED_REPOS = new Set(["itlackey/akm"]);
const EXCLUDED_NPM_PACKAGES = new Set(["akm-cli"]);

export interface BuildRegistryIndexOptions {
  manualEntriesPath?: string;
  npmRegistryBase?: string;
  githubApiBase?: string;
}

export interface BuildRegistryIndexResult {
  index: RegistryIndex;
  counts: {
    manual: number;
    npm: number;
    github: number;
    total: number;
  };
  paths: {
    manualEntriesPath: string;
  };
}

interface NpmSearchResult {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
      links?: { homepage?: string; npm?: string; repository?: string };
      author?: { name?: string; username?: string };
      publisher?: { username?: string };
    };
  }>;
}

interface GithubRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  owner: { login: string };
  license: { spdx_id: string } | null;
  topics: string[];
  default_branch: string;
}

interface GithubSearchResponse {
  items: GithubRepo[];
}

interface PackageInspection {
  description?: string;
  latestVersion?: string;
  license?: string;
  tags?: string[];
  assetTypes?: string[];
  assets?: RegistryStashEntry["assets"];
}

const EMPTY_INSPECTION: PackageInspection = {};

function getDefaultRegistryBuildDir(): string {
  return path.join(getCacheDir(), "registry-build");
}

export async function buildRegistryIndex(options?: BuildRegistryIndexOptions): Promise<BuildRegistryIndexResult> {
  const manualEntriesPath = path.resolve(
    options?.manualEntriesPath ?? path.join(getDefaultRegistryBuildDir(), "manual-entries.json"),
  );
  const npmRegistryBase = trimTrailingSlash(options?.npmRegistryBase ?? DEFAULT_NPM_REGISTRY_BASE);
  const githubApiBase = trimTrailingSlash(options?.githubApiBase ?? GITHUB_API_BASE);

  const [manualKits, npmKits, githubKits] = await Promise.all([
    loadManualEntries(manualEntriesPath),
    scanNpm(npmRegistryBase),
    scanGithub(githubApiBase),
  ]);

  const stashes = deduplicateStashes([...manualKits, ...npmKits, ...githubKits]).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const index: RegistryIndex = {
    version: 3,
    updatedAt: new Date().toISOString(),
    stashes,
  };

  return {
    index,
    counts: {
      manual: manualKits.length,
      npm: npmKits.length,
      github: githubKits.length,
      total: stashes.length,
    },
    paths: {
      manualEntriesPath,
    },
  };
}

export function writeRegistryIndex(index: RegistryIndex, outPath?: string): string {
  const resolved = path.resolve(outPath ?? path.join(getDefaultRegistryBuildDir(), "index.json"));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return resolved;
}

async function scanNpm(npmRegistryBase: string): Promise<RegistryStashEntry[]> {
  const stashes: RegistryStashEntry[] = [];
  const seen = new Set<string>();

  for (const keyword of REQUIRED_KEYWORDS) {
    let offset = 0;
    const size = 250;

    while (true) {
      const url = `${npmRegistryBase}/-/v1/search?text=keywords:${encodeURIComponent(keyword)}&size=${size}&from=${offset}`;
      const data = await fetchJson<NpmSearchResult>(url);

      for (const obj of data.objects) {
        const pkg = obj.package;
        if (EXCLUDED_NPM_PACKAGES.has(pkg.name)) continue;

        const repoUrl = pkg.links?.repository ?? "";
        const normalizedRepo = repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
        if (EXCLUDED_REPOS.has(normalizedRepo)) continue;

        const id = `npm:${pkg.name}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const keywords = (pkg.keywords ?? []).map((value) => value.toLowerCase());
        if (!keywords.some((value) => REQUIRED_KEYWORDS.includes(value))) continue;

        let latestMetadata: Record<string, unknown> = {};
        try {
          latestMetadata = await fetchJson<Record<string, unknown>>(
            `${npmRegistryBase}/${encodeURIComponent(pkg.name)}/latest`,
          );
        } catch {
          latestMetadata = {};
        }

        const inspection = await inspectNpmPackage(npmRegistryBase, latestMetadata).catch(() => EMPTY_INSPECTION);
        const tags = mergeStrings(
          (pkg.keywords ?? []).filter((value) => !REQUIRED_KEYWORDS.includes(value.toLowerCase())),
          inspection.tags,
        );

        stashes.push(
          normalizeStash({
            id,
            name: pkg.name,
            description: inspection.description ?? pkg.description,
            ref: pkg.name,
            source: "npm",
            homepage: pkg.links?.homepage ?? pkg.links?.npm,
            author: pkg.author?.name ?? pkg.author?.username ?? pkg.publisher?.username,
            latestVersion: inspection.latestVersion ?? pkg.version,
            license: asString(latestMetadata.license) ?? inspection.license,
            tags,
            assetTypes: inspection.assetTypes,
            assets: inspection.assets,
          }),
        );
      }

      if (data.objects.length < size) break;
      offset += size;
    }
  }

  return stashes;
}

async function inspectNpmPackage(
  _npmRegistryBase: string,
  latestMetadata: Record<string, unknown>,
): Promise<PackageInspection> {
  const dist = asRecord(latestMetadata.dist);
  const tarballUrl = asString(dist.tarball);
  if (!tarballUrl) return {};

  const inspection = await inspectArchive(tarballUrl);
  return {
    description: asString(latestMetadata.description) ?? inspection.description,
    latestVersion: asString(latestMetadata.version) ?? inspection.latestVersion,
    license: asString(latestMetadata.license) ?? inspection.license,
    tags: mergeStrings(extractNonReservedKeywords(latestMetadata.keywords), inspection.tags),
    assetTypes: inspection.assetTypes,
    assets: inspection.assets,
  };
}

async function scanGithub(githubApiBase: string): Promise<RegistryStashEntry[]> {
  const stashes: RegistryStashEntry[] = [];
  const seen = new Set<string>();
  const headers = githubHeaders();

  for (const topic of GITHUB_TOPICS) {
    let page = 1;
    const perPage = 100;

    while (true) {
      const q = encodeURIComponent(`topic:${topic}`);
      const url = `${githubApiBase}/search/repositories?q=${q}&sort=updated&order=desc&per_page=${perPage}&page=${page}`;
      const data = await fetchJson<GithubSearchResponse>(url, headers);

      for (const repo of data.items) {
        if (EXCLUDED_REPOS.has(repo.full_name)) continue;
        const id = `github:${repo.full_name}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const inspection = await inspectArchive(
          `${githubApiBase}/repos/${repo.full_name}/tarball/${encodeURIComponent(repo.default_branch)}`,
          headers,
        ).catch(() => EMPTY_INSPECTION);
        const topics = repo.topics.filter((value) => !GITHUB_TOPICS.includes(value));

        stashes.push(
          normalizeStash({
            id,
            name: repo.name,
            description: inspection.description ?? repo.description ?? undefined,
            ref: repo.full_name,
            source: "github",
            homepage: repo.html_url,
            author: repo.owner.login,
            latestVersion: inspection.latestVersion,
            license: repo.license?.spdx_id ?? inspection.license,
            tags: mergeStrings(topics, inspection.tags),
            assetTypes: inspection.assetTypes,
            assets: inspection.assets,
          }),
        );
      }

      if (data.items.length < perPage) break;
      page += 1;
    }
  }

  return stashes;
}

async function inspectArchive(url: string, headers?: HeadersInit): Promise<PackageInspection> {
  // Route registry-build scratch space under the akm cache dir instead of
  // the system temp directory. Long-running registry builds that crash
  // mid-flight previously left orphan dirs under `/tmp`, which can fill
  // the OS partition. Pinning to `${getCacheDir()}/registry-build/` keeps
  // a single `rm -rf` of that directory sufficient to reclaim the space
  // and leaves the operator's `/tmp` untouched. See #276 for the
  // bench-tmp precedent and #284 for this non-bench rollout.
  const tmpRoot = path.join(getCacheDir(), "registry-build");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tmpRoot, "build-"));
  const archivePath = path.join(tempDir, "archive.tgz");
  const extractDir = path.join(tempDir, "extract");

  try {
    const response = await fetchWithRetry(url, headers ? { headers } : undefined, { timeout: 120_000 });
    if (!response.ok) {
      throw new Error(`Failed to fetch archive (${response.status}) from ${url}`);
    }
    await Bun.write(archivePath, response);

    // Reuse the secure extraction from registry-install which validates entries,
    // uses --no-same-owner, strips components, and runs a post-extraction scan.
    extractTarGzSecure(archivePath, extractDir);

    const stashRoot = detectStashRoot(extractDir);
    const inspectionRoot = applyIncludeConfigForInspection(stashRoot, tempDir, extractDir) ?? stashRoot;
    const metadata = await enumerateAssets(inspectionRoot);
    const packageMetadata = readNearestPackageJson(extractDir, inspectionRoot);
    const assets = metadata.map((entry) => ({
      type: entry.type,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.tags && entry.tags.length > 0 ? { tags: entry.tags } : {}),
      ...(typeof entry.fileSize === "number" ? { estimatedTokens: Math.round(entry.fileSize / 4) } : {}),
    }));

    return {
      description: asString(packageMetadata.description),
      latestVersion: asString(packageMetadata.version),
      license: asString(packageMetadata.license),
      tags: extractNonReservedKeywords(packageMetadata.keywords),
      assetTypes: deriveAssetTypes(assets),
      assets: assets.length > 0 ? assets : undefined,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readNearestPackageJson(extractDir: string, stashRoot: string): Record<string, unknown> {
  const candidates = [
    path.join(stashRoot, "package.json"),
    path.join(extractDir, "package.json"),
    path.join(extractDir, "package", "package.json"),
  ];

  for (const candidate of candidates) {
    try {
      return asRecord(JSON.parse(fs.readFileSync(candidate, "utf8")));
    } catch {}
  }

  return {};
}

async function enumerateAssets(stashRoot: string): Promise<StashEntry[]> {
  const fileContexts = walkStashFlat(stashRoot);
  const dirGroups = new Map<string, string[]>();

  for (const ctx of fileContexts) {
    const group = dirGroups.get(ctx.parentDirAbs);
    if (group) group.push(ctx.absPath);
    else dirGroups.set(ctx.parentDirAbs, [ctx.absPath]);
  }

  const entries: StashEntry[] = [];
  for (const [dirPath, files] of dirGroups) {
    const generated = await generateMetadataFlat(stashRoot, files);
    const legacyOverrides = loadStashFile(dirPath, { requireFilename: true });
    const mergedEntries = legacyOverrides
      ? generated.entries.map((entry) => mergeLegacyEntry(entry, legacyOverrides.entries))
      : generated.entries;
    const stash = mergedEntries.length > 0 ? { entries: mergedEntries } : legacyOverrides;
    if (!stash || stash.entries.length === 0) continue;

    entries.push(...stash.entries.filter((entry) => !!entry.filename).map((entry) => attachFileSize(dirPath, entry)));
  }

  return entries.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

function mergeLegacyEntry(entry: StashEntry, legacyEntries: StashEntry[]): StashEntry {
  const legacy = legacyEntries.find((candidate) => candidate.filename === entry.filename);
  return legacy ? { ...entry, ...legacy, filename: entry.filename } : entry;
}

function attachFileSize(dirPath: string, entry: StashEntry): StashEntry {
  if (typeof entry.fileSize === "number" || !entry.filename) return entry;
  try {
    return { ...entry, fileSize: fs.statSync(path.join(dirPath, entry.filename)).size };
  } catch {
    return entry;
  }
}

function applyIncludeConfigForInspection(stashRoot: string, tempDir: string, searchRoot: string): string | undefined {
  const includeConfig = findNearestIncludeConfig(stashRoot, searchRoot);
  if (!includeConfig) return undefined;

  const selectedDir = path.join(tempDir, "selected");
  fs.rmSync(selectedDir, { recursive: true, force: true });
  fs.mkdirSync(selectedDir, { recursive: true });
  copyIncludedPaths(includeConfig.include, includeConfig.baseDir, selectedDir);
  return selectedDir;
}

async function loadManualEntries(manualEntriesPath: string): Promise<RegistryStashEntry[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(manualEntriesPath, "utf8"));
    const candidateKits = Array.isArray(raw) ? raw : asRecord(raw).stashes;
    const parsed = parseRegistryIndex({ version: 3, updatedAt: new Date().toISOString(), stashes: candidateKits });
    if (!parsed) return [];
    // Legacy `curated` flag on input entries is ignored (v1 spec §4.2). The
    // builder no longer emits it on the resulting index.
    return parsed.stashes.map((stash) => normalizeStash(stash));
  } catch {
    return [];
  }
}

// npm / GitHub API JSON pages; 25 MB cap covers the largest realistic
// search result set while still bounding memory against a malicious or
// misconfigured upstream that streams unbounded JSON.
const BUILD_INDEX_JSON_BYTE_CAP = 25 * 1024 * 1024;

async function fetchJson<T>(url: string, headers?: HeadersInit): Promise<T> {
  const response = await fetchWithRetry(url, headers ? { headers } : undefined, { timeout: 30_000 });
  if (!response.ok) {
    // Error-body sampling is intentionally small; 4 KB is plenty to
    // include upstream hints in the thrown error.
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 200)}`);
  }
  return jsonWithByteCap<T>(response, BUILD_INDEX_JSON_BYTE_CAP);
}

function deduplicateStashes(stashes: RegistryStashEntry[]): RegistryStashEntry[] {
  const byId = new Map<string, RegistryStashEntry>();
  for (const stash of stashes) {
    const existing = byId.get(stash.id);
    byId.set(stash.id, existing ? mergeEntries(existing, stash) : stash);
  }
  return [...byId.values()];
}

function mergeEntries(a: RegistryStashEntry, b: RegistryStashEntry): RegistryStashEntry {
  const assets = mergeAssets(a.assets, b.assets);
  const assetTypes = mergeStrings(a.assetTypes, b.assetTypes, assets ? deriveAssetTypes(assets) : undefined);
  return normalizeStash({
    id: a.id,
    name: a.name,
    description: a.description ?? b.description,
    ref: a.ref,
    source: a.source,
    homepage: a.homepage ?? b.homepage,
    tags: mergeStrings(a.tags, b.tags),
    assetTypes,
    assets,
    author: a.author ?? b.author,
    license: a.license ?? b.license,
    latestVersion: a.latestVersion ?? b.latestVersion,
  });
}

function mergeAssets(
  a?: RegistryStashEntry["assets"],
  b?: RegistryStashEntry["assets"],
): RegistryStashEntry["assets"] | undefined {
  if (!a && !b) return undefined;
  const merged = new Map<string, NonNullable<RegistryStashEntry["assets"]>[number]>();
  for (const asset of [...(a ?? []), ...(b ?? [])]) {
    const key = `${asset.type}:${asset.name}`;
    if (!merged.has(key)) merged.set(key, asset);
  }
  const values = [...merged.values()];
  return values.length > 0 ? sortAssets(values) : undefined;
}

function mergeStrings(...values: Array<string[] | undefined>): string[] | undefined {
  const merged = [...new Set(values.flatMap((value) => value ?? []).filter((value) => value.trim().length > 0))].sort();
  return merged.length > 0 ? merged : undefined;
}

function deriveAssetTypes(assets?: RegistryStashEntry["assets"]): string[] | undefined {
  return mergeStrings(assets?.map((asset) => asset.type));
}

function extractNonReservedKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => !REQUIRED_KEYWORDS.includes(item.toLowerCase()));
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeStash(stash: RegistryStashEntry): RegistryStashEntry {
  const assets = stash.assets ? sortAssets(stash.assets) : undefined;
  return {
    ...stash,
    ...(stash.tags && stash.tags.length > 0 ? { tags: stash.tags } : {}),
    ...(stash.assetTypes && stash.assetTypes.length > 0 ? { assetTypes: stash.assetTypes } : {}),
    ...(assets && assets.length > 0 ? { assets } : {}),
  };
}

function sortAssets(assets: NonNullable<RegistryStashEntry["assets"]>): NonNullable<RegistryStashEntry["assets"]> {
  return [...assets].sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
