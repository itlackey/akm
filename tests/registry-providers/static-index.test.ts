/**
 * Phase 6 (v1 architecture refactor) — coverage for the `static-index`
 * registry provider exercised through the full `RegistryProvider` interface
 * (`search`, `searchKits`, `searchAssets`, `getKit`, `canHandle`).
 *
 * These tests are intentionally siloed from the orchestrator-level tests in
 * `tests/registry-search.test.ts`: they hit the provider directly to make sure
 * the v1-spec §3.1 surface contracts hold for the default provider.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProviderFactory } from "../../src/registry/registry-factory";
import type { RegistryProvider } from "../../src/registry/registry-providers/types";
import type { ParsedGithubRef, ParsedNpmRef } from "../../src/registry/registry-types";

// Trigger self-registration
import "../../src/registry/registry-providers/static-index";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURE_INDEX = {
  version: 3,
  updatedAt: "2026-04-25T00:00:00Z",
  stashes: [
    {
      id: "github:vercel-labs/agent-skills",
      name: "agent-skills",
      description: "Production-ready agent skills",
      ref: "vercel-labs/agent-skills",
      source: "github",
      tags: ["agent", "skills"],
      assetTypes: ["skill"],
      assets: [
        { type: "skill", name: "deploy", description: "Deploy to Vercel" },
        { type: "skill", name: "rollback" },
      ],
      author: "vercel-labs",
      latestVersion: "1.0.0",
    },
    {
      id: "npm:@itlackey/openkit",
      name: "@itlackey/openkit",
      description: "OpenCode starter",
      ref: "@itlackey/openkit",
      source: "npm",
      tags: ["opencode", "starter"],
      author: "itlackey",
    },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];
const servers: Array<{ stop: (force: boolean) => void }> = [];

function createTmpDir(prefix = "akm-static-index-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function serveJson(body: unknown): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  servers.push(server);
  return {
    url: `http://localhost:${server.port}/index.json`,
    close: () => server.stop(true),
  };
}

function makeProvider(url: string, name = "official"): RegistryProvider {
  const factory = resolveProviderFactory("static-index");
  if (!factory) throw new Error("static-index provider not registered");
  return factory({ url, name });
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("akm-si-cache-");
});

afterEach(() => {
  for (const s of servers) {
    try {
      s.stop(true);
    } catch {
      /* already stopped */
    }
  }
  servers.length = 0;

  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("StaticIndexProvider", () => {
  test("factory is registered", () => {
    expect(resolveProviderFactory("static-index")).not.toBeNull();
  });

  describe("searchKits (v1-spec §3.1)", () => {
    test("returns KitResult entries with installRef", async () => {
      const srv = serveJson(FIXTURE_INDEX);
      const provider = makeProvider(srv.url);
      const kits = await provider.searchKits({ text: "skills", limit: 10 });
      expect(kits.length).toBeGreaterThan(0);
      for (const kit of kits) {
        expect(typeof kit.id).toBe("string");
        expect(typeof kit.title).toBe("string");
        expect(typeof kit.installRef).toBe("string");
      }
    });

    test("kit installRef is a valid akm add target", async () => {
      const srv = serveJson(FIXTURE_INDEX);
      const provider = makeProvider(srv.url);
      const kits = await provider.searchKits({ text: "agent", limit: 10 });
      const githubKit = kits.find((k) => k.id.startsWith("github:"));
      expect(githubKit?.installRef).toBe("github:vercel-labs/agent-skills");
    });

    test("respects limit", async () => {
      const srv = serveJson(FIXTURE_INDEX);
      const provider = makeProvider(srv.url);
      const kits = await provider.searchKits({ text: "agent skills opencode", limit: 1 });
      expect(kits.length).toBeLessThanOrEqual(1);
    });
  });

  describe("searchAssets (v1-spec §3.1)", () => {
    test("returns AssetPreview entries scoped to kits", async () => {
      const srv = serveJson(FIXTURE_INDEX);
      const provider = makeProvider(srv.url);
      const assets = await provider.searchAssets?.({ text: "deploy", limit: 10 });
      expect(assets).toBeDefined();
      const deploy = assets?.find((a) => a.name === "deploy");
      expect(deploy?.type).toBe("skill");
      expect(deploy?.kitId).toBe("github:vercel-labs/agent-skills");
      expect(deploy?.cloneRef).toBe("github:vercel-labs/agent-skills");
    });
  });

  describe("getKit (v1-spec §3.1)", () => {
    test("returns a KitManifest for a known id", async () => {
      const srv = serveJson(FIXTURE_INDEX);
      const provider = makeProvider(srv.url);
      const manifest = await provider.getKit("github:vercel-labs/agent-skills");
      expect(manifest).not.toBeNull();
      expect(manifest?.id).toBe("github:vercel-labs/agent-skills");
      expect(manifest?.installRef).toBe("github:vercel-labs/agent-skills");
      expect(manifest?.assets?.length ?? 0).toBeGreaterThan(0);
    });

    test("returns null for an unknown id", async () => {
      const srv = serveJson(FIXTURE_INDEX);
      const provider = makeProvider(srv.url);
      const manifest = await provider.getKit("github:does-not-exist/anywhere");
      expect(manifest).toBeNull();
    });

    test("preserves npm install refs", async () => {
      const srv = serveJson(FIXTURE_INDEX);
      const provider = makeProvider(srv.url);
      const manifest = await provider.getKit("npm:@itlackey/openkit");
      expect(manifest?.installRef).toBe("npm:@itlackey/openkit");
    });
  });

  describe("canHandle (plan §9 item 2)", () => {
    test("claims github refs", () => {
      const srv = serveJson({ stashes: [] });
      const provider = makeProvider(srv.url);
      const ref: ParsedGithubRef = {
        source: "github",
        ref: "owner/repo",
        id: "github:owner/repo",
        owner: "owner",
        repo: "repo",
      };
      expect(provider.canHandle(ref)).toBe(true);
    });

    test("claims npm refs (default catch-all)", () => {
      const srv = serveJson({ stashes: [] });
      const provider = makeProvider(srv.url);
      const ref: ParsedNpmRef = {
        source: "npm",
        ref: "npm:foo",
        id: "npm:foo",
        packageName: "foo",
      };
      expect(provider.canHandle(ref)).toBe(true);
    });
  });

  describe("backwards-compat search", () => {
    test("legacy search() still returns RegistrySearchHit shape", async () => {
      const srv = serveJson(FIXTURE_INDEX);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "agent", limit: 10 });
      expect(Array.isArray(result.hits)).toBe(true);
      const hit = result.hits.find((h) => h.id === "github:vercel-labs/agent-skills");
      expect(hit?.installRef).toBe("github:vercel-labs/agent-skills");
    });
  });
});
