// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The secret store adapter contract: what a store bundle's adapter recognizes
 * as an entry, which of a store's secrets are entries, and how a bundle's
 * `store` descriptor names its adapter. The adapters' own clients run programs
 * and are covered in `tests/integration/secret-store-bundles.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  parseStoreDescriptor,
  SECRET_STORE_ADAPTER_IDS,
  VALID_ADAPTER_IDS,
} from "../../../src/core/adapter/adapter-ids";
import { secretStoreAdapter } from "../../../src/core/adapter/adapters/secret-store-shared";
import { getAdapters, secretStoreOf } from "../../../src/core/adapter/registry";
import {
  listSecretNames,
  type SecretStore,
  secretConceptId,
  secretNameOf,
} from "../../../src/core/adapter/secret-store";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

function storeOf(names: string[]): SecretStore {
  return { list: () => names, read: () => undefined, write: () => undefined, remove: () => false };
}

const ROOT = "/index/stores/keyring";
const COMPONENT: BundleComponent = { id: "keyring", adapter: "memory", root: ROOT, writable: true, locator: "akm" };
const adapter = secretStoreAdapter("memory", "1", () => storeOf([]));

describe("secret store adapter", () => {
  test("an entry is recognized from its ref alone, as a secret with its name", () => {
    const doc = adapter.recognize(COMPONENT, buildFileContext(ROOT, `${ROOT}/secrets/team/gh_token`));
    expect(doc).toMatchObject({
      ref: "keyring//secrets/team/gh_token",
      bundle: "keyring",
      conceptId: "secrets/team/gh_token",
      adapterId: "memory",
      type: "secret",
      name: "gh_token",
    });
    expect(doc?.content).toBeUndefined();
  });

  test("two entries never share a hash, and one entry keeps its own", () => {
    const hashOf = (name: string) =>
      adapter.recognize(COMPONENT, buildFileContext(ROOT, `${ROOT}/secrets/${name}`))?.hash;
    expect(hashOf("a")).toBe(hashOf("a"));
    expect(hashOf("a")).not.toBe(hashOf("b"));
  });

  test("a path outside secrets/ is no entry", () => {
    expect(adapter.recognize(COMPONENT, buildFileContext(ROOT, `${ROOT}/env/prod.env`))).toBeNull();
    expect(adapter.recognize(COMPONENT, buildFileContext(ROOT, `${ROOT}/secrets`))).toBeNull();
  });

  test("a store has nothing to validate", async () => {
    expect(await adapter.validate(COMPONENT, [], {} as never)).toEqual([]);
  });
});

describe("secret names and refs", () => {
  test("a secret's ref is secrets/<name>, and only such a ref names a secret", () => {
    expect(secretConceptId("team/gh_token")).toBe("secrets/team/gh_token");
    expect(secretNameOf("secrets/team/gh_token")).toBe("team/gh_token");
    expect(secretNameOf("secrets/")).toBeUndefined();
    expect(secretNameOf("knowledge/secrets/x")).toBeUndefined();
  });

  test("a secret whose name no ref can spell is not an entry", () => {
    const names = ["gh_token", "My Wi-Fi", "Passwords/router", "a#b", "../escape", "a//b", "trailing/"];
    expect(listSecretNames(storeOf(names))).toEqual(["gh_token", "My Wi-Fi", "Passwords/router"]);
  });
});

describe("store descriptors", () => {
  test("a descriptor is a secret store adapter and what it opens", () => {
    expect(parseStoreDescriptor("secret-tool:akm")).toEqual({ adapterId: "secret-tool", locator: "akm" });
    // Only the first colon separates: a locator may hold more.
    expect(parseStoreDescriptor("azure-key-vault:team:prod")).toEqual({
      adapterId: "azure-key-vault",
      locator: "team:prod",
    });
  });

  test("a directory adapter, an unknown adapter and an empty locator are refused", () => {
    for (const store of ["akm:work", "dotenv:x", "nope:x", "secret-tool:", "secret-tool", ":x", ""]) {
      expect(parseStoreDescriptor(store)).toBeUndefined();
    }
  });

  test("the store adapters are exactly the registered adapters that open a store", () => {
    const opening = getAdapters()
      .filter((registered) => registered.secretStore !== undefined)
      .map((registered) => registered.id);
    expect(opening).toEqual([...SECRET_STORE_ADAPTER_IDS]);
    expect(VALID_ADAPTER_IDS.filter((id) => SECRET_STORE_ADAPTER_IDS.includes(id))).toEqual([]);
  });

  test("a bundle has a store only when it names both a store adapter and a locator", () => {
    expect(secretStoreOf({ adapterId: "secret-tool", locator: "akm" })).toBeDefined();
    expect(secretStoreOf({ adapterId: "secret-tool" })).toBeUndefined();
    expect(secretStoreOf({ adapterId: "akm", locator: "akm" })).toBeUndefined();
    expect(secretStoreOf({ locator: "akm" })).toBeUndefined();
  });
});
