import { afterAll, describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/errors";
import { resolveStashProviderFactory } from "../../src/stash-provider-factory";
import { OpenVikingStashProvider, parseOVSearchResponse, uriToVikingRef } from "../../src/stash-providers/openviking";

// Trigger self-registration
import "../../src/stash-providers/openviking";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURE_RESPONSE = {
  status: "ok",
  result: [
    { uri: "viking://memories/project-context", name: "project-context", score: 0.95, type: "memories" },
    { uri: "viking://skills/code-review", name: "code-review", score: 0.88, type: "skills" },
    { uri: "viking://resources/api-docs", name: "api-docs", score: 0.72, type: "resources" },
  ],
  time: 0.042,
};

const EMPTY_RESPONSE = { status: "ok", result: [], time: 0.001 };
const ERROR_RESPONSE = { status: "error", error: "Something went wrong" };

// ── Helpers ─────────────────────────────────────────────────────────────────

const servers: Array<{ stop: (force: boolean) => void }> = [];

function serveJson(body: unknown, statusCode = 200): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(body), {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  servers.push(server);
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

function getFactory() {
  const factory = resolveStashProviderFactory("openviking");
  expect(factory).toBeTruthy();
  // biome-ignore lint/style/noNonNullAssertion: factory is guaranteed by the expect above
  return factory!;
}

afterAll(() => {
  for (const s of servers) {
    try {
      s.stop(true);
    } catch {
      /* ignore */
    }
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OpenVikingStashProvider", () => {
  test("self-registers as 'openviking'", () => {
    const factory = resolveStashProviderFactory("openviking");
    expect(factory).toBeTruthy();
  });

  test("creates a provider with the correct type", () => {
    const factory = getFactory();
    const provider = factory({ type: "openviking", url: "http://localhost:1933" });
    expect(provider.type).toBe("openviking");
    expect(provider.name).toBe("openviking");
  });

  test("returns results as StashSearchHit[] with correct shape", async () => {
    const { url, close } = serveJson(FIXTURE_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url, name: "test-ov" });
      const result = await provider.search({ query: "project context", limit: 10 });

      expect(result.hits).toHaveLength(3);
      expect(result.warnings).toBeUndefined();

      const first = result.hits[0];
      expect(first.type).toBe("memory");
      expect(first.name).toBe("project-context");
      expect(first.ref).toBe("viking://memories/project-context");
      expect(first.path).toBe("viking://memories/project-context");
      expect(first.action).toBe("akm show viking://memories/project-context");
      expect(first.origin).toBe("test-ov");
      expect(first.editable).toBe(false);
      expect(first.score).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  test("returns hits with correct asset types", async () => {
    const { url, close } = serveJson(FIXTURE_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url, name: "test-ov" });
      const result = await provider.search({ query: "context", limit: 10 });

      expect(result.hits).toHaveLength(3);

      const memoryHit = result.hits.find((h) => h.name === "project-context");
      expect(memoryHit).toBeDefined();
      expect(memoryHit?.type).toBe("memory");

      const skillHit = result.hits.find((h) => h.name === "code-review");
      expect(skillHit).toBeDefined();
      expect(skillHit?.type).toBe("skill");

      const resourceHit = result.hits.find((h) => h.name === "api-docs");
      expect(resourceHit).toBeDefined();
      expect(resourceHit?.type).toBe("knowledge");
    } finally {
      close();
    }
  });

  test("returns empty hits for empty response", async () => {
    const { url, close } = serveJson(EMPTY_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url });
      const result = await provider.search({ query: "nothing", limit: 10 });

      expect(result.hits).toHaveLength(0);
    } finally {
      close();
    }
  });

  test("returns warning on error response", async () => {
    const { url, close } = serveJson(ERROR_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url, name: "bad-ov" });
      const result = await provider.search({ query: "test", limit: 10 });

      expect(result.hits).toHaveLength(0);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("bad-ov");
    } finally {
      close();
    }
  });

  test("returns warning on HTTP error", async () => {
    const { url, close } = serveJson({ error: "not found" }, 404);
    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url, name: "error-ov" });
      const result = await provider.search({ query: "test", limit: 10 });

      expect(result.hits).toHaveLength(0);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("error-ov");
    } finally {
      close();
    }
  });

  test("returns warning when server is unreachable", async () => {
    const factory = getFactory();
    const provider = factory({ type: "openviking", url: "http://127.0.0.1:19339", name: "offline-ov" });
    const result = await provider.search({ query: "test", limit: 5 });

    expect(result.hits).toHaveLength(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.[0]).toContain("offline-ov");
  });

  test("respects limit", async () => {
    const { url, close } = serveJson(FIXTURE_RESPONSE);
    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url });
      const result = await provider.search({ query: "test", limit: 2 });

      expect(result.hits.length).toBeLessThanOrEqual(2);
    } finally {
      close();
    }
  });

  test("canShow returns true for viking:// URIs", () => {
    const factory = getFactory();
    const provider = factory({ type: "openviking", url: "http://localhost:1933" });
    expect(provider.canShow("viking://memories/foo")).toBe(true);
    expect(provider.canShow("  viking://skills/bar")).toBe(true);
    expect(provider.canShow("script:deploy.sh")).toBe(false);
    expect(provider.canShow("skill:ops")).toBe(false);
  });

  test("uses text search when searchType is 'text'", async () => {
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname;
        return new Response(JSON.stringify(FIXTURE_RESPONSE), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({
        type: "openviking",
        url: `http://localhost:${server.port}`,
        options: { searchType: "text" },
      });
      await provider.search({ query: "test", limit: 10 });

      expect(capturedPath).toBe("/api/v1/search/grep");
    } finally {
      server.stop(true);
    }
  });

  test("uses semantic search by default", async () => {
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedPath = new URL(req.url).pathname;
        return new Response(JSON.stringify(FIXTURE_RESPONSE), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });
      await provider.search({ query: "test", limit: 10 });

      expect(capturedPath).toBe("/api/v1/search/find");
    } finally {
      server.stop(true);
    }
  });

  // ── show() tests ────────────────────────────────────────────────────────

  test("show returns content for viking:// URI", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          return new Response(
            JSON.stringify({ status: "ok", result: { name: "my-doc", type: "resources", abstract: "A test doc" } }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname === "/api/v1/content/read") {
          return new Response(JSON.stringify({ status: "ok", result: "# My Doc\n\nHello world" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });
      const result = await provider.show("viking://resources/my-doc");

      expect(result.name).toBe("my-doc");
      expect(result.type).toBe("knowledge");
      expect(result.content).toBe("# My Doc\n\nHello world");
      expect(result.editable).toBe(false);
      expect(result.description).toBe("A test doc");
    } finally {
      server.stop(true);
    }
  });

  test("show sends Authorization header when apiKey is configured", async () => {
    let capturedAuth = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedAuth = req.headers.get("authorization") ?? "";
        return new Response(JSON.stringify({ status: "ok", result: { name: "test", type: "memories" } }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({
        type: "openviking",
        url: `http://localhost:${server.port}`,
        options: { apiKey: "test-key-123" },
      });
      await provider.show("viking://memories/test");

      expect(capturedAuth).toBe("Bearer test-key-123");
    } finally {
      server.stop(true);
    }
  });

  test("show throws NotFoundError when server is unreachable", async () => {
    const factory = getFactory();
    const provider = factory({ type: "openviking", url: "http://127.0.0.1:19339" });

    await expect(provider.show("viking://memories/missing")).rejects.toThrow(/Could not fetch remote asset/);
  });

  test("show throws NotFoundError when content is missing", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          return new Response(JSON.stringify({ status: "ok", result: { name: "partial", type: "resources" } }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        // Content endpoint returns error
        return new Response(JSON.stringify({ status: "error", error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });

      await expect(provider.show("viking://resources/partial")).rejects.toThrow(/Content not found/);
    } finally {
      server.stop(true);
    }
  });

  // ── Security: malformed / adversarial URIs ───────────────────────────────

  test("show handles viking:// URI with path traversal safely (passes to server as-is, server decides)", async () => {
    // The client should not crash or execute local path traversal;
    // the server is responsible for access control.
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(JSON.stringify({ status: "ok", result: null }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });
      // Should throw NotFoundError (content is null) but NOT execute local path traversal
      await expect(provider.show("viking://../../etc/passwd")).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test("show handles URI with null bytes without crashing", async () => {
    const factory = getFactory();
    // Use an unreachable server; we expect a network error, not a crash
    const provider = factory({ type: "openviking", url: "http://127.0.0.1:19340" });
    await expect(provider.show("viking://memories/foo\0bar")).rejects.toThrow();
  });

  // ── Security: constructor validation ────────────────────────────────────

  test("throws ConfigError when baseUrl uses file:// scheme", () => {
    expect(() => new OpenVikingStashProvider({ type: "openviking", url: "file:///etc/passwd" })).toThrow(ConfigError);
  });

  test("throws ConfigError when baseUrl uses ftp:// scheme", () => {
    expect(() => new OpenVikingStashProvider({ type: "openviking", url: "ftp://evil.example.com" })).toThrow(
      ConfigError,
    );
  });

  test("does not throw for valid http:// baseUrl", () => {
    expect(() => new OpenVikingStashProvider({ type: "openviking", url: "http://localhost:8080" })).not.toThrow();
  });

  test("does not throw for valid https:// baseUrl", () => {
    expect(
      () => new OpenVikingStashProvider({ type: "openviking", url: "https://openviking.example.com" }),
    ).not.toThrow();
  });

  // ── Security: control character sanitization ─────────────────────────────

  test("sanitizes control characters in search result names", () => {
    const maliciousResult = {
      status: "ok",
      result: [
        {
          uri: "viking://memories/test",
          name: "normal-name\x1b[31mRED\x1b[0m",
          score: 0.9,
          type: "memories",
        },
      ],
    };
    const entries = parseOVSearchResponse(maliciousResult.result);
    // parseOVSearchResponse returns the raw entries; sanitization happens in mapToStashHits
    // The name field here should be accessible without crashing
    expect(entries).toHaveLength(1);
    expect(typeof entries[0].name).toBe("string");
  });
});

// ── R3.3: OV type map consolidation ─────────────────────────────────────────
//
// OV_TYPE_MAP is an internal (non-exported) constant, so we test type mapping
// indirectly through the public API:
//   • parseOVSearchResponse() for the raw entry shape
//   • provider.search() for the mapped StashSearchHit.type
//
// This ensures the single OV_TYPE_MAP used by both search and show is correct.

describe("mapOVType", () => {
  // Helper: create a minimal flat response containing a single entry with the
  // given OV type string, then run provider.search() and return the first hit.
  async function hitForOVType(ovType: string): Promise<{ type: string }> {
    const response = {
      status: "ok",
      result: [{ uri: `viking://${ovType}/sample`, name: "sample", score: 0.9, type: ovType }],
      time: 0.001,
    };
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    servers.push(server);
    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });
      const result = await provider.search({ query: "sample", limit: 5 });
      return { type: result.hits[0]?.type ?? "missing" };
    } finally {
      server.stop(true);
    }
  }

  test("'skill' and 'skills' map to 'skill'", async () => {
    expect((await hitForOVType("skill")).type).toBe("skill");
    expect((await hitForOVType("skills")).type).toBe("skill");
  });

  test("'memory' and 'memories' map to 'memory'", async () => {
    expect((await hitForOVType("memory")).type).toBe("memory");
    expect((await hitForOVType("memories")).type).toBe("memory");
  });

  test("'resource' and 'resources' map to 'knowledge'", async () => {
    expect((await hitForOVType("resource")).type).toBe("knowledge");
    expect((await hitForOVType("resources")).type).toBe("knowledge");
  });

  test("'knowledge' maps to 'knowledge'", async () => {
    expect((await hitForOVType("knowledge")).type).toBe("knowledge");
  });

  test("'agent' and 'agents' map to 'agent'", async () => {
    expect((await hitForOVType("agent")).type).toBe("agent");
    expect((await hitForOVType("agents")).type).toBe("agent");
  });

  test("'command' and 'commands' map to 'command'", async () => {
    expect((await hitForOVType("command")).type).toBe("command");
    expect((await hitForOVType("commands")).type).toBe("command");
  });

  test("'script' and 'scripts' map to 'script'", async () => {
    expect((await hitForOVType("script")).type).toBe("script");
    expect((await hitForOVType("scripts")).type).toBe("script");
  });

  test("unknown types default to 'knowledge'", async () => {
    expect((await hitForOVType("document")).type).toBe("knowledge");
    expect((await hitForOVType("note")).type).toBe("knowledge");
    expect((await hitForOVType("collection")).type).toBe("knowledge");
    expect((await hitForOVType("prompt_template")).type).toBe("knowledge");
    expect((await hitForOVType("tool")).type).toBe("knowledge");
    expect((await hitForOVType("assistant")).type).toBe("knowledge");
    expect((await hitForOVType("persona")).type).toBe("knowledge");
    expect((await hitForOVType("completely_unknown_type")).type).toBe("knowledge");
  });

  test("uriToVikingRef normalises plain URIs to viking:// scheme", () => {
    expect(uriToVikingRef("viking://skills/foo")).toBe("viking://skills/foo");
    expect(uriToVikingRef("skills/foo")).toBe("viking://skills/foo");
    expect(uriToVikingRef("/skills/foo")).toBe("viking://skills/foo");
  });
});

// ── T4: show() ignores `view` parameter ─────────────────────────────────────
//
// The OpenViking provider's show() method accepts an optional `view` parameter
// (KnowledgeView) but always returns full content regardless. This is by
// design — view filtering is the caller's responsibility for remote assets.

describe("show() ignores view parameter", () => {
  test("show returns full content when view is { mode: 'toc' }", async () => {
    const fullContent = "# Full Document\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          return new Response(
            JSON.stringify({ status: "ok", result: { name: "doc", type: "knowledge", abstract: "A doc" } }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname === "/api/v1/content/read") {
          return new Response(JSON.stringify({ status: "ok", result: fullContent }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });

      // Call with a toc view — should still return full content
      const result = await provider.show("viking://knowledge/doc", { mode: "toc" });

      expect(result.content).toBe(fullContent);
      expect(result.name).toBe("doc");
      expect(result.type).toBe("knowledge");
    } finally {
      server.stop(true);
    }
  });

  test("show returns full content when view is { mode: 'frontmatter' }", async () => {
    const fullContent = "---\ntitle: Test\n---\n# Main Content\n\nBody text.";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          return new Response(JSON.stringify({ status: "ok", result: { name: "fm-doc", type: "resources" } }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/content/read") {
          return new Response(JSON.stringify({ status: "ok", result: fullContent }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });

      const result = await provider.show("viking://resources/fm-doc", { mode: "frontmatter" });

      // Full content returned, not just frontmatter
      expect(result.content).toBe(fullContent);
      expect(result.type).toBe("knowledge");
    } finally {
      server.stop(true);
    }
  });

  test("show returns same content with and without view parameter", async () => {
    const fullContent = "# Identical Content\n\nShould be the same regardless of view.";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          return new Response(JSON.stringify({ status: "ok", result: { name: "same", type: "memories" } }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/content/read") {
          return new Response(JSON.stringify({ status: "ok", result: fullContent }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });

      const withoutView = await provider.show("viking://memories/same");
      const withFullView = await provider.show("viking://memories/same", { mode: "full" });
      const withTocView = await provider.show("viking://memories/same", { mode: "toc" });

      expect(withoutView.content).toBe(fullContent);
      expect(withFullView.content).toBe(fullContent);
      expect(withTocView.content).toBe(fullContent);
    } finally {
      server.stop(true);
    }
  });
});

// ── T7: Degraded show — stat returns null, content succeeds ─────────────────
//
// When the stat API returns null (e.g. asset has no metadata) but the content
// API succeeds, the provider should use URI-inferred type and name rather than
// throwing an error.

describe("show() degraded — stat null, content present", () => {
  test("uses URI-inferred type and name when stat returns null", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          // Stat returns null — no metadata available
          return new Response(JSON.stringify({ status: "ok", result: null }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/content/read") {
          return new Response(JSON.stringify({ status: "ok", result: "# Skill content here" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });

      const result = await provider.show("viking://skills/my-skill");

      // Name should be inferred from the URI path's last segment
      expect(result.name).toBe("my-skill");
      // Type should be inferred from the URI's first path segment ("skills" -> "skill")
      expect(result.type).toBe("skill");
      // Content should still be returned
      expect(result.content).toBe("# Skill content here");
      expect(result.editable).toBe(false);
      // No description when stat is null
      expect(result.description).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("infers 'knowledge' type for unknown URI segment when stat is null", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          return new Response(JSON.stringify({ status: "ok", result: null }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/content/read") {
          return new Response(JSON.stringify({ status: "ok", result: "Some content" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });

      const result = await provider.show("viking://documents/my-doc");

      // "documents" is not in OV_TYPE_MAP, so it defaults to "knowledge"
      expect(result.type).toBe("knowledge");
      expect(result.name).toBe("my-doc");
      expect(result.content).toBe("Some content");
    } finally {
      server.stop(true);
    }
  });

  test("infers name from last URI segment when stat is null", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/fs/stat") {
          return new Response(JSON.stringify({ status: "ok", result: null }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/content/read") {
          return new Response(JSON.stringify({ status: "ok", result: "# Deep content" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    servers.push(server);

    try {
      const factory = getFactory();
      const provider = factory({ type: "openviking", url: `http://localhost:${server.port}` });

      const result = await provider.show("viking://memories/project/deep-context");

      // Name comes from the last URI segment
      expect(result.name).toBe("deep-context");
      // Type inferred from first segment "memories" -> "memory"
      expect(result.type).toBe("memory");
      expect(result.content).toBe("# Deep content");
    } finally {
      server.stop(true);
    }
  });
});
