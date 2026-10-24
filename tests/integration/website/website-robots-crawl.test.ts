// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1 — robots.txt compliance: loopback-fixture crawl integration tests.
 *
 * Authoritative spec: docs/plans/specs/p1-robots.md §4.6/§4.7. Row IDs in test
 * names (C-xx) refer to that spec's crawl-behavior table.
 *
 * Follows the fixture patterns in add-website-source.test.ts (Bun.serve
 * loopback fixture) and website-ssrf.test.ts (no real network, private-host
 * hatch). `ensureWebsiteMirror` is called in-process (as in
 * tests/integration/source-source.test.ts) rather than spawning the CLI, and
 * loopback hosts are allowed via the `allowPrivateHosts` test escape hatch
 * (never a raw `globalThis.fetch` swap or CLI network — the fixture server IS
 * the network boundary).
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { SourceConfigEntry } from "../../../src/core/config/config";
import { UsageError } from "../../../src/core/errors";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { ensureWebsiteMirror, getWebsiteCachePaths } from "../../../src/sources/snapshot-fetchers/website-ingest";
import { overrideSeam } from "../../_helpers/seams";

// ── Fixture server ───────────────────────────────────────────────────────────

interface FixtureRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

interface RequestRecord {
  pathname: string;
  at: number;
}

interface FixtureServer {
  url: string;
  requestLog: RequestRecord[];
}

const servers: Array<{ stop: (force: boolean) => void }> = [];
const cacheRoots: string[] = [];

function startFixtureServer(opts: {
  robots: FixtureRoute | null;
  pages: Record<string, string | FixtureRoute>;
}): FixtureServer {
  const requestLog: RequestRecord[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requestLog.push({ pathname: url.pathname, at: Date.now() });

      if (url.pathname === "/robots.txt") {
        if (!opts.robots) return new Response("not found", { status: 404 });
        return new Response(opts.robots.body ?? "", {
          status: opts.robots.status ?? 200,
          headers: { "content-type": "text/plain", ...(opts.robots.headers ?? {}) },
        });
      }

      const page = opts.pages[url.pathname];
      if (page === undefined) return new Response("not found", { status: 404 });
      const route: FixtureRoute = typeof page === "string" ? { body: page } : page;
      return new Response(route.body ?? "", {
        status: route.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8", ...(route.headers ?? {}) },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requestLog };
}

/** Builds the minimal SourceConfigEntry shape ensureWebsiteMirror() reads. */
function websiteEntry(url: string, options?: Record<string, unknown>): SourceConfigEntry {
  return { type: "website", url, options } as SourceConfigEntry;
}

/**
 * True when some crawled page's own `sourceUrl:` frontmatter is `sourceUrl`.
 * Matches the exact frontmatter line (not just "the text appears somewhere"):
 * a page that merely LINKS to a disallowed URL renders that URL into its own
 * markdown body (see htmlToMarkdown's anchor handling), so a plain substring
 * search would false-positive on "the disallowed page was never crawled, but
 * another page mentions it."
 *
 * Recurses into subdirectories: a multi-segment path like `/docs/guide`
 * lands on `knowledge/docs/guide.md` (see `urlToRelativePath`), not directly
 * under `knowledgeDir`.
 */
function stashContainsSourceUrl(stashDir: string, sourceUrl: string): boolean {
  const knowledgeDir = path.join(stashDir, "knowledge");
  if (!fs.existsSync(knowledgeDir)) return false;
  const frontmatterLine = `sourceUrl: ${JSON.stringify(sourceUrl)}`;

  function walk(dir: string): boolean {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(entryPath)) return true;
      } else if (entry.name.endsWith(".md") && fs.readFileSync(entryPath, "utf8").includes(frontmatterLine)) {
        return true;
      }
    }
    return false;
  }

  return walk(knowledgeDir);
}

/** Tracks a website cache root (keyed by URL) so afterEach can remove it. */
function trackCache(url: string): void {
  cacheRoots.push(getWebsiteCachePaths(url).rootDir);
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of cacheRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── §4.6 crawlWebsite integration (via ensureWebsiteMirror) ─────────────────

describe("crawlWebsite robots.txt compliance", () => {
  test("C-02: a disallowed start URL throws UsageError before fetching any page", async () => {
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /\n" },
      pages: { "/": "<html><body>Home</body></html>" },
    });
    trackCache(url);
    const normalizedUrl = `${url}/`;
    const robotsUrl = `${url}/robots.txt`;

    let caught: unknown;
    try {
      await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UsageError);
    const message = (caught as Error).message;
    expect(message).toContain(normalizedUrl);
    expect(message).toContain(robotsUrl);
    expect(message).toMatch(/respectRobots/);

    // No page was fetched — only /robots.txt.
    expect(requestLog.some((r) => r.pathname === "/")).toBe(false);
  });

  test(
    "C-02: a trailing-slash start URL is rejected even though normalizeSiteUrl strips the slash before the " +
      "robots check sees it",
    async () => {
      // Regression: validateWebsiteUrl -> normalizeSiteUrl strips the start
      // URL's trailing slash before assertStartUrlAllowedByRobots ever sees
      // it, so a start URL typed as `/secret/` under `Disallow: /secret/`
      // never matched that rule (the rule requires a literal trailing `/` in
      // the target) and the disallowed start page was fetched instead of
      // being rejected.
      const { url, requestLog } = startFixtureServer({
        robots: { body: "User-agent: *\nDisallow: /secret/\n" },
        pages: { "/secret": "<html><body>Secret content</body></html>" },
      });
      const startUrl = `${url}/secret/`;
      trackCache(startUrl);

      let caught: unknown;
      try {
        await ensureWebsiteMirror(websiteEntry(startUrl), { allowPrivateHosts: true });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(UsageError);
      expect((caught as Error).message).toMatch(/respectRobots/);
      // The disallowed start page must never have been fetched — only
      // /robots.txt.
      expect(requestLog.map((r) => r.pathname)).toEqual(["/robots.txt"]);
    },
  );

  test("C-03: a 5xx robots.txt on the start origin no longer blocks the crawl", async () => {
    const { url, requestLog } = startFixtureServer({
      robots: { status: 500, body: "boom" },
      pages: { "/": "<html><body>Home</body></html>" },
    });
    trackCache(url);

    await expect(ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true })).resolves.toBeDefined();
    expect(requestLog.some((r) => r.pathname === "/robots.txt")).toBe(true);
    expect(requestLog.some((r) => r.pathname === "/")).toBe(true);
  });

  test(
    "C-04/C-05/C-06: default respectRobots skips a disallowed page without fetching it and reads robots.txt " +
      "once; respectRobots:false fully bypasses it",
    async () => {
      const { url, requestLog } = startFixtureServer({
        robots: { body: "User-agent: *\nDisallow: /secret\n" },
        pages: {
          "/": '<html><body><a href="/secret">Secret</a> <a href="/public">Public</a></body></html>',
          "/secret": "<html><body>Secret content</body></html>",
          "/public": "<html><body>Public content</body></html>",
        },
      });
      trackCache(url);
      const secretUrl = `${url}/secret`;
      const publicUrl = `${url}/public`;

      const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

      // C-04: disallowed page is skipped without erroring, and never fetched.
      expect(stashContainsSourceUrl(cachePaths.stashDir, secretUrl)).toBe(false);
      expect(stashContainsSourceUrl(cachePaths.stashDir, publicUrl)).toBe(true);
      expect(requestLog.some((r) => r.pathname === "/secret")).toBe(false);

      // C-06: exactly one robots.txt request for the whole crawl.
      expect(requestLog.filter((r) => r.pathname === "/robots.txt")).toHaveLength(1);
      const robotsRequestsBeforeBypass = requestLog.filter((r) => r.pathname === "/robots.txt").length;

      // C-05: respectRobots:false is a full bypass — force a re-crawl of the
      // same origin (same cache key) and confirm it now includes the
      // previously-disallowed page, with zero additional /robots.txt requests.
      await ensureWebsiteMirror(websiteEntry(url, { respectRobots: false }), {
        allowPrivateHosts: true,
        force: true,
      });

      expect(stashContainsSourceUrl(cachePaths.stashDir, secretUrl)).toBe(true);
      const robotsRequestsAfterBypass = requestLog.filter((r) => r.pathname === "/robots.txt").length;
      expect(robotsRequestsAfterBypass).toBe(robotsRequestsBeforeBypass);
    },
  );

  test("C-04: a Disallow: /dir/ rule is honored for a discovered /dir/ link even with no redirect involved", async () => {
    // Regression: normalizeCrawlUrl strips a link's trailing slash before
    // the robots gate runs, so `Disallow: /secret/` never matched the
    // slash-less alias `/secret` the gate actually checked — even when the
    // server serves `/secret` directly with 200 and no redirect is ever
    // involved. The 9d7581f post-redirect re-check only closed the 301
    // variant of this gap.
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /secret/\n" },
      pages: {
        "/": '<html><body><a href="/secret/">Secret</a> <a href="/public">Public</a></body></html>',
        "/secret": "<html><body>Secret content</body></html>",
        "/secret/": "<html><body>Secret content</body></html>",
        "/public": "<html><body>Public content</body></html>",
      },
    });
    trackCache(url);
    const secretUrl = `${url}/secret`;
    const publicUrl = `${url}/public`;

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

    expect(stashContainsSourceUrl(cachePaths.stashDir, secretUrl)).toBe(false);
    expect(stashContainsSourceUrl(cachePaths.stashDir, `${secretUrl}/`)).toBe(false);
    expect(stashContainsSourceUrl(cachePaths.stashDir, publicUrl)).toBe(true);
    // /secret must never be requested at all.
    expect(requestLog.some((r) => r.pathname === "/secret")).toBe(false);
    // /llms.txt is probed first (issue #749); this fixture has none (404),
    // so the crawl falls through to normal BFS unchanged.
    expect(requestLog.map((r) => r.pathname)).toEqual(["/robots.txt", "/llms.txt", "/", "/public"]);
  });

  test("C-04: a redirect that lands on a disallowed URL is skipped, not fetched into the stash", async () => {
    // Regression: normalizeCrawlUrl strips trailing slashes before the
    // initial robots gate, so `Disallow: /secret/` correctly lets `/secret`
    // through that gate. If the server then redirects `/secret` -> `/secret/`
    // (an extremely common trailing-slash canonicalization), the redirect
    // target must be re-checked against robots.txt BEFORE it is fetched — not
    // merely re-checked after the fact to decide whether to store the body.
    // (Earlier, this check ran only after the fetch, so the disallowed URL
    // was still requested over the network; it is now gated before the
    // recursive fetch in `fetchWebsiteResponse`, so no request reaches it.)
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /secret/\n" },
      pages: {
        "/": '<html><body><a href="/secret">Secret</a> <a href="/public">Public</a></body></html>',
        "/secret": { status: 301, headers: { location: "/secret/" } },
        "/secret/": "<html><body>Secret content</body></html>",
        "/public": "<html><body>Public content</body></html>",
      },
    });
    trackCache(url);
    const secretUrl = `${url}/secret/`;
    const publicUrl = `${url}/public`;

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

    expect(stashContainsSourceUrl(cachePaths.stashDir, secretUrl)).toBe(false);
    expect(stashContainsSourceUrl(cachePaths.stashDir, publicUrl)).toBe(true);
    // The redirect hop (/secret) is still requested — it passed the initial
    // gate — but the disallowed redirect TARGET must never be requested at
    // all, not merely never stored.
    expect(requestLog.some((r) => r.pathname === "/secret")).toBe(true);
    expect(requestLog.some((r) => r.pathname === "/secret/")).toBe(false);
  });

  test("C-04: an allowed URL that redirects to a disallowed URL is skipped", async () => {
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /secret\n" },
      pages: {
        "/": '<html><body><a href="/go">Go</a></body></html>',
        "/go": { status: 302, headers: { location: "/secret" } },
        "/secret": "<html><body>Secret content</body></html>",
      },
    });
    trackCache(url);
    const secretUrl = `${url}/secret`;

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

    expect(stashContainsSourceUrl(cachePaths.stashDir, secretUrl)).toBe(false);
    expect(requestLog.some((r) => r.pathname === "/go")).toBe(true);
  });

  test("C-04: an intermediate redirect hop landing on a disallowed URL is never requested", async () => {
    // Regression: fetchWebsiteResponse only robots-checked the pre-redirect
    // queue URL (crawlWebsite's gate) and the FINAL post-redirect URL
    // (fetchWebsitePage's recheck above). Every hop strictly BETWEEN those
    // two was fetched with no robots gate at all. Chain: /go -> 302
    // /secret/ -> 302 /public. /secret/ is disallowed but is neither the
    // queue URL (/go) nor the final URL (/public), so it slipped through
    // both existing checks and got a live GET issued to it.
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /secret/\n" },
      pages: {
        "/": '<html><body><a href="/go">Go</a></body></html>',
        "/go": { status: 302, headers: { location: "/secret/" } },
        "/secret/": { status: 302, headers: { location: "/public" } },
        "/public": "<html><body>Public content</body></html>",
      },
    });
    trackCache(url);
    const publicUrl = `${url}/public`;

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

    // The disallowed intermediate hop must never be requested, and the
    // chain it would have led to must never land in the stash.
    expect(requestLog.some((r) => r.pathname === "/secret/")).toBe(false);
    expect(stashContainsSourceUrl(cachePaths.stashDir, publicUrl)).toBe(false);
  });

  test("C-04: a start URL disallowed only when normalized crawls under its raw Allow-matching form", async () => {
    // Regression: normalizeSiteUrl strips a start URL's trailing slash
    // before the robots check ever sees it, so the canonical
    // "Disallow: / \n Allow: /docs/" layout — which requires that trailing
    // slash to match the Allow rule — rejected a start URL the site owner
    // explicitly opened to crawlers, throwing UsageError and naming a URL
    // (".../docs") the user never supplied.
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /\nAllow: /docs/\n" },
      pages: {
        "/docs": "<html><body>Should not be fetched</body></html>",
        "/docs/": "<html><body>Docs index</body></html>",
      },
    });
    const startUrl = `${url}/docs/`;
    trackCache(startUrl);

    const cachePaths = await ensureWebsiteMirror(websiteEntry(startUrl), { allowPrivateHosts: true });

    // Crawled via the raw (slash-intact) form that actually matches the
    // Allow rule, not the normalized alias that only matches Disallow: /.
    // The stored sourceUrl is still the normalized (slash-stripped) form —
    // only the literal URL *requested* over the network changes.
    expect(stashContainsSourceUrl(cachePaths.stashDir, `${url}/docs`)).toBe(true);
    expect(requestLog.map((r) => r.pathname)).toEqual(["/robots.txt", "/docs/"]);
  });

  test("C-04: a discovered link disallowed only when normalized is fetched under its raw Allow-matching form", async () => {
    // Regression: the crawlWebsite queue gate ANDed isAllowed(normalized)
    // with isAllowed(raw) and always fetched the normalized (slash-stripped)
    // form. Under "Disallow: / \n Allow: /docs/", a discovered <a
    // href="/docs/"> link normalizes to "/docs", which only matches
    // Disallow: / (Allow: /docs/ requires the trailing slash) — so the
    // section index was skipped and NEVER requested, even though the site
    // owner opened exactly that path to crawlers.
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /\nAllow: /docs/\nAllow: /$\n" },
      pages: {
        "/": '<html><body><a href="/docs/">Docs</a> <a href="/docs/guide">Guide</a></body></html>',
        "/docs": "<html><body>Should not be fetched</body></html>",
        "/docs/": "<html><body>Docs index</body></html>",
        "/docs/guide": "<html><body>Guide</body></html>",
      },
    });
    trackCache(url);

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

    // The stored sourceUrl is the normalized (slash-stripped) form — only
    // the literal URL *requested* over the network is the raw, Allow-matching
    // one (asserted below).
    expect(stashContainsSourceUrl(cachePaths.stashDir, `${url}/docs`)).toBe(true);
    expect(stashContainsSourceUrl(cachePaths.stashDir, `${url}/docs/guide`)).toBe(true);
    // /docs (no trailing slash) must never be requested — only its
    // Allow-matching raw form /docs/.
    expect(requestLog.some((r) => r.pathname === "/docs")).toBe(false);
    expect(requestLog.some((r) => r.pathname === "/docs/")).toBe(true);
  });

  test(
    "percent-encoding regression: a link written as an unreserved percent-encoded alias of a disallowed " +
      "path is never requested",
    async () => {
      // Regression: the match target was built from URL.pathname, which
      // preserves %-escapes verbatim, so `Disallow: /secret/` never matched
      // a link written as `/%73ecret/` (`%73` decodes to the unreserved
      // byte `s`) and the disallowed page was fetched and stored.
      const { url, requestLog } = startFixtureServer({
        robots: { body: "User-agent: *\nDisallow: /secret/\n" },
        pages: {
          "/": '<html><body><a href="/%73ecret/">Secret</a> <a href="/public">Public</a></body></html>',
          "/secret/": "<html><body>Secret content</body></html>",
          "/public": "<html><body>Public content</body></html>",
        },
      });
      trackCache(url);
      const publicUrl = `${url}/public`;

      const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

      expect(stashContainsSourceUrl(cachePaths.stashDir, publicUrl)).toBe(true);
      // The percent-encoded alias must never be requested at all — not
      // decoded-and-skipped, not stored under any form.
      expect(requestLog.some((r) => r.pathname === "/%73ecret/")).toBe(false);
      expect(requestLog.some((r) => r.pathname === "/secret/")).toBe(false);
    },
  );

  test(
    "non-http(s) redirect regression: an intermediate redirect Location with a non-http(s) scheme is refused " +
      "without aborting the crawl, and the remaining pages are still collected",
    async () => {
      // Regression (a67412c): the intermediate-redirect robots gate computed
      // `normalizeCrawlUrl(nextUrl) ?? nextUrl`, falling back to the raw
      // redirect target whenever it wasn't an http(s) URL (e.g. a `mailto:`
      // Location) and handing that opaque-origin URL straight to
      // `RobotsPolicy.rulesFor()`. `rulesFor` resolves `/robots.txt` against
      // `new URL(url).origin` — the literal string `"null"` for a
      // non-http(s) URL — which throws an unhandled TypeError ("Invalid
      // base URL") that aborted the ENTIRE crawl, not just that one hop.
      const { url, requestLog } = startFixtureServer({
        robots: { body: "User-agent: *\n" }, // allow everything
        pages: {
          "/": '<html><body><a href="/go">Go</a> <a href="/public">Public</a></body></html>',
          "/go": { status: 302, headers: { location: "mailto:nobody@example.test" } },
          "/public": "<html><body>Public content</body></html>",
        },
      });
      trackCache(url);
      const publicUrl = `${url}/public`;

      // Must resolve, not throw/reject — the whole point of the fix.
      const cachePaths = await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

      // The redirect hop itself is still requested (it passed the initial
      // gate as an ordinary http(s) URL)...
      expect(requestLog.some((r) => r.pathname === "/go")).toBe(true);
      // ...but the crawl completes and collects the unrelated remaining page.
      expect(stashContainsSourceUrl(cachePaths.stashDir, publicUrl)).toBe(true);
    },
  );

  test("C-06: robots.txt is fetched exactly once per origin no matter how many pages are crawled", async () => {
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\n" }, // no Disallow lines => allow everything
      pages: {
        "/": '<html><body><a href="/page-1">1</a> <a href="/page-2">2</a> <a href="/page-3">3</a></body></html>',
        "/page-1": "<html><body>Page 1</body></html>",
        "/page-2": "<html><body>Page 2</body></html>",
        "/page-3": "<html><body>Page 3</body></html>",
      },
    });
    trackCache(url);

    await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

    expect(requestLog.filter((r) => r.pathname === "/robots.txt")).toHaveLength(1);
    for (const p of ["/page-1", "/page-2", "/page-3"]) {
      expect(requestLog.filter((r) => r.pathname === p)).toHaveLength(1);
    }
  });

  test(
    "C-07/C-09: Crawl-delay spaces page fetches apart but does not delay the first fetch",
    async () => {
      const { url, requestLog } = startFixtureServer({
        // 150ms: small enough to keep the test fast, well above scheduler jitter.
        robots: { body: "User-agent: *\nCrawl-delay: 0.15\n" },
        pages: {
          "/": '<html><body><a href="/page-2">2</a></body></html>',
          "/page-2": "<html><body>Page 2</body></html>",
        },
      });
      trackCache(url);

      await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

      const pageHits = requestLog.filter((r) => r.pathname === "/" || r.pathname === "/page-2");
      const [firstHit, secondHit] = pageHits;
      if (!firstHit || !secondHit) {
        throw new Error(`expected exactly 2 page fetches, got ${pageHits.length}`);
      }
      const gapMs = secondHit.at - firstHit.at;
      expect(gapMs).toBeGreaterThanOrEqual(100);
    },
    { timeout: 15_000 },
  );

  test(
    "C-10: a Crawl-delay that would cross the wall-clock deadline defers the URL and reports it unfetched, never sleeping past the cap",
    async () => {
      const warnCalls: string[] = [];
      overrideSeam(_setWarnSinkForTests, (level, args) => {
        if (level !== "warn") return;
        warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });

      const { url, requestLog } = startFixtureServer({
        // 5s Crawl-delay: deliberately far larger than the injected wall-clock
        // cap below, so honoring it verbatim would blow straight through the
        // deadline.
        robots: { body: "User-agent: *\nCrawl-delay: 5\n" },
        pages: {
          "/": '<html><body><a href="/page-2">2</a></body></html>',
          "/page-2": "<html><body>Page 2</body></html>",
        },
      });
      trackCache(url);

      // wallClockCapMs is a test-only seam (mirrors allowPrivateHosts): the
      // real wall-clock cap is a hardcoded 10 minutes, which makes this
      // deadline-boundary behavior untestable at reasonable cost without it.
      //
      // The 2s test-level timeout below (far under the 5s Crawl-delay) IS the
      // time-budget assertion: it fails the test if the crawl actually sleeps
      // the delay in full instead of noticing upfront that doing so would
      // cross the deadline and breaking. This uses bun's own per-test
      // `timeout` rather than a manual `Date.now()` delta assertion, which
      // `scripts/lint-tests-isolation.ts` bans as flake-prone.
      const cachePaths = await ensureWebsiteMirror(websiteEntry(url), {
        allowPrivateHosts: true,
        wallClockCapMs: 400,
      });

      // The first (undelayed) page still made it into the stash...
      expect(stashContainsSourceUrl(cachePaths.stashDir, `${url}/`)).toBe(true);
      // ...but the delay-gated second page was never even fetched.
      expect(requestLog.some((r) => r.pathname === "/page-2")).toBe(false);
      // A URL whose Crawl-delay does not fit the remaining budget is now
      // deferred to the back of the queue rather than ending the crawl, and
      // is reported as unfetched once its deferral budget is spent — so a
      // rate-limited origin is visible instead of silently missing.
      expect(warnCalls.some((m) => /were not fetched/i.test(m))).toBe(true);
      expect(warnCalls.some((m) => m.includes("/page-2"))).toBe(true);
    },
    { timeout: 2_000 },
  );

  test(
    "C-11: a robots-skipped URL between two allowed pages does not add an extra delay-sized gap",
    async () => {
      const { url, requestLog } = startFixtureServer({
        // 200ms: large enough that "one interval" (~200ms) and "two
        // intervals" (~400ms, the bug this guards against — the skipped
        // /secret URL incorrectly consuming a slot in the delay-pacing
        // counter) are unambiguous even under CI jitter.
        robots: { body: "User-agent: *\nDisallow: /secret\nCrawl-delay: 0.2\n" },
        pages: {
          "/": '<html><body><a href="/secret">Secret</a> <a href="/page-2">2</a></body></html>',
          "/secret": "<html><body>Secret content</body></html>",
          "/page-2": "<html><body>Page 2</body></html>",
        },
      });
      trackCache(url);

      await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

      // The disallowed page between the two allowed ones must never be fetched.
      expect(requestLog.some((r) => r.pathname === "/secret")).toBe(false);

      const pageHits = requestLog.filter((r) => r.pathname === "/" || r.pathname === "/page-2");
      const [firstHit, secondHit] = pageHits;
      if (!firstHit || !secondHit) {
        throw new Error(`expected exactly 2 allowed-page fetches, got ${pageHits.length}`);
      }
      const gapMs = secondHit.at - firstHit.at;
      // One crawl-delay interval (~200ms), not two: the fetch-attempt counter
      // used for delay pacing must not increment on a robots-skipped URL
      // (spec §4.6 C-11).
      expect(gapMs).toBeGreaterThanOrEqual(150);
      expect(gapMs).toBeLessThan(350);
    },
    { timeout: 15_000 },
  );
});

describe("robots alias coverage (codex review)", () => {
  test("a disallowed alias does not suppress the allowed one discovered later", async () => {
    // `/docs/` and `/docs` share a normalized key but get different verdicts
    // (a `Disallow: /docs/` rule matches only the trailing-slash form).
    // Marking that key visited BEFORE the robots decision let whichever alias
    // was discovered first — and rejected — permanently hide the allowed one,
    // making coverage depend on link order.
    const { url, requestLog } = startFixtureServer({
      robots: { body: "User-agent: *\nDisallow: /docs/\n" },
      pages: {
        "/": '<html><body><a href="/docs/">slash first</a><a href="/docs">bare second</a></body></html>',
        "/docs": "<html><body><main>allowed bare form</main></body></html>",
        "/docs/": "<html><body><main>disallowed slash form</main></body></html>",
      },
    });
    trackCache(url);

    await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true });

    // The disallowed trailing-slash form is never requested...
    expect(requestLog.some((r) => r.pathname === "/docs/")).toBe(false);
    // ...but the allowed bare form is still crawled despite being discovered
    // second and sharing a normalized key with the rejected alias.
    expect(requestLog.some((r) => r.pathname === "/docs")).toBe(true);
  });
});

describe("crawlTimeoutMs: hard process cap", () => {
  test(
    "a huge Retry-After on /robots.txt cannot outlast the cap",
    async () => {
      // Before this, fetchWithRetry honoured Retry-After with a bare
      // setTimeout that ignored any signal, and the crawl deadline was only
      // consulted between queue iterations — so a single 429 could park
      // `bundle add` for as long as the server asked (hours), regardless of
      // the advertised wall-clock cap.
      const { url } = startFixtureServer({
        robots: { body: "", status: 429, headers: { "retry-after": "3600" } },
        pages: { "/": "<html><body><main>Home</main></body></html>" },
      });
      trackCache(url);

      // The 3s per-test timeout IS the assertion: if the cap were still soft,
      // this would sit in the Retry-After sleep for an hour.
      let caught: unknown;
      try {
        await ensureWebsiteMirror(websiteEntry(url), { allowPrivateHosts: true, wallClockCapMs: 300 });
      } catch (err) {
        caught = err;
      }
      // Either outcome is acceptable — what matters is that it RETURNED.
      expect(caught === undefined || caught instanceof Error).toBe(true);
    },
    { timeout: 3_000 },
  );

  test("crawlTimeoutMs: 0 disables the cap and the crawl still completes normally", async () => {
    const { url } = startFixtureServer({
      robots: null,
      pages: {
        "/": '<html><body><main>Home</main><a href="/b">b</a></body></html>',
        "/b": "<html><body><main>Page B</main></body></html>",
      },
    });
    trackCache(url);

    const cachePaths = await ensureWebsiteMirror(websiteEntry(url, { crawlTimeoutMs: 0 }), {
      allowPrivateHosts: true,
    });
    expect(stashContainsSourceUrl(cachePaths.stashDir, `${url}/`)).toBe(true);
    expect(stashContainsSourceUrl(cachePaths.stashDir, `${url}/b`)).toBe(true);
  });

  test("an explicit crawlTimeoutMs is honored over the default", async () => {
    const { url } = startFixtureServer({
      robots: { body: "", status: 429, headers: { "retry-after": "3600" } },
      pages: { "/": "<html><body><main>Home</main></body></html>" },
    });
    trackCache(url);

    let caught: unknown;
    try {
      await ensureWebsiteMirror(websiteEntry(url, { crawlTimeoutMs: 300 }), { allowPrivateHosts: true });
    } catch (err) {
      caught = err;
    }
    expect(caught === undefined || caught instanceof Error).toBe(true);
  }, 3_000);
});
