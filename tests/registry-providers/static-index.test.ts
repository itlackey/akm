/**
 * Phase 6 (v1 architecture refactor) — coverage for the `static-index`
 * registry provider exercised through the full `RegistryProvider` interface
 * (`search`, `searchKits`, `searchAssets`, `getKit`, `canHandle`).
 *
 * These tests are intentionally siloed from the orchestrator-level tests in
 * `tests/registry-search.test.ts`: they hit the provider directly to make sure
 * the v1-spec §3.1 surface contracts hold for the default provider.
 *
 * #664 Seam 1: providers receive an injected `fetch` (RegistryProviderDeps), so
 * these tests stand up no `Bun.serve` — the fake fetch returns the index JSON
 * directly and the non-routable endpoint is never contacted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HttpClient } from "../../src/core/common";
import { resolveProviderFactory } from "../../src/registry/factory";
import type { RegistryProvider } from "../../src/registry/providers/types";
import type { ParsedGithubRef, ParsedNpmRef } from "../../src/registry/types";
import { type Cleanup, sandboxXdgCacheHome } from "../_helpers/sandbox";

// Trigger self-registration
import "../../src/registry/providers/static-index";

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

/** A fake HttpClient that serves `body` as JSON for any request. */
function fakeFetch(body: unknown): HttpClient {
  return async () =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
}

// The registry index is cached by URL in index.db, so each provider gets a
// unique (non-routable) endpoint to keep per-test indexes from colliding in the
// cache. The injected fetch never connects, so the host need not resolve.
let urlSeq = 0;

/** Build a static-index provider whose injected fetch returns `index`. */
function makeProvider(index: unknown, name = "official"): RegistryProvider {
  const factory = resolveProviderFactory("static-index");
  if (!factory) throw new Error("static-index provider not registered");
  const url = `http://test.local/index-${urlSeq++}.json`;
  return factory({ url, name }, { fetch: fakeFetch(index) });
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  envCleanup = cacheResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("StaticIndexProvider", () => {
  test("factory is registered", () => {
    expect(resolveProviderFactory("static-index")).not.toBeNull();
  });

  describe("searchKits (v1-spec §3.1)", () => {
    test("returns KitResult entries with installRef", async () => {
      const provider = makeProvider(FIXTURE_INDEX);
      const kits = await provider.searchKits({ text: "skills", limit: 10 });
      expect(kits.length).toBeGreaterThan(0);
      for (const kit of kits) {
        expect(typeof kit.id).toBe("string");
        expect(typeof kit.title).toBe("string");
        expect(typeof kit.installRef).toBe("string");
      }
    });

    test("kit installRef is a valid akm add target", async () => {
      const provider = makeProvider(FIXTURE_INDEX);
      const kits = await provider.searchKits({ text: "agent", limit: 10 });
      const githubKit = kits.find((k) => k.id.startsWith("github:"));
      expect(githubKit?.installRef).toBe("github:vercel-labs/agent-skills");
    });

    test("respects limit", async () => {
      const provider = makeProvider(FIXTURE_INDEX);
      const kits = await provider.searchKits({ text: "agent skills opencode", limit: 1 });
      expect(kits.length).toBeLessThanOrEqual(1);
    });
  });

  describe("searchAssets (v1-spec §3.1)", () => {
    test("returns AssetPreview entries scoped to kits", async () => {
      const provider = makeProvider(FIXTURE_INDEX);
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
      const provider = makeProvider(FIXTURE_INDEX);
      const manifest = await provider.getKit("github:vercel-labs/agent-skills");
      expect(manifest).not.toBeNull();
      expect(manifest?.id).toBe("github:vercel-labs/agent-skills");
      expect(manifest?.installRef).toBe("github:vercel-labs/agent-skills");
      expect(manifest?.assets?.length ?? 0).toBeGreaterThan(0);
    });

    test("returns null for an unknown id", async () => {
      const provider = makeProvider(FIXTURE_INDEX);
      const manifest = await provider.getKit("github:does-not-exist/anywhere");
      expect(manifest).toBeNull();
    });

    test("preserves npm install refs", async () => {
      const provider = makeProvider(FIXTURE_INDEX);
      const manifest = await provider.getKit("npm:@itlackey/openkit");
      expect(manifest?.installRef).toBe("npm:@itlackey/openkit");
    });
  });

  describe("canHandle (plan §9 item 2)", () => {
    test("claims github refs", () => {
      const provider = makeProvider({ stashes: [] });
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
      const provider = makeProvider({ stashes: [] });
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
      const provider = makeProvider(FIXTURE_INDEX);
      const result = await provider.search({ query: "agent", limit: 10 });
      expect(Array.isArray(result.hits)).toBe(true);
      const hit = result.hits.find((h) => h.id === "github:vercel-labs/agent-skills");
      expect(hit?.installRef).toBe("github:vercel-labs/agent-skills");
    });
  });

  describe("registry version contract", () => {
    test("version 3 index parses without warnings (canonical format)", async () => {
      const provider = makeProvider(FIXTURE_INDEX); // FIXTURE_INDEX has version: 3
      const result = await provider.search({ query: "agent", limit: 10 });
      expect(result.warnings ?? []).toHaveLength(0);
      expect(result.hits.length).toBeGreaterThan(0);
    });

    test("version 2 index parses without warnings (live official registry format)", async () => {
      const provider = makeProvider({ ...FIXTURE_INDEX, version: 2 });
      const result = await provider.search({ query: "agent", limit: 10 });
      expect(result.warnings ?? []).toHaveLength(0);
      expect(result.hits.length).toBeGreaterThan(0);
    });

    test("version 2 index returns correct kit hits", async () => {
      const provider = makeProvider({ ...FIXTURE_INDEX, version: 2 });
      const kits = await provider.searchKits({ text: "agent", limit: 10 });
      expect(kits.length).toBeGreaterThan(0);
      expect(kits.some((k) => k.id === "github:vercel-labs/agent-skills")).toBe(true);
    });

    test("version 1 index returns null (unsupported)", async () => {
      // version 1 is explicitly unsupported per schema comment
      const provider = makeProvider({ ...FIXTURE_INDEX, version: 1 });
      const result = await provider.search({ query: "agent", limit: 10 });
      // No hits because the parser returns null for unsupported versions
      expect(result.hits).toHaveLength(0);
    });
  });
});
