// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { NotFoundError, TransientError } from "../src/core/errors";
import { assertResolvedHostAllowed, fetchGuardedResponse } from "../src/sources/snapshot-fetchers/host-guard";
import { ensureWebsiteMirror, fetchWebsiteMarkdownSnapshot } from "../src/sources/snapshot-fetchers/website-ingest";
import { withMockedFetch } from "./_helpers/sandbox";

// A website that cannot be fetched is the site's or the network's doing, never an akm bug: a typed error, so the
// CLI exits 75 (retry) or 1 (refused), not 70 (internal).
async function failure(run: () => Promise<unknown>, reply: (url: string) => Response | Promise<Response>) {
  try {
    await withMockedFetch(run, async (url) => reply(url));
  } catch (error) {
    return error;
  }
  throw new Error("expected the fetch to fail");
}

const snapshot = () =>
  fetchWebsiteMarkdownSnapshot("https://docs.example.test/page", { resolveSecret: undefined, allowPrivateHosts: true });

describe("website fetch failures are typed", () => {
  test("an HTTP 403 is a refusal: WEBSITE_REFUSED (exit 1)", async () => {
    const error = await failure(snapshot, () => new Response("forbidden", { status: 403 }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ code: "WEBSITE_REFUSED" });
    expect((error as Error).message).toContain("(403)");
  });

  test("an HTTP 503 or 429 can be retried: WEBSITE_UNREACHABLE (exit 75)", async () => {
    for (const status of [503, 429]) {
      const error = await failure(snapshot, () => new Response("busy", { status }));
      expect(error).toBeInstanceOf(TransientError);
      expect(error).toMatchObject({ code: "WEBSITE_UNREACHABLE" });
    }
  });

  test("a connection that fails or times out can be retried: WEBSITE_UNREACHABLE", async () => {
    const error = await failure(
      () =>
        fetchGuardedResponse(
          "https://down.example.test/",
          {},
          { timeoutMs: 1_000, retries: 0, allowPrivateHosts: true },
        ),
      () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    );
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ code: "WEBSITE_UNREACHABLE" });
    expect((error as Error).message).toContain("ECONNREFUSED");
  });

  test("a redirect loop or a redirect with no Location is a refusal", async () => {
    const loop = await failure(
      () =>
        fetchGuardedResponse(
          "https://loop.example.test/",
          {},
          { timeoutMs: 1_000, retries: 0, allowPrivateHosts: true },
        ),
      () => new Response("", { status: 302, headers: { location: "https://loop.example.test/" } }),
    );
    expect(loop).toMatchObject({ code: "WEBSITE_REFUSED" });
    const bare = await failure(
      () =>
        fetchGuardedResponse(
          "https://bare.example.test/",
          {},
          { timeoutMs: 1_000, retries: 0, allowPrivateHosts: true },
        ),
      () => new Response("", { status: 302 }),
    );
    expect(bare).toMatchObject({ code: "WEBSITE_REFUSED" });
  });

  test("a site with no page akm can take is WEBSITE_NO_CONTENT (exit 1), not a flag error", async () => {
    // `akm import <url>`: one page, here a 404.
    const imported = await failure(snapshot, () => new Response("gone", { status: 404 }));
    expect(imported).toBeInstanceOf(NotFoundError);
    expect(imported).toMatchObject({ code: "WEBSITE_NO_CONTENT" });
    expect((imported as Error).message).toContain("No content could be fetched");
    // A website bundle: the crawl keeps no page.
    const crawled = await failure(
      () =>
        ensureWebsiteMirror({ type: "website", url: "https://empty.example.test/", name: "empty" } as never, {
          allowPrivateHosts: true,
        }),
      () => new Response("gone", { status: 404 }),
    );
    expect(crawled).toBeInstanceOf(NotFoundError);
    expect(crawled).toMatchObject({ code: "WEBSITE_NO_CONTENT" });
    expect((crawled as Error).message).toContain("No content could be scraped");
  });

  test("a DNS lookup that fails or finds nothing can be retried", async () => {
    for (const resolveHostname of [
      async () => [],
      async (): Promise<string[]> => Promise.reject(new Error("ENOTFOUND")),
    ]) {
      const error = await assertResolvedHostAllowed("docs.example.com", { resolveHostname }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientError);
      expect(error).toMatchObject({ code: "WEBSITE_UNREACHABLE" });
    }
  });
});
