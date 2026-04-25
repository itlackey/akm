/**
 * Phase 6 (v1 architecture refactor) — parity test.
 *
 * Both built-in registry providers (`static-index`, `skills-sh`) must respond
 * to the same `RegistryProvider` interface methods uniformly. This test fans
 * out the same query through each provider and asserts the call surface is
 * equivalent — never the per-provider scoring or upstream-data shape.
 *
 * If you add a third built-in registry provider, register it here.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProviderFactory } from "../../src/registry/registry-factory";
import type { RegistryProvider } from "../../src/registry/registry-providers/types";
import type { ParsedGithubRef } from "../../src/registry/registry-types";

// Trigger self-registration of every built-in provider
import "../../src/registry/registry-providers/index";

// ── Fixtures ────────────────────────────────────────────────────────────────

const STATIC_INDEX_FIXTURE = {
  version: 3,
  updatedAt: "2026-04-25T00:00:00Z",
  stashes: [
    {
      id: "github:acme/widgets",
      name: "widgets",
      description: "Widget skills",
      ref: "acme/widgets",
      source: "github",
      tags: ["widget"],
      assetTypes: ["skill"],
      assets: [{ type: "skill", name: "widget-deploy" }],
    },
  ],
};

const SKILLS_SH_FIXTURE = {
  skills: [
    {
      id: "acme/widgets/widget-deploy",
      name: "widget-deploy",
      installs: 100,
      source: "acme/widgets",
    },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const createdTmpDirs: string[] = [];
const servers: Array<{ stop: (force: boolean) => void }> = [];

function createTmpDir(prefix = "akm-parity-"): string {
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
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = createTmpDir("akm-parity-cache-");
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

// ── Provider factory ────────────────────────────────────────────────────────

interface ProviderHarness {
  type: string;
  build: () => RegistryProvider;
}

function buildHarnesses(): ProviderHarness[] {
  return [
    {
      type: "static-index",
      build: () => {
        const srv = serveJson(STATIC_INDEX_FIXTURE);
        const factory = resolveProviderFactory("static-index");
        if (!factory) throw new Error("static-index not registered");
        return factory({ url: `${srv.url}/index.json`, name: "official" });
      },
    },
    {
      type: "skills-sh",
      build: () => {
        const srv = serveJson(SKILLS_SH_FIXTURE);
        const factory = resolveProviderFactory("skills-sh");
        if (!factory) throw new Error("skills-sh not registered");
        return factory({ url: srv.url, name: "skills.sh" });
      },
    },
  ];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("RegistryProvider parity (built-in providers)", () => {
  for (const harness of buildHarnesses()) {
    describe(harness.type, () => {
      test("exposes the v1-spec interface methods", () => {
        const provider = harness.build();
        expect(typeof provider.search).toBe("function");
        expect(typeof provider.searchKits).toBe("function");
        expect(typeof provider.getKit).toBe("function");
        expect(typeof provider.canHandle).toBe("function");
        // searchAssets is optional, but both built-ins implement it
        expect(typeof provider.searchAssets).toBe("function");
      });

      test("searchKits returns KitResult-shaped entries", async () => {
        const provider = harness.build();
        const kits = await provider.searchKits({ text: "widget", limit: 10 });
        expect(Array.isArray(kits)).toBe(true);
        for (const kit of kits) {
          expect(typeof kit.id).toBe("string");
          expect(typeof kit.title).toBe("string");
          expect(typeof kit.installRef).toBe("string");
        }
      });

      test("canHandle accepts a github ref without throwing", () => {
        const provider = harness.build();
        const ref: ParsedGithubRef = {
          source: "github",
          ref: "acme/widgets",
          id: "github:acme/widgets",
          owner: "acme",
          repo: "widgets",
        };
        // Result is provider-specific; we only assert the call shape.
        const handled = provider.canHandle(ref);
        expect(typeof handled).toBe("boolean");
      });

      test("getKit returns a manifest or null without throwing", async () => {
        const provider = harness.build();
        const result = await provider.getKit("github:acme/widgets");
        if (result !== null) {
          expect(typeof result.id).toBe("string");
          expect(typeof result.installRef).toBe("string");
        }
      });
    });
  }

  test("first provider whose canHandle matches owns the install ref", () => {
    // Smoke test for the orchestrator pattern in commands/add.ts (post-Phase 6).
    // The order of factory registration (static-index → skills-sh) means
    // static-index claims github refs first as the catch-all.
    const types = ["static-index", "skills-sh"];
    const ref: ParsedGithubRef = {
      source: "github",
      ref: "acme/widgets",
      id: "github:acme/widgets",
      owner: "acme",
      repo: "widgets",
    };

    let owner: string | undefined;
    for (const type of types) {
      const factory = resolveProviderFactory(type);
      expect(factory).not.toBeNull();
      // Use a dummy URL — canHandle is pure dispatch on ref shape, not network.
      const provider = factory?.({ url: "http://localhost:0/none", name: type });
      if (provider?.canHandle(ref)) {
        owner = provider.type;
        break;
      }
    }
    expect(owner).toBeDefined();
  });
});
