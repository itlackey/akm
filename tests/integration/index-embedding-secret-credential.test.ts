// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #953 — `akm index`'s embedding requests must carry the
 * `secret://` store-resolved credential, the same way `akm improve`'s
 * consolidate path already does (see the last describe block below, the
 * known-good control).
 *
 * A field run with `secret://lab-api-key` on `embedding.apiKey` and
 * `LAB_API_KEY` deliberately absent from the environment reportedly sent
 * every embedding request with NO Authorization header at all — silently,
 * not as a resolution error. This suite reproduces the standalone `akm
 * index` materializer path in-process AND as a real CLI child process
 * (since the field failure was specifically the CLI), plus every other path
 * that reaches `RemoteEmbedder`: an `extends`-inherited apiKey with adapter
 * detection persisting mid-run (#945); `akm bundle update`'s post-commit
 * embedding pass (`runPostCommitEmbeddingPass`, reached via `akmUpdate`);
 * the `remember` write path (`indexWrittenAssets`, which calls
 * `generateEmbeddingsForDb` at its own fresh `loadConfig()`); and the
 * improve consolidate path as the known-good control.
 *
 * Every request the mock server sees is asserted to carry the resolved
 * `Authorization` header — none of the variants below reproduced a keyless
 * request against the code as it stands (see the #953 entry in the 0.9.15
 * "Added" section of CHANGELOG.md for what was actually found); this suite
 * pins that as a regression guard.
 *
 * Integration-classified (ORG-03/04/05/06): drives a real `akm index` run
 * against a real index.db and a real HTTP mock server, and one variant
 * spawns a real child process.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { setSecret } from "../../src/commands/env/secret";
import { akmUpdate } from "../../src/commands/sources/installed-stashes";
import { resetConfigCache } from "../../src/core/config/config";
import { getRegistryCacheDir } from "../../src/core/paths";
import { indexWrittenAssets } from "../../src/indexer/index-written-assets";
import { akmIndex } from "../../src/indexer/indexer";
import { clearEmbeddingCache } from "../../src/llm/embedders/cache";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";
import { seedLockEntries } from "../_helpers/lockfile";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

/** Absolute path to the repo's CLI entrypoint, for the child-process variant. */
const CLI_ENTRYPOINT = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

function createAuthCapturingEmbeddingServer(): {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  authHeaders: (string | null)[];
} {
  const authHeaders: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      authHeaders.push(request.headers.get("authorization"));
      const body = (await request.json()) as { input: string[] };
      const data = body.input.map((_t, i) => ({ embedding: [1, 0, 0, 0], index: i }));
      return new Response(JSON.stringify({ data, model: "mock", usage: {} }), {
        headers: { "Content-Type": "application/json", Connection: "close" },
      });
    },
  });
  return { url: `http://localhost:${server.port}`, server, authHeaders };
}

/** Every captured request's Authorization header must equal `expected`, and at least one request must have happened. */
function expectEveryRequestCarriedCredential(authHeaders: (string | null)[], expected: string): void {
  expect(authHeaders.length).toBeGreaterThan(0);
  for (const header of authHeaders) {
    expect(header).toBe(expected);
  }
}

describe("akm index embedding requests carry the secret:// credential (#953)", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    clearEmbeddingCache();
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
    resetConfigCache();
  });

  function writeMemory(name: string, body: string): void {
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", name),
      `---\ndescription: ${name}\n---\n\n${body}\n`,
      "utf8",
    );
  }

  test("in-process akmIndex({ full: true }) sends Bearer <store value> on every embedding request", async () => {
    setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("store-secret-value"));

    const capture = createAuthCapturingEmbeddingServer();
    server = capture.server;

    writeMemory("entry-1.md", "First memory entry for the credential test.");
    writeMemory("entry-2.md", "Second memory entry for the credential test.");

    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      embedding: { endpoint: capture.url, model: "mock", dimension: 8, apiKey: "secret://lab-api-key" },
    });
    resetConfigCache();

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(result.verification.ok).toBe(true);
    expectEveryRequestCarriedCredential(capture.authHeaders, "Bearer store-secret-value");
  });

  test("the real CLI child process (`bun src/cli.ts index --full`) sends Bearer <store value> too", async () => {
    setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("cli-store-secret-value"));

    const capture = createAuthCapturingEmbeddingServer();
    server = capture.server;

    writeMemory("entry-1.md", "First memory entry for the CLI credential test.");

    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      embedding: { endpoint: capture.url, model: "mock", dimension: 8, apiKey: "secret://lab-api-key" },
    });

    // A child process inherits nothing about the current test's in-memory
    // config cache — this is the real reproduction of "the field failure was
    // the CLI": a fresh process, real env vars, real config-on-disk read.
    // MUST be an ASYNC spawn (Bun.spawn), not spawnSync: the mock server
    // above runs on this same process's event loop, and a synchronous
    // spawnSync would block that loop and starve the server of the very
    // requests this test is waiting for.
    const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    delete childEnv.LAB_API_KEY;
    delete childEnv.AKM_EMBED_API_KEY;

    const child = Bun.spawn(["bun", CLI_ENTRYPOINT, "index", "--full"], {
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    expect(exitCode).toBe(0);
    expectEveryRequestCarriedCredential(capture.authHeaders, "Bearer cli-store-secret-value");
    void stderr; // available for debugging on failure; not asserted on
  }, 60_000);

  test("an apiKey inherited via `extends`, with adapter detection persisting mid-run (#945), still resolves", async () => {
    setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("extends-store-secret-value"));

    const capture = createAuthCapturingEmbeddingServer();
    server = capture.server;

    writeMemory("entry-1.md", "Entry for the extends-inherited apiKey test.");

    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    if (!xdgConfigHome) throw new Error("XDG_CONFIG_HOME must be set by withIsolatedAkmStorage()");
    const baseConfigPath = path.join(xdgConfigHome, "akm", "base-config.json");
    fs.writeFileSync(
      baseConfigPath,
      `${JSON.stringify(
        {
          configVersion: "0.9.0",
          embedding: { endpoint: capture.url, model: "mock", dimension: 8, apiKey: "secret://lab-api-key" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // The local file only sets `extends` and the source `bundles` block — no
    // adapter is declared on the filesystem source, so
    // detectAndPersistBundleAdapters must run a real mutateConfig round-trip
    // mid-run (the #945 candidate).
    writeSandboxConfig({
      extends: baseConfigPath,
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    });
    resetConfigCache();

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(result.configUpdated?.detectedAdapters).toEqual({ stash: "akm" });
    expect(result.verification.ok).toBe(true);
    expectEveryRequestCarriedCredential(capture.authHeaders, "Bearer extends-store-secret-value");

    // #945: the local file must still not have baked in the inherited
    // `embedding` block just because a run happened to touch config.json.
    const localRaw = JSON.parse(fs.readFileSync(path.join(xdgConfigHome, "akm", "config.json"), "utf8"));
    expect(localRaw.embedding).toBeUndefined();
  });
});

describe("akm bundle update: post-commit embedding pass carries the secret:// credential (#953)", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    clearEmbeddingCache();
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
    resetConfigCache();
  });

  /** Write `count` markdown files under `contentDir/knowledge/` so the bundle has something to embed. */
  function writeMarkdownFiles(contentDir: string, count: number, marker: string): void {
    const dir = path.join(contentDir, "knowledge");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(
        path.join(dir, `entry-${i}.md`),
        `---\ndescription: ${marker} entry ${i}\n---\n\nContent for ${marker} entry ${i}.\n`,
        "utf8",
      );
    }
  }

  test("runPostCommitEmbeddingPass (reached via akmUpdate) sends Bearer <store value> on every embedding request", async () => {
    setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("bundle-update-store-secret-value"));

    const capture = createAuthCapturingEmbeddingServer();
    server = capture.server;

    const id = "credential-probe";
    const cacheDir = path.join(getRegistryCacheDir(), `${id}-cache`);
    const contentDir = path.join(cacheDir, "content");
    writeMarkdownFiles(contentDir, 2, "seed");

    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: {
        [id]: { npm: id, components: { main: { root: ".", adapter: "akm", writable: false } } },
      },
      embedding: { endpoint: capture.url, model: "mock", dimension: 8, apiKey: "secret://lab-api-key" },
    });
    resetConfigCache();
    seedLockEntries([
      {
        id,
        source: "npm",
        ref: `npm:${id}`,
        resolvedVersion: "1.0.0",
        localRoot: contentDir,
        installedAt: "2026-08-18T00:00:00.000Z",
      },
    ]);

    // Establish the index first — the post-commit pass under test only runs
    // as part of `akmUpdate`, not this seed run.
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });
    // Isolate the assertion below to requests made by the update's post-commit
    // pass, not the seed run above (which the real fix also credentials, but
    // that path is already covered by the in-process akmIndex variant).
    capture.authHeaders.length = 0;

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      const cacheRootDir = options?.cacheRootDir;
      if (!cacheRootDir) throw new Error("update did not provide an isolated cacheRootDir");
      const updatedCacheDir = path.join(cacheRootDir, `${id}-cache`);
      const updatedContentDir = path.join(updatedCacheDir, "content");
      writeMarkdownFiles(updatedContentDir, 2, "updated");
      return {
        id,
        source: "npm",
        ref: `npm:${id}`,
        artifactUrl: `https://registry.example/${id}.tgz`,
        resolvedVersion: "2.0.0",
        contentDir: updatedContentDir,
        cacheDir: updatedCacheDir,
        extractedDir: updatedContentDir,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: false,
      };
    });

    try {
      const result = await akmUpdate({ target: id, stashDir: storage.stashDir });

      expect(result.index.semanticStatus).toBeDefined();
      expect(["ready-vec", "ready-js"]).toContain(result.index.semanticStatus as string);
      expectEveryRequestCarriedCredential(capture.authHeaders, "Bearer bundle-update-store-secret-value");
    } finally {
      syncSpy.mockRestore();
    }
  });
});

describe("akm remember write path: indexWrittenAssets carries the secret:// credential (#953)", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    clearEmbeddingCache();
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
    resetConfigCache();
  });

  test("generateEmbeddingsForDb, called at indexWrittenAssets's own fresh loadConfig(), sends Bearer <store value>", async () => {
    setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("remember-store-secret-value"));

    const capture = createAuthCapturingEmbeddingServer();
    server = capture.server;

    fs.writeFileSync(
      path.join(storage.stashDir, "memories", "seed-memory.md"),
      "---\ndescription: seed-memory\n---\n\nSeed memory so the index is non-empty before the write-path call.\n",
      "utf8",
    );

    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      embedding: { endpoint: capture.url, model: "mock", dimension: 8, apiKey: "secret://lab-api-key" },
    });
    resetConfigCache();

    // Establish the index via a normal full run first (already covered by the
    // in-process akmIndex variant above) — the assertion below isolates the
    // write path's OWN fresh `loadConfig()` call inside `indexWrittenAssets`,
    // reached via `generateEmbeddingsForDb`, not this seed run.
    await akmIndex({ stashDir: storage.stashDir, full: true });
    capture.authHeaders.length = 0;

    const filePath = path.join(storage.stashDir, "memories", "remembered-entry.md");
    fs.writeFileSync(
      filePath,
      "---\ndescription: remembered-entry\n---\n\nA newly remembered entry to embed via the write path.\n",
      "utf8",
    );

    expect(await indexWrittenAssets(storage.stashDir, [filePath])).toBe(true);
    expectEveryRequestCarriedCredential(capture.authHeaders, "Bearer remember-store-secret-value");
  });
});

describe("known-good control: improve consolidate's embedding path (#953)", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    clearEmbeddingCache();
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
    resetConfigCache();
  });

  test("embedBatch(texts, config.embedding, ...) from the improve consolidate call shape sends Bearer <store value>", async () => {
    setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("consolidate-store-secret-value"));

    const capture = createAuthCapturingEmbeddingServer();
    server = capture.server;

    writeSandboxConfig({
      embedding: { endpoint: capture.url, model: "mock", dimension: 8, apiKey: "secret://lab-api-key" },
    });
    resetConfigCache();

    const { loadConfig } = await import("../../src/core/config/config");
    const { embedBatch } = await import("../../src/llm/embedder");
    const config = loadConfig();
    const vectors = await embedBatch(["consolidate control text"], config.embedding);

    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toBeDefined();
    expectEveryRequestCarriedCredential(capture.authHeaders, "Bearer consolidate-store-secret-value");
  });
});
