// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Characterization tests for the `withIsolatedAkmStorage` composite fixture.
 *
 * These pin the contract the migration relies on: one temp root, the four
 * managed env vars repointed into it, a scaffolded stash named as the
 * `defaultBundle` of the config file (akm reads no env var for it), and a single
 * idempotent cleanup that restores every env var it touched. The global
 * `tests/_preload.ts` afterEach tripwire is the regression net that proves the
 * env restore is complete — these tests additionally assert it directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resolveStashDir } from "../src/core/common";
import { makeSandboxDir, STASH_SKELETON_SUBDIRS, withIsolatedAkmStorage } from "./_helpers/sandbox";

describe("withIsolatedAkmStorage", () => {
  test("returns a context with all four storage dirs under one temp root", () => {
    const s = withIsolatedAkmStorage();
    try {
      expect(fs.existsSync(s.root)).toBe(true);
      for (const dir of [s.stashDir, s.dataDir, s.cacheDir, s.configDir]) {
        expect(fs.existsSync(dir)).toBe(true);
        // Every managed dir lives under the single temp root.
        expect(path.dirname(dir)).toBe(s.root);
      }
    } finally {
      s.cleanup();
    }
  });

  test("points the four managed env vars at the context dirs, and names the stash as the working bundle", () => {
    const s = withIsolatedAkmStorage();
    try {
      expect(process.env.AKM_BUNDLE_DIR).toBeUndefined();
      expect(resolveStashDir()).toBe(s.stashDir);
      expect(process.env.XDG_DATA_HOME).toBe(s.dataDir);
      expect(process.env.XDG_CACHE_HOME).toBe(s.cacheDir);
      expect(process.env.XDG_CONFIG_HOME).toBe(s.configDir);
    } finally {
      s.cleanup();
    }
  });

  test("scaffolds the standard stash subdirs and the config akm/ dir", () => {
    const s = withIsolatedAkmStorage();
    try {
      for (const sub of STASH_SKELETON_SUBDIRS) {
        expect(fs.existsSync(path.join(s.stashDir, sub))).toBe(true);
      }
      expect(fs.existsSync(path.join(s.configDir, "akm"))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("cleanup restores prior env values and removes the temp root", () => {
    const prevData = process.env.XDG_DATA_HOME;

    const s = withIsolatedAkmStorage();
    const root = s.root;
    expect(process.env.XDG_DATA_HOME).not.toBe(prevData);
    s.cleanup();

    expect(process.env.XDG_DATA_HOME).toBe(prevData);
    expect(fs.existsSync(root)).toBe(false);
  });

  test("cleanup is idempotent", () => {
    const s = withIsolatedAkmStorage();
    s.cleanup();
    expect(() => s.cleanup()).not.toThrow();
  });

  test("overrides win over the managed defaults and are still restored", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const sentinel = makeSandboxDir("akm-sentinel-config-");
    const s = withIsolatedAkmStorage({ XDG_CONFIG_HOME: sentinel.dir });
    try {
      expect(process.env.XDG_CONFIG_HOME).toBe(sentinel.dir);
      // The other managed vars still point at the temp root, and the working bundle is named in the overriding file.
      expect(process.env.XDG_DATA_HOME).toBe(s.dataDir);
      expect(resolveStashDir()).toBe(s.stashDir);
    } finally {
      s.cleanup();
      sentinel.cleanup();
    }
    expect(process.env.XDG_CONFIG_HOME).toBe(prev);
  });

  test("an undefined override deletes the key and restores it on cleanup", () => {
    const before = process.env.XDG_CACHE_HOME;
    const s = withIsolatedAkmStorage({ XDG_CACHE_HOME: undefined });
    try {
      expect(process.env.XDG_CACHE_HOME).toBeUndefined();
    } finally {
      s.cleanup();
    }
    expect(process.env.XDG_CACHE_HOME).toBe(before);
  });

  test("{ bundle: false } leaves no working bundle, and an AKM_BUNDLE_DIR override is refused", () => {
    const s = withIsolatedAkmStorage({}, { bundle: false });
    try {
      expect(() => resolveStashDir()).toThrow("No default bundle is configured");
    } finally {
      s.cleanup();
    }
    expect(() => withIsolatedAkmStorage({ AKM_BUNDLE_DIR: "/x" })).toThrow("akm reads no AKM_BUNDLE_DIR");
  });

  describe("beforeEach/afterEach usage shape", () => {
    let storage: ReturnType<typeof withIsolatedAkmStorage>;
    beforeEach(() => {
      storage = withIsolatedAkmStorage();
    });
    afterEach(() => storage.cleanup());

    test("the stash dir is live during a test", () => {
      expect(resolveStashDir()).toBe(storage.stashDir);
      expect(fs.existsSync(storage.stashDir)).toBe(true);
    });
  });
});

describe("STASH_SKELETON_SUBDIRS", () => {
  test("is a single non-empty constant covering the standard asset dirs", () => {
    expect(STASH_SKELETON_SUBDIRS.length).toBeGreaterThan(0);
    for (const expected of ["skills", "commands", "agents", "knowledge", "scripts", "memories", "lessons"]) {
      expect(STASH_SKELETON_SUBDIRS).toContain(expected);
    }
  });
});
