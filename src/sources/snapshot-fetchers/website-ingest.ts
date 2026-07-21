// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fetchWithRetry, ResponseTooLargeError, readBodyWithByteCap, resolveStashDir } from "../../core/common";
import type { SourceConfigEntry } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { getRegistryIndexCacheDir } from "../../core/paths";
import { warn } from "../../core/warn";
import { withFreshnessCache } from "../freshness";
import { sanitizeString } from "../providers/provider-utils";
import { type FetcherContext, loadWikiSnapshotFetchers, type WikiSnapshotResult } from "./registry";

/** Refresh website snapshots every 12 hours to balance freshness with scraping load. */
const CACHE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Allow up to 7 days of stale snapshots when refresh fails so search remains available during outages. */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Allow limited breadth-first expansion without letting the crawl queue grow unbounded. */
const QUEUE_EXPANSION_FACTOR = 5;

const MAX_PAGES_DEFAULT = 50;
const MAX_DEPTH_DEFAULT = 3;

/**
 * Per-page body cap for website scraping. HTML pages this large are
 * almost never useful as agent knowledge sources and a runaway server
 * streaming tens of megabytes would blow memory with no upside.
 */
const WEBSITE_PAGE_BYTE_CAP = 5 * 1024 * 1024;

/**
 * Wall-clock cap for a full crawl (10 minutes). With per-request timeouts
 * of 15s and a `maxPages` default of 50, an unresponsive site could
 * otherwise stall `akm add` for 12.5 minutes with no feedback. Cap the
 * whole crawl and return what we have when time runs out.
 */
const WEBSITE_CRAWL_WALL_CLOCK_MS = 10 * 60 * 1000;
const WEBSITE_MAX_REDIRECTS = 8;

interface WebsitePage {
  url: string;
  title: string;
  markdown: string;
}

export interface WebsiteMarkdownSnapshot {
  url: string;
  title: string;
  markdown: string;
  preferredName: string;
  content: string;
}

export interface FetchSnapshotOptions {
  stashDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowPrivateHosts?: boolean;
}

interface WebsiteValidationOptions {
  allowPrivateHosts?: boolean;
}

export function shouldAllowPrivateWebsiteHostsForTests(): boolean {
  return process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
}

export function shouldAllowPrivateWebsiteUrlForTests(rawUrl: string): boolean {
  if (!shouldAllowPrivateWebsiteHostsForTests()) return false;
  try {
    return isLoopbackWebsiteHostname(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolveFetcherStashDir(explicitStashDir?: string): string | null {
  if (explicitStashDir) return explicitStashDir;
  try {
    return resolveStashDir({ readOnly: true });
  } catch {
    return null;
  }
}

export function getWebsiteCachePaths(siteUrl: string): {
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

export async function ensureWebsiteMirror(
  config: SourceConfigEntry,
  options?: { requireStashDir?: boolean; force?: boolean; allowPrivateHosts?: boolean },
): Promise<ReturnType<typeof getWebsiteCachePaths>> {
  const rawUrl = config.url ?? "";
  const normalizedUrl = validateWebsiteUrl(rawUrl, { allowPrivateHosts: options?.allowPrivateHosts });
  const cachePaths = getWebsiteCachePaths(normalizedUrl);
  const requireStashDir = options?.requireStashDir === true;

  await withFreshnessCache({
    markerPath: cachePaths.manifestPath,
    ttlMs: CACHE_REFRESH_INTERVAL_MS,
    staleMs: CACHE_STALE_MS,
    force: options?.force === true,
    isUsable: () => !requireStashDir || hasExtractedSite(cachePaths.stashDir),
    refresh: async () => {
      fs.mkdirSync(cachePaths.rootDir, { recursive: true });
      await scrapeWebsiteToStash(normalizedUrl, cachePaths.stashDir, {
        maxPages: coercePositiveInt(config.options?.maxPages, MAX_PAGES_DEFAULT),
        maxDepth: coercePositiveInt(config.options?.maxDepth, MAX_DEPTH_DEFAULT),
        allowPrivateHosts: options?.allowPrivateHosts,
      });
      fs.writeFileSync(
        cachePaths.manifestPath,
        `${JSON.stringify({ url: normalizedUrl, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    },
  });
  return cachePaths;
}

function hasExtractedSite(stashDir: string): boolean {
  try {
    const knowledgeDir = path.join(stashDir, "knowledge");
    if (!fs.statSync(stashDir).isDirectory() || !fs.statSync(knowledgeDir).isDirectory()) return false;
    for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) return true;
      if (entry.isDirectory()) {
        const subEntries = fs.readdirSync(path.join(knowledgeDir, entry.name));
        if (subEntries.some((e) => e.endsWith(".md"))) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function scrapeWebsiteToStash(
  startUrl: string,
  stashDir: string,
  options: { maxPages: number; maxDepth: number; allowPrivateHosts?: boolean },
): Promise<void> {
  const pages = await crawlWebsite(startUrl, options);
  if (pages.length === 0) {
    throw new Error(`No content could be scraped from ${startUrl}`);
  }

  fs.rmSync(stashDir, { recursive: true, force: true });
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const usedPaths = new Set<string>();
  for (const page of pages) {
    const relPath = avoidReservedBasename(urlToRelativePath(page.url));
    const uniquePath = uniqueSlug(relPath, usedPaths);
    const filePath = path.join(knowledgeDir, `${uniquePath}.md`);
    const dir = path.dirname(filePath);
    if (dir !== knowledgeDir) fs.mkdirSync(dir, { recursive: true });
    const slug = uniquePath.split("/").pop() ?? "index";
    fs.writeFileSync(filePath, buildMarkdownSnapshot(page, slug), "utf8");
  }
}

export async function fetchWebsiteMarkdownSnapshot(
  rawUrl: string,
  options?: FetchSnapshotOptions,
): Promise<WebsiteMarkdownSnapshot> {
  const normalizedUrl = validateWebsiteInputUrl(rawUrl, { allowPrivateHosts: options?.allowPrivateHosts });
  const parsedUrl = new URL(normalizedUrl);
  const stashDir = resolveFetcherStashDir(options?.stashDir);
  const context: FetcherContext = {
    stashDir: stashDir ?? "",
    timeoutMs: options?.timeoutMs ?? 15_000,
    signal: options?.signal,
  };

  for (const fetcher of await loadWikiSnapshotFetchers(stashDir)) {
    try {
      if (!fetcher.matches(parsedUrl, context)) continue;
      const snapshot = await fetcher.fetch(parsedUrl, context);
      if (!snapshot) continue;
      return websiteMarkdownSnapshotFromResult(snapshot);
    } catch (error) {
      warn(
        "[akm] wiki-fetcher %s threw on %s: %s",
        fetcher.name,
        normalizedUrl,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const fetched = await fetchWebsitePage(normalizedUrl, { allowPrivateHosts: options?.allowPrivateHosts });
  if (!fetched) {
    throw new UsageError(`No content could be fetched from ${normalizedUrl}`);
  }

  return websiteMarkdownSnapshotFromResult({
    url: fetched.page.url,
    title: fetched.page.title,
    markdown: fetched.page.markdown,
  });
}

function websiteMarkdownSnapshotFromResult(snapshot: WikiSnapshotResult): WebsiteMarkdownSnapshot {
  const preferredName = snapshot.preferredName ?? deriveImportPath(snapshot.url);
  const slug = preferredName.split("/").pop() ?? preferredName;
  return {
    url: snapshot.url,
    title: snapshot.title,
    markdown: snapshot.markdown,
    preferredName,
    content: buildMarkdownSnapshot(
      {
        url: snapshot.url,
        title: snapshot.title,
        markdown: snapshot.markdown,
      },
      slug || "website",
      snapshot.tags,
    ),
  };
}

async function crawlWebsite(
  startUrl: string,
  options: { maxPages: number; maxDepth: number; allowPrivateHosts?: boolean },
): Promise<WebsitePage[]> {
  const start = new URL(normalizeSiteUrl(startUrl));
  const allowedOrigin = start.origin;
  const queue: Array<{ url: string; depth: number }> = [{ url: start.toString(), depth: 0 }];
  const visited = new Set<string>();
  const pages: WebsitePage[] = [];
  const deadline = Date.now() + WEBSITE_CRAWL_WALL_CLOCK_MS;

  while (queue.length > 0 && pages.length < options.maxPages) {
    if (Date.now() > deadline) break;
    const next = queue.shift();
    if (!next) break;
    const normalized = normalizeCrawlUrl(next.url);
    if (!normalized || visited.has(normalized)) continue;
    visited.add(normalized);

    const fetched = await fetchWebsitePage(normalized, { allowPrivateHosts: options.allowPrivateHosts });
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

  if (Date.now() > deadline) {
    warn(
      "[akm] website crawl stopped at the %ds wall-clock cap with %d/%d pages collected from %s.",
      WEBSITE_CRAWL_WALL_CLOCK_MS / 1000,
      pages.length,
      options.maxPages,
      startUrl,
    );
  }

  return pages;
}

async function fetchWebsitePage(
  pageUrl: string,
  options?: WebsiteValidationOptions,
): Promise<{ page: WebsitePage; links: URL[] } | null> {
  const response = await fetchWebsiteResponse(pageUrl, 0, options);

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Failed to fetch website content (${response.status}) from ${pageUrl}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let body: string;
  try {
    body = await readBodyWithByteCap(response, WEBSITE_PAGE_BYTE_CAP);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) return null;
    throw err;
  }
  const finalUrl = normalizeCrawlUrl(response.url || pageUrl) ?? pageUrl;
  assertWebsiteRequestUrl(finalUrl, Error, options);

  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || looksLikeMarkup(body)) {
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

async function fetchWebsiteResponse(
  pageUrl: string,
  redirectCount = 0,
  options?: WebsiteValidationOptions,
): Promise<Response> {
  assertWebsiteRequestUrl(pageUrl, Error, options);
  const response = await fetchWithRetry(
    pageUrl,
    {
      headers: {
        Accept: "text/html, text/markdown, text/plain;q=0.9, application/xhtml+xml;q=0.8",
        "User-Agent": "akm-cli website provider",
      },
      redirect: "manual",
    },
    { timeout: 15_000, retries: 1 },
  );

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= WEBSITE_MAX_REDIRECTS) {
      throw new Error(`Too many redirects while fetching ${pageUrl}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect response from ${pageUrl} did not include a Location header`);
    }
    const nextUrl = new URL(location, pageUrl).toString();
    assertWebsiteRequestUrl(nextUrl, Error, options);
    return fetchWebsiteResponse(nextUrl, redirectCount + 1, options);
  }

  return response;
}

function buildMarkdownSnapshot(page: WebsitePage, slug: string, tags?: string[]): string {
  const title = sanitizeString(page.title, 200) || slug;
  const description = sanitizeString(`Snapshot of ${page.url}`, 500);
  const host = sanitizeString(new URL(page.url).hostname, 120);
  const content = page.markdown.trim() || `Source: ${page.url}`;
  const normalizedTags = Array.from(new Set(["website", host, ...(tags ?? [])]));

  return [
    "---",
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(description)}`,
    `sourceUrl: ${JSON.stringify(page.url)}`,
    `title: ${JSON.stringify(title)}`,
    "tags:",
    ...normalizedTags.map((tag) => `  - ${JSON.stringify(tag)}`),
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

export function validateWebsiteUrl(rawUrl: string, options?: WebsiteValidationOptions): string {
  return validateWebsiteUrlWithError(rawUrl, ConfigError, options);
}

export function validateWebsiteInputUrl(rawUrl: string, options?: WebsiteValidationOptions): string {
  return validateWebsiteUrlWithError(rawUrl, UsageError, options);
}

function validateWebsiteUrlWithError(
  rawUrl: string,
  ErrorType: typeof ConfigError | typeof UsageError,
  options?: WebsiteValidationOptions,
): string {
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
  assertWebsiteRequestUrl(parsed.toString(), ErrorType, options);

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

/**
 * D-R6: `index.md`/`log.md` are OKF reserved structural filenames at every
 * depth — no adapter indexes them, so a crawled page must never land on one.
 * Same remap convention as the content migration (`index.md` →
 * `index-content.md`). Segments are already lowercased by slugifySegment.
 */
function avoidReservedBasename(relPath: string): string {
  const segments = relPath.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last === "index" || last === "log") {
    segments[segments.length - 1] = `${last}-content`;
  }
  return segments.join("/");
}

function urlToRelativePath(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => slugifySegment(segment))
    .filter(Boolean);
  if (parsed.search) {
    const querySuffix = slugifySegment(parsed.search.slice(1));
    if (querySuffix && segments.length > 0) {
      segments[segments.length - 1] = `${segments[segments.length - 1]}_${querySuffix}`;
    }
  }
  return segments.length > 0 ? segments.join("/") : "index";
}

function deriveImportPath(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const relativePath = urlToRelativePath(rawUrl);
  if (relativePath !== "index") return relativePath;

  const host = slugifySegment(parsed.hostname) || "website";
  if (!parsed.search) return host;

  const querySuffix = slugifySegment(parsed.search.slice(1));
  return querySuffix ? `${host}-${querySuffix}` : host;
}

function slugifySegment(value: string): string {
  return sanitizeString(value, 200)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSlug(base: string, used: Set<string>): string {
  const seed = base || "website";
  let candidate = seed;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${seed}-${i}`;
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

function looksLikeMarkup(body: string): boolean {
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

type WebsiteUrlErrorCtor = new (message: string) => Error;

function assertWebsiteRequestUrl(
  rawUrl: string,
  ErrorType: WebsiteUrlErrorCtor = Error,
  options?: WebsiteValidationOptions,
): void {
  const parsedUrl = new URL(rawUrl);
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname.endsWith(".invalid")) {
    throw new ErrorType(`Refusing to fetch reserved invalid hostname: ${parsedUrl.hostname}`);
  }
  if (isForbiddenWebsiteHostname(hostname, options)) {
    throw new ErrorType(`Refusing to fetch non-public website host: ${parsedUrl.hostname}`);
  }
}

// WHATWG URL.hostname wraps IPv6 literals in brackets (e.g. "[::1]"), but
// node:net's isIP() only recognizes the bare address form and returns 0 for
// anything bracketed — silently skipping all IPv6 forbidden-host checks
// below for every hostname parsed off a URL. Strip the brackets before any
// isIP()/isForbiddenIpv6() call so those checks actually run.
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isForbiddenWebsiteHostname(hostname: string, options?: WebsiteValidationOptions): boolean {
  if (options?.allowPrivateHosts === true) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") {
    return true;
  }

  const bareHostname = stripIpv6Brackets(hostname);
  const ipVersion = isIP(bareHostname);
  if (ipVersion === 4) return isForbiddenIpv4(bareHostname);
  if (ipVersion === 6) return isForbiddenIpv6(bareHostname);
  return false;
}

function isLoopbackWebsiteHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const bareHostname = stripIpv6Brackets(hostname);
  const ipVersion = isIP(bareHostname);
  if (ipVersion === 4) return bareHostname.startsWith("127.");
  if (ipVersion === 6) return bareHostname === "::1";
  return false;
}

function isForbiddenIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Extracts the embedded IPv4 address from an IPv4-mapped IPv6 literal
 * (`::ffff:a.b.c.d` or its canonical hex form `::ffff:xxxx:yyyy`), or
 * returns null if `hostname` isn't one.
 */
function extractIpv4MappedAddress(normalizedHostname: string): string | null {
  const match = normalizedHostname.match(/^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (!match) return null;
  if (match[1]) return match[1];
  const high = Number.parseInt(match[2]!, 16);
  const low = Number.parseInt(match[3]!, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isForbiddenIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const mappedIpv4 = extractIpv4MappedAddress(normalized);
  if (mappedIpv4) return isForbiddenIpv4(mappedIpv4);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
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
