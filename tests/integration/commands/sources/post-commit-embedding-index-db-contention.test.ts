// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression, fix-contention-labels field follow-up, defect 2:
 * `runPostCommitEmbeddingPass` (src/commands/sources/installed-stashes.ts,
 * `akm bundle update`'s post-commit embedding pass) used to build its
 * user-facing warning straight from the raw thrown error —
 * `error instanceof Error ? error.message : String(error)` — so a
 * contention-shaped failure from its first statement, `openIndexDatabase`
 * (whose `init` runs `ensureSchema` and writes even on an already-canonical
 * database), read verbatim as
 * "[akm bundle update] post-commit embedding pass failed: database is locked"
 * instead of reporting index.db contention.
 *
 * Drives the REAL `akmUpdate` coordinator end to end (mirroring
 * tests/integration/bundle-update-embedding-durability.test.ts's harness:
 * a managed npm-style bundle, a mocked `syncFromRef`, a real index.db), then
 * arranges for a second raw connection to hold `BEGIN IMMEDIATE` on index.db
 * at the exact moment `runPostCommitEmbeddingPass`'s own
 * `openIndexDatabase(getDbPath(), ...)` call runs — distinguished from the
 * coordinator's OWN earlier `openIndexDatabase` call (which always passes a
 * `beforeSchema` option this one never does) — reproducing the skeptic's
 * exact scenario, and captures the literal text handed to `warn(...)`.
 * `SQLITE_BUSY_TIMEOUT_MS` (30s) is applied inside that same open call before
 * this test can intervene, so — unlike the defect-1 regression — this one
 * cannot be sped up without touching that shared constant; it is expected to
 * take on the order of 30s, matching
 * tests/integration/commands/sources/index-db-contention.test.ts's own
 * documented floor for the same reason.
 *
 * Lives under tests/integration/ (AGENTS.md classification rule): a real
 * process-wide coordinator run, two real index.db connections.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { akmUpdate } from "../../../../src/commands/sources/installed-stashes";
import { saveConfig } from "../../../../src/core/config/config";
import { getDbPath, getRegistryCacheDir } from "../../../../src/core/paths";
import * as warnModule from "../../../../src/core/warn";
import { akmIndex } from "../../../../src/indexer/indexer";
import * as syncFromRefModule from "../../../../src/sources/providers/sync-from-ref";
import type { Database } from "../../../../src/storage/database";
import * as indexConnectionModule from "../../../../src/storage/repositories/index-connection";
import { seedLockEntries } from "../../../_helpers/lockfile";
import { writeMarkdownFiles } from "../../../_helpers/markdown-fixtures";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

describe("akm bundle update: post-commit embedding pass warning under real index.db contention", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    storage.cleanup();
  });

  test("reports index.db contention, never the raw driver text, when a second connection holds BEGIN IMMEDIATE at the post-commit open", async () => {
    const id = "post-commit-contention-probe";
    const cacheDir = path.join(getRegistryCacheDir(), `${id}-cache`);
    const contentDir = path.join(cacheDir, "content");
    writeMarkdownFiles(contentDir, 3, "seed");
    saveConfig({
      semanticSearchMode: "auto",
      embedding: { dimension: 4 },
      bundles: { [id]: { npm: id, components: { main: { root: ".", adapter: "akm", writable: false } } } },
    });
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
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      const cacheRootDir = (options as { cacheRootDir?: string } | undefined)?.cacheRootDir;
      if (!cacheRootDir) throw new Error("update did not provide an isolated cacheRootDir");
      const updatedCacheDir = path.join(cacheRootDir, `${id}-cache`);
      const updatedContentDir = path.join(updatedCacheDir, "content");
      writeMarkdownFiles(updatedContentDir, 3, "updated");
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

    const realOpenIndexDatabase = indexConnectionModule.openIndexDatabase;
    let holder: Database | undefined;
    const openSpy = spyOn(indexConnectionModule, "openIndexDatabase").mockImplementation((...args) => {
      const opts = args[1] as { beforeSchema?: unknown } | undefined;
      if (opts?.beforeSchema) {
        // The coordinator's OWN open (openUnifiedUpdateTransaction) — pass through untouched.
        return realOpenIndexDatabase(...(args as Parameters<typeof realOpenIndexDatabase>));
      }
      // This is runPostCommitEmbeddingPass's own open, reached AFTER the
      // coordinator has already committed and closed its transaction. Grab a
      // real second connection's BEGIN IMMEDIATE right now, so the call this
      // delegates to below genuinely contends against it.
      holder = realOpenIndexDatabase(getDbPath());
      holder.exec("BEGIN IMMEDIATE");
      return realOpenIndexDatabase(...(args as Parameters<typeof realOpenIndexDatabase>));
    });

    const warnSpy = spyOn(warnModule, "warn");

    try {
      const result = await akmUpdate({ target: id, stashDir: storage.stashDir });
      // Defect 2's whole point: this does NOT throw — the update itself
      // still succeeds; only the embedding verification degrades.
      expect(result.index.semanticStatus).toBe("blocked");

      const postCommitWarnings = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("post-commit embedding pass failed"));
      expect(postCommitWarnings.length).toBe(1);
      const warnLine = postCommitWarnings[0] as string;

      expect(warnLine).toContain("akm's index database is busy");
      expect(warnLine).toContain("retry shortly");
      // The exact regression this guards: before the fix, the raw driver
      // text leaked straight into this line instead.
      expect(warnLine).not.toContain("database is locked");
    } finally {
      try {
        holder?.exec("ROLLBACK");
      } catch {
        // best-effort
      }
      try {
        holder?.close();
      } catch {
        // best-effort
      }
      openSpy.mockRestore();
      warnSpy.mockRestore();
      syncSpy.mockRestore();
    }
  }, 45_000);
});
