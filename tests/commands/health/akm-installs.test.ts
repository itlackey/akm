// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-installs` advisory for `akm health` (upgrade-D D3). The enumerator is
 * injected so this never scans the real host filesystem or spawns a real
 * process — pure unit test.
 */

import { describe, expect, test } from "bun:test";
import { collectAkmInstallsAdvisory } from "../../../src/commands/health/akm-installs";
import type { AkmInstall } from "../../../src/core/akm-installs";

function install(overrides: Partial<AkmInstall>): AkmInstall {
  return {
    path: "/opt/akm/akm",
    binDir: "/opt/akm",
    manager: "standalone",
    version: "0.9.17",
    isRunning: false,
    ...overrides,
  };
}

describe("collectAkmInstallsAdvisory (upgrade-D D3)", () => {
  test("not probed: unknown, never enumerates", () => {
    let enumerated = false;
    const result = collectAkmInstallsAdvisory(false, {
      cliVersion: "0.9.17",
      enumerateAkmInstalls: () => {
        enumerated = true;
        return [];
      },
    });
    expect(enumerated).toBe(false);
    expect(result.name).toBe("akm-installs");
    expect(result.status).toBe("unknown");
    expect(result.message.toLowerCase()).toContain("not probed");
  });

  test("no install found anywhere: unknown", () => {
    const result = collectAkmInstallsAdvisory(true, { cliVersion: "0.9.17", enumerateAkmInstalls: () => [] });
    expect(result.name).toBe("akm-installs");
    expect(result.status).toBe("unknown");
    expect(result.message.toLowerCase()).toContain("no akm install");
  });

  test("enumeration throws: unknown, never aborts", () => {
    const result = collectAkmInstallsAdvisory(true, {
      cliVersion: "0.9.17",
      enumerateAkmInstalls: () => {
        throw new Error("boom");
      },
    });
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("boom");
  });

  test("every install matches the running version: pass", () => {
    const result = collectAkmInstallsAdvisory(true, {
      cliVersion: "0.9.17",
      enumerateAkmInstalls: () => [
        install({ path: "/a/akm", version: "0.9.17", isRunning: true }),
        install({ path: "/b/akm", manager: "npm", version: "0.9.17" }),
      ],
    });
    expect(result.status).toBe("pass");
    expect(result.message).toContain("2");
  });

  test("an install behind the running version: warn naming the path, version, and manager remedy", () => {
    const result = collectAkmInstallsAdvisory(true, {
      cliVersion: "0.9.17",
      enumerateAkmInstalls: () => [
        install({ path: "/a/akm", version: "0.9.17", isRunning: true }),
        install({ path: "/b/akm", manager: "npm", version: "0.9.15" }),
      ],
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("/b/akm");
    expect(result.message).toContain("0.9.15");
    expect(result.message).toContain("npm install -g akm-cli@latest");
  });

  test("an install whose --version failed, all others matching: unknown, not a false pass", () => {
    const result = collectAkmInstallsAdvisory(true, {
      cliVersion: "0.9.17",
      enumerateAkmInstalls: () => [
        install({ path: "/a/akm", version: "0.9.17", isRunning: true }),
        install({ path: "/b/akm", manager: "checkout", version: undefined }),
      ],
    });
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("/b/akm");
  });

  test("evidence carries the full install list", () => {
    const installs = [install({ path: "/a/akm", version: "0.9.17", isRunning: true })];
    const result = collectAkmInstallsAdvisory(true, { cliVersion: "0.9.17", enumerateAkmInstalls: () => installs });
    expect(result.evidence).toMatchObject({ installs });
  });
});
