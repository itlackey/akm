// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import githubFetcher, { extractGithubRepository } from "../src/sources/snapshot-fetchers/github";
import type { FetcherContext } from "../src/sources/snapshot-fetchers/types";
import { ensureWebsiteMirror, fetchWebsiteMarkdownSnapshot } from "../src/sources/snapshot-fetchers/website-ingest";
import { makeStashDir, withBundle, withEnv, withMockedFetch } from "./_helpers/sandbox";

const CTX: FetcherContext = { stashDir: "", timeoutMs: 5_000, allowPrivateHosts: true };
const README_HTML = `<div id="readme" class="md" data-path="README.md">
  <article class="markdown-body entry-content">
    <h1>AirLLM</h1>
    <p>Run large language models in a single GPU.</p>
    <img src="assets/logo.png" alt="Logo">
    <table><thead><tr><th>Model</th><th>Memory</th></tr></thead>
      <tbody><tr><td>70B</td><td>4 GB</td></tr></tbody></table>
  </article>
</div>`;

function customFetcherStash() {
  const stash = makeStashDir();
  const fetcherDir = path.join(stash.dir, "scripts", "wiki-fetchers");
  fs.mkdirSync(fetcherDir, { recursive: true });
  fs.writeFileSync(
    path.join(fetcherDir, "redirect-custom.mjs"),
    `export default {
      name: "redirect-custom",
      matches(url) { return url.hostname === "custom.example" || url.hostname === "github.com"; },
      async fetch(url) {
        if (url.hostname === "github.com" || url.pathname === "/null") return null;
        if (url.pathname === "/throw") throw new Error("custom failure");
        return {
          url: url.toString(),
          title: "Custom redirect",
          markdown: "Custom fetcher content",
          preferredName: "custom/redirect",
        };
      },
    };`,
    "utf8",
  );
  return stash;
}

function responseAt(url: string, body: string): Response {
  const response = new Response(body, { headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("GitHub repository fetcher", () => {
  test.each([
    ["https://github.com/lyogavin/airllm", { owner: "lyogavin", repo: "airllm" }],
    ["https://www.github.com/Owner/Repo.git", { owner: "Owner", repo: "Repo" }],
  ])("parses repository root %s", (href, expected) => {
    expect(extractGithubRepository(new URL(href))).toEqual(expected);
  });

  test.each([
    "https://github.com/lyogavin",
    "https://github.com/lyogavin/airllm/issues",
    "https://github.com/settings/profile",
    "https://github.com/solutions/ci-cd",
    "https://github.com/customer-stories/example",
    "https://example.com/lyogavin/airllm",
  ])("does not classify %s as a repository root", (href) => {
    expect(extractGithubRepository(new URL(href))).toBeNull();
  });

  test("uses GitHub's rendered README endpoint instead of repository UI", async () => {
    const token = "GITHUB_README_TOKEN";
    let requestUrl = "";
    let accept = "";
    let authorization = "";
    const snapshot = await withEnv({ GITHUB_TOKEN: token }, () =>
      withMockedFetch(
        () => githubFetcher.fetch(new URL("https://github.com/lyogavin/airllm"), CTX),
        async (input, init) => {
          requestUrl = input;
          const headers = new Headers(init?.headers);
          accept = headers.get("accept") ?? "";
          authorization = headers.get("authorization") ?? "";
          return new Response(README_HTML, { headers: { "content-type": "text/html" } });
        },
      ),
    );

    expect(requestUrl).toBe("https://api.github.com/repos/lyogavin/airllm/readme");
    expect(accept).toBe("application/vnd.github.html+json");
    expect(authorization).toBe(`Bearer ${token}`);
    expect(snapshot?.title).toBe("lyogavin/airllm");
    expect(snapshot?.preferredName).toBe("lyogavin/airllm");
    expect(snapshot?.markdown).toContain("# AirLLM");
    expect(snapshot?.markdown).toContain("Run large language models");
    expect(snapshot?.markdown).toContain("| Model | Memory |");
    expect(snapshot?.markdown).toContain("https://github.com/lyogavin/airllm/assets/logo.png");
    expect(JSON.stringify(snapshot)).not.toContain(token);
  });

  test("falls back to generic GitHub HTML when the README endpoint is unavailable", async () => {
    const seen: string[] = [];
    const snapshot = await withEnv({ GITHUB_TOKEN: "TEST_TOKEN" }, () =>
      withMockedFetch(
        () =>
          fetchWebsiteMarkdownSnapshot("https://github.com/owner/repo", {
            stashDir: "/nonexistent-akm-test-stash",
            allowPrivateHosts: true,
          }),
        async (input) => {
          seen.push(input);
          if (input === "https://api.github.com/repos/owner/repo/readme") return new Response("", { status: 404 });
          return responseAt(input, "<html><body><main><h1>Generic repository page</h1></main></body></html>");
        },
      ),
    );
    expect(seen).toEqual(["https://api.github.com/repos/owner/repo/readme", "https://github.com/owner/repo"]);
    expect(snapshot.markdown).toContain("# Generic repository page");
  });

  test("normalizes a leading-dot repository basename into an indexable path", async () => {
    const snapshot = await withEnv({ GITHUB_TOKEN: "" }, () =>
      withMockedFetch(
        () => githubFetcher.fetch(new URL("https://github.com/github/.github"), CTX),
        async () => new Response(README_HTML, { headers: { "content-type": "text/html" } }),
      ),
    );
    expect(snapshot?.preferredName).toBe("github/dot-github");
  });

  test("rejects API redirects without forwarding the GitHub token", async () => {
    const seen: Array<{ url: string; authorization: string }> = [];
    const snapshot = await withEnv({ GITHUB_TOKEN: "TOKEN_MUST_NOT_FOLLOW" }, () =>
      withMockedFetch(
        () => githubFetcher.fetch(new URL("https://github.com/owner/repo"), CTX),
        async (input, init) => {
          seen.push({ url: input, authorization: new Headers(init?.headers).get("authorization") ?? "" });
          return new Response("", { status: 302, headers: { location: "https://evil.example/readme" } });
        },
      ),
    );
    expect(snapshot).toBeNull();
    expect(seen).toEqual([
      { url: "https://api.github.com/repos/owner/repo/readme", authorization: "Bearer TOKEN_MUST_NOT_FOLLOW" },
    ]);
  });

  test.each([
    "file://8.8.8.8/etc/passwd",
    "ftp://public.example/archive",
    "https://user:password@public.example/private",
  ])("rejects an unsafe generic redirect target %s before fetching it", async (location) => {
    const seen: string[] = [];
    await expect(
      withMockedFetch(
        () =>
          fetchWebsiteMarkdownSnapshot("https://share.example/unsafe", {
            stashDir: "/nonexistent-akm-test-stash",
            allowPrivateHosts: true,
          }),
        async (input) => {
          seen.push(input);
          return new Response("", { status: 302, headers: { location } });
        },
      ),
    ).rejects.toThrow(/Refusing to fetch/);
    expect(seen).toEqual(["https://share.example/unsafe"]);
  });

  test("a malformed generic redirect cancels its response body before failing", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 302, headers: { location: "http://[" } },
    );
    await expect(
      withMockedFetch(
        () =>
          fetchWebsiteMarkdownSnapshot("https://share.example/malformed", {
            stashDir: "/nonexistent-akm-test-stash",
            allowPrivateHosts: true,
          }),
        async () => response,
      ),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  test("a pre-aborted snapshot request performs no fetch and does not fall through", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    let fetched = false;
    await expect(
      withMockedFetch(
        () =>
          fetchWebsiteMarkdownSnapshot("https://github.com/owner/repo", {
            stashDir: "/nonexistent-akm-test-stash",
            signal: controller.signal,
          }),
        async () => {
          fetched = true;
          return new Response(README_HTML);
        },
      ),
    ).rejects.toBe(reason);
    expect(fetched).toBe(false);
  });

  test("a plain-text response cannot emit active Markdown or raw HTML", async () => {
    const snapshot = await withMockedFetch(
      () =>
        fetchWebsiteMarkdownSnapshot("https://text.example/note.txt", {
          stashDir: "/nonexistent-akm-test-stash",
          allowPrivateHosts: true,
        }),
      async () =>
        new Response("# FORGED\n<h1>HTML_FORGED</h1>\n<img src=x onerror=alert(1)>\n[click](javascript:alert(1))", {
          headers: { "content-type": "text/plain" },
        }),
    );
    expect(snapshot.markdown).not.toMatch(/^# FORGED/m);
    expect(snapshot.markdown).not.toContain("<img");
    expect(snapshot.markdown).not.toMatch(/^# HTML_FORGED/m);
    expect(snapshot.markdown).toContain("&lt;h1>HTML_FORGED&lt;/h1>");
    expect(snapshot.markdown).not.toMatch(/(?<!\\)\]\(javascript:/);
  });

  test("re-dispatches a redirected short URL to the GitHub fetcher", async () => {
    const seen: string[] = [];
    let genericResponseCancelled = false;
    const snapshot = await withEnv({ GITHUB_TOKEN: "" }, () =>
      withMockedFetch(
        () =>
          fetchWebsiteMarkdownSnapshot("https://share.example/repository", {
            stashDir: "/nonexistent-akm-test-stash",
            allowPrivateHosts: true,
          }),
        async (input) => {
          seen.push(input);
          if (input === "https://share.example/repository") {
            return new Response("", {
              status: 302,
              headers: { location: "https://github.com/lyogavin/airllm" },
            });
          }
          if (input === "https://github.com/lyogavin/airllm") {
            const response = new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("Private repository page"));
                },
                cancel() {
                  genericResponseCancelled = true;
                },
              }),
              {
                status: 404,
                headers: { "content-type": "text/html" },
              },
            );
            Object.defineProperty(response, "url", { value: input });
            return response;
          }
          if (input === "https://api.github.com/repos/lyogavin/airllm/readme") {
            return new Response(README_HTML, { headers: { "content-type": "text/html" } });
          }
          return new Response("", { status: 404 });
        },
      ),
    );

    expect(seen).toEqual([
      "https://share.example/repository",
      "https://github.com/lyogavin/airllm",
      "https://api.github.com/repos/lyogavin/airllm/readme",
    ]);
    expect(snapshot.url).toBe("https://github.com/lyogavin/airllm");
    expect(snapshot.markdown).toContain("Run large language models");
    expect(snapshot.markdown).not.toContain("Generic GitHub application shell");
    expect(genericResponseCancelled).toBe(true);
  });

  test("an aborted redirected fetcher cancels the retained generic response", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel redirected import");
    let genericResponseCancelled = false;
    const request = withEnv({ GITHUB_TOKEN: "TEST_TOKEN" }, () =>
      withMockedFetch(
        () =>
          fetchWebsiteMarkdownSnapshot("https://share.example/repository", {
            stashDir: "/nonexistent-akm-test-stash",
            allowPrivateHosts: true,
            signal: controller.signal,
          }),
        async (input) => {
          if (input === "https://share.example/repository") {
            return new Response("", {
              status: 302,
              headers: { location: "https://github.com/owner/repo" },
            });
          }
          if (input === "https://github.com/owner/repo") {
            return new Response(
              new ReadableStream({
                start(streamController) {
                  streamController.enqueue(new TextEncoder().encode("Generic repository page"));
                },
                cancel() {
                  genericResponseCancelled = true;
                },
              }),
              { headers: { "content-type": "text/html" } },
            );
          }
          controller.abort(reason);
          throw reason;
        },
      ),
    );
    await expect(request).rejects.toBe(reason);
    expect(genericResponseCancelled).toBe(true);
  });

  test("a stash-local fetcher wins when a redirect reveals its URL", async () => {
    const stash = customFetcherStash();
    try {
      const snapshot = await withMockedFetch(
        () =>
          fetchWebsiteMarkdownSnapshot("https://share.example/custom", {
            stashDir: stash.dir,
            allowPrivateHosts: true,
          }),
        async (input) => {
          if (input === "https://share.example/custom") {
            return new Response("", { status: 302, headers: { location: "https://custom.example/content" } });
          }
          return responseAt(input, "<html><body><main>Generic content</main></body></html>");
        },
      );
      expect(snapshot.title).toBe("Custom redirect");
      expect(snapshot.markdown).toBe("Custom fetcher content");
      expect(snapshot.preferredName).toBe("custom/redirect");
    } finally {
      stash.cleanup();
    }
  });

  test("website mirrors load custom fetchers from the active stash, not the generated cache", async () => {
    const stash = customFetcherStash();
    try {
      let fetched = false;
      const paths = await withBundle(stash.dir, () =>
        withMockedFetch(
          () =>
            ensureWebsiteMirror(
              { url: "https://custom.example/content", options: { maxPages: 1, maxDepth: 1 } } as never,
              { allowPrivateHosts: true, force: true, requireStashDir: true },
            ),
          async () => {
            fetched = true;
            return new Response("network fallback");
          },
        ),
      );
      const output = fs.readFileSync(path.join(paths.stashDir, "knowledge", "custom", "redirect.md"), "utf8");
      expect(output).toContain("Custom fetcher content");
      expect(fetched).toBe(false);
    } finally {
      stash.cleanup();
    }
  });

  test("a stash-local null result falls through to the built-in GitHub fetcher", async () => {
    const stash = customFetcherStash();
    try {
      const snapshot = await withEnv({ GITHUB_TOKEN: "" }, () =>
        withMockedFetch(
          () =>
            fetchWebsiteMarkdownSnapshot("https://share.example/repository", {
              stashDir: stash.dir,
              allowPrivateHosts: true,
            }),
          async (input) => {
            if (input === "https://share.example/repository") {
              return new Response("", {
                status: 302,
                headers: { location: "https://github.com/lyogavin/airllm" },
              });
            }
            if (input === "https://github.com/lyogavin/airllm") {
              return responseAt(input, "<html><body><main>Generic shell</main></body></html>");
            }
            return new Response(README_HTML, { headers: { "content-type": "text/html" } });
          },
        ),
      );
      expect(snapshot.markdown).toContain("Run large language models");
      expect(snapshot.markdown).not.toContain("Generic shell");
    } finally {
      stash.cleanup();
    }
  });

  test("a throwing stash-local fetcher retains the already-fetched generic snapshot", async () => {
    const stash = customFetcherStash();
    try {
      const snapshot = await withMockedFetch(
        () =>
          fetchWebsiteMarkdownSnapshot("https://share.example/throw", {
            stashDir: stash.dir,
            allowPrivateHosts: true,
          }),
        async (input) => {
          if (input === "https://share.example/throw") {
            return new Response("", { status: 302, headers: { location: "https://custom.example/throw" } });
          }
          return responseAt(input, "<html><body><main>Retained generic content</main></body></html>");
        },
      );
      expect(snapshot.markdown).toContain("Retained generic content");
    } finally {
      stash.cleanup();
    }
  });
});
