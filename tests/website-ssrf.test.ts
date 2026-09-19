import { describe, expect, test } from "bun:test";
import { _setWarnSinkForTests } from "../src/core/warn";
import { assertWebsiteRequestUrl, fetchGuardedResponse } from "../src/sources/snapshot-fetchers/host-guard";
import {
  assertResolvedHostAllowed,
  fetchWebsiteMarkdownSnapshot,
  type HostnameResolver,
} from "../src/sources/snapshot-fetchers/website-ingest";
import { shouldAllowPrivateWebsiteUrlForTests, validateWebsiteInputUrl } from "../src/sources/website-url";
import { withMockedFetch } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

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

  test("proceeding on a private start URL warns exactly once per host outside test mode", () => {
    const seen: unknown[][] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") seen.push(args);
    });
    const originalBunTest = process.env.BUN_TEST;
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.BUN_TEST;
      delete process.env.NODE_ENV;
      expect(shouldAllowPrivateWebsiteUrlForTests("http://10.9.9.9/handbook")).toBe(true);
      expect(shouldAllowPrivateWebsiteUrlForTests("http://10.9.9.9/handbook")).toBe(true);
      expect(seen.length).toBe(1);
    } finally {
      if (originalBunTest === undefined) delete process.env.BUN_TEST;
      else process.env.BUN_TEST = originalBunTest;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
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
