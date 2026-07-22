import { describe, expect, test } from "bun:test";
import { assertResolvedHostAllowed, type HostnameResolver } from "../../src/sources/snapshot-fetchers/website-ingest";

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
});
