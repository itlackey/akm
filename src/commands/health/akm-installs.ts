// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-installs` advisory for `akm health` (upgrade-D D3).
 *
 * `enumerateAkmInstalls` (`../../core/akm-installs.ts`) finds every `akm` on
 * PATH and in the known install roots. This turns that enumeration into one
 * advisory: `pass` when every install reports the running version, `warn`
 * naming each install whose version differs and the manager command that
 * pins it to the running version, `unknown` when nothing could be found or a
 * `--version` probe failed on every install. `--probe`-gated like
 * `scheduler-binary.ts`: enumeration spawns a `--version` probe per
 * discovered install (and, to find the npm global root, `npm root
 * --global`), so `unknown` "not probed" with `--no-probe` rather than
 * shelling out unconditionally. Best-effort like its neighbours in
 * `gatherAncillaryAdvisories` (`../health.ts`) — a thrown error here is
 * reported as `unknown`, never allowed to abort the health report.
 */

import {
  type AkmInstall,
  enumerateAkmInstalls,
  isUnlinkedNpmInstall,
  unlinkedNpmPackageRoot,
} from "../../core/akm-installs";
import { getPackageManagerUpgradeCommand } from "../sources/self-update";
import type { HealthCheckResult } from "./types";

export interface AkmInstallsAdvisoryOptions {
  /** The running akm-cli version to compare each install against. */
  cliVersion: string;
  /** Env passed to enumeration; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable enumerator; defaults to the real one. Tests supply a fake. */
  enumerateAkmInstalls?: typeof enumerateAkmInstalls;
}

/**
 * The remedy for `install`, pinned to the running `cliVersion`. Reuses
 * `getPackageManagerUpgradeCommand` (`../sources/self-update.ts`) so this
 * remedy can never drift from what `akm upgrade` itself would run, and pins
 * the running version rather than `@latest` — a host running a prerelease
 * (e.g. `next`) would otherwise be told to install `@latest` and downgrade.
 * An unlinked npm global package (upgrade-D3 r2-1) has no bin-dir link for
 * any package manager command to update, so its remedy is to remove the
 * package directory instead — the same "is this install manageable"
 * decision `self-update.ts`'s `describeOtherInstalls`/`upgradeOtherInstall`
 * make, via the shared `isUnlinkedNpmInstall`/`unlinkedNpmPackageRoot`.
 */
function remedyFor(install: AkmInstall, cliVersion: string): string {
  if (isUnlinkedNpmInstall(install)) return `remove ${unlinkedNpmPackageRoot(install)}`;
  switch (install.manager) {
    case "npm":
    case "bun":
    case "pnpm":
      return (
        getPackageManagerUpgradeCommand(install.manager, undefined, cliVersion, install.binDir)?.displayCommand ??
        "reinstall it manually"
      );
    case "checkout":
      return "pull and rebuild that checkout";
    case "standalone":
      return "re-run the release install script for that binary";
    default:
      return "reinstall it manually";
  }
}

export function collectAkmInstallsAdvisory(probe: boolean, options: AkmInstallsAdvisoryOptions): HealthCheckResult {
  if (!probe) {
    return {
      name: "akm-installs",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "Installed akm binaries were not probed.",
    };
  }

  const enumerate = options.enumerateAkmInstalls ?? enumerateAkmInstalls;
  const env = options.env ?? process.env;

  let installs: AkmInstall[];
  try {
    installs = enumerate(env);
  } catch (error) {
    return {
      name: "akm-installs",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: `Installed akm binaries could not be enumerated: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (installs.length === 0) {
    return {
      name: "akm-installs",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No akm install was found on PATH or in the known install roots.",
    };
  }

  const behind = installs.filter((install) => install.version !== undefined && install.version !== options.cliVersion);
  const unreadable = installs.filter((install) => install.version === undefined);

  if (behind.length > 0) {
    const behindDetail = behind
      .map((install) => {
        const status = isUnlinkedNpmInstall(install) ? `v${install.version}, not on PATH` : `v${install.version}`;
        return `${install.path} -> ${status} (${remedyFor(install, options.cliVersion)})`;
      })
      .join("; ");
    const unreadableDetail =
      unreadable.length > 0
        ? ` ${unreadable.length} install(s) did not respond to --version: ${unreadable.map((i) => i.path).join(", ")}.`
        : "";
    return {
      name: "akm-installs",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: `${behind.length} of ${installs.length} akm install(s) differ from the running v${options.cliVersion}: ${behindDetail}.${unreadableDetail}`,
      evidence: { installs },
    };
  }

  if (unreadable.length > 0) {
    return {
      name: "akm-installs",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: `${unreadable.length} of ${installs.length} akm install(s) did not respond to --version: ${unreadable.map((i) => i.path).join(", ")}.`,
      evidence: { installs },
    };
  }

  return {
    name: "akm-installs",
    kind: "deterministic",
    status: "pass",
    confidence: "high",
    message: `All ${installs.length} akm install(s) on this host report v${options.cliVersion}.`,
    evidence: { installs },
  };
}
