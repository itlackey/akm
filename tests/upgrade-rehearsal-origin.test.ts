// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `resolveUpgradeOriginVersion`/`KNOWN_UPGRADE_ORIGINS` (upgrade-B) with an
 * injected `CommandRunner` — no real `npm`/network, unlike the gated
 * `AKM_UPGRADE_REHEARSAL=1` suite these feed.
 */

import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../scripts/package-install";
import { KNOWN_UPGRADE_ORIGINS, resolveUpgradeOriginVersion } from "./integration/upgrade-rehearsal/previous-release";

describe("KNOWN_UPGRADE_ORIGINS / resolveUpgradeOriginVersion", () => {
  test("lists exactly the previous release and the fixed 0.9.15 origin", () => {
    expect(KNOWN_UPGRADE_ORIGINS).toEqual(["previous", "0.9.15"]);
  });

  test('the "0.9.15" origin is fixed and never calls the runner', async () => {
    const runner: CommandRunner = () => {
      throw new Error("should not be called for a fixed origin");
    };
    expect(await resolveUpgradeOriginVersion("0.9.15", "0.9.17", runner)).toBe("0.9.15");
  });

  test('the "previous" origin resolves dynamically, delegating to resolvePreviousReleaseVersion', async () => {
    const runner: CommandRunner = async (args) => {
      expect(args).toEqual(["npm", "view", "akm-cli", "versions", "--json"]);
      return { stdout: JSON.stringify(["0.9.14", "0.9.15", "0.9.16", "0.9.17"]), stderr: "" };
    };
    expect(await resolveUpgradeOriginVersion("previous", "0.9.17", runner)).toBe("0.9.16");
  });
});
