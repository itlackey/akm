import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../common";
import type { StashConfigEntry } from "../config";
import { ConfigError, UsageError } from "../errors";
import { getRegistryIndexCacheDir } from "../paths";
import type { StashProvider, StashSearchOptions, StashSearchResult } from "../stash-provider";
import { registerStashProvider } from "../stash-provider-factory";
import type { KnowledgeView, ShowResponse } from "../stash-types";
import { isExpired, sanitizeString } from "./provider-utils";

/** Refresh website snapshots every 12 hours to balance freshness with scraping load. */
const CACHE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Allow up to 7 days of stale snapshots when refresh fails so search remains available during outages. */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const QUEUE_EXPANSION_FACTOR = 3;

const MAX_PAGES_DEFAULT = 10;
const MAX_DEPTH_DEFAULT = 1;

interface WebsitePage {
  url: string;
  title: string;
  markdown: string;
}

class WebsiteStashProvider implements StashProvider {
  readonly type = "website";
  readonly name: string;

  constructor(config: StashConfigEntry) {
    this.name = config.name ?? "website";
    validateWebsiteUrl(config.url ?? "");
  }

  /** Content is indexed through the standard FTS5 pipeline. */
  async search(_options: StashSearchOptions): Promise<StashSearchResult> {
    return { hits: [] };
  }

  /** Content is local files, shown via showLocal. */
  async show(_ref: string, _view?: KnowledgeView): Promise<ShowResponse> {
    throw new Error("Website provider content is shown via local index");
  }

  /** Content is local; no remote show needed. */
  canShow(_ref: string): boolean {
    return false;
  }
}

registerStashProvider("website", (config) => new WebsiteStashProvider(config));

function getCachePaths(siteUrl: string): {
  rootDir: string;
  stashDir: string;
  manifestPath: string;
} {
  const key = createHash("sha256").update(normalizeSiteUrl(siteUrl)).digest("hex").slice(0, 16);
  const rootDir = path.join(getRegistryIndexCacheDir(), `website-${key}`);
  return {
    rootDir,
    stashDir: path.join(rootDir, "stash"),
    manifestPath: path.join(rootDir, "manifest.json"),
  };
}

async function ensureWebsiteMirror(
  config: StashConfigEntry,
  options?: { requireStashDir?: boolean },
): Promise<ReturnType<typeof getCachePaths>> {
  const rawUrl = config.url ?? "";
  const normalizedUrl = validateWebsiteUrl(rawUrl);
  const cachePaths = getCachePaths(normalizedUrl);
  const requireStashDir = options?.requireStashDir === true;

  let mtime = 0;
  try {
    mtime = fs.statSync(cachePaths.manifestPath).mtimeMs;
  } catch {
    /* no cached manifest */
  }

  if (
    mtime &&
    !isExpired(mtime, CACHE_REFRESH_INTERVAL_MS) &&
    (!requireStashDir || hasExtractedSite(cachePaths.stashDir))
  ) {
    return cachePaths;
  }

  try {
    fs.mkdirSync(cachePaths.rootDir, { recursive: true });
    await scrapeWebsiteToStash(normalizedUrl, cachePaths.stashDir, {
      maxPages: coercePositiveInt(config.options?.maxPages, MAX_PAGES_DEFAULT),
      maxDepth: coercePositiveInt(config.options?.maxDepth, MAX_DEPTH_DEFAULT),
    });
    fs.writeFileSync(
      cachePaths.manifestPath,
      `${JSON.stringify({ url: normalizedUrl, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return cachePaths;
  } catch (err) {
    if (mtime && !isExpired(mtime, CACHE_STALE_MS) && (!requireStashDir || hasExtractedSite(cachePaths.stashDir))) {
      return cachePaths;
    }
    throw err;
  }
}

function hasExtractedSite(stashDir: string): boolean {
  try {
    const knowledgeDir = path.join(stashDir, "knowledge");
    return (
      fs.statSync(stashDir).isDirectory() &&
      fs.statSync(knowledgeDir).isDirectory() &&
      fs.readdirSync(knowledgeDir).some((entry) => entry.endsWith(".md"))
    );
  } catch {
    return false;
  }
}

async function scrapeWebsiteToStash(
  startUrl: string,
  stashDir: string,
  options: { maxPages: number; maxDepth: number },
): Promise<void> {
  const pages = await crawlWebsite(startUrl, options);
  if (pages.length === 0) {
    throw new Error(`No content could be scraped from ${startUrl}`);
  }

  fs.rmSync(stashDir, { recursive: true, force: true });
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const usedSlugs = new Set<string>();
  for (const page of pages) {
    const slug = uniqueSlug(slugifyUrl(page.url), usedSlugs);
    const filePath = path.join(knowledgeDir, `${slug}.md`);
    fs.writeFileSync(filePath, buildMarkdownSnapshot(page, slug), "utf8");
  }
}

async function crawlWebsite(startUrl: string, options: { maxPages: number; maxDepth: number }): Promise<WebsitePage[]> {
  const start = new URL(normalizeSiteUrl(startUrl));
  const allowedOrigin = start.origin;
  const queue: Array<{ url: string; depth: number }> = [{ url: start.toString(), depth: 0 }];
  const visited = new Set<string>();
  const pages: WebsitePage[] = [];

  while (queue.length > 0 && pages.length < options.maxPages) {
    const next = queue.shift();
    if (!next) break;
    const normalized = normalizeCrawlUrl(next.url);
    if (!normalized || visited.has(normalized)) continue;
    visited.add(normalized);

    const fetched = await fetchWebsitePage(normalized);
    if (!fetched) continue;
    pages.push(fetched.page);

    if (next.depth >= options.maxDepth) continue;
    for (const link of fetched.links) {
      if (queue.length + pages.length >= options.maxPages * QUEUE_EXPANSION_FACTOR) break;
      if (link.origin !== allowedOrigin) continue;
      const candidate = normalizeCrawlUrl(link.toString());
      if (!candidate || visited.has(candidate) || isAssetLikePath(link.pathname)) continue;
      queue.push({ url: candidate, depth: next.depth + 1 });
    }
  }

  return pages;
}

async function fetchWebsitePage(pageUrl: string): Promise<{ page: WebsitePage; links: URL[] } | null> {
  const response = await fetchWithRetry(
    pageUrl,
    {
      headers: {
        Accept: "text/html, text/markdown, text/plain;q=0.9, application/xhtml+xml;q=0.8",
        "User-Agent": "akm-cli website provider",
      },
    },
    { timeout: 15_000, retries: 1 },
  );

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to fetch website content (${response.status}) from ${pageUrl}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await response.text();
  const finalUrl = normalizeCrawlUrl(response.url || pageUrl) ?? pageUrl;

  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || looksLikeHtml(body)) {
    const title = extractHtmlTitle(body) || new URL(finalUrl).hostname;
    return {
      page: {
        url: finalUrl,
        title,
        markdown: htmlToMarkdown(body, finalUrl),
      },
      links: extractSameDocumentLinks(body, finalUrl),
    };
  }

  return {
    page: {
      url: finalUrl,
      title: extractTextTitle(body) || new URL(finalUrl).hostname,
      markdown: body.trim(),
    },
    links: [],
  };
}

function buildMarkdownSnapshot(page: WebsitePage, slug: string): string {
  const title = sanitizeString(page.title, 200) || slug;
  const description = sanitizeString(`Snapshot of ${page.url}`, 500);
  const host = sanitizeString(new URL(page.url).hostname, 120);
  const content = page.markdown.trim() || `Source: ${page.url}`;

  return [
    "---",
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(description)}`,
    `sourceUrl: ${JSON.stringify(page.url)}`,
    `title: ${JSON.stringify(title)}`,
    "tags:",
    `  - ${JSON.stringify("website")}`,
    `  - ${JSON.stringify(host)}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Source: ${page.url}`,
    "",
    content,
    "",
  ].join("\n");
}

function validateWebsiteUrl(rawUrl: string): string {
  return validateWebsiteUrlWithError(rawUrl, ConfigError);
}

function validateWebsiteInputUrl(rawUrl: string): string {
  return validateWebsiteUrlWithError(rawUrl, UsageError);
}

function validateWebsiteUrlWithError(rawUrl: string, ErrorType: typeof ConfigError | typeof UsageError): string {
  if (!rawUrl) {
    throw new ErrorType("Website provider requires a URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ErrorType(`Website URL is not valid: "${rawUrl}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ErrorType(`Website URL must use http:// or https://, got "${parsed.protocol}" in "${rawUrl}"`);
  }
  if (parsed.username || parsed.password) {
    throw new ErrorType("Website URL must not contain embedded credentials");
  }

  parsed.hash = "";
  return normalizeSiteUrl(parsed.toString());
}

function normalizeSiteUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

function normalizeCrawlUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function slugifyUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const host = slugifySegment(parsed.hostname);
  const pathSegments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => slugifySegment(segment))
    .filter(Boolean);
  const query = parsed.search ? slugifySegment(parsed.search.slice(1)) : "";
  const slugParts = [host, ...pathSegments, ...(query ? [query] : [])].filter(Boolean);
  return slugParts.join("__") || host || "website";
}

function slugifySegment(value: string): string {
  return sanitizeString(value, 200)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSlug(base: string, used: Set<string>): string {
  let candidate = base || "website";
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

function coercePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function looksLikeHtml(body: string): boolean {
  return /<html[\s>]|<body[\s>]|<\/[a-z][\w:-]*>/i.test(body);
}

function extractHtmlTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) return decodeHtmlEntities(stripTags(title)).trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1) return decodeHtmlEntities(stripTags(h1)).trim();
  return undefined;
}

function extractTextTitle(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) return trimmed.replace(/^#+\s*/, "");
    return trimmed.slice(0, 120);
  }
  return undefined;
}

function extractSameDocumentLinks(html: string, pageUrl: string): URL[] {
  const links: URL[] = [];
  const hrefPattern = /<a\b[^>]*href\s*=\s*(['"])(.*?)\1[^>]*>/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const href = match[2]?.trim();
    if (!href || href.startsWith("#")) continue;
    try {
      const resolved = new URL(href, pageUrl);
      if (!isSafeLinkUrl(resolved)) continue;
      links.push(resolved);
    } catch {
      /* ignore malformed links */
    }
  }
  return links;
}

function htmlToMarkdown(html: string, pageUrl: string): string {
  let text = html;
  text = stripDangerousBlockTag(text, "script");
  text = stripDangerousBlockTag(text, "style");
  text = stripDangerousBlockTag(text, "noscript");
  text = stripDangerousBlockTag(text, "template");

  text = text.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_match, code) => {
    const decoded = decodeHtmlEntities(stripTags(code)).trim();
    return decoded ? `\n\n\`\`\`\n${decoded}\n\`\`\`\n\n` : "\n\n";
  });
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, code) => {
    const decoded = decodeHtmlEntities(stripTags(code)).trim();
    return decoded ? `\`${decoded}\`` : "";
  });
  text = text.replace(/<a\b[^>]*href\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_match, _q, href, body) => {
    const label = decodeHtmlEntities(stripTags(body)).trim();
    if (!label) return "";
    try {
      const resolved = new URL(href, pageUrl);
      if (!isSafeLinkUrl(resolved)) return label;
      return `[${label}](${resolved})`;
    } catch {
      return label;
    }
  });
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, body) => {
    const heading = decodeHtmlEntities(stripTags(body)).trim();
    return heading ? `\n\n${"#".repeat(Number(level))} ${heading}\n\n` : "\n\n";
  });
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, body) => {
    const item = decodeHtmlEntities(stripTags(body)).trim();
    return item ? `\n- ${item}` : "";
  });
  text = text.replace(/<(p|div|section|article|main|header|footer|blockquote|table|tr)\b[^>]*>/gi, "\n\n");
  text = text.replace(/<\/(p|div|section|article|main|header|footer|blockquote|table|tr)>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
  text = decodeHtmlEntities(stripTags(text));
  text = text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const normalized = String(entity).toLowerCase();
    if (normalized.startsWith("#x")) {
      return safeCodePointToString(Number.parseInt(normalized.slice(2), 16)) ?? match;
    }
    if (normalized.startsWith("#")) {
      return safeCodePointToString(Number.parseInt(normalized.slice(1), 10)) ?? match;
    }
    return namedEntities[normalized] ?? match;
  });
}

function isAssetLikePath(pathname: string): boolean {
  return /\.(css|js|json|png|jpe?g|gif|svg|ico|webp|pdf|zip|tar|gz|mp4|mp3|woff2?)$/i.test(pathname);
}

function isSafeLinkUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function stripDangerousBlockTag(value: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, "gi");
  return value.replace(pattern, "");
}

function safeCodePointToString(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return undefined;
  try {
    return String.fromCodePoint(value);
  } catch {
    return undefined;
  }
}

export { ensureWebsiteMirror, getCachePaths, validateWebsiteInputUrl, validateWebsiteUrl, WebsiteStashProvider };
