// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `cli-version` advisory for `akm health` (#950). Injects `checkForUpdate` so
 * no real network call is ever made — mirrors
 * `tests/commands/health/plugin-staleness.test.ts`'s injected-seam pattern.
 */

import { describe, expect, test } from "bun:test";
import { collectVersionDriftAdvisory } from "../../../src/commands/health/version-drift";

describe("collectVersionDriftAdvisory (#950)", () => {
  test("not probed: unknown, names the installed version, never touches the network", async () => {
    let called = false;
    const result = await collectVersionDriftAdvisory(false, {
      cliVersion: "0.9.12",
      checkForUpdate: async () => {
        called = true;
        throw new Error("must not be called when probe is false");
      },
    });
    expect(called).toBe(false);
    expect(result.name).toBe("cli-version");
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("0.9.12");
    expect(result.message.toLowerCase()).toContain("not probed");
  });

  test("a newer release warns, naming both versions and the upgrade command", async () => {
    const result = await collectVersionDriftAdvisory(true, {
      cliVersion: "0.9.12",
      checkForUpdate: async (currentVersion) => ({
        currentVersion,
        latestVersion: "0.9.15",
        updateAvailable: true,
        installMethod: "npm",
      }),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("0.9.12");
    expect(result.message).toContain("0.9.15");
    expect(result.message).toContain("akm upgrade");
    expect(result.evidence).toMatchObject({ installedVersion: "0.9.12", latestVersion: "0.9.15" });
  });

  test("up to date passes", async () => {
    const result = await collectVersionDriftAdvisory(true, {
      cliVersion: "0.9.15",
      checkForUpdate: async (currentVersion) => ({
        currentVersion,
        latestVersion: "0.9.15",
        updateAvailable: false,
        installMethod: "npm",
      }),
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ installedVersion: "0.9.15", latestVersion: "0.9.15" });
  });

  test("a network failure degrades to unknown, never a false warn, and reports the error class", async () => {
    const result = await collectVersionDriftAdvisory(true, {
      cliVersion: "0.9.12",
      checkForUpdate: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("0.9.12");
    expect(result.evidence?.error).toBe("TypeError");
  });

  test("defaults cliVersion to the running package version when omitted", async () => {
    const result = await collectVersionDriftAdvisory(false);
    expect(typeof result.evidence?.installedVersion).toBe("string");
    expect((result.evidence?.installedVersion as string).length).toBeGreaterThan(0);
  });
});
