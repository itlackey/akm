// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Release version rules (#1089), used by .github/workflows/release.yml.
 *
 * From 0.10 the patch number is a daily build: `0.<minor>.YYMMDDNN`, with
 * `YY` the UTC year, `MM` the month, `DD` the day and `NN` the build that day
 * (`01` to `99`), all two digits. A prerelease carries its stage only:
 * `0.10.26101001-alpha`, `-beta` or `-rc`. One build is promoted by publishing
 * the same `YYMMDDNN` with the next stage, then without one. The 0.9 line and
 * older keep plain `X.Y.Z[-prerelease]`.
 *
 *   bun scripts/release-version.ts validate <version>
 *   VERSION_INPUT=... STAGE_INPUT=... bun scripts/release-version.ts resolve
 *
 * `resolve` prints the version to release: the input (plus the stage), or,
 * with no input, the next daily build of package.json's line, numbered from
 * the versions already on npm.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const STAGES = ["alpha", "beta", "rc"] as const;

const DAILY = /^0\.(\d+)\.(\d{2})(\d{2})(\d{2})(\d{2})(?:-(alpha|beta|rc))?$/;
const LEGACY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** The first minor that uses daily builds. */
const FIRST_DAILY_MINOR = 10;

function usesDailyBuilds(version: string): boolean {
  const m = /^0\.(\d+)\./.exec(version);
  return m !== null && Number(m[1]) >= FIRST_DAILY_MINOR;
}

/** An error message when `version` is not a valid release version, else undefined. */
export function validateVersion(version: string): string | undefined {
  if (!usesDailyBuilds(version)) {
    return LEGACY.test(version) ? undefined : `"${version}" is not a valid version (X.Y.Z or X.Y.Z-prerelease)`;
  }
  const m = DAILY.exec(version);
  if (!m) {
    return `"${version}" is not 0.<minor>.YYMMDDNN with an optional -alpha, -beta or -rc (two digits each for YY, MM, DD, NN)`;
  }
  const [, , yy, mm, dd, nn] = m;
  const date = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd)));
  if (
    date.getUTCFullYear() !== 2000 + Number(yy) ||
    date.getUTCMonth() !== Number(mm) - 1 ||
    date.getUTCDate() !== Number(dd)
  ) {
    return `"${version}": ${yy}${mm}${dd} is not a calendar date (YYMMDD)`;
  }
  if (Number(nn) < 1) return `"${version}": the build number NN is 01 to 99`;
  return undefined;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The next daily build of `line` (for example `0.10`) on the UTC day of `now`:
 * one above the highest build already published that day, so a build promoted
 * through its stages counts once and a gap left by an unpublished version is
 * never reused.
 */
export function deriveVersion(line: string, now: Date, published: readonly string[], stage?: string): string {
  const day = `${pad2(now.getUTCFullYear() % 100)}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
  let highest = 0;
  for (const v of published) {
    const m = DAILY.exec(v);
    if (m && `0.${m[1]}` === line && `${m[2]}${m[3]}${m[4]}` === day) highest = Math.max(highest, Number(m[5]));
  }
  if (highest >= 99)
    throw new Error(`${line}.${day}99 is already published: no build numbers are left for this UTC day`);
  return `${line}.${day}${pad2(highest + 1)}${stage ? `-${stage}` : ""}`;
}

export interface ResolveInput {
  /** The workflow's `version` input; empty to derive. */
  version: string;
  /** The workflow's `stage` input: empty or `none` for a stable build, else `alpha`, `beta` or `rc`. */
  stage: string;
  /** package.json's version, whose major.minor is the line to derive for. */
  packageVersion: string;
  now: Date;
  /** Versions already on npm; read only when deriving. */
  listPublished: () => readonly string[];
}

/** The version to release, or an Error naming what is wrong with the inputs. */
export function resolveVersion(input: ResolveInput): string {
  const stage = input.stage.trim() === "none" ? "" : input.stage.trim();
  if (stage !== "" && !(STAGES as readonly string[]).includes(stage)) {
    throw new Error(`stage "${stage}" is not one of ${STAGES.join(", ")}`);
  }
  const given = input.version.trim();
  let candidate: string;
  if (given !== "") {
    if (stage !== "") {
      if (!usesDailyBuilds(given))
        throw new Error(`stage applies to daily builds (0.${FIRST_DAILY_MINOR}+) only, not "${given}"`);
      if (given.includes("-"))
        throw new Error(
          `"${given}" already has a stage; give the build number (0.<minor>.YYMMDDNN) and the stage separately`,
        );
      candidate = `${given}-${stage}`;
    } else {
      candidate = given;
    }
  } else {
    const m = /^0\.(\d+)\./.exec(input.packageVersion);
    if (!m || Number(m[1]) < FIRST_DAILY_MINOR) {
      throw new Error(`cannot derive a daily build for package.json ${input.packageVersion}; pass version explicitly`);
    }
    candidate = deriveVersion(`0.${m[1]}`, input.now, input.listPublished(), stage || undefined);
  }
  const problem = validateVersion(candidate);
  if (problem) throw new Error(problem);
  return candidate;
}

/** Versions of `name` on npm; none when it has never been published. */
function npmVersions(name: string): string[] {
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed: unknown = out.trim() === "" ? [] : JSON.parse(out);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (stderr.includes("E404")) return [];
    throw err;
  }
}

function main(argv: string[]): number {
  const [command, arg] = argv;
  if (command === "validate" && arg) {
    const problem = validateVersion(arg);
    if (problem) {
      console.error(problem);
      return 1;
    }
    return 0;
  }
  if (command === "resolve") {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { name: string; version: string };
    try {
      console.log(
        resolveVersion({
          version: process.env.VERSION_INPUT ?? "",
          stage: process.env.STAGE_INPUT ?? "",
          packageVersion: pkg.version,
          now: new Date(),
          listPublished: () => npmVersions(pkg.name),
        }),
      );
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }
  console.error("usage: release-version.ts validate <version> | resolve");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
