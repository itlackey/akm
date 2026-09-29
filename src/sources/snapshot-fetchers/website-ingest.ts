// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  fetchWithRetry,
  isWithin,
  ResponseTooLargeError,
  readBodyWithByteCap,
  resolveStashDir,
  todayIso,
} from "../../core/common";
import type { SourceConfigEntry } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { warn, warnOnce, warnVerbose } from "../../core/warn";
import { withFreshnessCache } from "../freshness";
import { sanitizeString } from "../providers/provider-utils";
import {
  getWebsiteCachePaths,
  normalizeSiteUrl,
  validateWebsiteInputUrl,
  validateWebsiteUrl,
  type WebsiteUrlValidationOptions,
} from "../website-url";
import { htmlToMarkdownAndLinks } from "./content-extract";
import { escapeMarkdownStructure } from "./fetcher-util";
import { assertResolvedHostAllowed, assertWebsiteRequestUrl, type HostnameResolver } from "./host-guard";
import { loadWikiSnapshotFetchers } from "./registry";
import {
  createAllowAllRobotsPolicy,
  createRobotsPolicy,
  isPathAllowedByRobots,
  ROBOTS_BODY_TIMEOUT_MS,
  ROBOTS_BYTE_CAP,
  type RobotsFetchOutcome,
  type RobotsPolicy,
  type RobotsRuleSet,
} from "./robots";
import type { FetcherContext, SecretResolveFn, WikiSnapshotResult } from "./types";

/** Refresh website snapshots every 12 hours to balance freshness with scraping load. */
const CACHE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Allow up to 7 days of stale snapshots when refresh fails so search remains available during outages. */
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Allow limited breadth-first expansion without letting the crawl queue grow unbounded. */
const QUEUE_EXPANSION_FACTOR = 5;

const MAX_PAGES_DEFAULT = 50;
const MAX_DEPTH_DEFAULT = 3;

/** Byte cap for the `llms.txt` manifest itself — a curated link list, never a large file. */
const LLMS_TXT_BYTE_CAP = 512 * 1024;
const LLMS_TXT_BODY_TIMEOUT_MS = 15_000;

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

/** Resolve the exact persisted crawl timeout; zero explicitly disables it. */
export function resolveCrawlTimeoutMs(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === 0) return null;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new ConfigError(
    `Invalid value for crawlTimeoutMs: expected a non-negative integer, got ${JSON.stringify(value)}.`,
  );
}

/**
 * How many times a URL may be pushed back for not fitting its origin's
 * `Crawl-delay` in the remaining budget before it is reported unfetched.
 * Bounds the requeue loop when every remaining URL is rate-limited.
 */
const MAX_CRAWL_DEFERRALS = 3;

/**
 * Body-read deadline for a single page (30s). The per-request fetch timeout
 * (15s) bounds only the connection/header phase; without this a server that
 * dribbles body bytes below the size cap could stall the crawl until the whole
 * wall-clock cap elapses.
 */
const WEBSITE_PAGE_BODY_TIMEOUT_MS = 30_000;

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
  /** Test-only DNS seam for deterministic private-host classification. */
  resolveHostname?: HostnameResolver;
  /**
   * Secret-store reader for fetchers that need credentials. Injected by
   * command-layer callers (which can import `core/env-secret-ref`); this
   * module cannot import it without closing a cycle through the source
   * providers. Omitted means environment variables only.
   */
  resolveSecret?: SecretResolveFn;
}

interface WebsiteValidationOptions extends WebsiteUrlValidationOptions {
  /**
   * When set, `fetchWebsitePage` re-checks the *final* (post-redirect) URL
   * against this policy and drops the page (warnVerbose, no error) when
   * disallowed. Only `crawlWebsite` passes this — `fetchWebsiteMarkdownSnapshot`
   * (single-URL, user-typed fetches) intentionally stays ungated per spec §1.
   * Without this, `normalizeCrawlUrl` stripping trailing slashes plus a
   * server's own redirect (e.g. `/secret` -> `/secret/`) could land on a page
   * disallowed by a `Disallow: /secret/`-shaped rule that was never re-checked
   * post-redirect.
   */
  robots?: RobotsPolicy;
  /**
   * Hard-cap signal for the whole crawl. Passed into `fetchWithRetry` so both
   * the request and the retry sleep between attempts abort when the crawl's
   * deadline fires — a between-iteration check alone cannot interrupt a
   * `Retry-After` wait already under way.
   */
  signal?: AbortSignal;
}

function resolveFetcherStashDir(explicitStashDir?: string): string | null {
  if (explicitStashDir) return explicitStashDir;
  try {
    return resolveStashDir();
  } catch {
    return null;
  }
}

export async function ensureWebsiteMirror(
  config: SourceConfigEntry,
  options?: {
    requireStashDir?: boolean;
    force?: boolean;
    allowPrivateHosts?: boolean;
    /**
     * TEST-ONLY. Overrides `WEBSITE_CRAWL_WALL_CLOCK_MS` for this crawl.
     * Mirrors the `allowPrivateHosts` escape hatch: production callers never
     * set this, but the crawl's wall-clock cap is otherwise a hardcoded
     * 10-minute constant, which makes deadline-boundary behavior (breaking
     * a crawl rather than sleeping past the cap) impossible to exercise in a
     * fast test without it. Not surfaced through config.
     */
    wallClockCapMs?: number;
    /** See {@link FetchSnapshotOptions.resolveSecret}. */
    resolveSecret?: SecretResolveFn;
  },
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
        fetcherStashDir: resolveFetcherStashDir(),
        maxPages: resolvePositiveInt(config.options?.maxPages, MAX_PAGES_DEFAULT, "maxPages"),
        maxDepth: resolvePositiveInt(config.options?.maxDepth, MAX_DEPTH_DEFAULT, "maxDepth"),
        respectRobots: resolveRespectRobots(config.options?.respectRobots),
        allowPrivateHosts: options?.allowPrivateHosts,
        wallClockCapMs: options?.wallClockCapMs,
        crawlTimeoutMs: resolveCrawlTimeoutMs(config.options?.crawlTimeoutMs),
        resolveSecret: options?.resolveSecret,
        // As-supplied, pre-normalization start URL (see crawlWebsite's
        // `rawStartUrl` doc comment): threaded through purely for the C-02
        // robots.txt check, which must see the trailing slash the user
        // actually typed before `normalizeSiteUrl` strips it.
        rawStartUrl: rawUrl,
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
    const pending = [knowledgeDir];
    while (pending.length > 0) {
      const dir = pending.pop();
      if (!dir) break;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) return true;
        if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Iterate the snapshot-fetcher registry against a parsed URL, returning the
 * first fetcher that produces content, or null when none match. A fetcher that
 * throws is logged and treated as a non-match — one broken fetcher must not
 * fail the whole source.
 */
async function dispatchSnapshotFetchers(
  parsed: URL,
  context: FetcherContext,
  stashDir?: string | null,
): Promise<WikiSnapshotResult | null> {
  for (const fetcher of await loadWikiSnapshotFetchers(stashDir)) {
    try {
      if (!fetcher.matches(parsed, context)) continue;
      const snapshot = await fetcher.fetch(parsed, context);
      if (snapshot) return snapshot;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      warn(
        "[akm] snapshot fetcher %s threw on %s: %s",
        fetcher.name,
        parsed.toString(),
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return null;
}

/**
 * Run the snapshot-fetcher registry against a URL. Returns null when no
 * fetcher matches or produces content, so the caller falls back to a crawl.
 */
async function fetchSnapshotViaRegistry(
  startUrl: string,
  stashDir: string | null,
  allowPrivateHosts?: boolean,
  resolveSecret?: SecretResolveFn,
): Promise<WikiSnapshotResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(startUrl);
  } catch {
    return null;
  }
  const context: FetcherContext = {
    stashDir: stashDir ?? "",
    timeoutMs: 15_000,
    ...(resolveSecret ? { resolveSecret } : {}),
    ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  };
  return dispatchSnapshotFetchers(parsed, context, stashDir);
}

// ── Snapshot staging (refresh atomicity, issue #759) ─────────────────────────

/**
 * TEST-ONLY crash-window event, fired after each page file of a refresh lands.
 * See {@link _setWebsiteSnapshotWriteHookForTests}.
 */
export interface WebsiteSnapshotWriteEvent {
  point: "page-written";
  /** 1-based index of the page just written. */
  index: number;
  /** Total pages this refresh will write. */
  total: number;
  /** Stash-relative path of the page just written. */
  relPath: string;
}

let snapshotWriteHookForTests: ((event: WebsiteSnapshotWriteEvent) => void) | undefined;

/**
 * TEST-ONLY. Interrupt a refresh partway through its page-write loop;
 * `undefined` restores. Exists because "a process killed mid-refresh" cannot
 * be staged from outside the module — the whole loop is a single synchronous
 * burst between two awaits. Inert in production (one `undefined?.()` per page).
 */
export function _setWebsiteSnapshotWriteHookForTests(hook?: (event: WebsiteSnapshotWriteEvent) => void): void {
  snapshotWriteHookForTests = hook;
}

function snapshotWriteHook(event: WebsiteSnapshotWriteEvent): void {
  snapshotWriteHookForTests?.(event);
}

/**
 * A refresh replaces the ENTIRE stash directory. Writing in place meant
 * deleting the previous snapshot first and then materializing the new one file
 * by file, so a process killed anywhere in that loop left the mirror empty or
 * holding an arbitrary subset of the new pages with the old content already
 * destroyed — and, because the freshness marker still looked recent, the next
 * `sync()` could serve that wreckage instead of rebuilding it.
 *
 * The new snapshot is built in a sibling staging directory and swapped in with
 * renames instead. An interrupted refresh leaves the PREVIOUS complete snapshot
 * untouched; the abandoned staging directory is swept by the next refresh. The
 * staging/retired names are dot-prefixed so the indexer's walk (which skips
 * dot-directories) never sees a half-written snapshot even mid-flight.
 */
interface SnapshotStaging {
  /** Directory the new snapshot is materialized into. */
  readonly dir: string;
  /** Final location the staging directory is renamed onto. */
  readonly target: string;
}

function snapshotSiblingPrefix(stashDir: string, kind: "staging" | "retired"): string {
  return `.${path.basename(stashDir)}.${kind}-`;
}

function snapshotSiblingPath(stashDir: string, kind: "staging" | "retired"): string {
  const unique = `${process.pid}-${randomBytes(6).toString("hex")}`;
  return path.join(path.dirname(stashDir), `${snapshotSiblingPrefix(stashDir, kind)}${unique}`);
}

/**
 * Age gate for the staging sweep. Nothing enforces one refresh at a time for a
 * given website source, so a sibling directory may belong to a refresh that is
 * still running in another process; deleting it would break a healthy run
 * instead of cleaning up after a dead one. Only clearly-abandoned directories
 * (untouched for an hour — far longer than the 10-minute crawl wall-clock cap)
 * are swept. Leftovers are inert until then: they are dot-prefixed, so the
 * indexer's walk skips them.
 */
const SNAPSHOT_STAGING_SWEEP_AGE_MS = 60 * 60 * 1000;

/** Remove staging/retired directories abandoned by an earlier interrupted run. */
function sweepSnapshotStaging(stashDir: string): void {
  const parent = path.dirname(stashDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  const prefixes = [snapshotSiblingPrefix(stashDir, "staging"), snapshotSiblingPrefix(stashDir, "retired")];
  const cutoff = Date.now() - SNAPSHOT_STAGING_SWEEP_AGE_MS;
  for (const entry of entries) {
    if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
    const abandoned = path.join(parent, entry);
    try {
      if (fs.statSync(abandoned).mtimeMs > cutoff) continue;
    } catch {
      continue;
    }
    fs.rmSync(abandoned, { recursive: true, force: true });
  }
}

function beginSnapshotStaging(stashDir: string): SnapshotStaging {
  fs.mkdirSync(path.dirname(stashDir), { recursive: true });
  sweepSnapshotStaging(stashDir);
  const dir = snapshotSiblingPath(stashDir, "staging");
  fs.mkdirSync(dir, { recursive: true });
  return { dir, target: stashDir };
}

/**
 * Swap the staged snapshot in. POSIX cannot atomically exchange two non-empty
 * directories, so the previous snapshot is renamed ASIDE first and deleted
 * afterwards: the window in which the target does not exist is one syscall
 * wide instead of an entire write loop.
 */
function publishSnapshotStaging(staging: SnapshotStaging): void {
  let retired: string | undefined;
  if (fs.existsSync(staging.target)) {
    retired = snapshotSiblingPath(staging.target, "retired");
    fs.renameSync(staging.target, retired);
  }
  fs.renameSync(staging.dir, staging.target);
  if (retired) fs.rmSync(retired, { recursive: true, force: true });
}

/** Drop an unpublished staging directory (no-op once it has been renamed). */
function discardSnapshotStaging(staging: SnapshotStaging): void {
  fs.rmSync(staging.dir, { recursive: true, force: true });
}

/** Materialize a single fetcher snapshot as the source's whole stash. */
function writeSnapshotToStash(stashDir: string, snapshot: WikiSnapshotResult): void {
  const preferredName = snapshot.preferredName ?? deriveImportPath(snapshot.url);
  const relPath = avoidReservedBasename(preferredName);
  // Validate against the FINAL location so the guarantee (and the error text)
  // is independent of where the file is staged.
  const knowledgeDir = path.join(stashDir, "knowledge");
  if (!isWithin(path.resolve(knowledgeDir, `${relPath}.md`), knowledgeDir)) {
    throw new UsageError(`Snapshot fetcher returned an unsafe preferred name: ${JSON.stringify(preferredName)}`);
  }
  const staging = beginSnapshotStaging(stashDir);
  try {
    const filePath = path.resolve(path.join(staging.dir, "knowledge"), `${relPath}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const slug = relPath.split("/").pop() ?? "index";
    fs.writeFileSync(
      filePath,
      buildMarkdownSnapshot(
        { url: snapshot.url, title: snapshot.title, markdown: snapshot.markdown },
        slug,
        snapshot.tags,
      ),
      "utf8",
    );
    snapshotWriteHook({ point: "page-written", index: 1, total: 1, relPath: `knowledge/${relPath}.md` });
    publishSnapshotStaging(staging);
  } finally {
    discardSnapshotStaging(staging);
  }
}

async function scrapeWebsiteToStash(
  startUrl: string,
  stashDir: string,
  options: {
    maxPages: number;
    maxDepth: number;
    respectRobots?: boolean;
    allowPrivateHosts?: boolean;
    wallClockCapMs?: number;
    rawStartUrl?: string;
    resolveSecret?: SecretResolveFn;
    fetcherStashDir?: string | null;
    /** Hard process cap; `null` disables it. See {@link resolveCrawlTimeoutMs}. */
    crawlTimeoutMs?: number | null;
  },
): Promise<void> {
  // Offer the URL to the specialized fetchers before falling back to a crawl.
  // Without this, `akm bundle add <feed|profile URL>` reaches only the generic
  // crawler and the RSS/Bluesky/X/YouTube fetchers are unreachable outside the
  // `akm import` path. A fetcher returning null falls through to the crawl.
  const fetched = await fetchSnapshotViaRegistry(
    startUrl,
    options.fetcherStashDir ?? null,
    options.allowPrivateHosts,
    options.resolveSecret,
  );
  if (fetched) {
    writeSnapshotToStash(stashDir, fetched);
    return;
  }

  const pages = await crawlWebsite(startUrl, options);
  if (pages.length === 0) {
    throw new Error(`No content could be scraped from ${startUrl}`);
  }

  const staging = beginSnapshotStaging(stashDir);
  try {
    const knowledgeDir = path.join(staging.dir, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });

    const usedPaths = new Set<string>();
    let written = 0;
    for (const page of pages) {
      const relPath = avoidReservedBasename(urlToRelativePath(page.url));
      const uniquePath = uniqueSlug(relPath, usedPaths);
      const filePath = path.join(knowledgeDir, `${uniquePath}.md`);
      const dir = path.dirname(filePath);
      if (dir !== knowledgeDir) fs.mkdirSync(dir, { recursive: true });
      const slug = uniquePath.split("/").pop() ?? "index";
      fs.writeFileSync(filePath, buildMarkdownSnapshot(page, slug), "utf8");
      written++;
      snapshotWriteHook({
        point: "page-written",
        index: written,
        total: pages.length,
        relPath: `knowledge/${uniquePath}.md`,
      });
    }
    publishSnapshotStaging(staging);
  } finally {
    discardSnapshotStaging(staging);
  }
}

export async function fetchWebsiteMarkdownSnapshot(
  rawUrl: string,
  options?: FetchSnapshotOptions,
): Promise<WebsiteMarkdownSnapshot> {
  const normalizedUrl = validateWebsiteInputUrl(rawUrl, { allowPrivateHosts: options?.allowPrivateHosts });
  const parsedUrl = new URL(normalizedUrl);
  const allowPrivateHosts = await resolveAllowPrivateStartHost(
    parsedUrl,
    options?.allowPrivateHosts,
    options?.resolveHostname,
  );
  const stashDir = resolveFetcherStashDir(options?.stashDir);
  const context: FetcherContext = {
    stashDir: stashDir ?? "",
    timeoutMs: options?.timeoutMs ?? 15_000,
    signal: options?.signal,
    ...(options?.resolveSecret ? { resolveSecret: options.resolveSecret } : {}),
    ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  };

  const snapshot = await dispatchSnapshotFetchers(parsedUrl, context, stashDir);
  if (snapshot) return websiteMarkdownSnapshotFromResult(snapshot);

  const fetchedResponse = await fetchWebsiteResponse(normalizedUrl, 0, {
    allowPrivateHosts,
    signal: options?.signal,
  });
  const finalUrl = normalizeCrawlUrl(fetchedResponse.finalUrl) ?? normalizedUrl;
  if (finalUrl !== normalizedUrl) {
    let redirectedSnapshot: WikiSnapshotResult | null;
    try {
      redirectedSnapshot = await dispatchSnapshotFetchers(new URL(finalUrl), context, stashDir);
    } catch (error) {
      await fetchedResponse.response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (redirectedSnapshot) {
      await fetchedResponse.response.body?.cancel().catch(() => undefined);
      return websiteMarkdownSnapshotFromResult(redirectedSnapshot);
    }
  }

  const fetched = await websitePageFromResponse(fetchedResponse, normalizedUrl, {
    allowPrivateHosts,
    signal: options?.signal,
  });
  if (!fetched) throw new UsageError(`No content could be fetched from ${normalizedUrl}`);

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Evaluates a URL against robots.txt, checking both `normalizedUrl` — the
 * form akm treats as canonical for dedup/storage, with any bare trailing
 * slash already stripped by `normalizeCrawlUrl`/`normalizeSiteUrl` — and,
 * when it differs, `rawUrl`: the URL exactly as discovered (a link's literal
 * `href`), as-supplied (the user's typed start URL), or redirected-to (a
 * `Location` header), before any such stripping. Delegates the actual
 * allow/disallow decision to {@link decideRobotsAllowance}'s asymmetric
 * matrix — see its doc comment — rather than a plain AND of both forms: a
 * `Disallow: /dir/`-shaped rule needs the un-stripped `rawUrl` to ever match
 * (closing that gap), while an `Allow: /docs/`-shaped rule needs it too, in
 * the *other* direction (a normalized-disallowed-but-raw-allowed URL must
 * still be treated as allowed here, not just at the point where akm chooses
 * which literal URL to fetch — a URL reaching this function has already been
 * fetched, under whichever form `crawlWebsite`/`resolveCrawlRobotsDecision`
 * selected, so only the `allowed` verdict matters here, never `fetchUrl`).
 *
 * `normalizeCrawlUrl`/`normalizeSiteUrl` strip a bare trailing slash before
 * any robots check ever runs, so a `Disallow: /dir/`-shaped rule — which
 * requires a literal trailing `/` in the target, see
 * `matchesCompiledPattern`'s prefix check — can never match the stripped
 * alias. Checking the un-stripped `rawUrl` closes that gap without changing
 * what akm treats as the canonical URL for storage/dedup, and (crucially)
 * without over-blocking a URL that never had a trailing slash to begin with
 * — e.g. a `/secret` link that happens to redirect to `/secret/`: the
 * pre-redirect request itself is unaffected by a `Disallow: /secret/` rule,
 * only the redirect target is.
 */
async function isCrawlUrlAllowedByRobots(
  robots: RobotsPolicy,
  normalizedUrl: string,
  rawUrl?: string,
): Promise<boolean> {
  return (await resolveCrawlRobotsDecision(robots, normalizedUrl, rawUrl)).allowed;
}

/**
 * Decides whether `normalizedUrl` (akm's canonical form — dedup/cache key,
 * with any bare trailing slash already stripped by `normalizeCrawlUrl`/
 * `normalizeSiteUrl`) may be crawled, and which literal URL to actually
 * request.
 *
 * A `Disallow: /dir/`-shaped rule requires a literal trailing `/` in the
 * target (see `matchesCompiledPattern`'s prefix check), so it can never match
 * the slash-stripped normalized alias — checking the un-stripped `rawUrl` (a
 * link's literal `href`, the user's as-typed start URL, or a redirect
 * `Location`) closes that gap. Symmetrically, an `Allow: /docs/`-shaped rule
 * requires that same trailing `/` to match, so a start URL or link typed as
 * `.../docs/` under `Disallow: / \n Allow: /docs/` is allowed in its raw form
 * but disallowed once normalized — over-blocking a site the owner explicitly
 * opened to crawlers.
 *
 * Resolution matrix (raw form only consulted when it differs from normalized):
 *  - normalized allowed, raw allowed (or no distinct raw)  => allowed, fetch normalized
 *  - normalized allowed, raw disallowed                    => BLOCKED (raw wins: closes the Disallow: /dir/ gap)
 *  - normalized disallowed, raw allowed                    => allowed, fetch the RAW url (closes the Allow: /docs/ gap)
 *  - normalized disallowed, raw disallowed                 => BLOCKED
 *
 * Only the third row switches the fetch target; every other row fetches the
 * normalized form akm already treats as canonical. Do not collapse this to a
 * plain OR of the two checks — that would also flip the second row to
 * "allowed" and reopen the `Disallow: /dir/` bypass this matrix exists to
 * close.
 */
function decideRobotsAllowance(
  rules: RobotsRuleSet,
  normalizedUrl: string,
  rawUrl?: string,
): { allowed: boolean; fetchUrl: string } {
  const normalizedAllowed = isPathAllowedByRobots(rules, normalizedUrl);
  if (!rawUrl || rawUrl === normalizedUrl) {
    return { allowed: normalizedAllowed, fetchUrl: normalizedUrl };
  }
  const rawAllowed = isPathAllowedByRobots(rules, rawUrl);
  if (!normalizedAllowed && rawAllowed) {
    return { allowed: true, fetchUrl: rawUrl };
  }
  return { allowed: normalizedAllowed && rawAllowed, fetchUrl: normalizedUrl };
}

/**
 * Async wrapper of {@link decideRobotsAllowance} for call sites holding a
 * `RobotsPolicy` (which resolves/caches rules per origin) rather than an
 * already-fetched `RobotsRuleSet`.
 */
async function resolveCrawlRobotsDecision(
  robots: RobotsPolicy,
  normalizedUrl: string,
  rawUrl?: string,
): Promise<{ allowed: boolean; fetchUrl: string }> {
  const rules = await robots.rulesFor(normalizedUrl);
  return decideRobotsAllowance(rules, normalizedUrl, rawUrl);
}

/**
 * C-02/C-03: fail fast, before any page fetch, when the start URL itself is
 * off-limits per an actually-parsed robots.txt rule. A 5xx on robots.txt
 * itself no longer reaches this as `disallowAll`: `loadRobotsTxt` reports it the same way a
 * 4xx is reported (`ALLOW_ALL_RULES`), with its own warning, rather than
 * treating the site's own transient error as a Disallow. The check below
 * stays as defense-in-depth for a `RobotsPolicy` built over some other
 * loader that does still report `disallowAll`.
 *
 * Checks both `start`'s (normalized) URL and `rawStartUrl` — the URL exactly
 * as the user supplied it in config, before `validateWebsiteUrl` ->
 * `normalizeSiteUrl` stripped any trailing slash — via
 * `decideRobotsAllowance`. Without this, a start URL typed as `.../secret/`
 * under `Disallow: /secret/` would never match that rule and would be
 * crawled instead of rejected with the spec §4.6 C-02 UsageError; conversely,
 * a start URL typed as `.../docs/` under `Disallow: / \n Allow: /docs/`
 * would be normalized to `.../docs`, fail to match `Allow: /docs/`, and be
 * rejected even though the site owner explicitly opened `/docs/` to
 * crawlers. `crawlWebsite`'s queue gate applies the same decision (and, in
 * the Allow case, actually fetches the raw URL this function only validates
 * against) — see its call to `resolveCrawlRobotsDecision`.
 */
async function assertStartUrlAllowedByRobots(robots: RobotsPolicy, start: URL, rawStartUrl?: string): Promise<void> {
  const startUrl = start.toString();
  const robotsUrl = new URL("/robots.txt", start.origin).toString();
  const rules = await robots.rulesFor(startUrl);

  if (rules.disallowAll) {
    throw new UsageError(
      `Refusing to crawl ${startUrl}: ${robotsUrl} returned a server error, which robots.txt conventions ` +
        `treat as a full disallow until it recovers. Set respectRobots: false on this website source to bypass ` +
        `robots.txt.`,
    );
  }
  let rawStartUrlNormalized: string | undefined;
  if (rawStartUrl) {
    try {
      rawStartUrlNormalized = new URL(rawStartUrl).toString();
    } catch {
      rawStartUrlNormalized = undefined;
    }
  }
  const { allowed } = decideRobotsAllowance(rules, startUrl, rawStartUrlNormalized);
  if (!allowed) {
    throw new UsageError(
      `Refusing to crawl ${startUrl}: disallowed by ${robotsUrl}. Set respectRobots: false on this website ` +
        `source to bypass robots.txt.`,
    );
  }
}

/**
 * Decide whether to treat a fetch's start host — the URL an operator directly
 * typed or configured (`akm bundle add`, `akm knowledge add`, a crawl's own
 * start URL), never a link discovered while crawling — as private for this
 * operation. `requested` (already true when the URL itself was
 * loopback/private-literal, per `shouldAllowPrivateWebsiteUrlForTests`) wins
 * outright. Otherwise, resolve the host: a name that only turns out to be
 * private via DNS (a corporate wiki behind split-horizon DNS, a VPN hostname)
 * would otherwise abort with no escape hatch even though the operator named
 * this exact host. Callers scope the resulting bypass to same-origin work
 * only — a link discovered mid-crawl is restricted to the start URL's origin
 * before it ever reaches a guard, so this never extends trust to a host the
 * fetched content merely points at.
 */
async function resolveAllowPrivateStartHost(
  start: URL,
  requested: boolean | undefined,
  resolveHostname?: HostnameResolver,
): Promise<boolean> {
  if (requested) return true;
  try {
    await assertResolvedHostAllowed(start.hostname, { resolveHostname });
    return false;
  } catch {
    warnOnce(
      `website-private-start-host:${start.origin}`,
      `[akm] ${start.origin} is not a publicly routable host, but you added it as a source directly — proceeding. ` +
        "Links to other hosts found in its content are still checked.",
    );
    return true;
  }
}

async function crawlWebsite(
  startUrl: string,
  options: {
    maxPages: number;
    maxDepth: number;
    respectRobots?: boolean;
    allowPrivateHosts?: boolean;
    wallClockCapMs?: number;
    /** Hard process cap; `null` disables it. See {@link resolveCrawlTimeoutMs}. */
    crawlTimeoutMs?: number | null;
    /**
     * The start URL exactly as the user supplied it in config, before
     * `validateWebsiteUrl` -> `normalizeSiteUrl` stripped any trailing
     * slash. Passed through to `assertStartUrlAllowedByRobots` only — see
     * `decideRobotsAllowance`'s doc comment for why. `startUrl` itself is
     * always already normalized by the time it reaches here (every caller
     * routes it through `validateWebsiteUrl` first), so it cannot stand in
     * for the as-typed form on its own.
     */
    rawStartUrl?: string;
  },
): Promise<WebsitePage[]> {
  const start = new URL(normalizeSiteUrl(startUrl));
  const allowedOrigin = start.origin;
  const allowPrivateHosts = await resolveAllowPrivateStartHost(start, options.allowPrivateHosts);
  const queue: Array<{ url: string; rawUrl: string; depth: number; deferrals: number }> = [
    { url: start.toString(), rawUrl: options.rawStartUrl ?? start.toString(), depth: 0, deferrals: 0 },
  ];
  const visited = new Set<string>();
  const pages: WebsitePage[] = [];
  // Precedence: the test-only seam, then the user's `crawlTimeoutMs`, then the
  // default. `crawlTimeoutMs: 0` disables the cap outright, for a
  // deliberately long-running crawl the user is willing to babysit.
  const configuredCapMs =
    options.crawlTimeoutMs === null ? null : (options.crawlTimeoutMs ?? WEBSITE_CRAWL_WALL_CLOCK_MS);
  const wallClockCapMs = options.wallClockCapMs ?? configuredCapMs;
  const capDisabled = wallClockCapMs === null;
  const deadline = capDisabled ? Number.POSITIVE_INFINITY : Date.now() + (wallClockCapMs as number);

  // Between-iteration deadline checks cannot interrupt work already in
  // flight: a single request's `Retry-After` sleep, or a slow body read, can
  // run far past the cap on its own. This signal makes the cap a HARD limit —
  // it aborts the in-flight fetch and the retry sleep alike.
  const abortController = new AbortController();
  const capTimer = capDisabled
    ? undefined
    : setTimeout(
        () =>
          abortController.abort(new Error(`Website crawl exceeded its ${(wallClockCapMs as number) / 1000}s limit`)),
        wallClockCapMs as number,
      );
  const crawlSignal = abortController.signal;

  const robots =
    options.respectRobots === false
      ? createAllowAllRobotsPolicy()
      : createRobotsPolicy((robotsUrl) => loadRobotsTxt(robotsUrl, { allowPrivateHosts, signal: crawlSignal }));

  await assertStartUrlAllowedByRobots(robots, start, options.rawStartUrl);

  // llms.txt fast path: an increasing number of doc sites publish a curated,
  // deduplicated link list at `/llms.txt` specifically for tools like this
  // one. When present, use it as the crawl frontier instead of discovering
  // links by parsing HTML — each linked page still goes through the exact
  // same robots-compliant, host-guarded `fetchWebsitePage` call below, so
  // ingested pages stay individually addressable. Gated to origin-root start
  // URLs only (mirrors `extractGithubRepository`'s repo-root restriction):
  // adding a specific page must fetch that page, not silently pull in the
  // whole site's manifest.
  if (isOriginRootUrl(start)) {
    const manifest = await fetchLlmsManifest(start, robots, {
      allowPrivateHosts,
      signal: crawlSignal,
    });
    if (manifest) {
      warn("[akm] Using llms.txt manifest from %s", manifest.manifestUrl);
      queue.length = 0;
      for (const link of manifest.links) {
        // A manifest can name arbitrary hosts; only same-origin links are
        // honored by default, same as links discovered mid-crawl below.
        if (link.origin !== allowedOrigin) continue;
        const candidate = normalizeCrawlUrl(link.toString());
        if (!candidate) continue;
        // depth = maxDepth: fetch each manifest page individually, but don't
        // treat it as a fresh BFS seed — the manifest is already the
        // author-curated set of pages worth ingesting.
        queue.push({ url: candidate, rawUrl: link.toString(), depth: options.maxDepth, deferrals: 0 });
      }
    }
  }

  // Counts actual `fetchWebsitePage` invocations (regardless of outcome) so
  // Crawl-delay pacing skips the first fetch and never charges a delay slot
  // to a URL that robots.txt skipped without ever being fetched (C-11).
  let fetchAttempts = 0;
  // URLs pushed back because their Crawl-delay would not fit in the remaining
  // budget, and URLs that ran out of retries entirely. Reported at the end so
  // a rate-limited origin is visible rather than silently missing.
  const deferred = new Set<string>();
  const unfetched = new Set<string>();

  while (queue.length > 0 && pages.length < options.maxPages) {
    if (Date.now() > deadline) break;
    const next = queue.shift();
    if (!next) break;
    const normalized = normalizeCrawlUrl(next.url);
    if (!normalized || visited.has(normalized)) continue;

    const decision = await resolveCrawlRobotsDecision(robots, normalized, next.rawUrl);
    if (!decision.allowed) {
      // Deliberately NOT marked visited. `/docs/` and `/docs` share a
      // normalized key but get different robots verdicts (a `Disallow: /docs/`
      // rule matches only the trailing-slash form). Marking the key visited
      // here would let whichever alias happened to be discovered first — and
      // was then rejected — permanently suppress the allowed alias, making
      // crawl coverage depend on link order. Robots rules are cached per
      // origin, so re-evaluating a repeated disallowed alias is cheap.
      warnVerbose("[akm] website crawl: skipping %s (disallowed by robots.txt)", normalized);
      continue;
    }
    if (fetchAttempts > 0) {
      const delayMs = await robots.crawlDelayMs(normalized);
      if (delayMs > 0) {
        if (Date.now() + delayMs >= deadline) {
          // Sleeping this one out would blow the wall-clock cap. Defer it to
          // the back of the queue instead of ending the crawl here: other
          // origins may have no Crawl-delay and can still be fetched with the
          // time that remains. Anything still deferred when the deadline
          // arrives is reported as unfetched below rather than silently
          // dropped. `deferred` is bounded so a queue of delayed URLs cannot
          // spin forever re-appending to itself.
          if (next.deferrals < MAX_CRAWL_DEFERRALS) {
            queue.push({ ...next, deferrals: next.deferrals + 1 });
            deferred.add(normalized);
          } else {
            unfetched.add(normalized);
          }
          continue;
        }
        await sleep(delayMs);
      }
    }
    visited.add(normalized);
    deferred.delete(normalized);
    fetchAttempts++;

    const fetched = await fetchWebsitePage(decision.fetchUrl, {
      allowPrivateHosts,
      robots,
      signal: crawlSignal,
    });
    if (!fetched) continue;
    pages.push(fetched.page);

    if (next.depth >= options.maxDepth) continue;
    for (const link of fetched.links) {
      if (queue.length + pages.length >= options.maxPages * QUEUE_EXPANSION_FACTOR) break;
      if (link.origin !== allowedOrigin) continue;
      const rawLinkUrl = link.toString();
      const candidate = normalizeCrawlUrl(rawLinkUrl);
      if (!candidate || visited.has(candidate) || isAssetLikePath(link.pathname)) continue;
      queue.push({ url: candidate, rawUrl: rawLinkUrl, depth: next.depth + 1, deferrals: 0 });
    }
  }

  if (!capDisabled && Date.now() > deadline) {
    warn(
      "[akm] website crawl stopped at the %ds wall-clock cap with %d/%d pages collected from %s. " +
        "Raise crawlTimeoutMs on this website source, or set it to 0 to disable the cap.",
      (wallClockCapMs as number) / 1000,
      pages.length,
      options.maxPages,
      startUrl,
    );
  }

  if (capTimer) clearTimeout(capTimer);

  // A URL still deferred when the loop ends never got fetched — report it
  // rather than letting a rate-limited origin go missing without a trace.
  for (const url of deferred) unfetched.add(url);
  if (unfetched.size > 0) {
    warn(
      "[akm] website crawl: %d URL(s) were not fetched — their origin's Crawl-delay did not fit in the " +
        "remaining time budget. First: %s",
      unfetched.size,
      [...unfetched].slice(0, 3).join(", "),
    );
  }

  return pages;
}

/**
 * Sentinel thrown by `fetchWebsiteResponse` when a redirect hop's target is
 * disallowed by robots.txt (see the doc comment above the check in
 * `fetchWebsiteResponse`). Never escapes `fetchWebsitePage`, which maps it to
 * `null` — the same "page skipped, no error" outcome as any other
 * robots-disallowed URL. Not exported; purely an internal control-flow
 * signal between the two functions.
 */
class RobotsDisallowedRedirectError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows redirect target ${url}`);
    this.name = "RobotsDisallowedRedirectError";
  }
}

async function fetchWebsitePage(
  pageUrl: string,
  options?: WebsiteValidationOptions,
): Promise<{ page: WebsitePage; links: URL[] } | null> {
  let fetchedResponse: WebsiteResponse;
  try {
    fetchedResponse = await fetchWebsiteResponse(pageUrl, 0, options);
  } catch (err) {
    if (err instanceof RobotsDisallowedRedirectError) return null;
    throw err;
  }

  return websitePageFromResponse(fetchedResponse, pageUrl, options);
}

interface WebsiteResponse {
  response: Response;
  finalUrl: string;
}

async function websitePageFromResponse(
  fetched: WebsiteResponse,
  pageUrl: string,
  options?: WebsiteValidationOptions,
): Promise<{ page: WebsitePage; links: URL[] } | null> {
  const { response } = fetched;

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return null;
    throw new Error(`Failed to fetch website content (${response.status}) from ${pageUrl}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let body: string;
  try {
    body = await readBodyWithByteCap(response, WEBSITE_PAGE_BYTE_CAP, {
      bodyTimeoutMs: WEBSITE_PAGE_BODY_TIMEOUT_MS,
      signal: options?.signal,
    });
  } catch (err) {
    if (err instanceof ResponseTooLargeError) return null;
    throw err;
  }
  const rawFinalUrl = fetched.finalUrl;
  const finalUrl = normalizeCrawlUrl(rawFinalUrl) ?? pageUrl;
  assertWebsiteRequestUrl(finalUrl, Error, options);

  // Re-check robots.txt against the FINAL (post-redirect) URL, not just the
  // pre-redirect URL crawlWebsite already gated. normalizeCrawlUrl strips
  // trailing slashes before the initial gate, so a rule shaped like
  // `Disallow: /secret/` correctly lets `/secret` through that gate; if the
  // server then redirects to `/secret/` (a common trailing-slash
  // canonicalization), the disallowed page would otherwise be fetched and
  // stored without ever being weighed against robots.txt. See spec §4.6 C-04.
  // Checks `rawFinalUrl` (the un-normalized `response.url`, slash intact) as
  // well as `finalUrl`, per `isCrawlUrlAllowedByRobots` — `normalizeCrawlUrl`
  // would otherwise strip the very trailing slash a `Disallow: /secret/`
  // rule needs to match.
  if (options?.robots && !(await isCrawlUrlAllowedByRobots(options.robots, finalUrl, rawFinalUrl))) {
    warnVerbose("[akm] website crawl: skipping %s (disallowed by robots.txt after redirect)", finalUrl);
    return null;
  }

  if (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml") ||
    (!contentType && looksLikeMarkup(body))
  ) {
    const title = extractHtmlTitle(body) || new URL(finalUrl).hostname;
    // One parse yields both the content Markdown and the whole-document links.
    const { markdown, links } = htmlToMarkdownAndLinks(body, finalUrl);
    return {
      page: { url: finalUrl, title, markdown },
      links,
    };
  }

  return {
    page: {
      url: finalUrl,
      title: extractTextTitle(body) || new URL(finalUrl).hostname,
      markdown: plainTextToMarkdown(body),
    },
    links: [],
  };
}

async function fetchWebsiteResponse(
  pageUrl: string,
  redirectCount = 0,
  options?: WebsiteValidationOptions,
): Promise<WebsiteResponse> {
  assertWebsiteRequestUrl(pageUrl, Error, options);
  // Resolve-then-validate BEFORE connecting: the hostname checks above only
  // catch IP-literal / well-known-name hosts, so a public-looking DNS name that
  // resolves into a private range would otherwise slip through. This runs on
  // every hop because the redirect path re-enters this function recursively.
  await assertResolvedHostAllowed(new URL(pageUrl).hostname, options);
  const response = await fetchWithRetry(
    pageUrl,
    {
      headers: {
        Accept: "text/html, text/markdown, text/plain;q=0.9, application/xhtml+xml;q=0.8",
        "User-Agent": "akm-cli website provider",
      },
      redirect: "manual",
      ...(options?.signal ? { signal: options.signal } : {}),
    },
    { timeout: 15_000, retries: 1 },
  );

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= WEBSITE_MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Too many redirects while fetching ${pageUrl}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Redirect response from ${pageUrl} did not include a Location header`);
    }
    await response.body?.cancel().catch(() => undefined);
    const nextUrl = new URL(location, pageUrl).toString();
    try {
      assertWebsiteRequestUrl(nextUrl, Error, options);
    } catch (error) {
      if (options?.robots) {
        warnVerbose("[akm] website crawl: skipping unsafe redirect to %s", nextUrl);
        throw new RobotsDisallowedRedirectError(nextUrl);
      }
      throw error;
    }

    // Robots-check every intermediate redirect hop, not just the pre-redirect
    // queue URL (`crawlWebsite`'s gate) and the FINAL URL (the post-redirect
    // recheck below in `fetchWebsitePage`). Without this, a chain like
    // `/go` -> 302 `/secret/` -> 302 `/public` issues a live GET to
    // `/secret/` even when robots.txt disallows it, because that hop is
    // never the queue URL and never the final URL. Only gated when a
    // `RobotsPolicy` was actually threaded in (`crawlWebsite`); single-URL
    // `fetchWebsiteMarkdownSnapshot` fetches stay deliberately ungated per
    // spec §1.
    if (options?.robots) {
      const normalizedNext = normalizeCrawlUrl(nextUrl);
      if (!normalizedNext) {
        // `normalizeCrawlUrl` returns null for anything that isn't http(s) —
        // a redirect `Location` can legally point at `mailto:`, `tel:`, a
        // bare relative path that resolves to an opaque scheme, etc.
        // `RobotsPolicy.rulesFor` computes `new URL(url).origin` and then
        // resolves `/robots.txt` against it; for a non-http(s) URL that
        // origin is the literal string "null", and re-resolving against it
        // throws an unhandled TypeError that aborts the whole crawl. Refuse
        // the hop outright instead of ever handing such a URL to the policy —
        // `fetchWebsitePage` maps this to a graceful skip. Regression
        // introduced by a67412c, which fell back to the raw `nextUrl` here.
        warnVerbose("[akm] website crawl: skipping redirect to %s (not an http(s) URL)", nextUrl);
        throw new RobotsDisallowedRedirectError(nextUrl);
      }
      if (!(await isCrawlUrlAllowedByRobots(options.robots, normalizedNext, nextUrl))) {
        warnVerbose("[akm] website crawl: skipping redirect to %s (disallowed by robots.txt)", nextUrl);
        throw new RobotsDisallowedRedirectError(nextUrl);
      }
    }

    return fetchWebsiteResponse(nextUrl, redirectCount + 1, options);
  }

  return { response, finalUrl: pageUrl };
}

/**
 * Fetches and classifies `<origin>/robots.txt`. Reuses `fetchWebsiteResponse`
 * (spec §6.2: no second fetch path) so robots.txt gets the exact same SSRF
 * guards, retry, and redirect handling as a page fetch.
 *
 * Steps 1–2 (the guard on the INITIAL URL) run OUTSIDE the try/catch on
 * purpose: a guard rejection there must propagate as-is, never be downgraded
 * to "unavailable" (spec §4.5 F-12, §6.2). Guard rejections on a LATER
 * redirect hop happen inside `fetchWebsiteResponse`, which the try/catch
 * below does cover — the guard has already refused to fetch that host, so
 * only the error *reporting* is downgraded (F-11).
 */
export async function loadRobotsTxt(
  robotsUrl: string,
  options?: WebsiteValidationOptions,
): Promise<RobotsFetchOutcome> {
  assertWebsiteRequestUrl(robotsUrl, UsageError, options);
  await assertResolvedHostAllowed(new URL(robotsUrl).hostname, options);

  try {
    const { response } = await fetchWebsiteResponse(robotsUrl, 0, options);

    if (response.status >= 200 && response.status < 300) {
      try {
        const text = await readBodyWithByteCap(response, ROBOTS_BYTE_CAP, {
          bodyTimeoutMs: ROBOTS_BODY_TIMEOUT_MS,
          signal: options?.signal,
        });
        return { kind: "body", text };
      } catch (err) {
        if (err instanceof ResponseTooLargeError) {
          warn(
            "[akm] robots.txt at %s exceeded the %d-byte cap; treating it as unavailable.",
            robotsUrl,
            ROBOTS_BYTE_CAP,
          );
          return { kind: "unavailable" };
        }
        throw err;
      }
    }

    if (response.status >= 500 && response.status < 600) {
      await response.body?.cancel().catch(() => undefined);
      // Guard-audit finding 12: RFC 9309 §2.3.1.4 recommends treating an
      // unreachable robots.txt as a full disallow, but for a personal tool
      // crawling a site the operator explicitly chose, a transient 5xx on
      // the site's OWN robots.txt is not a site owner's Disallow — it is the
      // site being flaky. `fetchWithRetry` already retried this once, so
      // this is not a single blip; still, blocking the crawl outright over
      // it serves the operator worse than proceeding unrestricted. Reported
      // as "unavailable" (the same outcome a 4xx gets), which resolves to
      // ALLOW_ALL_RULES rather than DISALLOW_ALL_RULES.
      warn(
        "[akm] robots.txt at %s returned %d; proceeding as if no robots.txt were published, rather than treating " +
          "the crawl as fully disallowed. Set respectRobots: false on this website source to silence this warning.",
        robotsUrl,
        response.status,
      );
      return { kind: "unavailable" };
    }

    // 4xx (404 is the common, silent case), and any other non-2xx/5xx status.
    await response.body?.cancel().catch(() => undefined);
    return { kind: "unavailable" };
  } catch (err) {
    if (options?.signal?.aborted) throw err;
    warnVerbose(
      "[akm] failed to fetch robots.txt at %s: %s",
      robotsUrl,
      err instanceof Error ? err.message : String(err),
    );
    return { kind: "unavailable" };
  }
}

/** Resolve the exact persisted robots policy. */
export function resolveRespectRobots(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  throw new ConfigError(`Invalid value for respectRobots: expected a boolean, got ${JSON.stringify(value)}.`);
}

function buildMarkdownSnapshot(page: WebsitePage, slug: string, tags?: string[]): string {
  const title = sanitizeString(page.title, 200) || slug;
  const heading = title.replace(/([\\[\]`*_])/g, "\\$1").replace(/<(?=[a-zA-Z/!?])/g, "&lt;");
  const host = sanitizeString(new URL(page.url).hostname, 120);
  const description = sanitizeString(`Website snapshot from ${host}`, 500);
  const content = page.markdown.trim() || `Source: ${page.url}`;
  const normalizedTags = Array.from(new Set(["website", host, ...(tags ?? [])]));

  return [
    "---",
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(description)}`,
    `sourceUrl: ${JSON.stringify(page.url)}`,
    `title: ${JSON.stringify(title)}`,
    `updated: ${todayIso()}`,
    "lint_skip:",
    "  - stale-path",
    "tags:",
    ...normalizedTags.map((tag) => `  - ${JSON.stringify(tag)}`),
    "---",
    "",
    `# ${heading}`,
    "",
    `Source: ${page.url}`,
    "",
    content,
    "",
  ].join("\n");
}

/**
 * True for a start URL that names an origin's root (no path, no query).
 * Matches how `extractGithubRepository` restricts its own special-case match
 * to repository-root URLs — the llms.txt probe must not fire for a
 * user-supplied deep link, or `akm bundle add <site>/guides/foo` would
 * silently ingest the whole site's manifest instead of the page requested.
 */
export function isOriginRootUrl(url: URL): boolean {
  return url.pathname === "/" && !url.search;
}

/**
 * Parses the `llms.txt` link-list format: list items shaped like
 * `- [title](path) - description` (the description, and its separator, are
 * ignored — only the link target is needed). Any line that isn't a markdown
 * link list item — headings, the leading `# Title`/`> summary` lines, prose —
 * is simply not a link line and is skipped.
 */
export function parseLlmsTxtLinks(text: string, baseUrl: string): URL[] {
  const links: URL[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^-\s*\[[^\]]*\]\(([^)\s]+)\)/);
    const href = match?.[1];
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(resolved);
  }
  return links;
}

/**
 * Probes `<origin>/llms.txt` and, if present, returns its parsed link list.
 * Reuses `fetchWebsiteResponse` so the manifest fetch itself gets the exact
 * same SSRF host guard, redirect handling, and (via `robots`) robots.txt
 * compliance as any other page fetch — this is still a fetch against a
 * user-supplied host, no different from the rest of the crawl.
 *
 * `llms-full.txt` (the single-file concatenation of every page) is
 * deliberately NOT read here. Its `## <path>` separators are ambiguous — page
 * content legitimately contains `##` headings too — so recovered page
 * boundaries can't be trusted, whereas per-page fetches through the existing
 * pipeline are cheap, bounded by this author-curated list, and produce
 * cleanly addressable assets. See the issue's "alternatives considered".
 */
async function fetchLlmsManifest(
  start: URL,
  robots: RobotsPolicy,
  options: { allowPrivateHosts?: boolean; signal?: AbortSignal },
): Promise<{ manifestUrl: string; links: URL[] } | null> {
  const manifestUrl = new URL("/llms.txt", start.origin).toString();
  const decision = await resolveCrawlRobotsDecision(robots, manifestUrl);
  if (!decision.allowed) return null;

  let fetched: WebsiteResponse;
  try {
    fetched = await fetchWebsiteResponse(decision.fetchUrl, 0, {
      allowPrivateHosts: options.allowPrivateHosts,
      signal: options.signal,
      robots,
    });
  } catch {
    return null;
  }
  if (!fetched.response.ok) {
    await fetched.response.body?.cancel().catch(() => undefined);
    return null;
  }

  let text: string;
  try {
    text = await readBodyWithByteCap(fetched.response, LLMS_TXT_BYTE_CAP, {
      bodyTimeoutMs: LLMS_TXT_BODY_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch {
    return null;
  }

  const links = parseLlmsTxtLinks(text, fetched.finalUrl);
  if (links.length === 0) return null;
  return { manifestUrl: fetched.finalUrl, links };
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

export function resolvePositiveInt(value: unknown, fallback: number, optionName: string): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new ConfigError(`Invalid value for ${optionName}: expected a positive integer, got ${JSON.stringify(value)}.`);
}

function looksLikeMarkup(body: string): boolean {
  return /<html[\s>]|<body[\s>]|<\/[a-z][\w:-]*>/i.test(body);
}

function plainTextToMarkdown(body: string): string {
  const inlineSafe = body
    .replace(/\r\n?/g, "\n")
    .replace(/([\\[\]`])/g, "\\$1")
    .replace(/<(?=[a-zA-Z/!?])/g, "&lt;");
  return escapeMarkdownStructure(inlineSafe).trim();
}

/** True for URL paths that are plainly binary assets, never crawlable pages. */
function isAssetLikePath(pathname: string): boolean {
  return /\.(css|js|json|png|jpe?g|gif|svg|ico|webp|pdf|zip|tar|gz|mp4|mp3|woff2?)$/i.test(pathname);
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

function safeCodePointToString(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return undefined;
  try {
    return String.fromCodePoint(value);
  } catch {
    return undefined;
  }
}

export {
  getWebsiteCachePaths,
  normalizeSiteUrl,
  shouldAllowPrivateWebsiteHostsForTests,
  shouldAllowPrivateWebsiteUrlForTests,
  validateWebsiteInputUrl,
  validateWebsiteUrl,
} from "../website-url";
// Re-exported for existing importers (the SSRF suite pins these entry points).
export { assertResolvedHostAllowed, type HostnameResolver } from "./host-guard";
