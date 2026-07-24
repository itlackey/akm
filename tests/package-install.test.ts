// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compare as compareSemver, valid as validSemver } from "semver";
import {
  createLocalPackageCandidate,
  deriveLocalVersion,
  globalLauncherPath,
  globalPackageDir,
  installGlobalTarball,
  launcherExecutionCommand,
  npmGlobalInstallCommand,
  packPackage,
  pathLauncherWarning,
  replaceGlobalPackage,
  uninstallGlobalPackage,
  type VerifiedInstall,
  verifyGlobalInstall,
  windowsShimOwnsTarget,
} from "../scripts/package-install";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-package-install-test-"));
  tempRoots.push(root);
  return root;
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
        files: ["cli.js", "migrate.js"],
        bin: { akm: "cli.js", "akm-migrate-storage": "migrate.js" },
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
  const migrateLauncher = path.join(sourceDir, "migrate.js");
  fs.writeFileSync(migrateLauncher, '#!/usr/bin/env node\nthrow new Error("migrate launcher must not execute");\n');
  fs.chmodSync(migrateLauncher, 0o755);
  return sourceDir;
}

function fakeVerifiedInstall(prefix: string, version: string): VerifiedInstall {
  const launcher = path.join(prefix, "bin", "akm");
  return {
    launcher,
    launchers: { akm: launcher, "akm-migrate-storage": path.join(prefix, "bin", "akm-migrate-storage") },
    packageDir: globalPackageDir(prefix, "akm-cli"),
    version,
  };
}

function writePriorPackage(prefix: string, version: string): void {
  const packageDir = globalPackageDir(prefix, "akm-cli");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "akm-cli", version }));
}

function writePublishedPackage(packageDir: string, version: string): void {
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "akm-cli",
      version,
      bin: { akm: "dist/akm", "akm-migrate-storage": "dist/akm-migrate-storage" },
    }),
  );
  fs.writeFileSync(path.join(packageDir, "dist", "akm"), "akm");
  fs.writeFileSync(path.join(packageDir, "dist", "akm-migrate-storage"), "migrate");
}

function writeOwnedLaunchers(prefix: string, packageDir: string): void {
  for (const binName of ["akm", "akm-migrate-storage"] as const) {
    const launcher = globalLauncherPath(prefix, binName);
    const target = path.join(packageDir, "dist", binName);
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    if (process.platform === "win32") {
      const relativeTarget = path.win32.relative(prefix, target);
      fs.writeFileSync(launcher, `@node "%~dp0\\${relativeTarget}" %*\r\n`);
    } else {
      fs.symlinkSync(target, launcher);
    }
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("package install orchestration", () => {
  test("uses the Windows command processor for npm-generated .cmd launchers", () => {
    const launcher = String.raw`C:\Program Files\akm prefix\akm.cmd`;

    expect(
      launcherExecutionCommand(launcher, ["--version"], "win32", { ComSpec: String.raw`C:\Windows\cmd.exe` }),
    ).toEqual([String.raw`C:\Windows\cmd.exe`, "/d", "/s", "/c", launcher, "--version"]);
    expect(launcherExecutionCommand("/tmp/akm prefix/bin/akm", ["--version"], "linux", {})).toEqual([
      "/tmp/akm prefix/bin/akm",
      "--version",
    ]);
    const prefix = String.raw`C:\npm prefix`;
    const target = String.raw`C:\npm prefix\node_modules\akm-cli\dist\akm`;
    expect(windowsShimOwnsTarget(String.raw`@node "%~dp0\node_modules\akm-cli\dist\akm" %*`, prefix, target)).toBe(
      true,
    );
    expect(windowsShimOwnsTarget(String.raw`@node "%~dp0\node_modules\other\dist\akm" %*`, prefix, target)).toBe(false);
  });

  test("derives readable valid prerelease versions from stable and prerelease sources", () => {
    const date = new Date("2026-07-24T15:16:17.000Z");
    const hash = "ABCDEF1234567890abcdef1234567890";

    const prerelease = deriveLocalVersion("0.9.0-rc.10", date, hash);
    const stable = deriveLocalVersion("1.2.3", date, hash);

    expect(prerelease).toBe("0.9.0-rc.10.local.20260724T151617000Z.pabcdef123456");
    expect(stable).toBe("1.2.4-0.local.20260724T151617000Z.pabcdef123456");
    expect(validSemver(prerelease)).toBe(prerelease);
    expect(validSemver(stable)).toBe(stable);
    expect(compareSemver(prerelease, "0.9.0-rc.10")).toBeGreaterThan(0);
    expect(compareSemver(prerelease, "0.9.0-rc.11")).toBeLessThan(0);
    expect(compareSemver(stable, "1.2.3")).toBeGreaterThan(0);
    expect(compareSemver(stable, "1.2.4")).toBeLessThan(0);
  });

  test("warns only when PATH resolves akm to a different launcher", () => {
    expect(pathLauncherWarning("/home/user/.local/bin/akm", "/opt/npm/bin/akm")).toContain(
      "PATH resolves akm to /home/user/.local/bin/akm",
    );
    expect(pathLauncherWarning("/opt/npm/bin/akm", "/opt/npm/bin/akm")).toBeUndefined();
    expect(pathLauncherWarning(String.raw`C:\NPM\AKM.CMD`, String.raw`c:\npm\akm.cmd`, "win32")).toBeUndefined();
  });

  test("stages npm's canonical payload and preserves the source package bytes", async () => {
    const root = tempRoot();
    const sourceDir = writeFixturePackage(root);
    const packageFile = path.join(sourceDir, "package.json");
    const launcherFile = path.join(sourceDir, "cli.js");
    const sourcePackageBytes = fs.readFileSync(packageFile);
    const sourceLauncherBytes = fs.readFileSync(launcherFile);

    const candidate = await createLocalPackageCandidate(
      sourceDir,
      path.join(root, "work"),
      new Date("2026-07-24T15:16:17.000Z"),
    );

    expect(fs.readFileSync(packageFile)).toEqual(sourcePackageBytes);
    expect(fs.readFileSync(launcherFile)).toEqual(sourceLauncherBytes);
    expect(fs.readFileSync(path.join(candidate.stagedPackageDir, "cli.js"))).toEqual(sourceLauncherBytes);
    expect(fs.lstatSync(candidate.stagedPackageDir).isSymbolicLink()).toBe(false);
    expect(candidate.localVersion).toBe(
      deriveLocalVersion("1.2.3-rc.4", new Date("2026-07-24T15:16:17.000Z"), candidate.payloadHash),
    );
    expect(fs.existsSync(candidate.canonicalTarball)).toBe(true);
    expect(fs.existsSync(candidate.localTarball)).toBe(true);
  });

  test("installs only the exact tarball under an explicit temporary npm prefix", async () => {
    const root = tempRoot();
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
    expect(Object.keys(verified.launchers).sort()).toEqual(["akm", "akm-migrate-storage"]);
    expect(fs.existsSync(verified.launchers.akm)).toBe(true);
    expect(fs.existsSync(verified.launchers["akm-migrate-storage"])).toBe(true);
  });

  test("preflights, preserves the prior package, and restores it after verification failure", async () => {
    const root = tempRoot();
    const realPrefix = path.join(root, "real prefix");
    const temporaryPrefix = path.join(root, "temporary prefix");
    const rollbackDir = path.join(root, "rollback");
    const candidateTarball = path.join(root, "candidate.tgz");
    const rollbackTarball = path.join(root, "prior.tgz");
    writePriorPackage(realPrefix, "1.0.0");
    const events: string[] = [];

    let failure: unknown;
    try {
      await replaceGlobalPackage(
        {
          candidateTarball,
          expected: { name: "akm-cli", version: "1.1.0-local.1" },
          realPrefix,
          rollbackDir,
          temporaryPrefix,
        },
        {
          install: async (tarball, prefix) => {
            events.push(`install:${path.basename(tarball)}:${path.basename(prefix)}`);
          },
          pack: async (sourceDir, destination) => {
            events.push(`pack:${sourceDir}:${destination}`);
            return rollbackTarball;
          },
          uninstall: async (packageName, prefix) => {
            events.push(`uninstall:${packageName}:${prefix}`);
          },
          verify: async (prefix, expected) => {
            events.push(`verify:${path.basename(prefix)}:${expected.version}`);
            if (prefix === realPrefix && expected.version === "1.1.0-local.1") throw new Error("candidate mismatch");
            return fakeVerifiedInstall(prefix, expected.version);
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Global install failed: candidate mismatch");
    expect(String(failure)).toContain("Restored previous akm-cli@1.0.0 from its rollback tarball");
    expect(events).toEqual([
      "install:candidate.tgz:temporary prefix",
      "verify:temporary prefix:1.1.0-local.1",
      `pack:${globalPackageDir(realPrefix, "akm-cli")}:${rollbackDir}`,
      "install:candidate.tgz:real prefix",
      "verify:real prefix:1.1.0-local.1",
      "install:prior.tgz:real prefix",
      "verify:real prefix:1.0.0",
    ]);
  });

  test("reports rollback failure together with the original install failure", async () => {
    const root = tempRoot();
    const realPrefix = path.join(root, "real");
    const temporaryPrefix = path.join(root, "temporary");
    const candidateTarball = path.join(root, "candidate.tgz");
    const rollbackTarball = path.join(root, "prior.tgz");
    writePriorPackage(realPrefix, "1.0.0");

    let failure: unknown;
    try {
      await replaceGlobalPackage(
        {
          candidateTarball,
          expected: { name: "akm-cli", version: "1.1.0-local.1" },
          realPrefix,
          rollbackDir: path.join(root, "rollback"),
          temporaryPrefix,
        },
        {
          install: async (tarball, prefix) => {
            if (prefix === realPrefix && tarball === candidateTarball) throw new Error("candidate install exploded");
            if (tarball === rollbackTarball) throw new Error("prior reinstall exploded");
          },
          pack: async () => rollbackTarball,
          uninstall: async () => {},
          verify: async (prefix, expected) => fakeVerifiedInstall(prefix, expected.version),
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("Global install failed: candidate install exploded");
    expect(String(failure)).toContain("Rollback also failed: prior reinstall exploded");
  });

  test("refuses stray or foreign launchers before installing into the real prefix", async () => {
    for (const priorPackage of [false, true]) {
      const root = tempRoot();
      const realPrefix = path.join(root, priorPackage ? "foreign" : "stray");
      const temporaryPrefix = path.join(root, "temporary");
      const launcher = globalLauncherPath(realPrefix, priorPackage ? "akm-migrate-storage" : "akm");
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      if (priorPackage) {
        const packageDir = globalPackageDir(realPrefix, "akm-cli");
        writePublishedPackage(packageDir, "1.0.0");
        const foreignTarget = path.join(root, "foreign-akm");
        fs.writeFileSync(foreignTarget, "foreign");
        if (process.platform === "win32") fs.writeFileSync(launcher, '@node "%~dp0\\node_modules\\other\\akm" %*\r\n');
        else fs.symlinkSync(foreignTarget, launcher);
      } else {
        fs.writeFileSync(launcher, "stray");
      }
      const realInstalls: string[] = [];

      let failure: unknown;
      try {
        await replaceGlobalPackage(
          {
            candidateTarball: path.join(root, "candidate.tgz"),
            expected: { name: "akm-cli", version: "1.1.0-local.1" },
            realPrefix,
            rollbackDir: path.join(root, "rollback"),
            temporaryPrefix,
          },
          {
            install: async (_tarball, prefix) => {
              if (prefix === realPrefix) realInstalls.push(prefix);
            },
            pack: async () => {
              throw new Error("must not pack an unowned installation");
            },
            uninstall: async () => {},
            verify: async (prefix, expected) => fakeVerifiedInstall(prefix, expected.version),
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(String(failure)).toContain(priorPackage ? "is not owned" : "exists but no akm-cli package is installed");
      expect(realInstalls).toEqual([]);
    }
  });

  test("removes a partial install when no prior package existed", async () => {
    const root = tempRoot();
    const realPrefix = path.join(root, "real");
    const temporaryPrefix = path.join(root, "temporary");
    const events: string[] = [];

    let failure: unknown;
    try {
      await replaceGlobalPackage(
        {
          candidateTarball: path.join(root, "candidate.tgz"),
          expected: { name: "akm-cli", version: "1.1.0-local.1" },
          realPrefix,
          rollbackDir: path.join(root, "rollback"),
          temporaryPrefix,
        },
        {
          install: async (_tarball, prefix) => {
            events.push(`install:${path.basename(prefix)}`);
          },
          pack: async () => {
            throw new Error("no prior package should be packed");
          },
          uninstall: async (packageName, prefix) => {
            events.push(`uninstall:${packageName}:${path.basename(prefix)}`);
          },
          verify: async (prefix, expected) => {
            events.push(`verify:${path.basename(prefix)}`);
            if (prefix === realPrefix) throw new Error("candidate verification failed");
            return fakeVerifiedInstall(prefix, expected.version);
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("Global install failed: candidate verification failed");
    expect(String(failure)).toContain("Removed the partial akm-cli install; no previous package existed");
    expect(events).toEqual([
      "install:temporary",
      "verify:temporary",
      "install:real",
      "verify:real",
      "uninstall:akm-cli:real",
    ]);
  });

  test("reports cleanup failure together with the original error", async () => {
    const root = tempRoot();
    const realPrefix = path.join(root, "real");

    let failure: unknown;
    try {
      await replaceGlobalPackage(
        {
          candidateTarball: path.join(root, "candidate.tgz"),
          expected: { name: "akm-cli", version: "1.1.0-local.1" },
          realPrefix,
          rollbackDir: path.join(root, "rollback"),
          temporaryPrefix: path.join(root, "temporary"),
        },
        {
          install: async () => {},
          pack: async () => "unused",
          uninstall: async () => {
            throw new Error("npm cleanup exploded");
          },
          verify: async (prefix, expected) => {
            if (prefix === realPrefix) throw new Error("candidate mismatch");
            return fakeVerifiedInstall(prefix, expected.version);
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("Global install failed: candidate mismatch");
    expect(String(failure)).toContain("Cleanup of the partial install also failed: npm cleanup exploded");
  });

  test("restores linked package and launcher topology without packing it", async () => {
    const root = tempRoot();
    const realPrefix = path.join(root, "real");
    const temporaryPrefix = path.join(root, "temporary");
    const linkedSource = path.join(root, "linked source");
    writePublishedPackage(linkedSource, "1.0.0");
    const packageDir = globalPackageDir(realPrefix, "akm-cli");
    fs.mkdirSync(path.dirname(packageDir), { recursive: true });
    fs.symlinkSync(linkedSource, packageDir, process.platform === "win32" ? "junction" : undefined);
    writeOwnedLaunchers(realPrefix, packageDir);
    const originalLinkTarget = fs.readlinkSync(packageDir);
    let packed = false;

    let failure: unknown;
    try {
      await replaceGlobalPackage(
        {
          candidateTarball: path.join(root, "candidate.tgz"),
          expected: { name: "akm-cli", version: "1.1.0-local.1" },
          realPrefix,
          rollbackDir: path.join(root, "rollback"),
          temporaryPrefix,
        },
        {
          install: async (_tarball, prefix) => {
            if (prefix !== realPrefix) return;
            fs.unlinkSync(packageDir);
            writePublishedPackage(packageDir, "1.1.0-local.1");
            for (const binName of ["akm", "akm-migrate-storage"] as const)
              fs.unlinkSync(globalLauncherPath(realPrefix, binName));
            writeOwnedLaunchers(realPrefix, packageDir);
            throw new Error("candidate install failed after mutation");
          },
          pack: async () => {
            packed = true;
            return path.join(root, "prior.tgz");
          },
          uninstall: async () => {},
          verify: async (prefix, expected, allowLinkedPackage) => {
            if (prefix === realPrefix && expected.version === "1.0.0") {
              expect(allowLinkedPackage).toBe(true);
              expect(fs.lstatSync(packageDir).isSymbolicLink()).toBe(true);
              expect(fs.readlinkSync(packageDir)).toBe(originalLinkTarget);
              for (const binName of ["akm", "akm-migrate-storage"] as const) {
                const launcher = globalLauncherPath(realPrefix, binName);
                const target = path.join(packageDir, "dist", binName);
                if (process.platform === "win32") {
                  expect(windowsShimOwnsTarget(fs.readFileSync(launcher, "utf8"), realPrefix, target)).toBe(true);
                } else {
                  expect(fs.realpathSync(launcher)).toBe(fs.realpathSync(target));
                }
              }
            }
            return fakeVerifiedInstall(prefix, expected.version);
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(packed).toBe(false);
    expect(String(failure)).toContain(`Restored previous linked akm-cli@1.0.0 -> ${originalLinkTarget}`);
  });
});
