# Wiki Snapshot Fetchers

`akm import <url>` and every other URL-based knowledge read path pass through
a pluggable fetcher seam before the built-in website scraper.

akm currently ships one built-in fetcher: `youtube-transcript`, which extracts
the video description and transcript when captions are available.

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

`<stashDir>` is the active stash for the current operation. When a command has a
resolved write target (for example `akm import --target ...`), akm loads
fetchers from that target stash before falling back to the built-in website
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
}

export interface WikiSnapshotFetcher {
  name: string;
  matches(url: URL, context: FetcherContext): boolean;
  fetch(url: URL, context: FetcherContext): Promise<WikiSnapshotResult | null>;
}
```

`markdown` should contain only the body content. akm still wraps the result in
the standard raw snapshot frontmatter (`name`, `description`, `sourceUrl`,
`title`, `tags`) so downstream wiki tooling continues to work normally.

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
- Stash-local fetchers are loaded before built-ins, so you can override the
  built-in YouTube behavior for your own workflow when needed.
