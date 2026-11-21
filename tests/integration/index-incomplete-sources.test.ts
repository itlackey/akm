// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index` names each configured source it could not scan and why, reports a skipped `--clean` as skipped, and
 * records the list in the index for `akm doctor`. The adapter-skip warning names the bundle's config key and is
 * printed once per change of what is skipped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { readIncompleteSources } from "../../src/indexer/walk/index-context";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let dir: string;

type IndexOutput = {
  scanComplete: boolean;
  incompleteSources: Array<{ bundle: string; component: string; path: string; reason: string }>;
  clean?: { skipped?: { reason: string; sources: unknown[] }; checked?: number };
};

async function index(...extra: string[]): Promise<{ out: IndexOutput; stderr: string }> {
  const result = await runCliCapture(["index", ...extra, "--format=json"]);
  expect(result.code, result.stderr).toBe(0);
  return { out: JSON.parse(result.stdout) as IndexOutput, stderr: result.stderr };
}

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
    expect(second.out.incompleteSources[0]).toMatchObject({ bundle: "notes", component: "main", path: dir });
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

describe("the adapter-skip warning", () => {
  function narrowAdapter(): void {
    const config = loadConfig();
    const entry = config.bundles?.notes;
    if (!entry) throw new Error("bundle missing");
    saveConfig({
      ...config,
      bundles: {
        ...config.bundles,
        notes: { ...entry, components: { main: { root: ".", adapter: "agent-skills", writable: false } } },
      },
    });
  }

  test("names the bundle and its config key, and is repeated only when the skipped set changes", async () => {
    expect((await runCliCapture(["bundle", "add", dir, "--name", "notes"])).code).toBe(0);
    narrowAdapter();

    const first = await index("--full");
    expect(first.stderr).toContain('bundle "notes"');
    expect(first.stderr).toContain('bundles.notes.components.main.adapter to "akm"');
    expect(first.stderr).not.toContain("components.<name>");

    const again = await index("--full");
    expect(again.stderr).not.toContain("adapter skipped");

    fs.writeFileSync(path.join(dir, "knowledge", "second.md"), "---\ndescription: second\n---\n\n# Second\n");
    const changed = await index("--full");
    expect(changed.stderr).toContain("skipped 2 files");
  }, 60_000);
});
