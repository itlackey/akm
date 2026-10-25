// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { opencodeCacheDir, opencodeConfigDir, opencodeDataDir } from "../src/integrations/harnesses/opencode/roots";

describe("OpenCode's roots", () => {
  test("follow the XDG base directories when they are set", () => {
    const env = { XDG_DATA_HOME: "/x/data", XDG_CACHE_HOME: "/x/cache", XDG_CONFIG_HOME: "/x/config", HOME: "/h" };
    expect(opencodeDataDir(env)).toBe(path.join("/x/data", "opencode"));
    expect(opencodeCacheDir(env)).toBe(path.join("/x/cache", "opencode"));
    expect(opencodeConfigDir(env)).toBe(path.join("/x/config", "opencode"));
  });

  test("fall back to the XDG defaults under the home directory, on every platform", () => {
    const env = { HOME: "/h" };
    expect(opencodeDataDir(env)).toBe(path.join("/h", ".local", "share", "opencode"));
    expect(opencodeCacheDir(env)).toBe(path.join("/h", ".cache", "opencode"));
    expect(opencodeConfigDir(env)).toBe(path.join("/h", ".config", "opencode"));
  });

  test("an empty XDG variable counts as unset", () => {
    expect(opencodeDataDir({ XDG_DATA_HOME: "  ", HOME: "/h" })).toBe(path.join("/h", ".local", "share", "opencode"));
  });
});
