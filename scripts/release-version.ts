// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Release version rules (#1089), used by .github/workflows/release.yml.
 *
 * From 0.10 the patch number is a monthly release number: `0.<minor>.YYMMNN`,
 * with `YY` the UTC year, `MM` the month (`01` to `12`) and `NN` the release
 * within that month (`01` to `99`), all two digits. A release takes its number
 * when its branch (`release/<version>`) is cut, one above the highest `NN`
 * published that month at any stage. Its prereleases are that number with the
 * stage and a counter appended (`0.10.261001-beta.1`, then `-beta.2`, then
 * `-rc.1`; the counter is one above the highest on npm for that release and
 * stage); the stable release is the bare number. Prereleases published before
 * this rule carry a bare stage (`0.10.261115-beta`) and still validate.
 * The 0.9 line and older keep plain `X.Y.Z[-prerelease]`.
 *
 *   bun scripts/release-version.ts validate <version>
 *   bun scripts/release-version.ts next [0.<minor>]
 *   VERSION_INPUT=... STAGE_INPUT=... bun scripts/release-version.ts resolve
 *
 * `next` prints the next release number of a line (package.json's unless one is given, as when a new line starts)
 * for the UTC month, numbered from the versions already on npm (any stage counts, legacy 8-digit daily builds do
 * not): the name of the next release branch. `resolve` is what the Release workflow runs on a release's version and
 * stage.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const STAGES = ["alpha", "beta", "rc"] as const;

const MONTHLY = /^0\.(\d+)\.(\d{2})(\d{2})(\d{2})(?:-(alpha|beta|rc)(?:\.([1-9]\d*))?)?$/;
const LEGACY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** The first minor that uses monthly release numbers. */
const FIRST_MONTHLY_MINOR = 10;

function usesMonthlyNumbers(version: string): boolean {
  const m = /^0\.(\d+)\./.exec(version);
  return m !== null && Number(m[1]) >= FIRST_MONTHLY_MINOR;
}

/** An error message when `version` is not a valid release version, else undefined. */
export function validateVersion(version: string): string | undefined {
  if (!usesMonthlyNumbers(version)) {
    return LEGACY.test(version) ? undefined : `"${version}" is not a valid version (X.Y.Z or X.Y.Z-prerelease)`;
  }
  const m = MONTHLY.exec(version);
  if (!m) {
    const legacy = /^0\.\d+\.\d{8}(?:-|$)/.test(version) ? " (the 8-digit daily YYMMDDNN form is retired)" : "";
    return `"${version}" is not 0.<minor>.YYMMNN with an optional -alpha.N, -beta.N or -rc.N (two digits each for YY, MM, NN)${legacy}`;
  }
  const [, , , mm, nn] = m;
  if (Number(mm) < 1 || Number(mm) > 12) return `"${version}": the month MM is 01 to 12, not ${mm}`;
  if (Number(nn) < 1) return `"${version}": the release number NN is 01 to 99`;
  return undefined;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The next release number of `line` (for example `0.10`) in the UTC month of `now`: one above the highest NN already
 * published that month at any stage, so a number is never reused and a gap left by an unpublished version stays a
 * gap. Legacy 8-digit daily builds do not match and are ignored.
 */
export function deriveVersion(line: string, now: Date, published: readonly string[]): string {
  const month = `${pad2(now.getUTCFullYear() % 100)}${pad2(now.getUTCMonth() + 1)}`;
  let highest = 0;
  for (const v of published) {
    const m = MONTHLY.exec(v);
    if (m && `0.${m[1]}` === line && `${m[2]}${m[3]}` === month) highest = Math.max(highest, Number(m[4]));
  }
  if (highest >= 99)
    throw new Error(`${line}.${month}99 is already published: no release numbers are left for this UTC month`);
  return `${line}.${month}${pad2(highest + 1)}`;
}

/**
 * The version to publish: the release's number (the release branch's name for a prerelease, package.json for a
 * stable release), with `stage` and a counter appended for a prerelease (`stage` empty for a stable release). The
 * counter is one above the highest already in `published` for that release and stage; a published bare stage
 * counts as 1. Throws an Error naming what is wrong.
 */
export function resolveVersion(versionInput: string, stageInput: string, published: readonly string[] = []): string {
  const given = versionInput.trim();
  const stage = stageInput.trim();
  if (stage !== "" && !(STAGES as readonly string[]).includes(stage)) {
    throw new Error(`stage "${stage}" is not one of ${STAGES.join(", ")}`);
  }
  let candidate = given;
  if (stage !== "") {
    if (!usesMonthlyNumbers(given))
      throw new Error(`stage applies to monthly release numbers (0.${FIRST_MONTHLY_MINOR}+) only, not "${given}"`);
    if (given.includes("-"))
      throw new Error(
        `"${given}" already has a stage; give the release number (0.<minor>.YYMMNN) and the stage separately`,
      );
    let highest = 0;
    for (const v of published) {
      const m = MONTHLY.exec(v);
      if (m && v.split("-")[0] === given && m[5] === stage) highest = Math.max(highest, m[6] ? Number(m[6]) : 1);
    }
    candidate = `${given}-${stage}.${highest + 1}`;
  }
  const problem = validateVersion(candidate);
  if (problem) throw new Error(problem);
  return candidate;
}

function packageJson(): { name: string; version: string } {
  return JSON.parse(fs.readFileSync("package.json", "utf8")) as { name: string; version: string };
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
  try {
    if (command === "validate" && arg) {
      const problem = validateVersion(arg);
      if (problem) throw new Error(problem);
      return 0;
    }
    if (command === "resolve") {
      const stage = (process.env.STAGE_INPUT ?? "").trim();
      const published = stage === "" ? [] : npmVersions(packageJson().name);
      console.log(resolveVersion(process.env.VERSION_INPUT ?? "", stage, published));
      return 0;
    }
    if (command === "next") {
      const pkg = packageJson();
      const line = /^0\.(\d+)(?:\.|$)/.exec(arg ?? pkg.version);
      if (!line || Number(line[1]) < FIRST_MONTHLY_MINOR) {
        throw new Error(
          `${arg ?? `package.json ${pkg.version}`} is not a monthly-number line (0.${FIRST_MONTHLY_MINOR}+)`,
        );
      }
      console.log(deriveVersion(`0.${line[1]}`, new Date(), npmVersions(pkg.name)));
      return 0;
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  console.error("usage: release-version.ts validate <version> | resolve | next [0.<minor>]");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
