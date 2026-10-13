# Website Sources

`akm import <url>` and every other URL-based knowledge read path pass through
a pluggable fetcher seam before the built-in website scraper.

akm ships five built-in fetchers, probed in this order (host-specific
fetchers before the deliberately loose path-shaped RSS matcher; any fetcher
returning `null` falls through to the generic website crawler):

| Fetcher | Handles | What it extracts |
| --- | --- | --- |
| `github-repository` | `github.com/<owner>/<repo>` URLs | The repository README, rendered to markdown |
| `youtube-transcript` | YouTube watch/short URLs | The video description and transcript when captions are available |
| `bluesky-profile` | `bsky.app` profile URLs | Public profile and recent posts via the unauthenticated AT Protocol API |
| `x` | `x.com`/`twitter.com` profiles, posts, and articles | Post/article content; profile timelines need a bearer token (below) |
| `rss-feed` | Feed-shaped paths (`.rss`/`.atom`/`.xml`, `?feed=`) | Feed items as markdown sections |

## X credentials

The `x` fetcher reads public post/article pages without credentials. Profile
timelines require an API bearer token, resolved in order from the
`X_BEARER_TOKEN` environment variable, then the `secrets/x-bearer-token` akm
secret (`akm secret set secrets/x-bearer-token`). Alternatively, set `X_RSS_TEMPLATE`
to an RSS-bridge URL containing `{username}` to fetch profiles through the
`rss-feed` path instead.

## Crawl options

When no fetcher claims a URL, the generic crawler applies the `website`
source descriptor's knobs (see the config schema): `maxPages` (default 50),
`maxDepth` (default 3), `respectRobots` (default `true`; set `false` to
bypass robots.txt for that source), and `crawlTimeoutMs` per request.

## Why

Some sites need custom extraction logic that the generic HTML-to-markdown path
cannot provide well.

Examples:

- YouTube: fetch the transcript instead of the video description page chrome
- GitHub issues: fetch the issue body plus comments instead of the repository shell
- PDF-heavy sites: extract the underlying text instead of scraping an embed page

## Discovery

Drop fetcher modules into:

```text
<stashDir>/scripts/wiki-fetchers/
```

`<stashDir>` is the active bundle for the current operation. When a command has a
resolved write target (for example `akm import --bundle ...`), akm loads
fetchers from that target bundle before falling back to the built-in website
scraper.

Files ending in `.ts`, `.js`, or `.mjs` are loaded in alphabetical order.
The first fetcher whose `matches()` returns `true` gets a chance to handle the
URL.

If a fetcher:

- returns `null`, akm falls through to the next fetcher or the built-in website scraper
- throws, akm logs a warning and falls through to the next fetcher or the built-in website scraper

## Interface

Fetchers should export a default object with this shape:

```ts
export interface WikiSnapshotResult {
  url: string;
  title: string;
  markdown: string;
  preferredName?: string;
  tags?: string[];
}

export interface FetcherContext {
  stashDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Resolve a secret by ref (e.g. `secrets/x-bearer-token`) from akm's
   * secret store, or null when absent. Injected rather than imported so
   * fetchers stay leaves in the import graph; never log the returned value.
   */
  resolveSecret?: (ref: string) => string | null;
}

export interface WikiSnapshotFetcher {
  name: string;
  matches(url: URL, context: FetcherContext): boolean;
  fetch(url: URL, context: FetcherContext): Promise<WikiSnapshotResult | null>;
}
```

`markdown` should contain only the body content. akm still wraps the result in
the standard raw snapshot frontmatter (`name`, `description`, `sourceUrl`,
`title`, `updated`, a `lint_skip` entry for `stale-path`, and `tags`) so
downstream wiki tooling continues to work normally.

Custom `tags` are appended to the default snapshot tags (`website` and the
resolved hostname). They do not replace those defaults.

## Example

```ts
export default {
  name: "youtube-transcript",
  matches(url: URL, _context: FetcherContext) {
    return (
      (url.hostname === "www.youtube.com" && url.pathname === "/watch") ||
      url.hostname === "youtu.be"
    );
  },
  async fetch(url: URL, _context: FetcherContext) {
    const videoId = url.hostname === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v");
    if (!videoId) return null;

    const transcript = await getTranscript(videoId);
    return {
      url: url.toString(),
      title: `Video ${videoId}`,
      markdown: `## Transcript\n\n${transcript}`,
      preferredName: `videos/${videoId}`,
      tags: ["video", "transcript"],
    };
  },
};
```

## Notes

- The fetcher seam is shared by `akm import <url>` and other URL-based
  knowledge reads that use `fetchWebsiteMarkdownSnapshot()`.
- The built-in website scraper remains the default path when no custom fetcher
  matches.
- Bundle-local fetchers are loaded before built-ins, so you can override any
  built-in fetcher's behavior for your own workflow when needed.
