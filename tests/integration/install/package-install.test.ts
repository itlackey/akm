// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RUNTIME-03/ORG-03: this one test performs a REAL `npm pack` +
 * `npm install --global` (into a throwaway temporary prefix, never the host's
 * real global prefix) and then verifies the result on disk. It shells out to
 * an external `npm` binary and mutates a (temporary, isolated) global-install
 * layout, so it belongs in the integration target — not the unit target,
 * which must stay hermetic and host-independent. The rest of
 * `tests/package-install.test.ts`'s coverage is pure unit-level logic (string
 * building, rollback bookkeeping via injected fakes) and stays there
 * unchanged; only this test — and the imports it alone needed — moved here.
 * Cost is small (~1.9s solo), so this is a placement/correctness fix, not a
 * runtime one.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  globalPackageDir,
  installGlobalTarball,
  npmGlobalInstallCommand,
  packPackage,
  uninstallGlobalPackage,
  verifyGlobalInstall,
} from "../../../scripts/package-install";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-package-install-integration-"));
}

function writeFixturePackage(root: string, name = "akm-package-install-fixture", version = "1.2.3-rc.4"): string {
  const sourceDir = path.join(root, "source package");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version,
        type: "module",
        files: ["cli.js"],
        bin: { akm: "cli.js" },
      },
      null,
      4,
    )}\n`,
  );
  const launcher = path.join(sourceDir, "cli.js");
  fs.writeFileSync(
    launcher,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"));',
      "console.log(pkg.version);",
      "",
    ].join("\n"),
  );
  fs.chmodSync(launcher, 0o755);
  return sourceDir;
}

describe("package install orchestration (real npm)", () => {
  test("installs only the exact tarball under an explicit temporary npm prefix", async () => {
    const root = tempRoot();
    try {
      const packageName = "akm-package-install-fixture";
      const version = "1.2.3-rc.4";
      const sourceDir = writeFixturePackage(root, packageName, version);
      const tarball = await packPackage(sourceDir, path.join(root, "packed"));
      const prefix = path.join(root, "temporary npm prefix");
      const command = npmGlobalInstallCommand(tarball, prefix);

      expect(command).toContain("--global");
      expect(command).not.toContain("--force");
      expect(command.slice(command.indexOf("--prefix"), command.indexOf("--prefix") + 2)).toEqual(["--prefix", prefix]);
      expect(command.at(-1)).toBe(path.resolve(tarball));

      let uninstallCommand: readonly string[] = [];
      await uninstallGlobalPackage("akm-cli", root, prefix, async (command) => {
        uninstallCommand = command;
        return { stdout: "", stderr: "" };
      });
      expect(uninstallCommand).toContain("uninstall");
      expect(uninstallCommand).toContain("akm-cli");
      expect(uninstallCommand).not.toContain("--force");

      await installGlobalTarball(tarball, root, prefix);
      const verified = await verifyGlobalInstall(prefix, { name: packageName, version });

      expect(verified.packageDir).toBe(globalPackageDir(prefix, packageName));
      expect(fs.lstatSync(verified.packageDir).isSymbolicLink()).toBe(false);
      expect(verified.version).toBe(version);
      expect(verified.launcher.startsWith(prefix)).toBe(true);
      expect(Object.keys(verified.launchers).sort()).toEqual(["akm"]);
      expect(fs.existsSync(verified.launchers.akm)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
