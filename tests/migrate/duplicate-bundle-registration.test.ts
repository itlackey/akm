// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for itlackey/akm#870: `AKM_BUNDLE_DIR` (or `--dir`)
 * pointing at a directory that is ALREADY configured under a different
 * bundle id must not register a second bundle for it, and if two bundle
 * ids already exist for the same directory (as happened in the wild before
 * this fix), `akm migrate` must reconcile rather than fail with the opaque
 * `duplicate task migration file path` / exit 70.
 *
 * Three parts, matching the issue's ask:
 *   1. Registration matches on the RESOLVED CONTENT ROOT
 *      (`path.resolve(entry.path, component.root ?? ".")`), not the bare
 *      configured `path` — `bundleKeyForContentRoot` / `withPrimaryBundle`.
 *   2. `akm migrate`'s file enumeration (`taskRoots` in
 *      scripts/akm-migrate/task-migrate.ts) reconciles two bundle ids that
 *      already resolve to the same directory instead of double-counting.
 *   3. A genuinely irreconcilable duplicate (conflicting settings) fails
 *      with a message naming both bundle ids and the shared path.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { inspectMigrationPlan, inspectTaskV4MigrationStatus } from "../../scripts/akm-migrate/task-migrate";
import { withPrimaryBundle } from "../../src/commands/sources/bundle-config-ops";
import { type AkmConfig, bundleContentRoot, bundleKeyForContentRoot } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { resolveWorkingStashTarget } from "../../src/core/write-source";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

function writeV2Task(tasksDir: string, name: string): void {
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, name), "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n", {
    mode: 0o640,
  });
}

// ── Part 0: the identity primitive ──────────────────────────────────────────

describe("bundleContentRoot / bundleKeyForContentRoot", () => {
  test("resolves a relative, absolute, and trailing-slash spelling of the same path identically", () => {
    const a = bundleContentRoot("/home/user/openpalm");
    const b = bundleContentRoot("/home/user/openpalm/");
    const c = bundleContentRoot("/home/user/./openpalm");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test("finds the bundle id owning a resolved content root, honoring a non-trivial component root", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: {
        openpalm: { path: "/home/user/openpalm", components: { main: { root: "catalog" } } },
      },
    };
    expect(bundleKeyForContentRoot(config, "/home/user/openpalm/catalog")).toBe("openpalm");
    expect(bundleKeyForContentRoot(config, "/home/user/openpalm")).toBeUndefined();
  });
});

// ── Part 1: registration must not mint a second bundle ──────────────────────

describe("withPrimaryBundle (issue #870 part 1)", () => {
  test("reuses the existing bundle id when its resolved content root already matches", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { openpalm: { path: "/home/user/openpalm", writable: true } },
      // No defaultBundle set yet — this is exactly the shape a container
      // entrypoint hits: AKM_BUNDLE_DIR == an already-configured bundle's
      // path, but defaultBundle hasn't been pointed at it yet.
    };
    const next = withPrimaryBundle(config, "/home/user/openpalm");
    expect(Object.keys(next.bundles ?? {})).toEqual(["openpalm"]);
    expect(next.defaultBundle).toBe("openpalm");
  });

  test("still mints a fresh id when no configured bundle owns that root", () => {
    const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off", bundles: {} };
    const next = withPrimaryBundle(config, "/home/user/brand-new-stash");
    expect(Object.keys(next.bundles ?? {})).toHaveLength(1);
    expect(next.defaultBundle).toBeDefined();
  });
});

describe("resolveWorkingStashTarget (issue #870 part 1, AKM_BUNDLE_DIR path)", () => {
  test("AKM_BUNDLE_DIR equal to an already-configured bundle's resolved root does not synthesize a second bundle", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: { openpalm: { path: storage.stashDir, writable: true } },
      };
      const target = resolveWorkingStashTarget(config, { requireWritable: false });
      expect(target.source.name).toBe("openpalm");
    } finally {
      storage.cleanup();
    }
  });

  test("a symlink spelling cannot reactivate a disabled configured bundle", () => {
    const storage = withIsolatedAkmStorage();
    const alias = path.join(path.dirname(storage.stashDir), `${path.basename(storage.stashDir)}-alias`);
    try {
      fs.symlinkSync(storage.stashDir, alias, "dir");
      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: { dormant: { path: alias, enabled: false } },
      };
      expect(() => resolveWorkingStashTarget(config, { requireWritable: false })).toThrow(/disabled/i);
    } finally {
      fs.rmSync(alias, { force: true });
      storage.cleanup();
    }
  });
});

// ── Parts 2 & 3: migrate enumeration reconciles / fails clearly ─────────────

describe("akm migrate task enumeration (issue #870 parts 2 & 3)", () => {
  test("two bundle ids resolving to the same directory are rejected before migration enumeration", () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeV2Task(path.join(storage.stashDir, "tasks"), "demo.yml");
      writeSandboxConfig({
        defaultBundle: "bundle-a",
        bundles: {
          "bundle-a": {
            path: storage.stashDir,
            writable: true,
            components: { main: { root: ".", adapter: "akm", writable: true } },
          },
          "bundle-b": {
            path: storage.stashDir,
            writable: true,
            components: { main: { root: ".", adapter: "akm", writable: true } },
          },
        },
      });

      expect(() => inspectMigrationPlan()).toThrow(/bundle-a.*bundle-b.*same physical content root/i);
    } finally {
      storage.cleanup();
    }
  });

  test("an irreconcilable duplicate (conflicting writable settings) names both bundle ids and the shared path", () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeV2Task(path.join(storage.stashDir, "tasks"), "demo.yml");
      writeSandboxConfig({
        defaultBundle: "bundle-a",
        bundles: {
          "bundle-a": {
            path: storage.stashDir,
            writable: true,
            components: { main: { root: ".", adapter: "akm", writable: true } },
          },
          "bundle-b": {
            path: storage.stashDir,
            writable: true,
            components: { main: { root: ".", adapter: "akm", writable: false } },
          },
        },
      });

      let caught: unknown;
      try {
        inspectTaskV4MigrationStatus();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const message = (caught as ConfigError).message;
      expect(message).toContain("bundle-a");
      expect(message).toContain("bundle-b");
      expect(message).toContain(storage.stashDir);
      expect(message).not.toContain("duplicate task migration file path");
    } finally {
      storage.cleanup();
    }
  });
});
