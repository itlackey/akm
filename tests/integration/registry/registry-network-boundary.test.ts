// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The registry network boundary (`src/registry/network.ts`) is plain
 * `fetch()` plus a request timeout, bounded retries, a byte cap, and
 * classified errors — no DNS pinning, no child-process transport (see
 * CHANGELOG). These tests run against real local HTTP servers so the
 * retry/classification/header behavior is verified over the wire rather than
 * through a mocked `fetch`.
 *
 * The exit-code mapping itself (AkmError `kind` -> numeric exit code) is
 * pinned generically in tests/cli/exit-code-classification.test.ts; these
 * tests only need to show that a registry network failure comes out of the
 * boundary as the right `AkmError` subclass/code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, TransientError } from "../../../src/core/errors";
import { fetchRegistry, fetchRegistryJson } from "../../../src/registry/network";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

function serve(handler: (req: Request) => Response): { url: string; close: () => void; calls: () => number } {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      calls += 1;
      return handler(req);
    },
  });
  return {
    url: `http://localhost:${server.port}/index.json`,
    close: () => server.stop(true),
    calls: () => calls,
  };
}

describe("fetchRegistry / fetchRegistryJson (src/registry/network.ts)", () => {
  test("a persistently failing server exhausts retries and throws TransientError (exit 75)", async () => {
    const server = serve(() => new Response("unavailable", { status: 503, headers: { "Retry-After": "0" } }));
    try {
      const caught = await fetchRegistry(server.url, { retries: 1, timeoutMs: 5_000 }).catch((err) => err);
      expect(caught).toBeInstanceOf(TransientError);
      expect((caught as TransientError).code).toBe("REGISTRY_UNREACHABLE");
      // Initial attempt + 1 retry, then the boundary gives up.
      expect(server.calls()).toBe(2);
    } finally {
      server.close();
    }
  });

  test("an unusable response body throws NotFoundError (exit 1)", async () => {
    const server = serve(() => new Response("not json", { status: 200 }));
    try {
      const caught = await fetchRegistryJson(server.url, { timeoutMs: 5_000 }).catch((err) => err);
      expect(caught).toBeInstanceOf(NotFoundError);
      expect((caught as NotFoundError).code).toBe("REGISTRY_RESPONSE_INVALID");
    } finally {
      server.close();
    }
  });

  test("a 404 throws NotFoundError with REGISTRY_NOT_FOUND (exit 1)", async () => {
    const server = serve(() => new Response("nope", { status: 404 }));
    try {
      await expect(fetchRegistry(server.url, { retries: 0, timeoutMs: 5_000 })).rejects.toMatchObject({
        code: "REGISTRY_NOT_FOUND",
      });
    } finally {
      server.close();
    }
  });

  test("caller-supplied credential headers reach the request unchanged", async () => {
    const seen: Array<string | null> = [];
    const server = serve((req) => {
      seen.push(req.headers.get("authorization"));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
      // Mirrors how src/registry/resolve.ts forwards a resolved GitHub
      // credential (githubHeaders() + an Authorization bearer) through this
      // same boundary — the plain-fetch rewrite must not drop caller headers.
      await fetchRegistryJson(server.url, {
        headers: { Authorization: "Bearer registry-secret" },
        timeoutMs: 5_000,
      });
      expect(seen).toEqual(["Bearer registry-secret"]);
    } finally {
      server.close();
    }
  });
});

describe("akm registry add enforces HTTPS unless explicitly overridden", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage({ AKM_REGISTRY_URL: undefined });
  });
  afterEach(() => {
    storage.cleanup();
  });

  test("plain HTTP is rejected without --allow-insecure-transport", async () => {
    const result = await runCliCapture(["registry", "add", "http://insecure.example/index.json", "--format=json"]);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
    expect(envelope.error).toContain("HTTP");
  });

  test("--allow-insecure-transport permits plain HTTP, with a warning", async () => {
    const result = await runCliCapture([
      "registry",
      "add",
      "http://insecure.example/index.json",
      "--allow-insecure-transport",
      "--format=json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr.toLowerCase()).toContain("http");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.added).toBe(true);
    expect(parsed.registries.some((r: { url: string }) => r.url === "http://insecure.example/index.json")).toBe(true);
  });

  test("https:// needs no override", async () => {
    const result = await runCliCapture(["registry", "add", "https://secure.example/index.json", "--format=json"]);
    expect(result.code).toBe(0);
  });
});
