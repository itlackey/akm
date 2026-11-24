// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An asset no file holds (a keyring's secret) has no path: `resolveAssetPath` answers `null` for it, where it joined
 * its key below the bundle's cache directory into a path that led nowhere (F36).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmIndex } from "../../../src/indexer/indexer";
import { findAssetOnDisk, resolveAssetPath } from "../../../src/indexer/path-resolver";
import { withFakeSecretStores } from "../../_helpers/fake-secret-stores";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

describe("a ref no file holds (F36)", () => {
  test("is found, and has no path", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        keyring: { adapter: "secret-tool", location: "akm" },
      },
      defaultBundle: "stash",
    });
    const keyrings = {
      akm: [
        {
          path: "/org/freedesktop/secrets/collection/akm/1",
          label: "gh_token",
          attributes: { akm: "akm/gh_token" },
          secret: "ghp-value",
        },
      ],
    };

    await withFakeSecretStores({ keyrings }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      expect(findAssetOnDisk("keyring//secrets/gh_token")?.ref).toBe("keyring//secrets/gh_token");
      expect(await resolveAssetPath("keyring//secrets/gh_token", { mode: "disk-only" })).toBeNull();
      expect(await resolveAssetPath("keyring//secrets/gh_token")).toBeNull();
    });
  });
});
