/**
 * R5 characterization (RED/contract) — pins the CURRENT observable behavior of
 * the install-ref grammar (`buildInstallRef`, currently a private function in
 * `src/registry/providers/static-index.ts`) that the R5 refactor must preserve
 * byte-for-byte while it (a) moves `buildInstallRef` to `resolve.ts`,
 * (b) tightens its `source` param from `string` to the 4-member `InstallKind`,
 * and (c) rewrites the `default: -> github:` arm as an explicit `case "github"`.
 *
 * `buildInstallRef` is NOT exported today, so it is pinned INDIRECTLY through the
 * public `RegistryProvider.search()` seam: each search hit's `installRef` is
 * `buildInstallRef(stash.source, stash.ref)` (static-index.ts:252). `asSource()`
 * (static-index.ts:366) only admits the 4-set {npm,github,git,local}, so a
 * fixture stash with one of those `source` values drives exactly one
 * `buildInstallRef` branch.
 *
 * The four assertions below are the behavior contract:
 *   npm    -> `npm:<ref>`
 *   git    -> `git+<ref>`
 *   local  -> `file:<ref>`
 *   github -> `github:<ref>`   (currently the `default:` fallthrough — the only
 *                               4-set value that reaches `default:`)
 *
 * Expected to be GREEN on current code (this is the pin), and to STAY green after
 * the refactor moves+narrows `buildInstallRef`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveProviderFactory } from "../../src/registry/factory";
import type { RegistryProvider } from "../../src/registry/providers/types";
import { type Cleanup, sandboxXdgCacheHome } from "../_helpers/sandbox";

// Trigger self-registration of the static-index provider.
import "../../src/registry/providers/static-index";

// ── Fixture: one stash per install-source kind ───────────────────────────────
// Each stash shares the token "pinme" so a single search() returns all four.

const FIXTURE_INDEX = {
  version: 3,
  updatedAt: "2026-04-25T00:00:00Z",
  stashes: [
    {
      id: "npm:pinme-pkg",
      name: "pinme-npm",
      description: "pinme",
      ref: "pinme-pkg",
      source: "npm",
      tags: ["pinme"],
    },
    {
      id: "git:pinme-git",
      name: "pinme-git",
      description: "pinme",
      ref: "https://example.com/pinme.git",
      source: "git",
      tags: ["pinme"],
    },
    {
      id: "local:pinme-local",
      name: "pinme-local",
      description: "pinme",
      ref: "/abs/path/to/pinme",
      source: "local",
      tags: ["pinme"],
    },
    {
      id: "github:owner/pinme",
      name: "pinme-github",
      description: "pinme",
      ref: "owner/pinme",
      source: "github",
      tags: ["pinme"],
    },
  ],
};

const servers: Array<{ stop: (force: boolean) => void }> = [];

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildInstallRef behavior contract (via RegistryProvider.search installRef)", () => {
  async function installRefFor(id: string): Promise<string | undefined> {
    const srv = serveJson(FIXTURE_INDEX);
    const provider = makeProvider(srv.url);
    const result = await provider.search({ query: "pinme", limit: 10 });
    return result.hits.find((h) => h.id === id)?.installRef;
  }

  test('source "npm" -> "npm:<ref>"', async () => {
    expect(await installRefFor("npm:pinme-pkg")).toBe("npm:pinme-pkg");
  });

  test('source "git" -> "git+<ref>"', async () => {
    expect(await installRefFor("git:pinme-git")).toBe("git+https://example.com/pinme.git");
  });

  test('source "local" -> "file:<ref>"', async () => {
    expect(await installRefFor("local:pinme-local")).toBe("file:/abs/path/to/pinme");
  });

  test('source "github" -> "github:<ref>" (currently the default: fallthrough)', async () => {
    expect(await installRefFor("github:owner/pinme")).toBe("github:owner/pinme");
  });

  test("all four source kinds resolve to distinct, prefixed installRefs in one search", async () => {
    const srv = serveJson(FIXTURE_INDEX);
    const provider = makeProvider(srv.url);
    const result = await provider.search({ query: "pinme", limit: 10 });
    const refs = Object.fromEntries(result.hits.map((h) => [h.source, h.installRef]));
    expect(refs).toEqual({
      npm: "npm:pinme-pkg",
      git: "git+https://example.com/pinme.git",
      local: "file:/abs/path/to/pinme",
      github: "github:owner/pinme",
    });
  });
});
