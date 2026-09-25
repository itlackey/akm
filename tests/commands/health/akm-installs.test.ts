// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-installs` advisory for `akm health` (upgrade-D D3). The enumerator is
 * injected so this never scans the real host filesystem or spawns a real
 * process — pure unit test.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAkmInstallsAdvisory } from "../../../src/commands/health/akm-installs";
import type { AkmInstall } from "../../../src/core/akm-installs";

function install(overrides: Partial<AkmInstall>): AkmInstall {
  return {
    path: "/opt/akm/akm",
    binDir: "/opt/akm",
    manager: "standalone",
    version: "0.9.17",
    isRunning: false,
    linked: true,
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

  test("an install behind a prerelease running version: warn naming the path, version, and a remedy pinned to that prerelease", () => {
    const result = collectAkmInstallsAdvisory(true, {
      cliVersion: "0.9.17-alpha.3",
      enumerateAkmInstalls: () => [
        install({ path: "/a/akm", version: "0.9.17-alpha.3", isRunning: true }),
        install({ path: "/b/akm", manager: "npm", version: "0.9.15" }),
      ],
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("/b/akm");
    expect(result.message).toContain("0.9.15");
    expect(result.message).toContain("differ from");
    expect(result.message).not.toContain("behind");
    expect(result.message).toContain("npm install -g akm-cli@0.9.17-alpha.3");
    expect(result.message).not.toContain("@latest");
  });

  test("an install newer than the running version: warn with a remedy pinned to the running version, not called behind", () => {
    const result = collectAkmInstallsAdvisory(true, {
      cliVersion: "0.9.17-alpha.3",
      enumerateAkmInstalls: () => [
        install({ path: "/a/akm", version: "0.9.17-alpha.3", isRunning: true }),
        install({ path: "/b/akm", manager: "bun", version: "0.9.18" }),
      ],
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("/b/akm");
    expect(result.message).toContain("0.9.18");
    expect(result.message).toContain("differ from");
    expect(result.message).toContain("bun install -g akm-cli@0.9.17-alpha.3");
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

  // r3-2: npm is `#!/usr/bin/env node`, so it derives its global prefix from
  // whichever `node` PATH resolves. A remedy naming only the bare
  // `npm install -g` would reinstall into the WRONG node's global prefix
  // when the behind install's own adjacent npm lives in a different
  // `binDir`. `remedyFor` reuses `getPackageManagerUpgradeCommand`'s
  // `displayCommand`, which must name that `binDir`.
  test("an npm install behind, with its own adjacent npm in binDir: the remedy names that binDir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-installs-bindir-"));
    const npmPath = path.join(dir, "npm");
    fs.writeFileSync(npmPath, "");
    try {
      const result = collectAkmInstallsAdvisory(true, {
        cliVersion: "0.9.17",
        enumerateAkmInstalls: () => [
          install({ path: "/a/akm", version: "0.9.17", isRunning: true }),
          install({ path: "/b/akm", manager: "npm", version: "0.9.15", binDir: dir }),
        ],
      });
      expect(result.status).toBe("warn");
      expect(result.message).toContain(dir);
      expect(result.message).toContain("npm install -g akm-cli@0.9.17");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // r2-1: an npm global package the direct akm-cli/dist scan found but that
  // nothing links onto any bin dir has no package manager command that can
  // ever update it, so the remedy is to remove it, and the message says it
  // is not on PATH rather than implying a link exists.
  test("an unlinked npm install behind: the message says not on PATH and remedies by removing it, no npm install -g", () => {
    const result = collectAkmInstallsAdvisory(true, {
      cliVersion: "0.9.17",
      enumerateAkmInstalls: () => [
        install({ path: "/a/akm", version: "0.9.17", isRunning: true }),
        install({
          path: "/root/lib/node_modules/akm-cli/dist/akm",
          manager: "npm",
          linked: false,
          version: "0.9.15",
        }),
      ],
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("/root/lib/node_modules/akm-cli/dist/akm");
    expect(result.message).toContain("not on PATH");
    expect(result.message).toContain("remove /root/lib/node_modules/akm-cli");
    expect(result.message).not.toContain("npm install -g");
  });
});
