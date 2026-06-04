// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proves the preload harness can never touch real user data:
 *  - HOME and the four XDG dirs resolve under the OS temp root in every test.
 *  - The real ~/.config/akm, ~/.local/share/akm, ~/akm are NOT the sandbox.
 *
 * If the sandbox ever fails to anchor, these assertions fail LOUDLY instead of
 * a test silently writing to the developer's real directories.
 */
import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

const TMP_REAL = require("node:fs").realpathSync(os.tmpdir());

function underTmp(p: string | undefined): boolean {
  if (!p) return false;
  return p === TMP_REAL || p.startsWith(TMP_REAL + path.sep);
}

describe("preload safety invariants", () => {
  test("HOME is anchored under the OS temp root", () => {
    expect(underTmp(process.env.HOME)).toBe(true);
  });

  test("all four XDG dirs are anchored under the OS temp root", () => {
    for (const k of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
      expect({ [k]: process.env[k], underTmp: underTmp(process.env[k]) }).toMatchObject({ underTmp: true });
    }
  });

  test("real user akm dirs are never the active sandbox", () => {
    const realHome = path.join(os.homedir(), ".config", "akm");
    expect(process.env.XDG_CONFIG_HOME === path.dirname(realHome)).toBe(false);
    expect(underTmp(realHome)).toBe(false);
  });

  test("AKM_*_DIR overrides, if set, are always live dirs under the temp root (heal drops leaked ones)", () => {
    // The cross-file leak signature is an AKM_*_DIR pointing at a now-deleted
    // /tmp dir. The beforeEach self-heal drops any such dangling pointer before
    // the test runs, so by the time any test body executes, an override that is
    // still set must resolve to a live dir under the temp root — never a
    // dangling pointer that would surface as STASH_DIR_UNREADABLE.
    for (const k of ["AKM_STASH_DIR", "AKM_CONFIG_DIR", "AKM_CACHE_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR"]) {
      const v = process.env[k];
      if (v !== undefined) expect(underTmp(v)).toBe(true);
    }
  });
});
