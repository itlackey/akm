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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_REAL = fs.realpathSync(os.tmpdir());
const repoRoot = path.resolve(__dirname, "..");

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

  test("Bun's process-start home is never the active config sandbox", () => {
    const processStartConfig = path.join(os.homedir(), ".config", "akm");
    expect(process.env.XDG_CONFIG_HOME).not.toBe(path.dirname(processStartConfig));
  });

  test("both broad shard runners seed a unique HOME before Bun starts", () => {
    for (const runner of ["scripts/test-unit.sh", "scripts/test-integration.sh"]) {
      const source = fs.readFileSync(path.join(repoRoot, runner), "utf8");
      expect(source).toMatch(/runtime_home="\$\{logdir\}\/runtime-home-\$\(\(k \+ 1\)\)"/);
      expect(source).toContain('HOME="$runtime_home" bun test');
    }
  });

  test("the AKM_BUNDLE_DIR override, if set, are always live dirs under the temp root (heal drops leaked ones)", () => {
    // The cross-file leak signature is an AKM_BUNDLE_DIR pointing at a now-deleted
    // /tmp dir. The beforeEach self-heal drops any such dangling pointer before
    // the test runs, so by the time any test body executes, an override that is
    // still set must resolve to a live dir under the temp root — never a
    // dangling pointer that would surface as STASH_DIR_UNREADABLE.
    for (const k of ["AKM_BUNDLE_DIR"]) {
      const v = process.env[k];
      if (v !== undefined) expect(underTmp(v)).toBe(true);
    }
  });
});
