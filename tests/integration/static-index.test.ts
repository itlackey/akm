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
import { resolveProviderFactory } from "../../src/registry/factory";
import type { RegistryProvider } from "../../src/registry/providers/types";
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

const createdTmpDirs: string[] = [];
const servers: Array<{ stop: (force: boolean) => void }> = [];

function _createTmpDir(prefix = "akm-static-index-"): string {
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

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  envCleanup = cacheResult.cleanup;
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
  envCleanup();
  envCleanup = () => {};
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

  describe("registry version contract", () => {
    test("version 3 index parses without warnings (canonical format)", async () => {
      const srv = serveJson(FIXTURE_INDEX); // FIXTURE_INDEX has version: 3
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "agent", limit: 10 });
      expect(result.warnings ?? []).toHaveLength(0);
      expect(result.hits.length).toBeGreaterThan(0);
    });

    test("version 2 index parses without warnings (live official registry format)", async () => {
      const v2Index = { ...FIXTURE_INDEX, version: 2 };
      const srv = serveJson(v2Index);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "agent", limit: 10 });
      expect(result.warnings ?? []).toHaveLength(0);
      expect(result.hits.length).toBeGreaterThan(0);
    });

    test("version 2 index returns correct kit hits", async () => {
      const v2Index = { ...FIXTURE_INDEX, version: 2 };
      const srv = serveJson(v2Index);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "agent", limit: 10 });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.some((h) => h.id === "github:vercel-labs/agent-skills")).toBe(true);
    });

    test("version 1 index returns null (unsupported)", async () => {
      // version 1 is explicitly unsupported per schema comment
      const v1Index = { ...FIXTURE_INDEX, version: 1 };
      const srv = serveJson(v1Index);
      const provider = makeProvider(srv.url);
      const result = await provider.search({ query: "agent", limit: 10 });
      // No hits because the parser returns null for unsupported versions
      expect(result.hits).toHaveLength(0);
    });
  });
});
