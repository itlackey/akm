// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index` names each configured source it could not scan and why, reports a skipped `--clean` as skipped, and
 * records the list in the index for `akm doctor`. The adapter-skip warning moved to `akm doctor` and `akm bundle add`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { genericFilesAdapter } from "../../src/core/adapter/adapters/generic-files-adapter";
import { resolveStashDir } from "../../src/core/common";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { readIncompleteSources } from "../../src/indexer/index-context";
import { akmIndex } from "../../src/indexer/indexer";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { withFakeSecretStores } from "../_helpers/fake-secret-stores";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let dir: string;

type IndexOutput = {
  mode: string;
  stashDir: string;
  totalEntries: number;
  scanComplete: boolean;
  incompleteSources: Array<{ bundle: string; path: string; reason: string }>;
  clean?: { skipped?: { reason: string; sources: unknown[] }; checked?: number };
};

async function index(...extra: string[]): Promise<{ out: IndexOutput; stderr: string }> {
  const result = await runCliCapture(["index", ...extra, "--format=json"]);
  expect(result.code, result.stderr).toBe(0);
  return { out: JSON.parse(result.stdout) as IndexOutput, stderr: result.stderr };
}

test("akm index uses the same directory library as other builders with a keyring default", async () => {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "keyring",
    bundles: { keyring: { adapter: "secret-tool", location: "akm" }, notes: { path: dir } },
  });
  await withEnv({ AKM_BUNDLE_DIR: undefined, HOME: storage.root }, async () => {
    const homeStash = path.join(storage.root, "akm");
    fs.mkdirSync(path.join(homeStash, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(homeStash, "knowledge", "home.md"), "---\ndescription: home\n---\n\n# Home\n");
    await withFakeSecretStores(
      {
        keyrings: {
          akm: [
            {
              path: "/org/freedesktop/secrets/collection/akm/1",
              label: "token",
              attributes: { akm: "akm/token" },
              secret: "fixture",
            },
          ],
        },
      },
      async () => {
        expect((await index()).out).toMatchObject({ mode: "full", stashDir: homeStash, totalEntries: 3 });
        expect((await index()).out).toMatchObject({ mode: "incremental", stashDir: homeStash, totalEntries: 3 });
        expect(await akmIndex({ stashDir: resolveStashDir() })).toMatchObject({ mode: "incremental", totalEntries: 3 });
        expect((await index()).out).toMatchObject({ mode: "incremental", stashDir: homeStash, totalEntries: 3 });
      },
    );
  });
});

function recordedIncompleteSources() {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) throw new Error("no index");
  try {
    return readIncompleteSources(db);
  } finally {
    closeDatabase(db);
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  dir = path.join(storage.root, "team-notes");
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(dir, "knowledge", "note.md"), "---\ndescription: a note\n---\n\n# A note\n");
});

afterEach(() => {
  storage.cleanup();
});

describe("a configured source that cannot be scanned", () => {
  test("is named with its error, --clean says it was skipped, and the index records the list", async () => {
    expect((await runCliCapture(["bundle", "add", dir, "--name", "notes"])).code).toBe(0);
    const first = await index();
    expect(first.out.incompleteSources).toEqual([]);
    expect(recordedIncompleteSources()).toEqual([]);

    const moved = `${dir}.moved`;
    fs.renameSync(dir, moved);

    const second = await index();
    expect(second.out.scanComplete).toBe(false);
    expect(second.out.incompleteSources).toHaveLength(1);
    expect(second.out.incompleteSources[0]).toMatchObject({ bundle: "notes", path: dir });
    expect(second.out.incompleteSources[0]?.reason).toContain("ENOENT");
    expect(recordedIncompleteSources()).toEqual(second.out.incompleteSources);

    const cleaned = await index("--clean");
    expect(cleaned.out.clean?.skipped?.reason).toBe("incomplete-scan");
    expect(cleaned.out.clean?.skipped?.sources).toHaveLength(1);
    expect(cleaned.out.clean?.checked).toBeUndefined();

    fs.renameSync(moved, dir);
    const restored = await index();
    expect(restored.out.scanComplete).toBe(true);
    expect(restored.out.incompleteSources).toEqual([]);
    expect(recordedIncompleteSources()).toEqual([]);
  }, 60_000);
});

describe("an unresolved source", () => {
  test("reports its real path and the real reason, never the internal placeholder", async () => {
    const outside = path.join(storage.root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    saveConfig({
      semanticSearchMode: "off",
      bundles: {
        escaping: {
          path: dir,
          adapter: "akm",
          root: "../team-notes-sibling",
          writable: false,
        },
        unmaterialized: { git: "git://127.0.0.1:1/none.git" },
      },
    });

    const result = await akmIndex({
      stashDir: storage.stashDir,
      hydrateSources: false,
      persistDetectedAdapters: false,
    });

    const byBundle = Object.fromEntries(result.incompleteSources.map((source) => [source.bundle, source]));
    expect(byBundle.escaping?.path).toBe(path.resolve(dir, "../team-notes-sibling"));
    expect(byBundle.escaping?.reason).toContain("escapes bundle");
    expect(byBundle.unmaterialized?.path).toContain("repo");
    expect(byBundle.unmaterialized?.reason).toContain("ENOENT");
    for (const source of result.incompleteSources) expect(source.path).not.toContain("unresolved");
  }, 60_000);
});

describe("an unresolved source reports the provider's own error", () => {
  test("an invalid git URL is unknown, with the URL error as the reason", async () => {
    saveConfig({ semanticSearchMode: "off", bundles: { broken: { git: "not a url" } } });

    const result = await akmIndex({
      stashDir: storage.stashDir,
      hydrateSources: false,
      persistDetectedAdapters: false,
    });

    const broken = result.incompleteSources.find((source) => source.bundle === "broken");
    expect(broken?.path).toBe("unknown");
    expect(broken?.reason).toContain("Invalid git URL");
  }, 60_000);

  test("a recorded but never-installed npm bundle is never walked as a relative path", async () => {
    const cwd = path.join(storage.root, "cwd");
    const decoy = path.join(cwd, "npm:left-pad", "knowledge");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "decoy.md"), "---\ndescription: decoy\n---\n\n# Decoy\n");
    saveConfig({ semanticSearchMode: "off", bundles: { pad: { npm: "npm:left-pad" } } });

    const previous = process.cwd();
    process.chdir(cwd);
    let result: Awaited<ReturnType<typeof akmIndex>>;
    try {
      result = await akmIndex({ stashDir: storage.stashDir, hydrateSources: false, persistDetectedAdapters: false });
    } finally {
      process.chdir(previous);
    }

    expect(result.totalEntries).toBe(0);
    const pad = result.incompleteSources.find((source) => source.bundle === "pad");
    expect(pad?.path).toBe("unknown");
    expect(pad?.reason).toContain("akm bundle update");
  }, 60_000);
});

describe("a recorded but never-installed npm bundle on other commands", () => {
  test("search prints no source-path warning", async () => {
    saveConfig({ semanticSearchMode: "off", bundles: { pad: { npm: "npm:left-pad" } } });

    const result = await runCliCapture(["search", "anything", "--format=json"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("failed to resolve");
  }, 60_000);
});

describe("the adapter-skip warning (§0.2 N18)", () => {
  test("`akm index` no longer prints it, whatever the bundle's adapter skips", async () => {
    expect((await runCliCapture(["bundle", "add", dir, "--name", "notes"])).code).toBe(0);
    const config = loadConfig();
    const entry = config.bundles?.notes;
    if (!entry) throw new Error("bundle missing");
    saveConfig({
      ...config,
      bundles: { ...config.bundles, notes: { ...entry, adapter: "agent-skills", writable: false } },
    });

    expect((await index("--full")).stderr).not.toContain("adapter skipped");
  }, 60_000);
});

describe("a directory bundle whose listing fails keeps its rows; one that lists nothing loses them (F18)", () => {
  /** The rows the index holds for `bundle`, by ref. */
  function rowsOf(bundle: string): string[] {
    const db = openReadonlyExistingDatabase(getDbPath());
    if (!db) throw new Error("no index");
    try {
      return (
        db.prepare("SELECT item_ref FROM entries WHERE bundle_id = ? ORDER BY item_ref").all(bundle) as Array<{
          item_ref: string;
        }>
      ).map((row) => row.item_ref);
    } finally {
      closeDatabase(db);
    }
  }

  /** Run `akm index` in process, with what it warned. */
  async function indexWarning(): Promise<{ result: Awaited<ReturnType<typeof akmIndex>>; warnings: string }> {
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      return { result: await akmIndex({ stashDir: storage.stashDir }), warnings: warnings.join("\n") };
    } finally {
      _setWarnSinkForTests(undefined);
    }
  }

  beforeEach(() => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { notes: { path: dir, adapter: "generic-files", writable: false } },
    });
  });

  test("a listing that fails outright warns, naming the bundle and the cause as for a keyring or vault", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const before = rowsOf("notes");
    expect(before.length).toBeGreaterThan(0);
    const failing = spyOn(genericFilesAdapter, "list").mockImplementation(() => {
      throw new Error("the disk went away");
    });
    try {
      const { result, warnings } = await indexWarning();
      expect(warnings).toContain(
        '[index] source "notes" was not scanned completely; preserving its last-known-good rows. the disk went away',
      );
      expect(result.scanComplete).toBe(false);
      expect(result.incompleteSources).toEqual([
        expect.objectContaining({ bundle: "notes", reason: "the disk went away" }),
      ]);
    } finally {
      failing.mockRestore();
    }
    expect(rowsOf("notes")).toEqual(before);
  }, 60_000);

  test("a bundle root that is missing is reported and keeps its rows, as before", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const before = rowsOf("notes");
    fs.renameSync(dir, `${dir}.gone`);
    const { result, warnings } = await indexWarning();
    expect(warnings).toMatch(
      /\[index\] source "notes" was not scanned completely; preserving its last-known-good rows\. ENOENT/,
    );
    expect(result.scanComplete).toBe(false);
    expect(result.incompleteSources).toEqual([expect.objectContaining({ bundle: "notes", path: dir })]);
    expect(rowsOf("notes")).toEqual(before);
  }, 60_000);

  test("a listing that succeeds with nothing in it removes the bundle's rows", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    expect(rowsOf("notes").length).toBeGreaterThan(0);
    fs.rmSync(path.join(dir, "knowledge"), { recursive: true });
    const { result, warnings } = await indexWarning();
    expect(warnings).not.toContain("was not scanned completely");
    expect(result.scanComplete).toBe(true);
    expect(rowsOf("notes")).toEqual([]);
  }, 60_000);
});
