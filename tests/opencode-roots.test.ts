// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { getDataDir } from "../src/core/paths";
import {
  akmOpencodeDatabasePath,
  databaseIn,
  opencodeCacheDir,
  opencodeConfigDir,
  opencodeDatabasePath,
} from "../src/integrations/harnesses/opencode/roots";

describe("OpenCode's roots", () => {
  test("follow the XDG base directories when they are set", () => {
    const env = { XDG_DATA_HOME: "/x/data", XDG_CACHE_HOME: "/x/cache", XDG_CONFIG_HOME: "/x/config", HOME: "/h" };
    expect(opencodeDatabasePath(env)).toBe(path.join("/x/data", "opencode", "opencode.db"));
    expect(opencodeCacheDir(env)).toBe(path.join("/x/cache", "opencode"));
    expect(opencodeConfigDir(env)).toBe(path.join("/x/config", "opencode"));
  });

  test("fall back to the XDG defaults under the home directory, on every platform", () => {
    const env = { HOME: "/h" };
    expect(opencodeDatabasePath(env)).toBe(path.join("/h", ".local", "share", "opencode", "opencode.db"));
    expect(opencodeCacheDir(env)).toBe(path.join("/h", ".cache", "opencode"));
    expect(opencodeConfigDir(env)).toBe(path.join("/h", ".config", "opencode"));
  });

  test("an empty XDG variable counts as unset", () => {
    expect(opencodeDatabasePath({ XDG_DATA_HOME: "  ", HOME: "/h" })).toBe(
      path.join("/h", ".local", "share", "opencode", "opencode.db"),
    );
  });

  test("OPENCODE_CONFIG_DIR moves the config directory, and an empty one counts as unset", () => {
    const env = { XDG_CONFIG_HOME: "/x/config", HOME: "/h" };
    expect(opencodeConfigDir({ ...env, OPENCODE_CONFIG_DIR: " /elsewhere " })).toBe("/elsewhere");
    expect(opencodeConfigDir({ ...env, OPENCODE_CONFIG_DIR: "  " })).toBe(path.join("/x/config", "opencode"));
  });

  test("the user's database and akm's are each one opencode.db, in the data directory they belong to", () => {
    expect(databaseIn("/somewhere")).toBe(path.join("/somewhere", "opencode.db"));
    expect(opencodeDatabasePath({ XDG_DATA_HOME: "/x/data", HOME: "/h" })).toBe(
      path.join("/x/data", "opencode", "opencode.db"),
    );
    expect(akmOpencodeDatabasePath()).toBe(path.join(getDataDir(), "opencode.db"));
  });
});
