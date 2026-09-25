// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolves and fetches the previously published `akm-cli` release used as
 * the upgrade rehearsal's starting point.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseSemver } from "semver";
import { type CommandRunner, parsePackedTarball, runCommand } from "../../../scripts/package-install";

const PACKAGE_NAME = "akm-cli";

/**
 * Every upgrade origin the rehearsal gate drives against the candidate.
 * `"previous"` resolves dynamically (the highest stable release below the
 * candidate). `"0.9.15"` is fixed: the last release before source-bound
 * scheduler grants (0.9.16) — a 0.9.15-built home has crontab rows
 * installed by `task add`'s own direct activation, with no host-local
 * `scheduler.enabled` grant recorded at all, the exact 2026-09-24 scenario
 * the scheduler-grant carry-forward exists to rescue.
 */
export const KNOWN_UPGRADE_ORIGINS = ["previous", "0.9.15"] as const;
export type UpgradeOrigin = (typeof KNOWN_UPGRADE_ORIGINS)[number];

/** `AKM_UPGRADE_FROM` still overrides ONLY the `"previous"` origin — `"0.9.15"` is fixed by definition. */
export async function resolveUpgradeOriginVersion(
  origin: UpgradeOrigin,
  candidateVersion: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  if (origin === "0.9.15") return "0.9.15";
  return resolvePreviousReleaseVersion(candidateVersion, runner);
}

/**
 * Resolve the previous release version: `AKM_UPGRADE_FROM` overrides;
 * otherwise the highest STABLE (no prerelease suffix) version below the
 * candidate's own `package.json` version, read from the real registry.
 */
export async function resolvePreviousReleaseVersion(
  candidateVersion: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  const override = process.env.AKM_UPGRADE_FROM?.trim();
  if (override) {
    if (!parseSemver(override)) throw new Error(`AKM_UPGRADE_FROM is not a valid version: ${override}`);
    return override;
  }

  let stdout: string;
  try {
    const result = await runner(["npm", "view", PACKAGE_NAME, "versions", "--json"], { cwd: process.cwd() });
    stdout = result.stdout;
  } catch (error) {
    throw new Error(
      `AKM_UPGRADE_REHEARSAL=1 could not resolve the previous release: \`npm view ${PACKAGE_NAME} versions\` failed ` +
        `(check network connectivity to the npm registry, or set AKM_UPGRADE_FROM=<version> to skip resolution). ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let versions: unknown;
  try {
    versions = JSON.parse(stdout);
  } catch {
    throw new Error(`\`npm view ${PACKAGE_NAME} versions --json\` did not return valid JSON: ${stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(versions)) {
    throw new Error(`\`npm view ${PACKAGE_NAME} versions --json\` returned a single version, expected an array`);
  }

  const candidate = parseSemver(candidateVersion);
  if (!candidate) throw new Error(`Candidate package.json version is not valid semver: ${candidateVersion}`);

  let best: { raw: string; major: number; minor: number; patch: number } | undefined;
  for (const raw of versions) {
    if (typeof raw !== "string") continue;
    const parsed = parseSemver(raw);
    if (!parsed || parsed.prerelease.length > 0) continue; // stable only
    if (parsed.compare(candidate) >= 0) continue; // strictly below the candidate
    if (!best || parsed.compare(parseSemver(best.raw) ?? parsed) > 0) {
      best = { raw, major: parsed.major, minor: parsed.minor, patch: parsed.patch };
    }
  }
  if (!best) {
    throw new Error(
      `AKM_UPGRADE_REHEARSAL=1 found no published stable ${PACKAGE_NAME} version below ${candidateVersion} on the ` +
        "registry. Set AKM_UPGRADE_FROM=<version> to pin one explicitly.",
    );
  }
  return best.raw;
}

/**
 * Fetch (and cache) the previous release's npm tarball. Cached under
 * `<cacheRoot>/previous-release/<version>/` so repeat runs do not hit the
 * network.
 */
export async function fetchPreviousReleaseTarball(
  version: string,
  cacheRoot: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  const cacheDir = path.join(cacheRoot, "previous-release", version);
  fs.mkdirSync(cacheDir, { recursive: true });

  const existing = fs.readdirSync(cacheDir).filter((name) => name.endsWith(".tgz"));
  if (existing.length === 1) return path.join(cacheDir, existing[0] as string);
  if (existing.length > 1) {
    throw new Error(`Multiple cached tarballs for ${PACKAGE_NAME}@${version} in ${cacheDir}; clear it and retry.`);
  }

  let stdout: string;
  try {
    const result = await runner(
      ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", cacheDir, `${PACKAGE_NAME}@${version}`],
      { cwd: cacheDir },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new Error(
      `AKM_UPGRADE_REHEARSAL=1 could not fetch ${PACKAGE_NAME}@${version} (check network connectivity to the npm ` +
        `registry). Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsePackedTarball(stdout, cacheDir);
}
