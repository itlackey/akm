import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { ConfigError, UsageError } from "../../src/core/errors";
import { resolveSourceProviderFactory } from "../../src/sources/provider-factory";
import {
  ensureWebsiteMirror,
  fetchWebsiteMarkdownSnapshot,
  getWebsiteCachePaths,
  validateWebsiteInputUrl,
  validateWebsiteUrl,
} from "../../src/sources/website-ingest";

// Trigger self-registration
import "../../src/sources/providers/website";
import { createWiki } from "../../src/wiki/wiki";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  makeStashDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withMockedFetch,
  writeSandboxConfig,
} from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  cleanup = stashResult.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("WebsiteSourceProvider", () => {
  test("self-registers as 'website'", () => {
    expect(resolveSourceProviderFactory("website")).toBeTruthy();
  });

  test("provider exposes only the v1 SourceProvider surface (no search/show stubs)", () => {
    const factory = resolveSourceProviderFactory("website");
    expect(factory).toBeTruthy();
    if (!factory) throw new Error("expected website factory to be registered");
    const provider = factory({
      type: "website",
      url: "https://example.com/docs",
      name: "example",
    });

    expect(provider.kind).toBe("website");
    expect(provider.name).toBe("example");
    expect(typeof provider.path).toBe("function");
    expect(typeof provider.sync).toBe("function");
    expect((provider as unknown as { search?: unknown }).search).toBeUndefined();
    expect((provider as unknown as { show?: unknown }).show).toBeUndefined();
    expect((provider as unknown as { canShow?: unknown }).canShow).toBeUndefined();
  });

  test("path() returns the same value across calls (lifetime stability)", () => {
    const factory = resolveSourceProviderFactory("website");
    expect(factory).toBeTruthy();
    if (!factory) throw new Error("expected website factory to be registered");
    const provider = factory({
      type: "website",
      url: "https://example.com/docs",
      name: "example",
    });
    const first = provider.path();
    const second = provider.path();
    expect(second).toBe(first);
  });

  test("scrapes a website into cached markdown files", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example.test/") {
        return new Response(
          "<html><head><title>Docs Home</title></head><body><h1>Docs Home</h1><p>Welcome.</p><a href='/guide'>Guide</a></body></html>",
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      if (url === "https://docs.example.test/guide") {
        return new Response("<html><body><h1>Guide</h1><p>Install the tool safely.</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const entry = { type: "website", url: "https://docs.example.test/" } as const;
      const cachePaths = await ensureWebsiteMirror(entry, { requireStashDir: true });
      const topFiles = fs.readdirSync(path.join(cachePaths.stashDir, "knowledge")).sort();
      expect(topFiles).toEqual(["guide.md", "index.md"]);

      const homeDoc = fs.readFileSync(path.join(cachePaths.stashDir, "knowledge", "index.md"), "utf8");
      expect(homeDoc).toContain("# Docs Home");
      expect(homeDoc).toContain("Source: https://docs.example.test/");
      expect(homeDoc).toContain("[Guide](https://docs.example.test/guide)");

      const guideDoc = fs.readFileSync(path.join(cachePaths.stashDir, "knowledge", "guide.md"), "utf8");
      expect(guideDoc).toContain("# Guide");
      expect(guideDoc).toContain("Install the tool safely.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("validateWebsiteUrl rejects embedded credentials", () => {
    expect(() => validateWebsiteUrl("https://user:pass@example.com")).toThrow("embedded credentials");
  });

  test("CLI input validation throws UsageError while config validation throws ConfigError", () => {
    expect(() => validateWebsiteInputUrl("not a url")).toThrow(UsageError);
    expect(() => validateWebsiteUrl("not a url")).toThrow(ConfigError);
  });

  test("getWebsiteCachePaths is stable for normalized URLs", () => {
    const a = getWebsiteCachePaths("https://example.com/docs/");
    const b = getWebsiteCachePaths("https://example.com/docs");
    expect(a.rootDir).toBe(b.rootDir);
  });

  test("fetchWebsiteMarkdownSnapshot fetches one page and derives a URL-path name", async () => {
    await withMockedFetch(
      async () => {
        const snapshot = await fetchWebsiteMarkdownSnapshot("https://docs.example.test/guide/getting-started");
        expect(snapshot.url).toBe("https://docs.example.test/guide/getting-started");
        expect(snapshot.preferredName).toBe("guide/getting-started");
        expect(snapshot.title).toBe("Getting Started");
        expect(snapshot.content).toContain('sourceUrl: "https://docs.example.test/guide/getting-started"');
        expect(snapshot.content).toContain("# Getting Started");
      },
      (url) => {
        if (url === "https://docs.example.test/guide/getting-started") {
          return new Response(
            "<html><head><title>Getting Started</title></head><body><h1>Getting Started</h1><p>Run setup first.</p></body></html>",
            {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
  });

  test("fetchWebsiteMarkdownSnapshot uses a matching custom fetcher before the default website fetch", async () => {
    const fetcherDir = path.join(process.env.AKM_STASH_DIR ?? "", "scripts", "wiki-fetchers");
    fs.mkdirSync(fetcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(fetcherDir, "youtube.ts"),
      [
        "export default {",
        '  name: "youtube-transcript",',
        '  matches(url) { return url.hostname === "video.example.test"; },',
        "  async fetch(url) {",
        "    return {",
        "      url: url.toString(),",
        '      title: "Transcript Title",',
        '      markdown: "## Transcript\\n\\nHello from transcript.",',
        '      preferredName: "videos/transcript-title",',
        '      tags: ["video", "transcript"],',
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await withMockedFetch(
      async () => {
        const snapshot = await fetchWebsiteMarkdownSnapshot("https://video.example.test/watch?v=abc123");
        expect(snapshot.title).toBe("Transcript Title");
        expect(snapshot.preferredName).toBe("videos/transcript-title");
        expect(snapshot.content).toContain("## Transcript");
        expect(snapshot.content).toContain('  - "website"');
        expect(snapshot.content).toContain('  - "video.example.test"');
        expect(snapshot.content).toContain('  - "video"');
        expect(snapshot.content).toContain('  - "transcript"');
      },
      (_url) => {
        throw new Error("default fetch should not run when a custom fetcher handles the URL");
      },
    );
  });

  test("fetchWebsiteMarkdownSnapshot falls through to the default website fetch when a custom fetcher returns null", async () => {
    const fetcherDir = path.join(process.env.AKM_STASH_DIR ?? "", "scripts", "wiki-fetchers");
    fs.mkdirSync(fetcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(fetcherDir, "null-fetcher.ts"),
      [
        "export default {",
        '  name: "null-fetcher",',
        '  matches(url) { return url.hostname === "docs.example.test"; },',
        "  async fetch() { return null; },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await withMockedFetch(
      async () => {
        const snapshot = await fetchWebsiteMarkdownSnapshot("https://docs.example.test/fallback");
        expect(snapshot.title).toBe("Fallback");
        expect(snapshot.content).toContain("# Fallback");
      },
      (url) => {
        if (url === "https://docs.example.test/fallback") {
          return new Response("<html><head><title>Fallback</title></head><body><p>default path</p></body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
  });

  test("fetchWebsiteMarkdownSnapshot falls through to the default website fetch when a custom fetcher throws", async () => {
    const fetcherDir = path.join(process.env.AKM_STASH_DIR ?? "", "scripts", "wiki-fetchers");
    fs.mkdirSync(fetcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(fetcherDir, "throwing-fetcher.ts"),
      [
        "export default {",
        '  name: "throwing-fetcher",',
        '  matches(url) { return url.hostname === "docs.example.test"; },',
        '  async fetch() { throw new Error("boom"); },',
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await withMockedFetch(
      async () => {
        const snapshot = await fetchWebsiteMarkdownSnapshot("https://docs.example.test/throws");
        expect(snapshot.title).toBe("Recovered");
        expect(snapshot.content).toContain("# Recovered");
      },
      (url) => {
        if (url === "https://docs.example.test/throws") {
          return new Response("<html><head><title>Recovered</title></head><body><p>default path</p></body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
  });

  test("fetchWebsiteMarkdownSnapshot falls through to the default website fetch when fetcher.matches throws", async () => {
    const fetcherDir = path.join(process.env.AKM_STASH_DIR ?? "", "scripts", "wiki-fetchers");
    fs.mkdirSync(fetcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(fetcherDir, "throwing-matches-fetcher.ts"),
      [
        "export default {",
        '  name: "throwing-matches-fetcher",',
        '  matches() { throw new Error("boom"); },',
        "  async fetch() { return null; },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await withMockedFetch(
      async () => {
        const snapshot = await fetchWebsiteMarkdownSnapshot("https://docs.example.test/matches-throws");
        expect(snapshot.title).toBe("Matches Recovered");
        expect(snapshot.content).toContain("# Matches Recovered");
      },
      (url) => {
        if (url === "https://docs.example.test/matches-throws") {
          return new Response(
            "<html><head><title>Matches Recovered</title></head><body><p>default path</p></body></html>",
            {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
  });

  test("wiki stash --target resolves custom fetchers from the target stash", async () => {
    const targetStash = makeStashDir();
    const priorCleanup = cleanup;
    cleanup = () => {
      targetStash.cleanup();
      priorCleanup();
    };

    writeSandboxConfig({
      sources: [
        {
          name: "target",
          type: "filesystem",
          path: targetStash.dir,
          writable: true,
        },
      ],
    });

    createWiki(targetStash.dir, "articles");

    const defaultFetcherDir = path.join(process.env.AKM_STASH_DIR ?? "", "scripts", "wiki-fetchers");
    fs.mkdirSync(defaultFetcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultFetcherDir, "default-fetcher.ts"),
      [
        "export default {",
        '  name: "default-fetcher",',
        '  matches(url) { return url.hostname === "video.example.test"; },',
        '  async fetch(url) { return { url: url.toString(), title: "Wrong Fetcher", markdown: "wrong" }; },',
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const targetFetcherDir = path.join(targetStash.dir, "scripts", "wiki-fetchers");
    fs.mkdirSync(targetFetcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetFetcherDir, "target-fetcher.ts"),
      [
        "export default {",
        '  name: "target-fetcher",',
        '  matches(url) { return url.hostname === "video.example.test"; },',
        '  async fetch(url) { return { url: url.toString(), title: "Target Fetcher", markdown: "target body" }; },',
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await withMockedFetch(
      async () => {
        const result = await runCliCapture([
          "wiki",
          "stash",
          "articles",
          "https://video.example.test/watch?v=abc123",
          "--target",
          "target",
          "--format",
          "json",
        ]);

        expect(result.code).toBe(0);
        const rawFiles = fs.readdirSync(path.join(targetStash.dir, "wikis", "articles", "raw"));
        expect(rawFiles.some((name) => name.endsWith(".md"))).toBe(true);
        const rawDoc = fs.readFileSync(
          path.join(targetStash.dir, "wikis", "articles", "raw", rawFiles.find((name) => name.endsWith(".md")) ?? ""),
          "utf8",
        );
        expect(rawDoc).toContain("# Target Fetcher");
        expect(rawDoc).not.toContain("Wrong Fetcher");
      },
      (_url) => {
        throw new Error("default website fetch should not run when the target stash provides a custom fetcher");
      },
    );
  });
});
