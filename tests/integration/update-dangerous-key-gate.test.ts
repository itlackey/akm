// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { _setClackForTests } from "../../src/cli/clack";
import { akmHealth } from "../../src/commands/health";
import { _setDangerousKeyScannerForTests } from "../../src/commands/sources/dangerous-env-audit";
import { _setUpdateTransactionHookForTests, akmUpdate } from "../../src/commands/sources/installed-stashes";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { getConfigLockPath } from "../../src/core/config/config-io";
import { getConfigPath, getDbPath, getLockfilePath, getRegistryCacheDir } from "../../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { readLockfile } from "../../src/integrations/lockfile";
import * as gitProvider from "../../src/sources/providers/git";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";
import { getWebsiteCachePaths } from "../../src/sources/website-url";
import { openDatabase } from "../../src/storage/database";
import {
  closeDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../src/storage/repositories/index-entries-repository";
import { seedLockEntries } from "../_helpers/lockfile";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  withMockedFetch,
  withTTY,
} from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";
import { pollUntil } from "./_helpers/workflow-crossproc";

const STATE_EVENT_WORKER = path.join(import.meta.dir, "_helpers/update-state-event-worker.ts");

let storage: IsolatedAkmStorage;
const disposers: Array<() => void> = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  storage.cleanup();
});

function makeBundle(prefix: string, env: string, marker: string): string {
  const root = makeSandboxDir(prefix);
  disposers.push(root.cleanup);
  writeBundle(root.dir, env, marker);
  return root.dir;
}

function writeBundle(root: string, env: string, marker: string): void {
  fs.mkdirSync(path.join(root, "env"), { recursive: true });
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(root, "env", "default.env"), env);
  fs.writeFileSync(
    path.join(root, "knowledge", "revision.md"),
    `---\ntype: knowledge\ndescription: Update audit revision ${marker}\n---\n\n# Revision ${marker}\n`,
  );
}

function indexedRows(): Array<{ bundleId: string; filePath: string; ref: string }> {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) return [];
  try {
    return getAllEntries(db)
      .map((row) => ({ bundleId: row.bundleId, filePath: row.filePath, ref: row.itemRef }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  } finally {
    closeDatabase(db);
  }
}

function indexedSearchText(): string {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) return "";
  try {
    return indexedSearchTextFrom(db);
  } finally {
    closeDatabase(db);
  }
}

function indexedSearchTextFrom(db: Parameters<typeof getAllEntries>[0]): string {
  return getAllEntries(db)
    .map((row) => row.searchText)
    .sort()
    .join("\n");
}

function sqliteFileInodes(dbPath: string): Map<string, number> {
  return new Map(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => [filePath, fs.statSync(filePath).ino]),
  );
}

function managedCachePaths(id: string): { cacheDir: string; contentDir: string } {
  const cacheDir = path.join(getRegistryCacheDir(), `${id}-cache`);
  return { cacheDir, contentDir: path.join(cacheDir, "content") };
}

async function configureCanonicalManagedBundle(opts: {
  id: string;
  env: string;
  marker: string;
  source?: "git" | "npm";
  revision?: string;
  adapter?: boolean;
}): Promise<{ cacheDir: string; contentDir: string; ref: string }> {
  const source = opts.source ?? "npm";
  const ref = source === "npm" ? `npm:${opts.id}` : `github:example/${opts.id}`;
  const paths = managedCachePaths(opts.id);
  writeBundle(paths.contentDir, opts.env, opts.marker);
  saveConfig({
    semanticSearchMode: "off",
    bundles: {
      [opts.id]: {
        ...(source === "npm" ? { npm: opts.id } : { git: `https://github.com/example/${opts.id}.git` }),
        components: {
          main: { root: ".", ...(opts.adapter === false ? {} : { adapter: "akm" }), writable: false },
        },
      },
    },
  });
  seedLockEntries([
    {
      id: opts.id,
      source,
      ref,
      ...(source === "npm"
        ? { resolvedVersion: opts.revision ?? "1.0.0" }
        : { resolvedRevision: opts.revision ?? "old-revision" }),
      localRoot: paths.contentDir,
      installedAt: "2026-08-18T00:00:00.000Z",
    },
  ]);
  await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });
  return { ...paths, ref };
}

function stageManagedCandidate(
  cacheRootDir: string,
  opts: {
    id: string;
    env: string;
    marker: string;
    source?: "git" | "npm";
    revision?: string;
  },
): Awaited<ReturnType<typeof syncFromRefModule.syncFromRef>> {
  const source = opts.source ?? "npm";
  const cacheDir = path.join(cacheRootDir, `${opts.id}-cache`);
  const contentDir = path.join(cacheDir, "content");
  writeBundle(contentDir, opts.env, opts.marker);
  return {
    id: opts.id,
    source,
    ref: source === "npm" ? `npm:${opts.id}` : `github:example/${opts.id}`,
    artifactUrl:
      source === "npm" ? `https://registry.example/${opts.id}.tgz` : `https://github.com/example/${opts.id}.git`,
    ...(source === "npm"
      ? { resolvedVersion: opts.revision ?? "2.0.0" }
      : { resolvedRevision: opts.revision ?? "new-revision" }),
    contentDir,
    cacheDir,
    extractedDir: contentDir,
    syncedAt: "2026-08-19T00:00:00.000Z",
    writable: false,
  };
}

function requiredStagingRoot(options: { cacheRootDir?: string } | undefined): string {
  if (!options?.cacheRootDir) throw new Error("update did not provide an isolated cacheRootDir");
  return options.cacheRootDir;
}

function snapshotState(): {
  config: string;
  lock: string | null;
  indexExists: boolean;
  rows: ReturnType<typeof indexedRows>;
  text: string;
} {
  const lockPath = getLockfilePath();
  return {
    config: fs.readFileSync(getConfigPath(), "utf8"),
    lock: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null,
    indexExists: fs.existsSync(getDbPath()),
    rows: indexedRows(),
    text: indexedSearchText(),
  };
}

function expectState(snapshot: ReturnType<typeof snapshotState>): void {
  expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(snapshot.config);
  const lockPath = getLockfilePath();
  expect(fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null).toBe(snapshot.lock);
  expect(fs.existsSync(getDbPath())).toBe(snapshot.indexExists);
  expect(indexedRows()).toEqual(snapshot.rows);
  expect(indexedSearchText()).toBe(snapshot.text);
}

function git(repoDir: string, args: string[]): string {
  const result = gitProvider.runGit(["-C", repoDir, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function initGitBundle(repoDir: string, marker: string): string {
  writeBundle(repoDir, "API_TOKEN=safe\n", marker);
  const init = gitProvider.runGit(["init", repoDir]);
  if (init.status !== 0) throw new Error(init.stderr.trim() || "git init failed");
  git(repoDir, ["config", "user.name", "AKM Update Test"]);
  git(repoDir, ["config", "user.email", "update-test@example.invalid"]);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", marker]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function commitGitMarker(repoDir: string, fileName: string, marker: string): string {
  fs.writeFileSync(path.join(repoDir, fileName), `${marker}\n`);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", marker]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function installPostMergeWriter(repoDir: string, targetPath: string, contents: string): void {
  const hookPath = path.join(repoDir, ".git", "hooks", "post-merge");
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, `#!/bin/sh\nprintf %s ${shellQuote(contents)} > ${shellQuote(targetPath)}\n`);
  fs.chmodSync(hookPath, 0o755);
}

function waitForFileSync(filePath: string, label: string): void {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function countStateEvents(ref: string): number {
  const db = openStateDatabase();
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM events WHERE ref = ?").get(ref) as { count: number }).count;
  } finally {
    db.close();
  }
}

function insertExpiredUsageEvent(ref: string): void {
  const db = openStateDatabase();
  try {
    db.prepare("INSERT INTO usage_events (event_type, entry_ref, source, created_at) VALUES (?, ?, ?, ?)").run(
      "search",
      ref,
      "user",
      "2000-01-01T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
}

function countUsageEvents(ref: string): number {
  const db = openStateDatabase();
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE entry_ref = ?").get(ref) as { count: number })
      .count;
  } finally {
    db.close();
  }
}

describe("akm bundle update dangerous-key gate (#765)", () => {
  test("safe revision -> dangerous revision is rejected before bytes, lock, or index are published", async () => {
    const safeRoot = makeBundle("akm-765-safe-", "API_TOKEN=safe\n", "safe");
    const dangerousRoot = makeBundle(
      "akm-765-dangerous-",
      "# akm-lint-ok: dangerous-env-key\nLD_PRELOAD=/tmp/evil.so\n",
      "dangerous",
    );
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        audited: {
          git: "https://github.com/example/audited.git",
          components: { main: { root: ".", adapter: "akm", writable: false } },
        },
      },
    });
    seedLockEntries([
      {
        id: "audited",
        source: "git",
        ref: "github:example/audited",
        resolvedRevision: "safe-revision",
        localRoot: safeRoot,
        installedAt: "2026-08-18T00:00:00.000Z",
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir });

    const lockBefore = fs.readFileSync(getLockfilePath(), "utf8");
    const indexBefore = indexedRows();
    expect(indexBefore.some((row) => row.filePath.startsWith(safeRoot))).toBe(true);

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "example/audited",
      source: "github",
      ref: "github:example/audited",
      artifactUrl: "https://github.com/example/audited/archive/dangerous-revision.tar.gz",
      resolvedRevision: "dangerous-revision",
      contentDir: dangerousRoot,
      cacheDir: dangerousRoot,
      extractedDir: dangerousRoot,
      syncedAt: "2026-08-19T00:00:00.000Z",
      writable: false,
    });

    try {
      await withTTY(false, async () => {
        await expect(akmUpdate({ target: "audited", stashDir: storage.stashDir, yes: true })).rejects.toMatchObject({
          code: "DANGEROUS_ENV_KEY",
        });
      });
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(safeRoot, "env", "default.env"), "utf8")).toBe("API_TOKEN=safe\n");
    expect(readLockfile().find((entry) => entry.id === "audited")?.resolvedRevision).toBe("safe-revision");
    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(lockBefore);
    expect(indexedRows()).toEqual(indexBefore);
    expect(indexedRows().some((row) => row.filePath.startsWith(dangerousRoot))).toBe(false);
  });

  test("--allow-dangerous-env-keys explicitly approves a staged dangerous same-version npm promotion", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "approved",
      env: "API_TOKEN=old\n",
      marker: "approved-old",
      revision: "1.0.0",
    });
    const expiredRef = "approved//knowledge/expired-state-transaction-probe";
    insertExpiredUsageEvent(expiredRef);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "approved",
        env: "LD_PRELOAD=/reviewed.so\n",
        marker: "approved-new",
        revision: "1.0.0",
      }),
    );

    try {
      const result = await withTTY(false, () =>
        akmUpdate({
          target: "approved",
          stashDir: storage.stashDir,
          force: true,
          yes: true,
          allowDangerousEnvKeys: true,
        }),
      );
      expect(result.processed[0]?.changed.any).toBe(false);
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("LD_PRELOAD=/reviewed.so\n");
    expect(indexedSearchText()).toContain("approved-new");
    expect(indexedSearchText()).not.toContain("approved-old");
    // Finalize purges this row inside the deferred state transaction. Its
    // absence proves the successful update committed that transaction; a
    // second COMMIT would make the update fail rather than reach this point.
    expect(countUsageEvents(expiredRef)).toBe(0);
    const writerAfterCommit = openStateDatabase();
    try {
      writerAfterCommit
        .prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, ?)")
        .run("update", "2026-08-19T00:00:02.000Z", "approved//writer-after-commit", "{}");
    } finally {
      writerAfterCommit.close();
    }
    expect(countStateEvents("approved//writer-after-commit")).toBe(1);
  });

  test("TTY confirmation observes only the old live bytes/lock/index before approving publication", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "interactive",
      env: "API_TOKEN=old\n",
      marker: "interactive-old",
      revision: "old-revision",
      source: "git",
    });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "interactive",
        env: "NODE_OPTIONS=--require=/tmp/evil.js\n",
        marker: "interactive-new",
        revision: "new-revision",
        source: "git",
      }),
    );
    let promptObserved = false;
    overrideSeam(_setClackForTests, {
      isCancel: () => false,
      confirm: async (config: { message: string }) => {
        expect(config.message).toBe("Update anyway?");
        expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
        expectState(before);
        expect(indexedSearchText()).not.toContain("interactive-new");
        promptObserved = true;
        return true;
      },
    });

    try {
      await withTTY(true, () => akmUpdate({ target: "interactive", stashDir: storage.stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(promptObserved).toBe(true);
    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toContain("NODE_OPTIONS");
    expect(readLockfile().find((entry) => entry.id === "interactive")?.resolvedRevision).toBe("new-revision");
    expect(indexedSearchText()).toContain("interactive-new");
  });

  test("an audit scanner fault fails closed before publication", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "audit-fault",
      env: "API_TOKEN=old\n",
      marker: "audit-fault-old",
    });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "audit-fault",
        env: "API_TOKEN=new\n",
        marker: "audit-fault-new",
      }),
    );
    overrideSeam(_setDangerousKeyScannerForTests, () => {
      throw new Error("scanner boundary fault");
    });

    try {
      await expect(
        withTTY(false, () => akmUpdate({ target: "audit-fault", stashDir: storage.stashDir, yes: true })),
      ).rejects.toMatchObject({ code: "DANGEROUS_ENV_AUDIT_FAILED" });
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
  });

  test("a publication-boundary fault restores exact live bytes, lock, config, and searchable index", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "publish-fault",
      env: "API_TOKEN=old\n",
      marker: "publish-fault-old",
      adapter: false,
    });
    const before = snapshotState();
    expect(before.config).not.toContain('"adapter"');
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "publish-fault",
        env: "API_TOKEN=new\n",
        marker: "publish-fault-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "published") throw new Error("publication boundary fault");
    });

    try {
      await expect(
        withTTY(false, () => akmUpdate({ target: "publish-fault", stashDir: storage.stashDir, yes: true })),
      ).rejects.toThrow("publication boundary fault");
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(indexedSearchText()).not.toContain("publish-fault-new");
  });

  test("a fault after the new index commits restores the prior content, lock, config, and DB generation", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "index-fault",
      env: "API_TOKEN=old\n",
      marker: "index-fault-old",
    });
    const expiredRef = "index-fault//knowledge/expired-state-transaction-probe";
    insertExpiredUsageEvent(expiredRef);
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "index-fault",
        env: "API_TOKEN=new\n",
        marker: "index-fault-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "indexed") throw new Error("post-index boundary fault");
    });

    try {
      await expect(
        withTTY(false, () => akmUpdate({ target: "index-fault", stashDir: storage.stashDir, yes: true })),
      ).rejects.toThrow("post-index boundary fault");
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(indexedSearchText()).toContain("index-fault-old");
    expect(indexedSearchText()).not.toContain("index-fault-new");
    expect(countUsageEvents(expiredRef)).toBe(1);
  });

  test("a held index reader sees only the old committed generation throughout rollback on the same inode", async () => {
    await configureCanonicalManagedBundle({
      id: "index-reader-rollback",
      env: "API_TOKEN=old\n",
      marker: "index-reader-old",
    });
    const held = openReadonlyExistingDatabase(getDbPath());
    if (!held) throw new Error("expected an existing index");
    expect(held.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const oldText = indexedSearchTextFrom(held);
    const inodesBefore = sqliteFileInodes(getDbPath());
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "index-reader-rollback",
        env: "API_TOKEN=new\n",
        marker: "index-reader-failed-candidate",
      }),
    );
    let heldDuring = "";
    let competingWriterBlocked = false;
    let attachedJournalModes: unknown[] = [];
    overrideSeam(_setUpdateTransactionHookForTests, (point, _id, context) => {
      if (point !== "indexed") return;
      if (!context?.db) throw new Error("missing unified update transaction");
      attachedJournalModes = [
        context.db.prepare("PRAGMA main.journal_mode").get(),
        context.db.prepare("PRAGMA akm_update_state.journal_mode").get(),
      ];
      heldDuring = indexedSearchTextFrom(held);
      const competitor = openDatabase(getDbPath(), { create: false });
      try {
        competitor.exec("PRAGMA busy_timeout = 0");
        competitor.prepare("UPDATE index_meta SET value = value WHERE key = 'builtAt'").run();
      } catch (error) {
        competingWriterBlocked = /locked|busy/i.test(error instanceof Error ? error.message : String(error));
      } finally {
        competitor.close();
      }
      throw new Error("rollback the uncommitted index generation");
    });

    try {
      await expect(akmUpdate({ target: "index-reader-rollback", stashDir: storage.stashDir })).rejects.toThrow(
        "rollback the uncommitted index generation",
      );
      expect(heldDuring).toBe(oldText);
      expect(indexedSearchTextFrom(held)).toBe(oldText);
      expect(indexedSearchText()).toBe(oldText);
      expect(competingWriterBlocked).toBe(true);
      expect(attachedJournalModes).toEqual([{ journal_mode: "wal" }, { journal_mode: "wal" }]);
      for (const [filePath, inode] of inodesBefore) {
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.statSync(filePath).ino).toBe(inode);
      }
    } finally {
      held.close();
      syncSpy.mockRestore();
    }

    const writerAfterRollback = openDatabase(getDbPath(), { create: false });
    try {
      writerAfterRollback.prepare("UPDATE index_meta SET value = value WHERE key = 'builtAt'").run();
    } finally {
      writerAfterRollback.close();
    }
  });

  test("Bun SQLite nests index transactions as savepoints and close rolls an outer transaction back", async () => {
    await configureCanonicalManagedBundle({
      id: "index-savepoint-proof",
      env: "API_TOKEN=old\n",
      marker: "index-savepoint-old",
    });
    const initialReader = openReadonlyExistingDatabase(getDbPath());
    if (!initialReader) throw new Error("expected an existing index for transaction proof");
    const original = initialReader.prepare("SELECT value FROM index_meta WHERE key = 'builtAt'").get() as {
      value: string;
    };
    initialReader.close();
    const db = openDatabase(getDbPath(), { create: false });
    db.exec("BEGIN IMMEDIATE");
    db.transaction(() => {
      db.exec("UPDATE index_meta SET value = 'nested-savepoint-value' WHERE key = 'builtAt'");
    })();
    expect(db.inTransaction).toBe(true);
    db.close();

    const reopened = openReadonlyExistingDatabase(getDbPath());
    if (!reopened) throw new Error("expected an existing index after rollback-on-close");
    try {
      expect(reopened.prepare("SELECT value FROM index_meta WHERE key = 'builtAt'").get()).toEqual(original);
    } finally {
      reopened.close();
    }

    expect(() =>
      openIndexDatabase(undefined, {
        beforeSchema(candidate) {
          candidate.exec("BEGIN IMMEDIATE");
          candidate.prepare("UPDATE index_meta SET value = ? WHERE key = 'builtAt'").run("open-failed-value");
          throw new Error("initializer failed after begin");
        },
      }),
    ).toThrow("initializer failed after begin");
    const writerAfterFailedOpen = openIndexDatabase();
    try {
      expect(writerAfterFailedOpen.prepare("SELECT value FROM index_meta WHERE key = 'builtAt'").get()).toEqual(
        original,
      );
      writerAfterFailedOpen.prepare("UPDATE index_meta SET value = value WHERE key = 'builtAt'").run();
    } finally {
      writerAfterFailedOpen.close();
    }
  });

  test("an actual deferred foreign-key COMMIT error rolls index and state back together", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "cross-db-commit-error",
      env: "API_TOKEN=old\n",
      marker: "cross-db-commit-old",
    });
    const expiredRef = "cross-db-commit-error//knowledge/expired-state-transaction-probe";
    insertExpiredUsageEvent(expiredRef);
    const before = snapshotState();
    const inodesBefore = sqliteFileInodes(getDbPath());
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "cross-db-commit-error",
        env: "API_TOKEN=new\n",
        marker: "cross-db-commit-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point, _id, context) => {
      if (point !== "before-commit") return;
      if (!context?.db?.inTransaction) throw new Error("missing unified update transaction");
      context.db.exec("PRAGMA defer_foreign_keys = ON");
      context.db
        .prepare(
          "INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate) VALUES (?, 0, 0, 0, 0)",
        )
        .run(-765);
    });

    try {
      await expect(akmUpdate({ target: "cross-db-commit-error", stashDir: storage.stashDir })).rejects.toThrow(
        /foreign key|constraint/i,
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(countUsageEvents(expiredRef)).toBe(1);
    for (const [filePath, inode] of inodesBefore) expect(fs.statSync(filePath).ino).toBe(inode);
  });

  test("health detects a durable split generation after restart and full index repairs it", async () => {
    await configureCanonicalManagedBundle({
      id: "split-generation",
      env: "API_TOKEN=old\n",
      marker: "split-generation-old",
    });

    const indexDb = openReadonlyExistingDatabase(getDbPath());
    if (!indexDb) throw new Error("expected an index for the split-generation probe");
    const entry = indexDb
      .prepare("SELECT id, item_ref FROM entries WHERE item_ref = ?")
      .get("split-generation//knowledge/revision") as { id: number; item_ref: string } | undefined;
    indexDb.close();
    if (!entry) throw new Error("expected the indexed split-generation entry");

    // Simulate restart after only one side of a cross-database commit reached
    // durable storage: the stable ref is from the current generation, while
    // state.db retained its adjacent generation's numeric index id. Every
    // handle is closed before health opens the files again.
    const stateDb = openStateDatabase();
    stateDb
      .prepare(
        "INSERT INTO usage_events (entry_id, entry_ref, event_type, source, created_at) " +
          "VALUES (?, ?, 'search', 'user', datetime('now'))",
      )
      .run(entry.id + 765_000, entry.item_ref);
    stateDb.close();

    const splitHealth = await akmHealth({ stashDir: storage.stashDir });
    expect(splitHealth.advisories).toContainEqual(
      expect.objectContaining({ name: "index-state-generation", status: "warn" }),
    );

    await akmIndex({ stashDir: storage.stashDir, full: true, hydrateSources: false });

    const repairedHealth = await akmHealth({ stashDir: storage.stashDir });
    expect(repairedHealth.advisories.find((finding) => finding.name === "index-state-generation")).toBeUndefined();
    const repairedIndex = openReadonlyExistingDatabase(getDbPath());
    if (!repairedIndex) throw new Error("expected a repaired index");
    const repairedEntry = repairedIndex.prepare("SELECT id FROM entries WHERE item_ref = ?").get(entry.item_ref) as
      | { id: number }
      | undefined;
    repairedIndex.close();
    if (!repairedEntry) throw new Error("expected the repaired split-generation entry");
    const repairedState = openStateDatabase();
    try {
      expect(
        repairedState.prepare("SELECT entry_id FROM usage_events WHERE entry_ref = ?").get(entry.item_ref),
      ).toEqual({ entry_id: repairedEntry.id });
    } finally {
      repairedState.close();
    }
    expect(indexedSearchText()).toContain("split-generation-old");
  });

  test("a concurrent lock generation cannot prevent content and index compensation", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "lock-race",
      env: "API_TOKEN=old\n",
      marker: "lock-race-old",
    });
    const thirdRoot = makeBundle("akm-765-lock-race-third-", "API_TOKEN=third\n", "lock-race-third");
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "lock-race",
        env: "API_TOKEN=new\n",
        marker: "lock-race-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point !== "before-index") return;
      fs.writeFileSync(
        getLockfilePath(),
        `${JSON.stringify(
          [
            {
              id: "lock-race",
              source: "npm",
              ref: "npm:lock-race",
              localRoot: thirdRoot,
            },
          ],
          null,
          2,
        )}\n`,
      );
      throw new Error("fault after concurrent lock publication");
    });

    try {
      await expect(
        withTTY(false, () => akmUpdate({ target: "lock-race", stashDir: storage.stashDir, yes: true })),
      ).rejects.toThrow("changed concurrently");
    } finally {
      syncSpy.mockRestore();
    }

    expect(readLockfile().find((entry) => entry.id === "lock-race")?.localRoot).toBe(thirdRoot);
    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before.config);
    expect(indexedRows()).toEqual(before.rows);
    expect(indexedSearchText()).toBe(before.text);
    expect(indexedSearchText()).not.toContain("lock-race-new");
  });

  test("state rollback preserves a concurrent committed event and an already-open cross-process handle", async () => {
    await configureCanonicalManagedBundle({
      id: "state-race",
      env: "API_TOKEN=old\n",
      marker: "state-race-old",
    });
    const marker = "state-race//concurrent-event";
    const ready = path.join(storage.root, "state-race.ready");
    const go = path.join(storage.root, "state-race.go");
    const committed = path.join(storage.root, "state-race.committed");
    const release = path.join(storage.root, "state-race.release");
    const observed = path.join(storage.root, "state-race.observed");
    const child = spawn("bun", [STATE_EVENT_WORKER, ready, go, committed, release, observed, marker], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const done = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await pollUntil(() => fs.existsSync(ready), { label: "state update worker ready" });

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "state-race",
        env: "API_TOKEN=new\n",
        marker: "state-race-new",
      }),
    );
    let released = false;
    let stateFileInodes = new Map<string, number>();
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "before-index") {
        fs.writeFileSync(go, "go");
        waitForFileSync(committed, "concurrent state event commit");
        const statePath = getStateDbPath();
        stateFileInodes = new Map(
          [statePath, `${statePath}-wal`, `${statePath}-shm`]
            .filter((filePath) => fs.existsSync(filePath))
            .map((filePath) => [filePath, fs.statSync(filePath).ino]),
        );
        expect(stateFileInodes.has(statePath)).toBe(true);
      }
      if (point === "indexed") throw new Error("post-index state rollback fault");
    });

    try {
      await expect(akmUpdate({ target: "state-race", stashDir: storage.stashDir })).rejects.toThrow(
        "post-index state rollback fault",
      );
      expect(countStateEvents(marker)).toBe(1);
      for (const [filePath, inode] of stateFileInodes) {
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.statSync(filePath).ino).toBe(inode);
      }
      fs.writeFileSync(release, "release");
      released = true;
      expect(await done).toBe(0);
      expect(stderr).toBe("");
      expect(fs.readFileSync(observed, "utf8")).toBe("1");
      expect(countStateEvents(marker)).toBe(1);
    } finally {
      syncSpy.mockRestore();
      if (!released) fs.writeFileSync(release, "release");
      if (child.exitCode === null) {
        await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
  });

  test("the deferred state transaction blocks a second mutator and rollback releases it", async () => {
    await configureCanonicalManagedBundle({
      id: "state-writer-fence",
      env: "API_TOKEN=old\n",
      marker: "state-writer-fence-old",
    });
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "state-writer-fence",
        env: "API_TOKEN=new\n",
        marker: "state-writer-fence-new",
      }),
    );
    let secondWriterBlocked = false;
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point !== "indexed") return;
      const second = openStateDatabase();
      try {
        second.exec("PRAGMA busy_timeout = 0");
        second
          .prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, ?)")
          .run("update", "2026-08-19T00:00:00.000Z", "state-writer-fence//during", "{}");
      } catch (error) {
        secondWriterBlocked = /locked|busy/i.test(error instanceof Error ? error.message : String(error));
      } finally {
        second.close();
      }
      throw new Error("rollback deferred state transaction");
    });

    try {
      await expect(akmUpdate({ target: "state-writer-fence", stashDir: storage.stashDir })).rejects.toThrow(
        "rollback deferred state transaction",
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(secondWriterBlocked).toBe(true);
    const after = openStateDatabase();
    try {
      after
        .prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, ?)")
        .run("update", "2026-08-19T00:00:01.000Z", "state-writer-fence//after", "{}");
    } finally {
      after.close();
    }
    expect(countStateEvents("state-writer-fence//during")).toBe(0);
    expect(countStateEvents("state-writer-fence//after")).toBe(1);
  });

  test("managed writable Git rejects a live commit made after audit instead of replacing the checkout", async () => {
    const liveRepo = managedCachePaths("managed-writable-race").contentDir;
    const initialHead = initGitBundle(liveRepo, "managed-writable-old");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "managed-writable-race": {
          git: "https://github.com/example/managed-writable-race.git",
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id: "managed-writable-race",
        source: "git",
        ref: "git:https://github.com/example/managed-writable-race.git",
        resolvedRevision: initialHead,
        localRoot: liveRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      const auditedHead = commitGitMarker(options.writableRoot, "audited.txt", "managed audited upstream");
      return {
        id: "managed-writable-race",
        source: "git",
        ref: "git:https://github.com/example/managed-writable-race.git",
        artifactUrl: "https://github.com/example/managed-writable-race.git",
        resolvedRevision: auditedHead,
        contentDir: options.writableRoot,
        cacheDir: options.writableRoot,
        extractedDir: options.writableRoot,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });
    let userHead = "";
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "audited") userHead = commitGitMarker(liveRepo, "user.txt", "user commit after audit");
    });

    try {
      await expect(akmUpdate({ target: "managed-writable-race", stashDir: storage.stashDir })).rejects.toThrow(
        /changed.*audit|changed.*staged/i,
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(userHead);
    expect(fs.readFileSync(path.join(liveRepo, "user.txt"), "utf8")).toBe("user commit after audit\n");
    expect(fs.existsSync(path.join(liveRepo, "audited.txt"))).toBe(false);
    expect(before.lock).not.toBeNull();
    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(before.lock as string);
    expect(indexedRows()).toEqual(before.rows);
  });

  test("managed writable Git preserves untracked live work created after audit", async () => {
    const id = "managed-writable-dirty";
    const liveRepo = managedCachePaths(id).contentDir;
    const initialHead = initGitBundle(liveRepo, "managed-writable-dirty-old");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        resolvedRevision: initialHead,
        localRoot: liveRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      const auditedHead = commitGitMarker(options.writableRoot, "audited.txt", "managed audited dirty target");
      return {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        artifactUrl: `https://github.com/example/${id}.git`,
        resolvedRevision: auditedHead,
        contentDir: options.writableRoot,
        cacheDir: options.writableRoot,
        extractedDir: options.writableRoot,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "audited") fs.writeFileSync(path.join(liveRepo, "untracked.local"), "preserve me\n");
    });

    try {
      await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(/working tree.*clean/i);
    } finally {
      syncSpy.mockRestore();
    }

    expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(fs.readFileSync(path.join(liveRepo, "untracked.local"), "utf8")).toBe("preserve me\n");
    expect(fs.existsSync(path.join(liveRepo, "audited.txt"))).toBe(false);
    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(before.lock as string);
    expect(indexedRows()).toEqual(before.rows);
  });

  test("a symlinked managed writable root is staged by physical containment and never mutates live bytes before audit", async () => {
    const id = "managed-writable-symlink";
    const fixture = makeSandboxDir("akm-765-managed-symlink-");
    disposers.push(fixture.cleanup);
    const physicalRepo = path.join(fixture.dir, "physical-repo");
    const linkedRepo = path.join(fixture.dir, "linked-repo");
    const initialHead = initGitBundle(physicalRepo, "managed symlink old");
    fs.symlinkSync(physicalRepo, linkedRepo, "dir");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        resolvedRevision: initialHead,
        localRoot: linkedRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    let providerUsedLivePhysicalRoot = false;
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      const providerRoot = options.writableRoot;
      providerUsedLivePhysicalRoot = fs.realpathSync(providerRoot) === fs.realpathSync(physicalRepo);
      fs.writeFileSync(path.join(providerRoot, "env", "default.env"), "LD_PRELOAD=/tmp/symlink-escape.so\n");
      git(providerRoot, ["add", "-A"]);
      git(providerRoot, ["commit", "-m", "dangerous symlink candidate"]);
      const auditedHead = git(providerRoot, ["rev-parse", "HEAD"]);
      return {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        artifactUrl: `https://github.com/example/${id}.git`,
        resolvedRevision: auditedHead,
        contentDir: providerRoot,
        cacheDir: providerRoot,
        extractedDir: providerRoot,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });

    try {
      await expect(withTTY(false, () => akmUpdate({ target: id, stashDir: storage.stashDir }))).rejects.toMatchObject({
        code: "DANGEROUS_ENV_KEY",
      });
    } finally {
      syncSpy.mockRestore();
    }

    expect(providerUsedLivePhysicalRoot).toBe(false);
    expect(git(physicalRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(fs.readFileSync(path.join(physicalRepo, "env", "default.env"), "utf8")).toBe("API_TOKEN=safe\n");
  });

  test("managed writable Git audits an upstream component symlink retarget instead of its old physical target", async () => {
    const id = "managed-component-retarget-danger";
    const fixture = makeSandboxDir("akm-765-managed-retarget-production-");
    disposers.push(fixture.cleanup);
    const remote = path.join(fixture.dir, "remote.git");
    const author = path.join(fixture.dir, "author");
    const liveRepo = managedCachePaths(id).contentDir;
    const bareInit = gitProvider.runGit(["init", "--bare", "--initial-branch=main", remote]);
    if (bareInit.status !== 0) throw new Error(bareInit.stderr.trim() || "git init --bare failed");
    const authorInit = gitProvider.runGit(["init", "--initial-branch=main", author]);
    if (authorInit.status !== 0) throw new Error(authorInit.stderr.trim() || "git init failed");
    git(author, ["config", "user.name", "AKM Update Test"]);
    git(author, ["config", "user.email", "update-test@example.invalid"]);
    writeBundle(path.join(author, "safe"), "API_TOKEN=safe\n", "component-safe");
    fs.symlinkSync("safe", path.join(author, "component"), "dir");
    git(author, ["add", "-A"]);
    git(author, ["commit", "-m", "A: track safe component link"]);
    git(author, ["remote", "add", "origin", remote]);
    git(author, ["push", "-u", "origin", "main"]);
    const initialHead = git(author, ["rev-parse", "HEAD"]);
    const clone = gitProvider.runGit(["clone", remote, liveRepo]);
    if (clone.status !== 0) throw new Error(clone.stderr.trim() || "git clone failed");

    fs.unlinkSync(path.join(author, "component"));
    fs.rmSync(path.join(author, "safe"), { recursive: true });
    writeBundle(path.join(author, "danger"), "LD_PRELOAD=/tmp/retarget.so\n", "component-danger");
    fs.symlinkSync("danger", path.join(author, "component"), "dir");
    git(author, ["add", "-A"]);
    git(author, ["commit", "-m", "B: retarget component and delete safe"]);
    git(author, ["push", "origin", "main"]);
    const dangerousHead = git(author, ["rev-parse", "HEAD"]);
    const ref = `git:https://github.com/example/${id}.git`;
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: "component", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref,
        resolvedRevision: initialHead,
        localRoot: liveRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    let productionProviderReached = false;
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      productionProviderReached = true;
      return gitProvider.syncExistingWritableCheckout(
        {
          id: `git:${remote}`,
          source: "git",
          ref,
          url: remote,
          requestedRef: "main",
        },
        {
          id: `git:${remote}`,
          source: "git",
          ref,
          artifactUrl: remote,
          resolvedRevision: dangerousHead,
        },
        options.writableRoot,
        "2026-08-19T00:00:00.000Z",
        options.writableRequiredRoots,
      );
    });

    try {
      await expect(withTTY(false, () => akmUpdate({ target: id, stashDir: storage.stashDir }))).rejects.toMatchObject({
        code: "DANGEROUS_ENV_KEY",
      });
    } finally {
      syncSpy.mockRestore();
    }

    expect(productionProviderReached).toBe(true);
    expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(fs.readlinkSync(path.join(liveRepo, "component"))).toBe("safe");
    expect(fs.existsSync(path.join(liveRepo, "safe"))).toBe(true);
    expect(fs.existsSync(path.join(liveRepo, "danger"))).toBe(false);
    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(before.lock as string);
    expect(indexedRows()).toEqual(before.rows);
    expect(indexedSearchText()).toBe(before.text);
  });

  test("managed writable Git rejects an upstream component symlink retarget outside the checkout", async () => {
    const id = "managed-component-retarget-outside";
    const fixture = makeSandboxDir("akm-765-managed-retarget-outside-");
    disposers.push(fixture.cleanup);
    const liveRepo = path.join(fixture.dir, "repo");
    const outside = path.join(fixture.dir, "outside");
    initGitBundle(liveRepo, "managed outside retarget base");
    writeBundle(path.join(liveRepo, "safe"), "API_TOKEN=safe\n", "component-safe");
    writeBundle(outside, "API_TOKEN=outside\n", "component-outside");
    fs.symlinkSync("safe", path.join(liveRepo, "component"), "dir");
    git(liveRepo, ["add", "-A"]);
    git(liveRepo, ["commit", "-m", "track contained component link"]);
    const initialHead = git(liveRepo, ["rev-parse", "HEAD"]);
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: "component", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        resolvedRevision: initialHead,
        localRoot: liveRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    let published = false;
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "published") published = true;
    });
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      fs.unlinkSync(path.join(options.writableRoot, "component"));
      fs.symlinkSync(outside, path.join(options.writableRoot, "component"), "dir");
      git(options.writableRoot, ["add", "-A"]);
      git(options.writableRoot, ["commit", "-m", "retarget component outside checkout"]);
      const auditedHead = git(options.writableRoot, ["rev-parse", "HEAD"]);
      return {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        artifactUrl: `https://github.com/example/${id}.git`,
        resolvedRevision: auditedHead,
        contentDir: options.writableRoot,
        cacheDir: options.writableRoot,
        extractedDir: options.writableRoot,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });

    try {
      await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(/outside|contain|escape/i);
    } finally {
      syncSpy.mockRestore();
    }

    expect(published).toBe(false);
    expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(fs.readlinkSync(path.join(liveRepo, "component"))).toBe("safe");
    expectState(before);
  });

  test("a writable component symlink escape is rejected before the provider sees a root", async () => {
    const id = "managed-writable-component-escape";
    const fixture = makeSandboxDir("akm-765-managed-component-escape-");
    disposers.push(fixture.cleanup);
    const physicalRepo = path.join(fixture.dir, "repo");
    const escapedRoot = path.join(fixture.dir, "outside");
    fs.mkdirSync(escapedRoot, { recursive: true });
    writeBundle(escapedRoot, "API_TOKEN=outside\n", "outside");
    const initialHead = initGitBundle(physicalRepo, "managed component escape old");
    fs.symlinkSync(escapedRoot, path.join(physicalRepo, "escaped"), "dir");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: "escaped", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        resolvedRevision: initialHead,
        localRoot: physicalRepo,
      },
    ]);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async () => {
      throw new Error("provider should not be called for an escaped writable root");
    });
    try {
      await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(/symlink|outside|contain/i);
      expect(syncSpy).not.toHaveBeenCalled();
    } finally {
      syncSpy.mockRestore();
    }
    expect(git(physicalRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  for (const mutation of ["tracked", "untracked", "ignored"] as const) {
    test(`writable Git compensates a dangerous ${mutation} post-fence mutation created during fast-forward`, async () => {
      const id = `managed-post-fence-${mutation}`;
      const liveRepo = managedCachePaths(id).contentDir;
      initGitBundle(liveRepo, `${mutation} post-fence old`);
      if (mutation === "ignored") {
        fs.writeFileSync(path.join(liveRepo, ".gitignore"), "env/ignored.env\n");
        git(liveRepo, ["add", ".gitignore"]);
        git(liveRepo, ["commit", "-m", "ignore local env"]);
      }
      const initialHead = git(liveRepo, ["rev-parse", "HEAD"]);
      saveConfig({
        semanticSearchMode: "off",
        bundles: {
          [id]: {
            git: `https://github.com/example/${id}.git`,
            components: { main: { root: ".", adapter: "akm", writable: true } },
          },
        },
      });
      seedLockEntries([
        {
          id,
          source: "git",
          ref: `git:https://github.com/example/${id}.git`,
          resolvedRevision: initialHead,
          localRoot: liveRepo,
        },
      ]);
      await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
      const before = snapshotState();
      const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
        if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
        const auditedHead = commitGitMarker(options.writableRoot, "audited.txt", `${mutation} audited upstream`);
        return {
          id,
          source: "git",
          ref: `git:https://github.com/example/${id}.git`,
          artifactUrl: `https://github.com/example/${id}.git`,
          resolvedRevision: auditedHead,
          contentDir: options.writableRoot,
          cacheDir: options.writableRoot,
          extractedDir: options.writableRoot,
          syncedAt: "2026-08-19T00:00:00.000Z",
          writable: true,
        };
      });
      const mutatedPath =
        mutation === "tracked"
          ? path.join(liveRepo, "env", "default.env")
          : path.join(liveRepo, "env", mutation === "ignored" ? "ignored.env" : "untracked.env");
      overrideSeam(_setUpdateTransactionHookForTests, (point) => {
        if (point === "audited") installPostMergeWriter(liveRepo, mutatedPath, "LD_PRELOAD=/tmp/post-fence.so\n");
      });

      try {
        await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(
          /dangerous|changed|audited|generation/i,
        );
      } finally {
        syncSpy.mockRestore();
      }

      expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
      expect(fs.readFileSync(path.join(liveRepo, "env", "default.env"), "utf8")).toBe("API_TOKEN=safe\n");
      if (mutation !== "tracked") expect(fs.existsSync(mutatedPath)).toBe(false);
      expect(fs.existsSync(path.join(liveRepo, "audited.txt"))).toBe(false);
      expectState(before);
    });
  }

  test("writable Git re-audits the exact worktree generation at the database commit boundary", async () => {
    const id = "managed-commit-boundary-race";
    const liveRepo = managedCachePaths(id).contentDir;
    const initialHead = initGitBundle(liveRepo, "commit-boundary old");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        resolvedRevision: initialHead,
        localRoot: liveRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      const auditedHead = commitGitMarker(options.writableRoot, "audited.txt", "commit-boundary audited upstream");
      return {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        artifactUrl: `https://github.com/example/${id}.git`,
        resolvedRevision: auditedHead,
        contentDir: options.writableRoot,
        cacheDir: options.writableRoot,
        extractedDir: options.writableRoot,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "indexed") {
        fs.writeFileSync(path.join(liveRepo, "env", "default.env"), "LD_PRELOAD=/tmp/commit-race.so\n");
      }
    });

    try {
      await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(
        /dangerous|changed|audited|generation/i,
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(fs.readFileSync(path.join(liveRepo, "env", "default.env"), "utf8")).toBe("API_TOKEN=safe\n");
    expect(fs.existsSync(path.join(liveRepo, "audited.txt"))).toBe(false);
    expectState(before);
  });

  test("managed writable Git rejects a non-fast-forward audited target without touching the live branch", async () => {
    const id = "managed-writable-diverged";
    const liveRepo = managedCachePaths(id).contentDir;
    const initialHead = initGitBundle(liveRepo, "managed-writable-diverged-old");
    const initialBranch = git(liveRepo, ["symbolic-ref", "--short", "HEAD"]);
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        resolvedRevision: initialHead,
        localRoot: liveRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      fs.writeFileSync(path.join(options.writableRoot, "diverged.txt"), "audited but not a descendant\n");
      git(options.writableRoot, ["add", "-A"]);
      const tree = git(options.writableRoot, ["write-tree"]);
      const auditedHead = git(options.writableRoot, ["commit-tree", tree, "-m", "diverged audited target"]);
      git(options.writableRoot, ["reset", "--hard", auditedHead]);
      return {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        artifactUrl: `https://github.com/example/${id}.git`,
        resolvedRevision: auditedHead,
        contentDir: options.writableRoot,
        cacheDir: options.writableRoot,
        extractedDir: options.writableRoot,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });

    try {
      await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(/not a fast-forward/i);
    } finally {
      syncSpy.mockRestore();
    }

    expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(git(liveRepo, ["symbolic-ref", "--short", "HEAD"])).toBe(initialBranch);
    expect(fs.existsSync(path.join(liveRepo, "diverged.txt"))).toBe(false);
    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(before.lock as string);
    expect(indexedRows()).toEqual(before.rows);
  });

  test("writable Git rejects an unauditable submodule target before changing the live checkout", async () => {
    const id = "managed-writable-submodule";
    const liveRepo = managedCachePaths(id).contentDir;
    const initialHead = initGitBundle(liveRepo, "managed submodule old");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        resolvedRevision: initialHead,
        localRoot: liveRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      git(options.writableRoot, ["update-index", "--add", "--cacheinfo", `160000,${initialHead},vendor/dependency`]);
      git(options.writableRoot, ["commit", "-m", "add unaudited submodule"]);
      const auditedHead = git(options.writableRoot, ["rev-parse", "HEAD"]);
      return {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        artifactUrl: `https://github.com/example/${id}.git`,
        resolvedRevision: auditedHead,
        contentDir: options.writableRoot,
        cacheDir: options.writableRoot,
        extractedDir: options.writableRoot,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });

    try {
      await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(/submodule|gitlink|audit/i);
    } finally {
      syncSpy.mockRestore();
    }
    expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expectState(before);
  });

  test("writable Git detects a local smudge filter that changes audited bytes during materialization", async () => {
    const id = "managed-writable-filter";
    const liveRepo = managedCachePaths(id).contentDir;
    const initialHead = initGitBundle(liveRepo, "managed filter old");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          git: `https://github.com/example/${id}.git`,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    seedLockEntries([
      {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        resolvedRevision: initialHead,
        localRoot: liveRepo,
      },
    ]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      if (!options?.writableRoot) throw new Error("writable update did not provide a staged checkout");
      fs.writeFileSync(path.join(options.writableRoot, ".gitattributes"), "filtered.txt filter=akm-danger\n");
      fs.writeFileSync(path.join(options.writableRoot, "filtered.txt"), "audited filter payload\n");
      git(options.writableRoot, ["add", "-A"]);
      git(options.writableRoot, ["commit", "-m", "add filtered target"]);
      const auditedHead = git(options.writableRoot, ["rev-parse", "HEAD"]);
      return {
        id,
        source: "git",
        ref: `git:https://github.com/example/${id}.git`,
        artifactUrl: `https://github.com/example/${id}.git`,
        resolvedRevision: auditedHead,
        contentDir: options.writableRoot,
        cacheDir: options.writableRoot,
        extractedDir: options.writableRoot,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });
    const filterScript = path.join(storage.root, "dangerous-smudge.sh");
    fs.writeFileSync(
      filterScript,
      `#!/bin/sh\nprintf %s 'LD_PRELOAD=/tmp/filter.so\n' > ${shellQuote(path.join(liveRepo, "env", "default.env"))}\ncat\n`,
    );
    fs.chmodSync(filterScript, 0o755);
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "audited") git(liveRepo, ["config", "filter.akm-danger.smudge", filterScript]);
    });

    try {
      await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(
        /filter|dangerous|changed|audited|generation/i,
      );
    } finally {
      syncSpy.mockRestore();
    }
    expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(fs.readFileSync(path.join(liveRepo, "env", "default.env"), "utf8")).toBe("API_TOKEN=safe\n");
    expectState(before);
  });

  test("plain writable Git rejects a live commit made after audit instead of replacing the checkout", async () => {
    const url = "https://github.com/example/plain-writable-race";
    const livePaths = gitProvider.getCachePaths(url);
    initGitBundle(livePaths.repoDir, "plain-writable-old");
    fs.writeFileSync(livePaths.indexPath, "[]\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "plain-writable-race": {
          git: url,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    const syncSpy = spyOn(gitProvider, "syncMirroredRepo").mockImplementation(async (_source, options) => {
      const staged = gitProvider.getCachePaths(url, requiredStagingRoot(options));
      const auditedHead = commitGitMarker(staged.repoDir, "audited.txt", "plain audited upstream");
      return {
        id: url,
        source: "git",
        ref: url,
        artifactUrl: url,
        resolvedRevision: auditedHead,
        contentDir: staged.repoDir,
        cacheDir: staged.rootDir,
        extractedDir: staged.repoDir,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });
    let userHead = "";
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "audited")
        userHead = commitGitMarker(livePaths.repoDir, "user.txt", "plain user commit after audit");
    });

    try {
      await expect(akmUpdate({ target: "plain-writable-race", stashDir: storage.stashDir })).rejects.toThrow(
        /changed.*audit|changed.*staged/i,
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(git(livePaths.repoDir, ["rev-parse", "HEAD"])).toBe(userHead);
    expect(fs.readFileSync(path.join(livePaths.repoDir, "user.txt"), "utf8")).toBe("plain user commit after audit\n");
    expect(fs.existsSync(path.join(livePaths.repoDir, "audited.txt"))).toBe(false);
    expect(indexedRows()).toEqual(before.rows);
  });

  test("plain writable Git rejects a post-sync component symlink escape before publication", async () => {
    const url = "https://github.com/example/plain-component-escape";
    const livePaths = gitProvider.getCachePaths(url);
    const outside = makeBundle("akm-765-plain-component-outside-", "API_TOKEN=outside\n", "plain-outside");
    initGitBundle(livePaths.repoDir, "plain component escape base");
    writeBundle(path.join(livePaths.repoDir, "safe"), "API_TOKEN=safe\n", "plain-component-safe");
    fs.symlinkSync("safe", path.join(livePaths.repoDir, "component"), "dir");
    git(livePaths.repoDir, ["add", "-A"]);
    git(livePaths.repoDir, ["commit", "-m", "track plain contained component"]);
    fs.writeFileSync(livePaths.indexPath, "[]\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        "plain-component-escape": {
          git: url,
          components: { main: { root: "component", adapter: "akm", writable: true } },
        },
      },
    });
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    let published = false;
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "published") published = true;
    });
    const syncSpy = spyOn(gitProvider, "syncMirroredRepo").mockImplementation(async (_source, options) => {
      const staged = gitProvider.getCachePaths(url, requiredStagingRoot(options));
      fs.unlinkSync(path.join(staged.repoDir, "component"));
      fs.symlinkSync(outside, path.join(staged.repoDir, "component"), "dir");
      git(staged.repoDir, ["add", "-A"]);
      git(staged.repoDir, ["commit", "-m", "retarget plain component outside checkout"]);
      const auditedHead = git(staged.repoDir, ["rev-parse", "HEAD"]);
      return {
        id: url,
        source: "git",
        ref: url,
        artifactUrl: url,
        resolvedRevision: auditedHead,
        contentDir: staged.repoDir,
        cacheDir: staged.rootDir,
        extractedDir: staged.repoDir,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: true,
      };
    });

    try {
      await expect(akmUpdate({ target: "plain-component-escape", stashDir: storage.stashDir })).rejects.toThrow(
        /outside|contain|escape/i,
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(published).toBe(false);
    expect(fs.readlinkSync(path.join(livePaths.repoDir, "component"))).toBe("safe");
    expectState(before);
  });

  test("audit-relevant component config drift is fenced before publication", async () => {
    const id = "config-drift";
    const live = managedCachePaths(id);
    writeBundle(path.join(live.contentDir, "safe"), "API_TOKEN=old-safe\n", "config-drift-old-safe");
    writeBundle(path.join(live.contentDir, "danger"), "API_TOKEN=old-danger-safe\n", "config-drift-old-danger");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        [id]: {
          npm: id,
          components: { main: { root: "safe", adapter: "akm", writable: false } },
        },
      },
    });
    seedLockEntries([{ id, source: "npm", ref: `npm:${id}`, resolvedVersion: "1.0.0", localRoot: live.contentDir }]);
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const beforeRows = indexedRows();
    const beforeLock = fs.readFileSync(getLockfilePath(), "utf8");
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) => {
      const cacheDir = path.join(requiredStagingRoot(options), `${id}-cache`);
      const contentDir = path.join(cacheDir, "content");
      writeBundle(path.join(contentDir, "safe"), "API_TOKEN=new-safe\n", "config-drift-new-safe");
      writeBundle(path.join(contentDir, "danger"), "LD_PRELOAD=/tmp/evil.so\n", "config-drift-new-danger");
      return {
        id,
        source: "npm",
        ref: `npm:${id}`,
        artifactUrl: `https://registry.example/${id}.tgz`,
        resolvedVersion: "2.0.0",
        contentDir,
        cacheDir,
        extractedDir: contentDir,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: false,
      };
    });
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point !== "audited") return;
      const config = loadConfig();
      saveConfig({
        ...config,
        bundles: {
          ...config.bundles,
          [id]: {
            ...config.bundles?.[id],
            npm: id,
            components: { main: { root: "danger", adapter: "akm", writable: false } },
          },
        },
      });
    });

    try {
      await expect(akmUpdate({ target: id, stashDir: storage.stashDir })).rejects.toThrow(/config.*changed/i);
    } finally {
      syncSpy.mockRestore();
    }

    expect(loadConfig().bundles?.[id]?.components?.main?.root).toBe("danger");
    expect(fs.readFileSync(path.join(live.contentDir, "danger", "env", "default.env"), "utf8")).toBe(
      "API_TOKEN=old-danger-safe\n",
    );
    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(beforeLock);
    expect(indexedRows()).toEqual(beforeRows);
    expect(indexedSearchText()).not.toContain("config-drift-new-danger");
  });

  test("an unrelated bundle config edit committed after audit is preserved", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "config-unrelated",
      env: "API_TOKEN=old\n",
      marker: "config-unrelated-old",
    });
    const unrelatedRoot = makeBundle("akm-765-unrelated-config-", "API_TOKEN=unrelated\n", "unrelated-config");
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "config-unrelated",
        env: "API_TOKEN=new\n",
        marker: "config-unrelated-new",
      }),
    );
    const fencedPoints = new Set<string>();
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "audited") {
        const config = loadConfig();
        saveConfig({
          ...config,
          bundles: {
            ...config.bundles,
            unrelated: {
              path: unrelatedRoot,
              components: { main: { root: ".", adapter: "akm", writable: true } },
            },
          },
        });
        return;
      }
      if (point === "published" || point === "before-index" || point === "indexed") {
        expect(fs.existsSync(getConfigLockPath())).toBe(true);
        fencedPoints.add(point);
      }
    });

    try {
      await akmUpdate({ target: "config-unrelated", stashDir: storage.stashDir });
    } finally {
      syncSpy.mockRestore();
    }

    expect(loadConfig().bundles?.unrelated?.path).toBe(unrelatedRoot);
    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=new\n");
    expect(indexedSearchText()).toContain("config-unrelated-new");
    expect(indexedSearchText()).toContain("unrelated-config");
    expect([...fencedPoints].sort()).toEqual(["before-index", "indexed", "published"]);
    expect(fs.existsSync(getConfigLockPath())).toBe(false);
  });

  test("index compensation restores the exact original lockfile bytes", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "raw-lock",
      env: "API_TOKEN=old\n",
      marker: "raw-lock-old",
    });
    const oldEntry = readLockfile().find((entry) => entry.id === "raw-lock");
    if (!oldEntry) throw new Error("raw-lock fixture missing lock entry");
    const customRaw = `[  ${JSON.stringify(oldEntry)}  ]\n\n`;
    fs.writeFileSync(getLockfilePath(), customRaw);
    fs.chmodSync(getLockfilePath(), 0o640);
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "raw-lock",
        env: "API_TOKEN=new\n",
        marker: "raw-lock-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "indexed") throw new Error("raw lock rollback fault");
    });

    try {
      await expect(akmUpdate({ target: "raw-lock", stashDir: storage.stashDir })).rejects.toThrow(
        "raw lock rollback fault",
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(customRaw);
    expect(fs.statSync(getLockfilePath()).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
  });

  test("a chmod-only lock generation is fenced before publication and never overwritten", async () => {
    const live = await configureCanonicalManagedBundle({
      id: "lock-mode-race",
      env: "API_TOKEN=old\n",
      marker: "lock-mode-old",
    });
    const lockBefore = fs.readFileSync(getLockfilePath(), "utf8");
    fs.chmodSync(getLockfilePath(), 0o640);
    const indexBefore = indexedRows();
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (_ref, options) =>
      stageManagedCandidate(requiredStagingRoot(options), {
        id: "lock-mode-race",
        env: "API_TOKEN=new\n",
        marker: "lock-mode-new",
      }),
    );
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "fenced") fs.chmodSync(getLockfilePath(), 0o600);
    });

    try {
      await expect(akmUpdate({ target: "lock-mode-race", stashDir: storage.stashDir })).rejects.toThrow(
        /changed concurrently/i,
      );
    } finally {
      syncSpy.mockRestore();
    }

    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(lockBefore);
    expect(fs.statSync(getLockfilePath()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(live.contentDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expect(indexedRows()).toEqual(indexBefore);
  });

  test("update --all continues per bundle and reports updated, blocked, and failed outcomes", async () => {
    const ids = ["danger-all", "safe-all", "broken-all"] as const;
    for (const id of ids) writeBundle(managedCachePaths(id).contentDir, "API_TOKEN=old\n", `${id}-old`);
    saveConfig({
      semanticSearchMode: "off",
      bundles: Object.fromEntries(
        ids.map((id) => [id, { npm: id, components: { main: { root: ".", adapter: "akm", writable: false } } }]),
      ),
    });
    seedLockEntries(
      ids.map((id) => ({
        id,
        source: "npm" as const,
        ref: `npm:${id}`,
        resolvedVersion: "1.0.0",
        localRoot: managedCachePaths(id).contentDir,
        installedAt: "2026-08-18T00:00:00.000Z",
      })),
    );
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });

    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockImplementation(async (ref, options) => {
      const id = ref.slice("npm:".length);
      if (id === "broken-all") throw new Error("provider failed");
      return stageManagedCandidate(requiredStagingRoot(options), {
        id,
        env: id === "danger-all" ? "LD_PRELOAD=/tmp/evil.so\n" : "API_TOKEN=new\n",
        marker: `${id}-new`,
      });
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await withTTY(false, () => akmUpdate({ all: true, stashDir: storage.stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(result.processed.map((item) => item.id)).toEqual(["safe-all"]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ id: "danger-all", status: "blocked", code: "DANGEROUS_ENV_KEY" }),
    );
    expect(result.skipped).toContainEqual(expect.objectContaining({ id: "broken-all", status: "failed" }));
    expect(fs.readFileSync(path.join(managedCachePaths("danger-all").contentDir, "env", "default.env"), "utf8")).toBe(
      "API_TOKEN=old\n",
    );
    expect(fs.readFileSync(path.join(managedCachePaths("safe-all").contentDir, "env", "default.env"), "utf8")).toBe(
      "API_TOKEN=new\n",
    );
    expect(readLockfile().find((entry) => entry.id === "danger-all")?.resolvedVersion).toBe("1.0.0");
    expect(readLockfile().find((entry) => entry.id === "safe-all")?.resolvedVersion).toBe("2.0.0");
    expect(readLockfile().find((entry) => entry.id === "broken-all")?.resolvedVersion).toBe("1.0.0");
    expect(indexedSearchText()).toContain("danger-all-old");
    expect(indexedSearchText()).not.toContain("danger-all-new");
    expect(indexedSearchText()).toContain("safe-all-new");
    expect(indexedSearchText()).toContain("broken-all-old");
  });

  for (const writable of [false, true]) {
    test(`plain ${writable ? "writable" : "read-only"} git audits its staged checkout without changing the active cache`, async () => {
      const url = `https://github.com/example/plain-${writable ? "writable" : "readonly"}`;
      const livePaths = gitProvider.getCachePaths(url);
      writeBundle(livePaths.repoDir, "API_TOKEN=old\n", `plain-${writable}-old`);
      fs.writeFileSync(livePaths.indexPath, "[]\n");
      saveConfig({
        semanticSearchMode: "off",
        bundles: {
          plain: {
            git: url,
            components: { main: { root: ".", adapter: "akm", writable } },
          },
        },
      });
      await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
      const before = snapshotState();
      const syncSpy = spyOn(gitProvider, "syncMirroredRepo").mockImplementation(async (_source, options) => {
        const stagedPaths = gitProvider.getCachePaths(url, requiredStagingRoot(options));
        writeBundle(stagedPaths.repoDir, "LD_PRELOAD=/tmp/evil.so\n", `plain-${writable}-new`);
        fs.writeFileSync(stagedPaths.indexPath, "[]\n");
        return {
          id: url,
          source: "git",
          ref: url,
          artifactUrl: url,
          contentDir: stagedPaths.repoDir,
          cacheDir: stagedPaths.rootDir,
          extractedDir: stagedPaths.repoDir,
          syncedAt: "2026-08-19T00:00:00.000Z",
          writable,
        };
      });

      try {
        await expect(
          withTTY(false, () => akmUpdate({ target: "plain", stashDir: storage.stashDir, yes: true })),
        ).rejects.toMatchObject({ code: "DANGEROUS_ENV_KEY" });
      } finally {
        syncSpy.mockRestore();
      }

      expect(fs.readFileSync(path.join(livePaths.repoDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
      expectState(before);
      expect(indexedSearchText()).not.toContain(`plain-${writable}-new`);
    });
  }

  test("an all-blocked --all response never hydrates the blocked plain source a second time", async () => {
    const url = "https://github.com/example/all-blocked";
    const livePaths = gitProvider.getCachePaths(url);
    writeBundle(livePaths.repoDir, "API_TOKEN=old\n", "all-blocked-old");
    fs.writeFileSync(livePaths.indexPath, "[]\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        blocked: {
          git: url,
          components: { main: { root: ".", adapter: "akm", writable: false } },
        },
      },
    });
    const before = snapshotState();
    let syncCalls = 0;
    const syncSpy = spyOn(gitProvider, "syncMirroredRepo").mockImplementation(async (_source, options) => {
      syncCalls += 1;
      const stagedPaths = gitProvider.getCachePaths(url, requiredStagingRoot(options));
      writeBundle(stagedPaths.repoDir, "LD_PRELOAD=/tmp/evil.so\n", "all-blocked-new");
      fs.writeFileSync(stagedPaths.indexPath, "[]\n");
      return {
        id: url,
        source: "git",
        ref: url,
        artifactUrl: url,
        contentDir: stagedPaths.repoDir,
        cacheDir: stagedPaths.rootDir,
        extractedDir: stagedPaths.repoDir,
        syncedAt: "2026-08-19T00:00:00.000Z",
        writable: false,
      };
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await withTTY(false, () => akmUpdate({ all: true, stashDir: storage.stashDir, yes: true }));
    } finally {
      syncSpy.mockRestore();
    }

    expect(syncCalls).toBe(1);
    expect(result.processed).toEqual([]);
    expect(result.plainSynced ?? []).toEqual([]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ id: "blocked", status: "blocked", code: "DANGEROUS_ENV_KEY" }),
    );
    expect(fs.readFileSync(path.join(livePaths.repoDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(indexedSearchText()).not.toContain("all-blocked-new");
  });

  test("website cache promotion rolls back its active root on a publication fault", async () => {
    const url = "http://127.0.0.1:45678/atomic-site";
    const livePaths = getWebsiteCachePaths(url);
    writeBundle(livePaths.stashDir, "API_TOKEN=old\n", "website-old");
    fs.writeFileSync(livePaths.manifestPath, "{}\n");
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        site: { website: { url }, components: { main: { root: ".", adapter: "akm", writable: false } } },
      },
    });
    await akmIndex({ stashDir: storage.stashDir, hydrateSources: false });
    const before = snapshotState();
    overrideSeam(_setUpdateTransactionHookForTests, (point) => {
      if (point === "published") throw new Error("website publication fault");
    });

    await withMockedFetch(
      async () => {
        await expect(akmUpdate({ target: "site", stashDir: storage.stashDir })).rejects.toThrow(
          "website publication fault",
        );
      },
      () =>
        new Response("<html><head><title>New site</title></head><body><h1>New site</h1></body></html>", {
          headers: { "content-type": "text/html" },
        }),
    );

    expect(fs.readFileSync(path.join(livePaths.stashDir, "env", "default.env"), "utf8")).toBe("API_TOKEN=old\n");
    expectState(before);
    expect(indexedSearchText()).toContain("website-old");
    expect(indexedSearchText()).not.toContain("New site");
  });
});
