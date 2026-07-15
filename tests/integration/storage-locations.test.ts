// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  getCacheDir,
  getConfigDir,
  getDataDir,
  getDbPath,
  getDefaultStashDir,
  getLockfileLockPath,
  getLockfilePath,
  getWorkflowDbPath,
} from "../../src/core/paths";
import { getStateDbPath } from "../../src/core/state-db";
import { resolveStorageLocations } from "../../src/storage/locations";
import { withEnv } from "../_helpers/sandbox";

// ── Environment sandbox ──────────────────────────────────────────────────────
// Pin every path-affecting env var to a deterministic isolated state so the
// resolver and the underlying getters observe identical inputs. withEnv()
// restores the prior values after each block.

const SANDBOX_ROOT = "/tmp/akm-storage-locations-sandbox";

// XDG_DATA_HOME is mandatory under `bun test`: getDataDir() refuses to resolve
// without it (TEST_ISOLATION_MISSING guard). All XDG roots are pinned so the
// resolver and the getters see one deterministic layout.
const isolatedEnv = {
  XDG_CONFIG_HOME: `${SANDBOX_ROOT}/config`,
  XDG_CACHE_HOME: `${SANDBOX_ROOT}/cache`,
  XDG_DATA_HOME: `${SANDBOX_ROOT}/data`,
  XDG_STATE_HOME: `${SANDBOX_ROOT}/state`,
  APPDATA: undefined,
  LOCALAPPDATA: undefined,
  USERPROFILE: undefined,
  AKM_CONFIG_DIR: undefined,
  AKM_CACHE_DIR: undefined,
  AKM_DATA_DIR: undefined,
  AKM_STATE_DIR: undefined,
  AKM_STASH_DIR: undefined,
  HOME: SANDBOX_ROOT,
} as const;

describe("resolveStorageLocations", () => {
  test("each field equals its delegated getter", async () => {
    await withEnv(isolatedEnv, () => {
      const locations = resolveStorageLocations();

      expect(locations.indexDb).toBe(getDbPath());
      expect(locations.stateDb).toBe(getStateDbPath());
      expect(locations.workflowDb).toBe(getWorkflowDbPath());
      expect(locations.lockfile).toBe(getLockfilePath());
      expect(locations.lockfileSentinel).toBe(getLockfileLockPath());
      expect(locations.dataDir).toBe(getDataDir());
      expect(locations.cacheDir).toBe(getCacheDir());
      expect(locations.configDir).toBe(getConfigDir());
      expect(locations.stashDir).toBe(getDefaultStashDir());
    });
  });

  test("honours AKM_DATA_DIR override for db paths", async () => {
    await withEnv({ ...isolatedEnv, AKM_DATA_DIR: "/tmp/akm-storage-locations-override" }, () => {
      const locations = resolveStorageLocations();

      expect(locations.dataDir).toBe(getDataDir());
      expect(locations.indexDb).toBe(getDbPath());
      expect(locations.stateDb).toBe(getStateDbPath());
      expect(locations.workflowDb).toBe(getWorkflowDbPath());
      expect(locations.lockfile).toBe(getLockfilePath());
      expect(locations.lockfileSentinel).toBe(getLockfileLockPath());
    });
  });

  test("returns exactly the documented field set", async () => {
    await withEnv(isolatedEnv, () => {
      const locations = resolveStorageLocations();
      expect(Object.keys(locations).sort()).toEqual(
        [
          "cacheDir",
          "configDir",
          "dataDir",
          "indexDb",
          "lockfile",
          "lockfileSentinel",
          "stashDir",
          "stateDb",
          "workflowDb",
        ].sort(),
      );
    });
  });
});
