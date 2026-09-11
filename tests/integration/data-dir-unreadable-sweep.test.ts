// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The rest of the #791 sweep: every remaining gate that answered "absent" for a
 * path it merely could not READ.
 *
 * `tests/integration/index-unreadable-not-absent.test.ts` pins the primary read
 * path (the search/curate openers, `probeLock`, `akm health`). This file pins
 * the sites the first pass did not reach — the ones where an `fs.existsSync`
 * gate over a data-dir / DB / lock / managed-asset path turned a permission
 * fault into a confident wrong answer:
 *
 *   - the lockfile write paths reading `[]` and then OVERWRITING the operator's
 *     lock records with it
 *   - `--clean` DELETING index rows for files it merely cannot look at
 *   - improve reporting "nothing eligible", feedback advising "run 'akm index'",
 *     `bundle list` reporting zero items, the graph loaders reporting no graph,
 *     and the write-path indexer reporting a successful no-op
 *
 * Every case here is written so it FAILS against the pre-sweep code — each one
 * was mutation-checked by reverting its call site. On the fixture technique
 * (why `chmod` is not enough) see `tests/_helpers/unreadable-path.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { collectEligibleRefs } from "../../src/commands/improve/eligibility";
import { akmListSources } from "../../src/commands/sources/installed-stashes";
import { type AkmConfig, saveConfig } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { getDataDir, getDbPath } from "../../src/core/paths";
import { getStateDbPath } from "../../src/core/state-db";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { loadGraphFilesOnly, loadStoredGraphMeta } from "../../src/indexer/db/graph-db";
import { indexWrittenAssets } from "../../src/indexer/index-written-assets";
import { akmIndex } from "../../src/indexer/indexer";
import { removeLockEntry, upsertLockEntry } from "../../src/integrations/lockfile";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { rekeyEntryInPlace } from "../../src/storage/repositories/index-entries-repository";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { makePathUnresolvableInPlace, makeUnresolvablePath } from "../_helpers/unreadable-path";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  storage.cleanup();
});

/** Collect everything routed through the `warn` seam while `fn` runs. */
async function captureWarnings(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") lines.push(args.map((a) => String(a)).join(" "));
  });
  try {
    await fn();
  } finally {
    _setWarnSinkForTests(undefined);
  }
  return lines;
}

/** An unreadable `index.db` in the sandboxed data dir. Returns its path. */
function unreadableIndexDb(): string {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return makeUnresolvablePath(path.dirname(dbPath), path.basename(dbPath));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function stashConfig(stashDir: string): AkmConfig {
  return {
    semanticSearchMode: "off",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
  } as AkmConfig;
}

// ── The lockfile write paths ────────────────────────────────────────────────

describe("the lockfile write paths refuse to overwrite what they cannot read (#791)", () => {
  const entry = { id: "demo", source: "npm", ref: "demo@1.0.0" } as const;

  test("upsertLockEntry rejects rather than replacing an unreadable lockfile", async () => {
    const lockfilePath = path.join(getDataDir(), "akm.lock");
    makeUnresolvablePath(path.dirname(lockfilePath), path.basename(lockfilePath));

    await expect(upsertLockEntry({ ...entry })).rejects.toThrow(/not readable|ELOOP/);
    expect(fs.lstatSync(lockfilePath).isSymbolicLink()).toBe(true);
  });

  test("removeLockEntry rejects on an unreadable data dir instead of reporting success", async () => {
    // getDataDir() is `<XDG_DATA_HOME>/akm` and withIsolatedAkmStorage leaves it
    // uncreated, so the loop lands exactly on the data dir itself.
    const dataDir = getDataDir();
    makeUnresolvablePath(path.dirname(dataDir), path.basename(dataDir));

    // Pre-sweep: `existsSync(dataDir)` was false, so this resolved silently and
    // the uninstall that called it reported the bundle as removed.
    await expect(removeLockEntry("demo")).rejects.toThrow(ConfigError);
  });

  test("an absent data dir still makes removeLockEntry a no-op", async () => {
    expect(fs.existsSync(getDataDir())).toBe(false);
    await removeLockEntry("demo");
    expect(fs.existsSync(getDataDir())).toBe(false);
  });
});

// ── The graph loaders ───────────────────────────────────────────────────────

describe("the graph loaders separate 'no graph' from 'no access' (#791)", () => {
  test("loadStoredGraphMeta raises instead of returning null", () => {
    unreadableIndexDb();
    let raised: unknown;
    try {
      loadStoredGraphMeta("/some/stash");
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ConfigError);
    expect((raised as ConfigError).code).toBe("DATA_DIR_UNREADABLE");
  });

  test("loadGraphFilesOnly raises instead of returning []", () => {
    unreadableIndexDb();
    expect(() => loadGraphFilesOnly("/some/stash")).toThrow(ConfigError);
  });

  test("a genuinely absent index still reads as 'nothing extracted yet'", () => {
    expect(loadStoredGraphMeta("/some/stash")).toBeNull();
    expect(loadGraphFilesOnly("/some/stash")).toEqual([]);
  });
});

// ── The write-path indexer ──────────────────────────────────────────────────

describe("indexWrittenAssets stops reporting an unreadable index as a successful no-op (#791)", () => {
  test("returns false and says so where an operator can see it", async () => {
    const stashDir = storage.stashDir;
    const assetPath = path.join(stashDir, "knowledge", "note.md");
    writeFile(assetPath, "---\ndescription: a note\n---\nbody\n");
    saveConfig(stashConfig(stashDir));
    unreadableIndexDb();

    let result: boolean | undefined;
    const warnings = await captureWarnings(async () => {
      // Pre-sweep this returned `true` — "the index is as the caller expects" —
      // which `acceptProposal` uses to advance its journal to `index-finalized`.
      result = await indexWrittenAssets(stashDir, [assetPath], { bundleId: "stash" });
    });

    expect(result).toBe(false);
    expect(warnings.join("\n")).toMatch(/not readable|ELOOP/);
  });

  test("a genuinely absent index is still a silent, successful skip", async () => {
    const stashDir = storage.stashDir;
    const assetPath = path.join(stashDir, "knowledge", "note.md");
    writeFile(assetPath, "---\ndescription: a note\n---\nbody\n");
    saveConfig(stashConfig(stashDir));

    const warnings = await captureWarnings(async () => {
      expect(await indexWrittenAssets(stashDir, [assetPath], { bundleId: "stash" })).toBe(true);
    });
    expect(warnings.join("\n")).not.toMatch(/not readable/);
  });
});

// ── improve eligibility ─────────────────────────────────────────────────────

describe("improve stops reporting 'nothing eligible' for an index it cannot read (#791)", () => {
  test("collectEligibleRefs raises rather than planning zero refs", async () => {
    const stashDir = storage.stashDir;
    writeFile(path.join(stashDir, "knowledge", "note.md"), "---\ndescription: a note\n---\nbody\n");
    const config = stashConfig(stashDir);
    saveConfig(config);
    unreadableIndexDb();

    // The read-only arm has refused this since the first pass; the write arm
    // still used `fs.existsSync` and answered `{ plannedRefs: [] }` at exit 0.
    let raised: unknown;
    try {
      await collectEligibleRefs({ mode: "all" }, stashDir, undefined, config);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ConfigError);
    expect((raised as ConfigError).code).toBe("DATA_DIR_UNREADABLE");
  });
});

// ── akm feedback ────────────────────────────────────────────────────────────

describe("akm feedback stops advising a rebuild the user cannot perform (#791)", () => {
  test("an unreadable index is reported as unreadable, not as a missing index", async () => {
    const stashDir = storage.stashDir;
    writeFile(path.join(stashDir, "memories", "note.md"), "---\ndescription: a note\n---\nbody\n");
    saveConfig(stashConfig(stashDir));
    unreadableIndexDb();

    const { stdout, stderr, code } = await runCliCapture(["feedback", "memories/note", "--positive", "--format=json"]);
    const payload = JSON.parse((stdout.trim() || stderr.trim()) as string) as Record<string, unknown>;

    expect(payload.ok).toBe(false);
    // Pre-sweep: exit 2 with "Index not found. Run 'akm index' first…" — advice
    // that would not have helped and that they may not have permission to take.
    expect(String(payload.error)).not.toMatch(/Run 'akm index' first/);
    expect(String(payload.error)).toMatch(/not readable/);
    expect(payload.code).toBe("DATA_DIR_UNREADABLE");
    expect(code).toBe(78);
  });
});

// ── akm bundle list ─────────────────────────────────────────────────────────

describe("bundle listing does not report zero items for an index it cannot read (#791)", () => {
  test("the unreadable index is surfaced rather than rendered as empty bundles", async () => {
    const stashDir = storage.stashDir;
    writeFile(path.join(stashDir, "knowledge", "note.md"), "---\ndescription: a note\n---\nbody\n");
    saveConfig(stashConfig(stashDir));
    const dbPath = unreadableIndexDb();

    const warnings = await captureWarnings(async () => {
      await akmListSources({ stashDir });
    });
    // Pre-sweep the `existsSync` gate returned an empty count map with no
    // warning at all, so every bundle rendered as `itemCount: 0`.
    expect(warnings.join("\n")).toContain(dbPath);
    expect(warnings.join("\n")).toMatch(/not readable|ELOOP/);
  });
});

// ── reconcile's gone-path sweep (formerly the --clean pass) ────────────────
//
// index-redesign (docs/plans/index-redesign.md): `--clean` is gone — every
// `akm index` run now reconciles gone paths unconditionally (rule 3). The
// absent-vs-inaccessible contract #791 gave `--clean` moved with it into
// `reconcile.ts`'s gone-path sweep.

describe("akm index deletes absent files, never unreadable ones (#791)", () => {
  test("an unreadable asset keeps its index row and is reported", async () => {
    const stashDir = storage.stashDir;
    const keep = path.join(stashDir, "scripts", "keep", "keep.sh");
    const restricted = path.join(stashDir, "scripts", "restricted", "restricted.sh");
    writeFile(keep, "#!/usr/bin/env bash\necho keep\n");
    writeFile(restricted, "#!/usr/bin/env bash\necho restricted\n");
    saveConfig(stashConfig(stashDir));

    const first = await akmIndex({ stashDir, full: true });
    expect(first.totalEntries).toBe(2);

    // The asset is still there; akm just cannot look at it any more.
    makePathUnresolvableInPlace(restricted);

    let result: Awaited<ReturnType<typeof akmIndex>> | undefined;
    const warnings = await captureWarnings(async () => {
      result = await akmIndex({ stashDir });
    });

    // Pre-#791-in-reconcile: the walker silently drops an unresolvable path
    // from its results the same way it drops an ordinary symlink, so it
    // looked exactly like "deleted" to the gone-path sweep and lost its row.
    expect(result?.totalEntries).toBe(2);
    expect(warnings.join("\n")).toContain(restricted);
    expect(warnings.join("\n")).toMatch(/ELOOP/);
  });

  test("a genuinely deleted asset is still removed", async () => {
    const stashDir = storage.stashDir;
    const keep = path.join(stashDir, "scripts", "keep", "keep.sh");
    const gone = path.join(stashDir, "scripts", "gone", "gone.sh");
    writeFile(keep, "#!/usr/bin/env bash\necho keep\n");
    writeFile(gone, "#!/usr/bin/env bash\necho gone\n");
    saveConfig(stashConfig(stashDir));

    const first = await akmIndex({ stashDir, full: true });
    expect(first.totalEntries).toBe(2);
    fs.unlinkSync(gone);

    const result = await akmIndex({ stashDir });
    expect(result.totalEntries).toBe(1);
  });
});

// ── the usage-history rewrite behind a rename ───────────────────────────────

describe("a rename does not silently drop usage history it cannot reach (#791)", () => {
  test("rekeyEntryInPlace surfaces an unreadable state.db instead of skipping the rewrite", async () => {
    const stashDir = storage.stashDir;
    writeFile(path.join(stashDir, "knowledge", "note.md"), "---\ndescription: a note\n---\nbody\n");
    saveConfig(stashConfig(stashDir));
    await akmIndex({ stashDir, full: true });

    // state.db is a separate file from index.db and can be separately
    // unreadable (different owner, tightened mode). Drop its sidecars too so
    // nothing resolves through them.
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${getStateDbPath()}${suffix}`, { force: true });
    makePathUnresolvableInPlace(getStateDbPath());

    const db = openExistingDatabase();
    try {
      const row = db.prepare("SELECT item_ref FROM entries WHERE item_ref IS NOT NULL LIMIT 1").get() as
        | { item_ref: string }
        | undefined;
      expect(row?.item_ref).toBeDefined();
      const [sourceName, oldRef] = (row as { item_ref: string }).item_ref.split("//");

      // Pre-sweep: `existsSync` said state.db was absent, so the usage-history
      // rewrite was skipped without a word and the rename reported success.
      expect(() =>
        rekeyEntryInPlace(db, {
          newName: "renamed",
          newFilePath: path.join(stashDir, "knowledge", "renamed.md"),
          oldRef: oldRef as string,
          newRef: "knowledge/renamed",
          sourceName: sourceName as string,
          sourceRoot: stashDir,
        }),
      ).toThrow(/Failed to rewrite usage events for move/);
    } finally {
      closeDatabase(db);
    }
  });
});
