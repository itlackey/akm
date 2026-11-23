// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { checkDeadUrls } from "../../src/commands/url-checker";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string) => Promise<Response> | Response): void {
  globalThis.fetch = ((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))) as unknown as typeof fetch;
}

describe("checkDeadUrls", () => {
  test("checks every URL found, with no cap on entries or per-entry matches", async () => {
    // 25 URLs across 12 entries — comfortably past the old MAX_URLS = 20 and
    // the old per-entry slice(0, 3): every entry here has more than 3 links.
    const requested: string[] = [];
    stubFetch((url) => {
      requested.push(url);
      return new Response(null, { status: 200 });
    });

    const entries = Array.from({ length: 12 }, (_, i) => ({
      ref: `knowledge/doc-${i}`,
      body: Array.from({ length: 5 }, (_, j) => `see https://example.com/${i}/${j}`).join(" and "),
    }));
    const totalUrls = 12 * 5;

    const result = await checkDeadUrls("/tmp/stash", entries);

    expect(requested.length).toBe(totalUrls);
    expect(result.coverage).toEqual({ checked: totalUrls, total: totalUrls, skipped: 0 });
    expect(result.deadUrls).toEqual([]);
  });

  test("bounds concurrency instead of firing every request at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    stubFetch(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so overlapping calls actually overlap instead of resolving synchronously.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(null, { status: 200 });
    });

    const entries = [
      { ref: "knowledge/many", body: Array.from({ length: 40 }, (_, i) => `https://example.com/${i}`).join(" ") },
    ];

    await checkDeadUrls("/tmp/stash", entries);

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  test("reports a >=400 response and a thrown fetch as dead, without swallowing either", async () => {
    stubFetch((url) => {
      if (url.endsWith("/missing")) return new Response(null, { status: 404 });
      if (url.endsWith("/boom")) return Promise.reject(new Error("network down"));
      return new Response(null, { status: 200 });
    });

    const entries = [
      {
        ref: "knowledge/doc",
        body: "ok: https://example.com/ok dead: https://example.com/missing broken: https://example.com/boom",
      },
    ];

    const result = await checkDeadUrls("/tmp/stash", entries);

    expect(result.coverage).toEqual({ checked: 3, total: 3, skipped: 0 });
    expect(result.deadUrls).toEqual(
      expect.arrayContaining([
        { ref: "knowledge/doc", url: "https://example.com/missing", status: 404 },
        { ref: "knowledge/doc", url: "https://example.com/boom", status: "error" },
      ]),
    );
    expect(result.deadUrls.length).toBe(2);
  });

  test("reports full coverage of zero URLs when no entry contains a link", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response(null, { status: 200 });
    });

    const result = await checkDeadUrls("/tmp/stash", [{ ref: "knowledge/doc", body: "no links here" }]);

    expect(called).toBe(false);
    expect(result.coverage).toEqual({ checked: 0, total: 0, skipped: 0 });
    expect(result.deadUrls).toEqual([]);
  });

  test('a request that never responds is reported dead with status "timeout", not swallowed or dropped', async () => {
    // A real hanging server rather than a fetch stub: proves the request
    // actually carries a working AbortSignal.timeout, not just that the
    // catch block can classify a hand-crafted DOMException.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {
          // Never resolves — the request must be aborted by the timeout.
        });
      },
    });
    try {
      const url = `http://localhost:${server.port}/hangs`;
      const entries = [{ ref: "knowledge/doc", body: `see ${url}` }];

      const result = await checkDeadUrls("/tmp/stash", entries);

      expect(result.deadUrls).toEqual([{ ref: "knowledge/doc", url, status: "timeout" }]);
      expect(result.coverage).toEqual({ checked: 1, total: 1, skipped: 0 });
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("a DNS/connection-level failure (ENOTFOUND and friends) is counted as skipped, not reported dead", async () => {
    stubFetch((url) => {
      if (url.includes("example.invalid")) {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), { code: "ENOTFOUND" });
      }
      return new Response(null, { status: 200 });
    });

    const entries = [
      {
        ref: "knowledge/doc",
        body: "unreachable: https://example.invalid/thing reachable: https://example.com/ok",
      },
    ];

    const result = await checkDeadUrls("/tmp/stash", entries);

    // The unresolvable host contributes nothing to deadUrls — an indeterminate
    // result is not evidence the link is dead — but it must not vanish from
    // coverage either: it is counted in `skipped`, so `checked` (1, for the
    // one URL that got a real answer) plus `skipped` (1) equals `total` (2).
    expect(result.deadUrls).toEqual([]);
    expect(result.coverage).toEqual({ checked: 1, total: 2, skipped: 1 });
  });

  test('other system-error codes not in the network-failure set still report as dead (status: "error")', async () => {
    stubFetch(() => {
      throw Object.assign(new Error("self-signed certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    });

    const entries = [{ ref: "knowledge/doc", body: "see https://example.com/cert" }];

    const result = await checkDeadUrls("/tmp/stash", entries);

    expect(result.deadUrls).toEqual([{ ref: "knowledge/doc", url: "https://example.com/cert", status: "error" }]);
    expect(result.coverage).toEqual({ checked: 1, total: 1, skipped: 0 });
  });
});
