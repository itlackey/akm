// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A layout-26 index written before 4f.2 keys a keyring's entry under a path inside the bundle's root and marks its
 * document `fileless`. Every command serves such a row as a row with no file, with no message; `akm migrate apply`
 * re-keys it (`file_path = ''`, no `fileless`), changing no column and not the layout version, and the commands answer
 * as before; and `akm index` writes the same form on its own.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runMigration } from "../../../scripts/akm-migrate/run-migrate";
import { akmSearch } from "../../../src/commands/read/search";
import { akmShowUnified as akmShow } from "../../../src/commands/read/show";
import { clearAdapterCaches } from "../../../src/core/adapter/registry";
import { resetConfigCache } from "../../../src/core/config/config";
import { readSecret } from "../../../src/core/env-secret-ref";
import { getCacheDir, getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { withFakeSecretStores } from "../../_helpers/fake-secret-stores";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
afterEach(() => storage?.cleanup());

const KEYRING = [
  { path: "/org/freedesktop/secrets/collection/akm/1", label: "gh", attributes: { akm: "akm/gh" }, secret: "v" },
  { path: "/org/freedesktop/secrets/collection/akm/2", label: "npm", attributes: { akm: "akm/npm" }, secret: "w" },
];

async function withKeyring(run: () => Promise<void>): Promise<void> {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true },
      keyring: { adapter: "secret-tool", location: "akm" },
    },
    defaultBundle: "stash",
  });
  resetConfigCache();
  await withFakeSecretStores({ keyrings: { akm: KEYRING } }, run);
}

interface Row {
  id: number;
  item_ref: string;
  file_path: string;
  document_json: string;
}

function rows(): Row[] {
  const db = openExistingDatabase(getDbPath());
  try {
    return db
      .prepare(
        "SELECT id, item_ref, file_path, document_json FROM entries WHERE bundle_id = 'keyring' ORDER BY item_ref",
      )
      .all() as Row[];
  } finally {
    closeDatabase(db);
  }
}

/**
 * The shape of the index before 4f.2: each keyring row under a path in the bundle's root, its document `fileless`, and
 * no per-bundle variant. With `storeField`, as a build before the locator wrote it: the entry's object and attributes
 * under `store`.
 */
function writeLegacyForm(options: { storeField?: boolean } = {}): void {
  const db = openExistingDatabase(getDbPath());
  try {
    for (const row of rows()) {
      const { locator, ...rest } = JSON.parse(row.document_json);
      const document = { ...rest, fileless: true, ...(options.storeField ? { store: locator } : { locator }) };
      db.prepare("UPDATE entries SET file_path = ?, document_json = ? WHERE id = ?").run(
        `${getCacheDir()}/index/bundles/keyring/${row.item_ref.split("//")[1]}`,
        JSON.stringify(document),
        row.id,
      );
    }
    db.prepare("DELETE FROM index_meta WHERE key = 'variant:keyring'").run();
  } finally {
    closeDatabase(db);
  }
}

/** A secret's value as a new command reads it: through its index row, nothing remembered from the index run. */
function secretValue(ref: string): string {
  clearAdapterCaches();
  return readSecret(ref).value;
}

/** Each keyring row's recorded locator, by ref. */
function locators(): unknown[] {
  return rows().map((row) => JSON.parse(row.document_json).locator);
}

function layout(): { version: string | undefined; columns: string[] } {
  const db = openExistingDatabase(getDbPath());
  try {
    const version = (
      db.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string } | undefined
    )?.value;
    const columns = (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((c) => c.name);
    return { version, columns };
  } finally {
    closeDatabase(db);
  }
}

/** What the commands answer for the keyring's entries. */
async function answers(): Promise<unknown> {
  const shown = await akmShow({ ref: "keyring//secrets/gh" });
  const found = await akmSearch({ query: "gh", source: "keyring", limit: 10 } as never);
  return {
    shown: { path: shown.path, ref: shown.ref, type: shown.type, editable: shown.editable },
    hits: (found as { hits: unknown }).hits,
  };
}

describe("a layout-26 index from before 4f.2", () => {
  test("serves a keyring's rows as rows with no file, `akm migrate apply` re-keys them, and the commands answer alike", async () => {
    await withKeyring(async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      expect(rows().map((row) => row.file_path)).toEqual(["", ""]);
      const recorded = locators();
      expect(recorded).toEqual(KEYRING.map((item) => ({ item: item.path, attributes: item.attributes })));
      expect(secretValue("keyring//secrets/gh")).toBe("v");
      writeLegacyForm();
      expect(rows().every((row) => row.file_path !== "" && JSON.parse(row.document_json).fileless === true)).toBe(true);
      const before = layout();
      const stderr = spyOn(process.stderr, "write");
      const answeredBefore = await answers();
      expect(stderr).not.toHaveBeenCalled();
      stderr.mockRestore();
      expect((answeredBefore as { shown: { path?: string } }).shown.path).toBeUndefined();
      expect((answeredBefore as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

      const dry = await runMigration({ apply: false });
      expect(dry.indexRows?.changed).toBe(2);
      expect(dry.status).toBe("ready");
      expect(rows().every((row) => row.file_path !== "")).toBe(true);

      const ids = rows().map((row) => row.id);
      const applied = await runMigration({ apply: true });
      expect(applied.indexRows).toMatchObject({ changed: 2, applied: 2, message: "index rows: 2 re-keyed" });
      expect(rows().map((row) => row.id)).toEqual(ids);
      expect(rows().map((row) => row.file_path)).toEqual(["", ""]);
      expect(rows().some((row) => "fileless" in JSON.parse(row.document_json))).toBe(false);
      // A keyring entry's recorded locator survives the re-key, and a secret is read through it.
      expect(locators()).toEqual(recorded);
      expect(secretValue("keyring//secrets/gh")).toBe("v");
      expect(layout()).toEqual(before);
      expect(await answers()).toEqual(answeredBefore);
      expect((await runMigration({ apply: false })).indexRows).toBeUndefined();
    });
  });

  test("`akm index` writes a legacy row again in the new form, keeping its id", async () => {
    await withKeyring(async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      writeLegacyForm();
      const ids = rows().map((row) => row.id);
      await akmIndex({ stashDir: storage.stashDir });
      expect(rows().map((row) => row.id)).toEqual(ids);
      expect(rows().map((row) => row.file_path)).toEqual(["", ""]);
      expect(rows().some((row) => "fileless" in JSON.parse(row.document_json))).toBe(false);
    });
  });

  test("`akm index` rewrites a row that recorded the entry under `store`, so a secret is read through its locator", async () => {
    await withKeyring(async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      const recorded = locators();
      writeLegacyForm({ storeField: true });
      expect(locators()).toEqual([undefined, undefined]);
      await akmIndex({ stashDir: storage.stashDir });
      expect(locators()).toEqual(recorded);
      expect(rows().some((row) => "store" in JSON.parse(row.document_json))).toBe(false);
      expect(secretValue("keyring//secrets/npm")).toBe("w");
    });
  });
});
