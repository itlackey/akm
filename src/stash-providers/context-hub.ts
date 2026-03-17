import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../common";
import type { StashConfigEntry } from "../config";
import { ConfigError, NotFoundError, UsageError } from "../errors";
import { parseFrontmatter, toStringOrUndefined } from "../frontmatter";
import { extractFrontmatterOnly, extractLineRange, extractSection, formatToc, parseMarkdownToc } from "../markdown";
import { getRegistryIndexCacheDir } from "../paths";
import { extractTarGzSecure } from "../registry-install";
import type { StashProvider, StashSearchOptions, StashSearchResult } from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import type { KnowledgeView, ShowResponse, StashSearchHit } from "../stash-types";

/** Cache TTL before refreshing the mirrored repo (12 hours). */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Maximum stale age allowed when refresh fails (7 days). */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const CONTEXT_HUB_REF_PREFIX = "context-hub://";

interface ContextHubEntry {
  id: string;
  ref: string;
  assetType: "knowledge" | "skill";
  filePath: string;
  description?: string;
  tags?: string[];
  language?: string;
  version?: string;
  sortName: string;
}

interface ParsedRepoUrl {
  owner: string;
  repo: string;
  ref: string;
  canonicalUrl: string;
}

class ContextHubStashProvider implements StashProvider {
  readonly type = "context-hub";
  readonly name: string;
  private readonly repo: ParsedRepoUrl;

  constructor(config: StashConfigEntry) {
    this.repo = parseContextHubRepoUrl(config.url ?? "");
    this.name = config.name ?? `${this.repo.owner}/${this.repo.repo}`;
  }

  async search(options: StashSearchOptions): Promise<StashSearchResult> {
    try {
      const entries = await this.loadEntries();
      const filtered = entries
        .filter((entry) => matchesType(entry, options.type))
        .map((entry) => ({ entry, score: scoreEntry(entry, options.query) }))
        .filter(({ score }) => options.query.trim() === "" || score > 0)
        .sort((a, b) => b.score - a.score || a.entry.sortName.localeCompare(b.entry.sortName))
        .slice(0, options.limit);

      return {
        hits: filtered.map(({ entry, score }) => entryToHit(entry, score)),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { hits: [], warnings: [`Stash ${this.name}: ${message}`] };
    }
  }

  async show(ref: string, view?: KnowledgeView): Promise<ShowResponse> {
    const filePath = parseContextHubRef(ref);
    const repoDir = await this.loadRepoDir();
    const resolved = resolveCachedFilePath(repoDir, filePath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new NotFoundError(`Context Hub asset not found: ${filePath}`);
    }

    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = parseFrontmatter(raw);
    const relFromContent = path.posix.normalize(
      path.relative(path.join(repoDir, "content"), resolved).replace(/\\/g, "/"),
    );
    const author = sanitizeString(relFromContent.split("/")[0] ?? "") || "unknown";
    const name = sanitizeString(toStringOrUndefined(parsed.data.name) ?? path.basename(path.dirname(resolved)));
    const description = sanitizeString(toStringOrUndefined(parsed.data.description), 1000);
    const assetType = path.basename(resolved) === "SKILL.md" ? "skill" : "knowledge";
    const content = renderContentForView(raw, view);

    return {
      type: assetType,
      name: `${author}/${name}`,
      path: ref,
      content,
      description,
      editable: false,
      origin: this.type,
      action: `Context Hub content from ${this.repo.canonicalUrl}`,
    };
  }

  canShow(ref: string): boolean {
    return ref.trim().startsWith(CONTEXT_HUB_REF_PREFIX);
  }

  private async loadEntries(): Promise<ContextHubEntry[]> {
    const cachePaths = getCachePaths(this.repo.canonicalUrl);
    const index = await ensureContextHubMirror(this.repo, cachePaths);
    return index.entries;
  }

  private async loadRepoDir(): Promise<string> {
    const cachePaths = getCachePaths(this.repo.canonicalUrl);
    await ensureContextHubMirror(this.repo, cachePaths, { requireRepoDir: true });
    return cachePaths.repoDir;
  }
}

registerStashProvider("context-hub", (config) => new ContextHubStashProvider(config));
registerStashProvider("github", (config) => new ContextHubStashProvider(config));

function getCachePaths(repoUrl: string): {
  rootDir: string;
  archivePath: string;
  repoDir: string;
  indexPath: string;
} {
  const key = createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
  const rootDir = path.join(getRegistryIndexCacheDir(), `context-hub-${key}`);
  return {
    rootDir,
    archivePath: path.join(rootDir, "repo.tar.gz"),
    repoDir: path.join(rootDir, "repo"),
    indexPath: path.join(rootDir, "index.json"),
  };
}

async function ensureContextHubMirror(
  repo: ParsedRepoUrl,
  cachePaths: ReturnType<typeof getCachePaths>,
  options?: { requireRepoDir?: boolean },
): Promise<{ entries: ContextHubEntry[] }> {
  const requireRepoDir = options?.requireRepoDir === true;
  const cached = readCachedIndex(cachePaths.indexPath);
  if (cached && !isExpired(cached.mtime, CACHE_TTL_MS) && (!requireRepoDir || hasExtractedRepo(cachePaths.repoDir))) {
    return { entries: cached.entries };
  }

  try {
    fs.mkdirSync(cachePaths.rootDir, { recursive: true });
    await downloadArchive(buildTarballUrl(repo), cachePaths.archivePath);
    extractTarGzSecure(cachePaths.archivePath, cachePaths.repoDir);
    const entries = buildContextHubIndex(cachePaths.repoDir);
    writeCachedIndex(cachePaths.indexPath, entries);
    return { entries };
  } catch (err) {
    if (
      cached &&
      !isExpired(cached.mtime, CACHE_STALE_MS) &&
      (!requireRepoDir || hasExtractedRepo(cachePaths.repoDir))
    ) {
      return { entries: cached.entries };
    }
    throw err;
  }
}

function hasExtractedRepo(repoDir: string): boolean {
  try {
    return fs.statSync(repoDir).isDirectory() && fs.statSync(path.join(repoDir, "content")).isDirectory();
  } catch {
    return false;
  }
}

function readCachedIndex(indexPath: string): { entries: ContextHubEntry[]; mtime: number } | null {
  try {
    const stat = fs.statSync(indexPath);
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown;
    if (!Array.isArray(raw)) return null;
    const entries = raw.filter(isContextHubEntry);
    return { entries, mtime: stat.mtimeMs };
  } catch {
    return null;
  }
}

function writeCachedIndex(indexPath: string, entries: ContextHubEntry[]): void {
  const dir = path.dirname(indexPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${indexPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, indexPath);
}

async function downloadArchive(url: string, destination: string): Promise<void> {
  const response = await fetchWithRetry(url, undefined, { timeout: 120_000, retries: 1 });
  if (!response.ok) {
    throw new Error(`Failed to download Context Hub archive (${response.status}) from ${url}`);
  }

  const BunRuntime = (globalThis as Record<string, unknown>).Bun as {
    write?: (path: string, body: Response) => Promise<number>;
  };
  if (BunRuntime?.write) {
    await BunRuntime.write(destination, response);
    return;
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destination, Buffer.from(arrayBuffer));
}

function buildContextHubIndex(repoDir: string): ContextHubEntry[] {
  const contentDir = path.join(repoDir, "content");
  if (!fs.existsSync(contentDir) || !fs.statSync(contentDir).isDirectory()) {
    throw new Error(`Context Hub repo at ${repoDir} is missing a content/ directory`);
  }

  const files = findEntryFiles(contentDir);
  const entries: ContextHubEntry[] = [];
  for (const filePath of files) {
    const entry = buildEntry(repoDir, contentDir, filePath);
    if (entry) entries.push(entry);
  }
  return entries;
}

function findEntryFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findEntryFiles(full));
    } else if (entry.name === "DOC.md" || entry.name === "SKILL.md") {
      results.push(full);
    }
  }
  return results;
}

function buildEntry(repoDir: string, contentDir: string, fullPath: string): ContextHubEntry | null {
  const raw = fs.readFileSync(fullPath, "utf8");
  const parsed = parseFrontmatter(raw);
  const relPath = path.posix.normalize(path.relative(repoDir, fullPath).replace(/\\/g, "/"));
  const relFromContent = path.posix.normalize(path.relative(contentDir, fullPath).replace(/\\/g, "/"));
  const segments = relFromContent.split("/");
  const author = sanitizeString(segments[0] ?? "");
  if (!author) return null;

  const name = sanitizeString(toStringOrUndefined(parsed.data.name) ?? path.basename(path.dirname(fullPath)));
  if (!name) return null;

  const metadata = (parsed.data.metadata ?? {}) as Record<string, unknown>;
  const tags = parseCsv(metadata.tags);
  const language = sanitizeString(toStringOrUndefined(metadata.languages));
  const version = sanitizeString(toStringOrUndefined(metadata.versions));
  const id = `${author}/${name}`;
  const assetType = path.basename(fullPath) === "SKILL.md" ? "skill" : "knowledge";

  return {
    id,
    ref: makeContextHubRef(relPath),
    assetType,
    filePath: relPath,
    description: sanitizeString(toStringOrUndefined(parsed.data.description), 1000),
    tags,
    language: language || undefined,
    version: version || undefined,
    sortName: `${id}:${language ?? ""}:${version ?? ""}`,
  };
}

function scoreEntry(entry: ContextHubEntry, query: string): number {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return 1;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;

  const haystacks = [
    { text: entry.id.toLowerCase(), weight: 4 },
    { text: entry.description?.toLowerCase() ?? "", weight: 2 },
    { text: (entry.tags ?? []).join(" ").toLowerCase(), weight: 2 },
    { text: entry.language?.toLowerCase() ?? "", weight: 1 },
    { text: entry.version?.toLowerCase() ?? "", weight: 1 },
  ];

  let matched = 0;
  let score = 0;
  for (const token of tokens) {
    let tokenScore = 0;
    for (const { text, weight } of haystacks) {
      if (!text) continue;
      if (text === token) tokenScore = Math.max(tokenScore, weight * 2);
      else if (text.includes(token)) tokenScore = Math.max(tokenScore, weight);
    }
    if (tokenScore > 0) {
      matched++;
      score += tokenScore;
    }
  }

  if (matched === 0) return 0;
  const coverage = matched / tokens.length;
  return Math.round((score * coverage + (entry.id.toLowerCase() === trimmed ? 5 : 0)) * 1000) / 1000;
}

function matchesType(entry: ContextHubEntry, requested: string | undefined): boolean {
  if (!requested || requested === "any") return true;
  return entry.assetType === requested;
}

function entryToHit(entry: ContextHubEntry, score: number): StashSearchHit {
  const details = [entry.language, entry.version].filter(Boolean).join(" • ");
  const description = [entry.description, details].filter(Boolean).join(" — ") || undefined;
  return {
    type: entry.assetType,
    name: entry.id,
    path: entry.ref,
    ref: entry.ref,
    origin: "context-hub",
    editable: false,
    description,
    tags: entry.tags,
    action: `akm show ${entry.ref}`,
    score,
  };
}

function renderContentForView(content: string, view?: KnowledgeView): string {
  if (!view || view.mode === "full") return content;

  switch (view.mode) {
    case "toc":
      return formatToc(parseMarkdownToc(content));
    case "frontmatter":
      return extractFrontmatterOnly(content) ?? "(no frontmatter)";
    case "section": {
      const section = extractSection(content, view.heading);
      if (!section) {
        throw new UsageError(`Section not found: ${view.heading}`);
      }
      return section.content;
    }
    case "lines":
      return extractLineRange(content, view.start, view.end);
    default:
      return content;
  }
}

function resolveCachedFilePath(repoDir: string, filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (!normalized.startsWith("content/")) {
    throw new UsageError(`Invalid Context Hub ref: ${filePath}`);
  }
  const resolved = path.resolve(repoDir, normalized);
  const root = path.resolve(repoDir);
  if (!resolved.startsWith(root + path.sep)) {
    throw new UsageError(`Invalid Context Hub ref: ${filePath}`);
  }
  return resolved;
}

function buildTarballUrl(repo: ParsedRepoUrl): string {
  return `https://github.com/${repo.owner}/${repo.repo}/archive/refs/heads/${repo.ref}.tar.gz`;
}

function parseContextHubRepoUrl(rawUrl: string): ParsedRepoUrl {
  if (!rawUrl) {
    throw new ConfigError("Context Hub provider requires a GitHub repository URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConfigError(`Context Hub URL is not valid: "${rawUrl}"`);
  }

  if (parsed.protocol !== "https:") {
    throw new ConfigError(`Context Hub URL must use https://, got "${parsed.protocol}"`);
  }
  if (parsed.hostname !== "github.com") {
    throw new ConfigError(`Context Hub provider only supports github.com URLs, got "${parsed.hostname}"`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new ConfigError(`Context Hub URL must point to a GitHub repository, got "${rawUrl}"`);
  }

  const owner = sanitizeString(segments[0]);
  const repo = sanitizeString(segments[1].replace(/\.git$/i, ""));
  let ref = "main";
  if (segments[2] === "tree" && segments.length >= 4) {
    ref = sanitizeString(segments.slice(3).join("/"), 255) || "main";
  }

  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ConfigError(`Unsupported Context Hub repository URL: "${rawUrl}"`);
  }
  if (!ref || ref.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new ConfigError(`Unsupported Context Hub branch/ref in URL: "${rawUrl}"`);
  }

  return {
    owner,
    repo,
    ref,
    canonicalUrl: `https://github.com/${owner}/${repo}/tree/${ref}`,
  };
}

function makeContextHubRef(filePath: string): string {
  return `${CONTEXT_HUB_REF_PREFIX}${path.posix.normalize(filePath)}`;
}

function parseContextHubRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(CONTEXT_HUB_REF_PREFIX)) {
    throw new UsageError(`Invalid Context Hub ref: ${ref}`);
  }
  const filePath = trimmed.slice(CONTEXT_HUB_REF_PREFIX.length);
  if (!filePath) {
    throw new UsageError(`Invalid Context Hub ref: ${ref}`);
  }
  return filePath;
}

function parseCsv(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const items = value
    .split(",")
    .map((item) => sanitizeString(item.trim(), 100))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function sanitizeString(value: unknown, maxLength = 255): string {
  if (typeof value !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips untrusted control chars from remote metadata
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

function isExpired(mtimeMs: number, ttlMs: number): boolean {
  return Date.now() - mtimeMs > ttlMs;
}

function isContextHubEntry(value: unknown): value is ContextHubEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.ref === "string" &&
    (obj.assetType === "knowledge" || obj.assetType === "skill") &&
    typeof obj.filePath === "string" &&
    typeof obj.sortName === "string"
  );
}

export { ContextHubStashProvider, buildContextHubIndex, makeContextHubRef, parseContextHubRef, parseContextHubRepoUrl };
