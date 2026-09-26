// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P4 — unit coverage for the SecretResolver capability on provider sync(). The
 * real `akm bundle update` composition is covered separately in
 * tests/integration/source-qa-fixes.test.ts with a stored bearer-token file.
 *
 * This test resolves the website provider factory and drives
 * `sync()` directly with a stub SecretResolver and asserts it is consulted for
 * `secrets/x-bearer-token`, and that the resolved value never surfaces in the
 * produced snapshot (containment — graft (a), verified rather than enforced via
 * a global redaction registry, which would reintroduce the mutable ambient
 * state this architecture deliberately avoids).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SecretResolver } from "../src/sources/provider";
import { resolveSourceProviderFactory } from "../src/sources/provider-factory";
import { ensureWebsiteMirror, getWebsiteCachePaths } from "../src/sources/snapshot-fetchers/website-ingest";
import { withMockedFetch } from "./_helpers/sandbox";

const SECRET = "STORE_TOKEN_FROM_SYNC_PATH";

function websiteEntry(url: string) {
  return { type: "website", url, name: "x-src" } as never;
}

describe("SecretResolver reaches provider sync()", () => {
  const ORIGINAL = process.env.X_BEARER_TOKEN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.X_BEARER_TOKEN;
    else process.env.X_BEARER_TOKEN = ORIGINAL;
  });

  test("website sync() consults the injected resolver for the X token", async () => {
    // No env var — the only way the token can arrive is via the resolver the
    // sync path injects. Before P4 this path was env-only, so the resolver
    // would never be called and the API request would carry no bearer token.
    delete process.env.X_BEARER_TOKEN;
    delete process.env.X_RSS_TEMPLATE;

    const asked: string[] = [];
    const resolver: SecretResolver = {
      resolveSecret: (ref) => {
        asked.push(ref);
        return ref === "secrets/x-bearer-token" ? SECRET : null;
      },
    };

    const factory = resolveSourceProviderFactory("website");
    expect(factory).not.toBeNull();
    const provider = factory?.(websiteEntry("http://127.0.0.1:9/x-user-profile"));
    expect(provider?.sync).toBeDefined();

    let sawBearer = false;
    let snapshotJson = "";
    await withMockedFetch(
      async () => {
        // The website provider treats the URL as an x.com profile only if it
        // matches; use a real x.com URL so the X fetcher engages.
        const p = resolveSourceProviderFactory("website")?.(websiteEntry("https://x.com/jack"));
        await p?.sync?.({ force: true, secrets: resolver, ensureWebsiteMirror });
        const { stashDir } = getWebsiteCachePaths("https://x.com/jack");
        const fs = await import("node:fs");
        const path = await import("node:path");
        const dir = path.join(stashDir, "knowledge", "x");
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) snapshotJson += fs.readFileSync(path.join(dir, f), "utf8");
        }
      },
      async (input, init) => {
        const url = String(input);
        if (new Headers(init?.headers).get("authorization") === `Bearer ${SECRET}`) sawBearer = true;
        if (url.includes("/users/by/username/")) {
          return new Response(JSON.stringify({ data: { id: "1" } }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/tweets")) {
          return new Response(
            JSON.stringify({ data: [{ id: "9", text: "hello from sync", created_at: "2025-04-01T10:00:00Z" }] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      },
    );

    // The resolver was consulted for the right ref...
    expect(asked).toContain("secrets/x-bearer-token");
    // ...the token authenticated the API call...
    expect(sawBearer).toBe(true);
    // ...the tweet content was materialized to the stash...
    expect(snapshotJson).toContain("hello from sync");
    // ...and the token itself never landed in the snapshot on disk.
    expect(snapshotJson).not.toContain(SECRET);
  });

  test("without a resolver the sync path is environment-only (no throw)", async () => {
    delete process.env.X_BEARER_TOKEN;
    delete process.env.X_RSS_TEMPLATE;
    const factory = resolveSourceProviderFactory("website");
    const provider = factory?.(websiteEntry("https://x.com/jack"));
    // No secrets injected, no env var: the X fetcher warns and falls through;
    // sync() must not throw.
    await expect(
      withMockedFetch(
        () => provider?.sync?.({ force: true, ensureWebsiteMirror }) ?? Promise.resolve(),
        async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
      ),
    ).resolves.toBeUndefined();
  });
});
