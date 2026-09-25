// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression coverage for `formatUpgradePlain` (r3-6): an `akm upgrade
// --check` against an explicit `--version`/`--tag` target must tell the
// operator to re-run with that same target, not a bare `akm upgrade` (which
// would install `latest` instead), and a downgrade target must read as a
// downgrade rather than as "available".

import { describe, expect, it } from "bun:test";
import { formatUpgradePlain } from "../src/output/text/command-format";

describe("formatUpgradePlain", () => {
  it("renders a plain latest-release check unchanged", () => {
    const text = formatUpgradePlain({
      currentVersion: "0.9.16",
      latestVersion: "0.9.17",
      updateAvailable: true,
      installMethod: "npm",
    });
    expect(text).toBe("akm v0.9.16 → v0.9.17 available (run 'akm upgrade' to install)");
  });

  it("names the --version target instead of a bare 'akm upgrade'", () => {
    const text = formatUpgradePlain({
      currentVersion: "0.9.16",
      latestVersion: "0.9.17",
      updateAvailable: true,
      installMethod: "npm",
      requestedTarget: { version: "0.9.17" },
    });
    expect(text).toBe("akm v0.9.16 → v0.9.17 available (run 'akm upgrade --version 0.9.17' to install)");
  });

  it("names the --tag target instead of a bare 'akm upgrade'", () => {
    const text = formatUpgradePlain({
      currentVersion: "0.9.16",
      latestVersion: "0.9.18-next.1",
      updateAvailable: true,
      installMethod: "npm",
      requestedTarget: { tag: "next" },
    });
    expect(text).toBe("akm v0.9.16 → v0.9.18-next.1 available (run 'akm upgrade --tag next' to install)");
  });

  it("reports a downgrade target as a downgrade, not as 'available'", () => {
    const text = formatUpgradePlain({
      currentVersion: "0.9.17",
      latestVersion: "0.9.10",
      updateAvailable: true,
      installMethod: "npm",
      requestedTarget: { version: "0.9.10" },
    });
    expect(text).toBe("akm v0.9.10 is older than the installed v0.9.17; pass --force to downgrade");
    expect(text).not.toContain("available");
  });

  it("still renders the already-latest and upgraded cases unchanged", () => {
    expect(
      formatUpgradePlain({
        currentVersion: "0.9.17",
        latestVersion: "0.9.17",
        updateAvailable: false,
        installMethod: "npm",
      }),
    ).toBe("akm v0.9.17 is already the latest version");
    expect(
      formatUpgradePlain({
        upgraded: true,
        currentVersion: "0.9.16",
        newVersion: "0.9.17",
        installMethod: "npm",
      }),
    ).toBe("akm upgraded: v0.9.16 → v0.9.17");
  });
});
