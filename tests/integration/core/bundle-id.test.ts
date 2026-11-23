// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleAtDir, bundleIdForDir } from "../../../src/core/bundle-id";
import type { AkmConfig } from "../../../src/core/config/config-types";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bundle-id-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const dir = (name: string) => {
  const full = path.join(root, name);
  fs.mkdirSync(full, { recursive: true });
  return full;
};

describe("bundleIdForDir", () => {
  test("is the basename slug of a directory no configured name takes", () => {
    expect(bundleIdForDir(path.join(root, "My Library"), new Set(["work"]))).toBe("my-library");
  });

  test("adds eight hex digits of the resolved path when a configured name has the slug", () => {
    const id = bundleIdForDir(path.join(root, "work"), new Set(["work"]));
    expect(id).toMatch(/^work-[0-9a-f]{8}$/);
    expect(bundleIdForDir(path.join(root, "work"), new Set(["work"]))).toBe(id);
  });
});

describe("bundleAtDir", () => {
  test("is the configured bundle whose content root is the directory, whatever it is called", () => {
    const config = { bundles: { notes: { path: dir("lib") } } } as unknown as AkmConfig;
    expect(bundleAtDir(config, path.join(root, "lib"))).toBe("notes");
  });

  test("follows a symbolic link to the real directory", () => {
    const real = dir("real");
    fs.symlinkSync(real, path.join(root, "alias"));
    const config = { bundles: { notes: { path: real } } } as unknown as AkmConfig;
    expect(bundleAtDir(config, path.join(root, "alias"))).toBe("notes");
  });

  test("is the id the directory gets when no configured bundle is there", () => {
    const config = { bundles: { notes: { path: dir("lib") } } } as unknown as AkmConfig;
    expect(bundleAtDir(config, dir("elsewhere"))).toBe("elsewhere");
  });

  test("two bundles on one directory: the default bundle, else the first in configured order", () => {
    const shared = dir("shared");
    const bundles = { first: { path: shared }, second: { path: shared } };
    expect(bundleAtDir({ bundles } as unknown as AkmConfig, shared)).toBe("first");
    expect(bundleAtDir({ bundles, defaultBundle: "second" } as unknown as AkmConfig, shared)).toBe("second");
  });

  test("a bundle with a root inside its path is found by the content root", () => {
    const outer = dir("outer");
    dir("outer/docs");
    const config = { bundles: { docs: { path: outer, root: "docs" } } } as unknown as AkmConfig;
    expect(bundleAtDir(config, path.join(outer, "docs"))).toBe("docs");
    expect(bundleAtDir(config, outer)).toBe("outer");
  });
});
