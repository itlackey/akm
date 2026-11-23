// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which bundle a directory is (`bundleAtDir`) and the key state rows are filed under (§0.2 P8): matched against every
 * configured bundle's resolved root, whatever kind the bundle is. A directory no bundle has is its own key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { bundleAtDir, bundleKeyForDir } from "../../../src/core/bundle-at-dir";
import type { AkmConfig } from "../../../src/core/config/config";
import { getLocationBundleRoot } from "../../../src/core/paths";
import { resolveSourceEntries } from "../../../src/indexer/search/search-source";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

const dir = (name: string) => {
  const full = path.join(storage.root, name);
  fs.mkdirSync(full, { recursive: true });
  return full;
};
const configOf = (bundles: Record<string, unknown>, defaultBundle?: string) =>
  ({ bundles, ...(defaultBundle ? { defaultBundle } : {}) }) as unknown as AkmConfig;

describe("bundleAtDir", () => {
  test("is the configured directory bundle whose root is the directory, whatever it is called", () => {
    const config = configOf({ notes: { path: dir("lib") } });
    expect(bundleAtDir(config, path.join(storage.root, "lib"))).toBe("notes");
  });

  test("follows a symbolic link to the real directory", () => {
    const real = dir("real");
    fs.symlinkSync(real, path.join(storage.root, "alias"));
    expect(bundleAtDir(configOf({ notes: { path: real } }), path.join(storage.root, "alias"))).toBe("notes");
  });

  test("two git bundles are two bundles: each checkout is its own", () => {
    const config = configOf({
      alpha: { git: "https://example.test/alpha.git" },
      beta: { git: "https://example.test/beta.git" },
    });
    const roots = Object.fromEntries(
      resolveSourceEntries(undefined, config)
        .filter((source) => source.registryId !== undefined)
        .map((source) => [source.registryId as string, source.path]),
    );
    expect(roots.alpha).not.toBe(roots.beta);
    expect(bundleAtDir(config, roots.alpha as string)).toBe("alpha");
    expect(bundleAtDir(config, roots.beta as string)).toBe("beta");
  });

  test("a location bundle is the root its entries are indexed under", () => {
    const config = configOf({ keys: { location: "alias", adapter: "secret-tool" } });
    expect(bundleAtDir(config, getLocationBundleRoot("keys"))).toBe("keys");
  });

  test("two bundles on one directory: the default bundle, else the first in configured order", () => {
    const shared = dir("shared");
    const bundles = { first: { path: shared }, second: { path: shared } };
    expect(bundleAtDir(configOf(bundles), shared)).toBe("first");
    expect(bundleAtDir(configOf(bundles, "second"), shared)).toBe("second");
  });

  test("is none for a directory no bundle has, which is then its own key", () => {
    const config = configOf({ notes: { path: dir("lib") } });
    const elsewhere = dir("elsewhere");
    expect(bundleAtDir(config, elsewhere)).toBeUndefined();
    expect(bundleKeyForDir(config, elsewhere)).toBe(elsewhere);
    expect(bundleKeyForDir(config, path.join(storage.root, "lib"))).toBe("notes");
  });
});
