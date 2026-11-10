// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { _setWarnSinkForTests } from "../src/core/warn";
import type { SecretResolver } from "../src/sources/provider";
import { resolveSourceProviderFactory } from "../src/sources/provider-factory";
import { assertWebsiteRequestUrl, fetchGuardedResponse } from "../src/sources/snapshot-fetchers/host-guard";
import {
  assertResolvedHostAllowed,
  ensureWebsiteMirror,
  fetchWebsiteMarkdownSnapshot,
  getWebsiteCachePaths,
  type HostnameResolver,
} from "../src/sources/snapshot-fetchers/website-ingest";
import { shouldAllowPrivateWebsiteUrlForTests, validateWebsiteInputUrl } from "../src/sources/website-url";
import { withMockedFetch } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

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
});

// Stub resolver seam so NO real DNS ever runs in tests.
function resolverReturning(...addresses: string[]): HostnameResolver {
  return async () => addresses;
}

function resolverThrowing(): HostnameResolver {
  return async () => {
    throw new Error("ENOTFOUND");
  };
}

describe("assertResolvedHostAllowed (SSRF resolve-then-validate)", () => {
  test("rejects a public-looking host that resolves to a private IPv4", async () => {
    await expect(
      assertResolvedHostAllowed("private-host.example.com", { resolveHostname: resolverReturning("10.0.0.1") }),
    ).rejects.toThrow(/non-public/);
  });

  test("rejects when ANY resolved address is private (mixed answer)", async () => {
    await expect(
      assertResolvedHostAllowed("rebind.example.com", {
        resolveHostname: resolverReturning("93.184.216.34", "127.0.0.1"),
      }),
    ).rejects.toThrow(/non-public/);
  });

  test("rejects a host that resolves into a private IPv6 range", async () => {
    await expect(
      assertResolvedHostAllowed("v6.example.com", { resolveHostname: resolverReturning("fd00::1") }),
    ).rejects.toThrow(/non-public/);
  });

  test("allows a host that resolves only to public addresses", async () => {
    await expect(
      assertResolvedHostAllowed("docs.example.com", { resolveHostname: resolverReturning("93.184.216.34") }),
    ).resolves.toBeUndefined();
  });

  test("allows public addresses elsewhere in 192.0.0.0/16", async () => {
    await expect(assertResolvedHostAllowed("192.0.43.8")).resolves.toBeUndefined();
    await expect(
      assertResolvedHostAllowed("iana.example.com", { resolveHostname: resolverReturning("192.0.43.8") }),
    ).resolves.toBeUndefined();
  });

  test.each([
    "192.0.0.9",
    "192.0.0.10",
    "2001:1::1",
  ])("allows globally reachable special-range exception %s", async (address) => {
    await expect(assertResolvedHostAllowed(address)).resolves.toBeUndefined();
  });

  test("fails closed when the resolver returns no addresses", async () => {
    await expect(
      assertResolvedHostAllowed("empty.example.com", { resolveHostname: resolverReturning() }),
    ).rejects.toThrow(/no addresses/);
  });

  test("fails closed when the resolver throws", async () => {
    await expect(
      assertResolvedHostAllowed("broken.example.com", { resolveHostname: resolverThrowing() }),
    ).rejects.toThrow(/DNS resolution failed/);
  });

  test("skips resolution entirely when allowPrivateHosts is set", async () => {
    let called = false;
    const resolver: HostnameResolver = async () => {
      called = true;
      return ["10.0.0.1"];
    };
    await expect(
      assertResolvedHostAllowed("internal.example.com", { allowPrivateHosts: true, resolveHostname: resolver }),
    ).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  test("does not resolve IP-literal hosts (already range-checked synchronously)", async () => {
    let called = false;
    const resolver: HostnameResolver = async () => {
      called = true;
      return [];
    };
    // A bare IPv4 literal short-circuits before the resolver seam.
    await expect(assertResolvedHostAllowed("93.184.216.34", { resolveHostname: resolver })).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  test.each([
    "100.64.0.1",
    "100.100.100.200",
    "192.0.2.1",
    "192.88.99.2",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "ff02::1",
    "fec0::1",
    "0:0:0:0:0:ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "::ffff:0:a9fe:a9fe",
    "2002:a9fe:a9fe::",
    "2001:11::1",
    "2001:21::1",
    "2001:db8::1",
    "3fff::1",
    "5f00::1",
  ])("rejects non-global literal or resolved address %s", async (address) => {
    await expect(assertResolvedHostAllowed(address)).rejects.toThrow(/non-public/);
    await expect(
      assertResolvedHostAllowed("special.example.com", { resolveHostname: resolverReturning(address) }),
    ).rejects.toThrow(/non-public/);
  });

  test("cross-origin redirects do not forward sensitive request headers", async () => {
    const seen: Array<{ url: string; authorization: string; cookie: string; custom: string }> = [];
    const result = await withMockedFetch(
      () =>
        fetchGuardedResponse(
          "https://origin.example/start",
          { headers: { Authorization: "Bearer secret", Cookie: "sid=secret", "X-Custom": "keep" } },
          { timeoutMs: 1_000, retries: 0, allowPrivateHosts: true },
        ),
      async (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: input,
          authorization: headers.get("authorization") ?? "",
          cookie: headers.get("cookie") ?? "",
          custom: headers.get("x-custom") ?? "",
        });
        if (input === "https://origin.example/start") {
          return new Response("", { status: 302, headers: { location: "https://other.example/final" } });
        }
        return new Response("ok");
      },
    );
    await result.response.body?.cancel();
    expect(seen).toEqual([
      {
        url: "https://origin.example/start",
        authorization: "Bearer secret",
        cookie: "sid=secret",
        custom: "keep",
      },
      { url: "https://other.example/final", authorization: "", cookie: "", custom: "keep" },
    ]);
  });

  test("credential errors never include credentials from a non-HTTP URL", () => {
    let message = "";
    try {
      assertWebsiteRequestUrl("ftp://alice:s3cr3t@example.com/private");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("embedded credentials");
    expect(message).not.toContain("alice");
    expect(message).not.toContain("s3cr3t");
  });
});

describe("start URL the operator typed is not refused outright", () => {
  test("a loopback start URL is allowed, not refused", () => {
    expect(shouldAllowPrivateWebsiteUrlForTests("http://localhost:8000/docs")).toBe(true);
    expect(shouldAllowPrivateWebsiteUrlForTests("http://192.168.1.50:8080/docs")).toBe(true);
    expect(() => validateWebsiteInputUrl("http://localhost:8000/docs", { allowPrivateHosts: true })).not.toThrow();
  });

  test("a public start URL is left alone — no bypass, no warning", () => {
    expect(shouldAllowPrivateWebsiteUrlForTests("https://docs.example.com/")).toBe(false);
  });

  test("an unparseable URL is not treated as private", () => {
    expect(shouldAllowPrivateWebsiteUrlForTests("not a url")).toBe(false);
  });

  test("proceeding on a private start URL warns exactly once per host, NODE_ENV=test or not", () => {
    const seen: unknown[][] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") seen.push(args);
    });
    expect(process.env.NODE_ENV).toBe("test");
    expect(shouldAllowPrivateWebsiteUrlForTests("http://10.9.9.9/handbook")).toBe(true);
    expect(shouldAllowPrivateWebsiteUrlForTests("http://10.9.9.9/handbook")).toBe(true);
    expect(seen.length).toBe(1);
  });

  test("a start URL that only resolves privately via DNS is allowed with a warning, not refused", async () => {
    const seen: unknown[][] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") seen.push(args);
    });
    const result = await withMockedFetch(
      () =>
        fetchWebsiteMarkdownSnapshot("https://split-horizon.internal-corp.example/handbook", {
          resolveSecret: undefined,
          resolveHostname: resolverReturning("10.20.30.40"),
        }),
      async () => new Response("<html><body>hello from the intranet</body></html>", { status: 200 }),
    );
    expect(result.markdown).toContain("hello from the intranet");
    expect(seen.length).toBeGreaterThan(0);
  });
});
