// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The index follows a write to a secret manager's bundle by one ref: a created secret is searchable and a deleted one
 * is gone, as a directory bundle's are, and an entry no file holds is indexed and shown with no path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { akmShowUnified as akmShow } from "../../src/commands/read/show";
import { writeAssets } from "../../src/core/assets/write";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { resolveWriteTarget } from "../../src/core/write-source";
import { akmIndex } from "../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { withFakeSecretStores } from "../_helpers/fake-secret-stores";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
afterEach(() => storage?.cleanup());

function row(ref: string): { type: string; file_path: string; document_json: string } | undefined {
  const db = openExistingDatabase(getDbPath());
  try {
    return db.prepare("SELECT type, file_path, document_json FROM entries WHERE item_ref = ?").get(ref) as never;
  } finally {
    closeDatabase(db);
  }
}

const KEYRING = [
  { path: "/org/freedesktop/secrets/collection/akm/1", label: "gh", attributes: { akm: "akm/gh" }, secret: "v" },
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

describe("a secret manager's bundle and the index", () => {
  test("a created secret has a row with no file, and a deleted one loses it", async () => {
    await withKeyring(async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      const target = resolveWriteTarget(loadConfig(), "keyring");

      writeAssets(target, { purpose: "test" }, (w) => w.create({ type: "secret", name: "fresh", content: "v2" }));
      const created = row("keyring//secrets/fresh");
      expect(created?.type).toBe("secret");
      expect(created?.file_path).toBe("");
      expect(JSON.parse(created?.document_json ?? "{}").fileless).toBeUndefined();

      writeAssets(target, { purpose: "test" }, (w) => w.delete("secrets/fresh"));
      expect(row("keyring//secrets/fresh")).toBeFalsy();
    });
  });

  test("show prints no path for an entry no file holds, and says its content is the value", async () => {
    await withKeyring(async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      const shown = await akmShow({ ref: "keyring//secrets/gh" });
      expect(shown.path).toBeUndefined();
      expect(shown.action).toContain("its content is the value and is never written");
      expect(shown.action).not.toContain("are never written");
    });
  });
});
